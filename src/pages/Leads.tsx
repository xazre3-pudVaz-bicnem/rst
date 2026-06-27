import { useCallback, useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import {
  Sparkles, Play, Settings2, CheckCircle2, Flame, PhoneOff, Copy as CopyIcon,
  Store, Building2, MapPin, Phone, Upload,
} from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { useAuth } from '@/context/AuthContext'
import { CaseApi, LeadCandidateApi, ImportBatchApi, AuditApi } from '@/lib/api'
import { classifyLead, generateMockLeads } from '@/lib/leadScoring'
import {
  DEFAULT_STATUS, LEAD_TEMP_COLORS, LS_LEAD_SETTINGS, DEFAULT_LEAD_SETTINGS,
} from '@/lib/constants'
import { isSupabaseConfigured, supabase } from '@/lib/supabaseClient'
import { cn, jpError, copyToClipboard, mapUrl } from '@/lib/utils'
import type { Case, LeadCandidate, LeadImportSettings, LeadTemperature } from '@/lib/types'

type Filter = 'ALL' | LeadTemperature
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'ALL', label: 'すべて' },
  { key: 'HOT', label: 'HOT' },
  { key: 'WARM', label: 'WARM' },
  { key: 'HOLD', label: '保留' },
  { key: 'EXCLUDED', label: '除外' },
]

function loadSettings(): LeadImportSettings {
  try {
    const raw = localStorage.getItem(LS_LEAD_SETTINGS)
    if (raw) return { ...DEFAULT_LEAD_SETTINGS, ...JSON.parse(raw) }
  } catch (_) { /* noop */ }
  return { ...DEFAULT_LEAD_SETTINGS }
}

export default function Leads() {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [candidates, setCandidates] = useState<LeadCandidate[]>([])
  const [cases, setCases] = useState<Case[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [settings, setSettings] = useState<LeadImportSettings>(loadSettings)
  const [showSettings, setShowSettings] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    try {
      const [lc, cs] = await Promise.all([LeadCandidateApi.list(800), CaseApi.listAll()])
      setCandidates(lc); setCases(cs)
    } catch (e) {
      console.error('[Leads]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Realtime
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let t: ReturnType<typeof setTimeout> | null = null
    const reload = () => { if (t) clearTimeout(t); t = setTimeout(load, 500) }
    const ch = supabase
      .channel('leads_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lead_candidates' }, reload)
      .subscribe()
    return () => { if (t) clearTimeout(t); supabase.removeChannel(ch) }
  }, [load])

  function saveSettings(s: LeadImportSettings) {
    setSettings(s)
    localStorage.setItem(LS_LEAD_SETTINGS, JSON.stringify(s))
  }

  // 案件へ投入
  async function importToCase(c: LeadCandidate): Promise<boolean> {
    const memo = [
      `【AI自動投入 / ${c.lead_temperature}】`,
      `投入理由: ${c.auto_import_reason ?? ''}`,
      `AIコメント: ${c.ai_comment ?? ''}`,
      `オーナー到達スコア: ${c.owner_reachability_score}`,
    ].join('\n')
    const created = await CaseApi.create({
      name: c.name,
      address: c.address ?? '',
      phone1: c.phone_number ?? '',
      industry: c.industry ?? null,
      status: DEFAULT_STATUS,
      hp1: c.website_url ?? null,
      instagram: c.instagram_url ?? null,
      source_urls: c.source_type ?? 'AI自動投入',
      memo,
      created_by_id: user?.id ?? null,
    })
    await LeadCandidateApi.update(c.id, { imported_to_cases: true, imported_at: new Date().toISOString() })
    AuditApi.log({ action: 'create', entity: 'case', entity_id: created.id, entity_name: created.name, detail: 'AI自動投入', actor_id: user?.id ?? null })
    return true
  }

  async function handleManualImport(c: LeadCandidate, force = false) {
    if (c.imported_to_cases) return
    const ok = await confirm({
      title: force ? '除外判定を解除して投入しますか？' : 'この候補をcasesへ投入しますか？',
      body: `${c.name}\n${c.phone_number ?? '電話番号なし'}`,
      confirmLabel: '投入する',
    })
    if (!ok) return
    try {
      await importToCase(c)
      toast.success(`「${c.name}」を案件に投入しました`)
      load()
    } catch (e) {
      toast.error('投入に失敗しました: ' + jpError(e))
    }
  }

  // モック手動実行
  async function runMock() {
    if (!isSupabaseConfigured) { toast.error('Supabase未設定です'); return }
    setRunning(true)
    try {
      const raws = generateMockLeads()
      const existingPhones = new Set(candidates.map((c) => c.phone_normalized).filter(Boolean) as string[])
      const todayImports = candidates.filter((c) => c.imported_at && moment(c.imported_at).isSame(moment(), 'day')).length

      let saved = 0, hot = 0, imported = todayImports, dup = 0, excluded = 0, hold = 0
      const createdHot: LeadCandidate[] = []

      for (const raw of raws) {
        const classified = classifyLead(raw, cases)
        // lead_candidates 内の電話重複はスキップ（再実行時の二重登録防止）
        if (classified.phone_normalized && existingPhones.has(classified.phone_normalized)) continue
        const row = await LeadCandidateApi.create({
          ...classified,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          imported_to_cases: false,
          created_by_id: user?.id ?? null,
        })
        if (!row) continue
        saved++
        if (classified.phone_normalized) existingPhones.add(classified.phone_normalized)
        if (row.lead_temperature === 'HOT') { hot++; createdHot.push(row) }
        if (row.lead_temperature === 'EXCLUDED') excluded++
        if (row.lead_temperature === 'HOLD') hold++
        if (row.duplicate_of_case_id) dup++
      }

      // HOT自動投入（設定ON＋日次上限まで）
      let autoImported = 0
      if (settings.autoImport) {
        for (const c of createdHot) {
          if (imported >= settings.dailyCap) break
          try {
            await importToCase(c)
            imported++; autoImported++
          } catch (e) {
            console.warn('[Lead import]', e)
          }
        }
      }

      await ImportBatchApi.create({
        source: 'ai_auto',
        file_name: 'AI自動投入（モック）',
        total_rows: raws.length,
        added_count: autoImported,
        duplicate_count: dup,
        error_count: excluded,
        detail: `保存${saved} / HOT${hot} / 自動投入${autoImported} / 保留${hold} / 除外${excluded}`,
        created_by_id: user?.id ?? null,
      })

      toast.success(`実行完了: 候補${saved}件保存 / HOT${hot}件 / casesへ${autoImported}件投入`)
      load()
    } catch (e) {
      toast.error('実行に失敗しました: ' + jpError(e))
    } finally {
      setRunning(false)
    }
  }

  const summary = useMemo(() => {
    const today = (c: LeadCandidate) => c.imported_at && moment(c.imported_at).isSame(moment(), 'day')
    return {
      todayImported: candidates.filter(today).length,
      hot: candidates.filter((c) => c.lead_temperature === 'HOT').length,
      noPhone: candidates.filter((c) => !c.phone_normalized).length,
      dup: candidates.filter((c) => c.duplicate_of_case_id).length,
      gbp: candidates.filter((c) => c.is_new_gbp).length,
      instagram: candidates.filter((c) => c.is_new_instagram).length,
      website: candidates.filter((c) => c.is_new_website).length,
      ad: candidates.filter((c) => c.is_new_ad_listing).length,
    }
  }, [candidates])

  const filtered = useMemo(
    () => (filter === 'ALL' ? candidates : candidates.filter((c) => c.lead_temperature === filter)),
    [candidates, filter],
  )

  const card = (icon: React.ReactNode, label: string, value: number, color: string) => (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card p-2.5">
      <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', color)}>{icon}</div>
      <div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold">{value}</div>
      </div>
    </div>
  )

  const sigBadge = (on: boolean, label: string) =>
    on ? <span className="rounded-sm bg-primary/10 px-1 text-[9px] text-primary">{label}</span> : null

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-[1400px] space-y-3">
          {/* ヘッダ */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="flex items-center gap-1.5 text-lg font-bold"><Sparkles className="h-4 w-4 text-primary" />AI投入リスト</h1>
              <p className="text-2xs text-muted-foreground">電話番号あり＋新規シグナル＋オーナー到達スコア80以上の「HOT」のみ案件へ自動投入</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowSettings((v) => !v)}>
                <Settings2 className="h-3.5 w-3.5" />設定
              </Button>
              <Button size="sm" onClick={runMock} disabled={running}>
                <Play className="h-3.5 w-3.5" />{running ? '実行中...' : '手動実行（モック）'}
              </Button>
            </div>
          </div>

          {/* 設定パネル */}
          {showSettings && (
            <div className="grid gap-3 rounded-xl border bg-card p-3 md:grid-cols-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.autoImport} onChange={(e) => saveSettings({ ...settings, autoImport: e.target.checked })} />
                HOTを自動でcasesへ投入
              </label>
              <div className="space-y-1">
                <Label>1日の自動投入上限</Label>
                <Input type="number" min={1} value={settings.dailyCap} onChange={(e) => saveSettings({ ...settings, dailyCap: Math.max(1, Number(e.target.value) || 1) })} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label>対象エリア</Label>
                <Input value={settings.areas} onChange={(e) => saveSettings({ ...settings, areas: e.target.value })} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label>対象業種</Label>
                <Input value={settings.industries} onChange={(e) => saveSettings({ ...settings, industries: e.target.value })} className="h-8" />
              </div>
              <div className="md:col-span-4 text-[10px] text-muted-foreground">
                ※毎朝6:00の自動実行は、実API接続（Phase2）時にSupabase Edge Function + Cronで構成します。現在は「手動実行（モック）」で動作確認できます。
              </div>
            </div>
          )}

          {/* 集計カード */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
            {card(<Upload className="h-4 w-4 text-white" />, '本日の自動投入', summary.todayImported, 'bg-primary')}
            {card(<Flame className="h-4 w-4 text-white" />, 'HOT件数', summary.hot, 'bg-red-500')}
            {card(<PhoneOff className="h-4 w-4 text-white" />, '電話なし保留', summary.noPhone, 'bg-slate-500')}
            {card(<CopyIcon className="h-4 w-4 text-white" />, '重複除外', summary.dup, 'bg-zinc-500')}
            {card(<MapPin className="h-4 w-4 text-white" />, '新規GBP', summary.gbp, 'bg-emerald-500')}
            {card(<Sparkles className="h-4 w-4 text-white" />, '新規Instagram', summary.instagram, 'bg-pink-500')}
            {card(<Building2 className="h-4 w-4 text-white" />, '新規HP', summary.website, 'bg-sky-500')}
            {card(<Store className="h-4 w-4 text-white" />, '新規広告', summary.ad, 'bg-amber-500')}
          </div>

          {/* フィルタ */}
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn('rounded-full border px-3 py-0.5 text-2xs', filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent')}
              >
                {f.label}{f.key !== 'ALL' && ` (${candidates.filter((c) => c.lead_temperature === f.key).length})`}
              </button>
            ))}
          </div>

          {/* テーブル */}
          {loading ? (
            <SkeletonRows count={8} />
          ) : !isSupabaseConfigured ? (
            <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">Supabase が未設定です。</div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
              候補がありません。「手動実行（モック）」を押すとサンプル候補を判定して取り込みます。
              <div className="mt-1 text-2xs">※ `lead_candidates` テーブル未作成の場合は migrations/2026-06-27_lead_candidates.sql を実行してください。</div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full min-w-[1100px] text-2xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">温度</th>
                    <th className="p-2 text-left">店名 / 業種</th>
                    <th className="p-2 text-left">電話番号</th>
                    <th className="p-2 text-left">住所</th>
                    <th className="p-2 text-left">検出シグナル</th>
                    <th className="p-2 text-center">到達<br />スコア</th>
                    <th className="p-2 text-left">判定</th>
                    <th className="p-2 text-left">投入理由 / AIコメント</th>
                    <th className="p-2 text-center">検出日</th>
                    <th className="p-2 text-center">状態</th>
                    <th className="p-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr key={c.id} className="border-t align-top">
                      <td className="p-2">
                        <span className={cn('rounded px-1.5 py-0.5 font-bold', LEAD_TEMP_COLORS[c.lead_temperature])}>{c.lead_temperature}</span>
                      </td>
                      <td className="p-2">
                        <div className="font-medium">{c.name}</div>
                        {c.industry && <div className="text-[9px] text-muted-foreground">{c.industry}</div>}
                      </td>
                      <td className="p-2">
                        {c.phone_number ? (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-2.5 w-2.5 text-muted-foreground" />{c.phone_number}
                            <button className="text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(c.phone_number!).then((ok) => ok && toast.success('コピーしました'))}><CopyIcon className="h-2.5 w-2.5" /></button>
                          </span>
                        ) : <span className="text-red-500">なし</span>}
                      </td>
                      <td className="max-w-[160px] p-2">
                        {c.address ? <a href={mapUrl(c.address, c.name)} target="_blank" rel="noreferrer" className="text-primary hover:underline">{c.address}</a> : '—'}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-0.5">
                          {sigBadge(c.is_new_gbp, 'GBP')}
                          {sigBadge(c.is_new_instagram, 'IG')}
                          {sigBadge(c.is_new_website, 'HP')}
                          {sigBadge(c.is_new_ad_listing, '広告')}
                          {c.is_new_corporation && <span className="rounded-sm bg-indigo-100 px-1 text-[9px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">新設法人</span>}
                          {!c.is_new_gbp && !c.is_new_instagram && !c.is_new_website && !c.is_new_ad_listing && !c.is_new_corporation && <span className="text-muted-foreground">—</span>}
                        </div>
                      </td>
                      <td className="p-2 text-center">
                        <span className={cn('font-bold', c.owner_reachability_score >= 80 ? 'text-green-600' : c.owner_reachability_score >= 50 ? 'text-amber-600' : 'text-red-600')}>
                          {c.owner_reachability_score}
                        </span>
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-0.5">
                          {c.is_chain_store && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">チェーン</span>}
                          {c.is_in_shopping_mall && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">施設内</span>}
                          {c.is_in_station_building && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">駅ビル</span>}
                          {c.is_large_company_branch && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">支店</span>}
                          {c.should_exclude_from_call_list && <span className="rounded-sm bg-red-100 px-1 text-[9px] text-red-700 dark:bg-red-500/20 dark:text-red-300">投入不可</span>}
                          {c.duplicate_of_case_id && <span className="rounded-sm bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">重複</span>}
                          {c.exclusion_reason && <div className="w-full text-[9px] text-muted-foreground">{c.exclusion_reason}</div>}
                        </div>
                      </td>
                      <td className="max-w-[280px] p-2">
                        <div className="font-medium text-foreground">{c.auto_import_reason}</div>
                        <div className="mt-0.5 line-clamp-3 text-[10px] text-muted-foreground" title={c.ai_comment ?? ''}>{c.ai_comment}</div>
                      </td>
                      <td className="whitespace-nowrap p-2 text-center text-muted-foreground">{moment(c.first_seen_at).format('MM/DD')}</td>
                      <td className="p-2 text-center">
                        {c.imported_to_cases
                          ? <span className="inline-flex items-center gap-0.5 text-green-600"><CheckCircle2 className="h-3 w-3" />投入済</span>
                          : <span className="text-muted-foreground">未投入</span>}
                      </td>
                      <td className="p-2 text-right">
                        {c.imported_to_cases ? (
                          <span className="text-[9px] text-muted-foreground">{c.imported_at ? moment(c.imported_at).format('MM/DD HH:mm') : ''}</span>
                        ) : c.duplicate_of_case_id ? (
                          <span className="text-[9px] text-muted-foreground">重複のため不可</span>
                        ) : c.lead_temperature === 'EXCLUDED' ? (
                          <button className="rounded border px-1.5 py-0.5 text-[9px] text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-500/10" onClick={() => handleManualImport(c, true)}>除外解除して投入</button>
                        ) : (
                          <button className="rounded border border-primary px-1.5 py-0.5 text-[9px] text-primary hover:bg-primary/10" onClick={() => handleManualImport(c)}>
                            {c.lead_temperature === 'HOT' ? 'casesへ投入' : '保留から投入'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

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
import { Textarea } from '@/components/ui/textarea'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { useAuth } from '@/context/AuthContext'
import { CaseApi, LeadCandidateApi, ImportBatchApi, AuditApi, AppConfigApi, LeadQueryLogApi } from '@/lib/api'
import { classifyLead, generateMockLeads } from '@/lib/leadScoring'
import {
  DEFAULT_STATUS, LEAD_TEMP_COLORS, LS_LEAD_SETTINGS, DEFAULT_LEAD_SETTINGS, parseList,
} from '@/lib/constants'
import { AREA_PRESET_OPTIONS, AREA_PRESETS, prefectureAreaTotals, presetLabel } from '@/lib/areaPresets'
import { isSupabaseConfigured, supabase } from '@/lib/supabaseClient'
import { cn, jpError, copyToClipboard, mapUrl } from '@/lib/utils'
import type { Case, LeadCandidate, LeadImportSettings, LeadRun, LeadTemperature } from '@/lib/types'

type Filter = 'ALL' | LeadTemperature
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'ALL', label: 'すべて' },
  { key: 'HOT', label: 'HOT' },
  { key: 'WARM', label: 'WARM' },
  { key: 'HOLD', label: '保留' },
  { key: 'EXCLUDED', label: '除外' },
]

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const m = moment(s)
  return m.isValid() ? m.format('YYYY/MM/DD') : '—'
}

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
  // Google Places
  const [gpConfigured, setGpConfigured] = useState<boolean | null>(null)
  const [gpReachable, setGpReachable] = useState<boolean | null>(null)
  const [gpDiag, setGpDiag] = useState<{ keyLength?: number; hasSupabaseUrl?: boolean; hasServiceRole?: boolean } | null>(null)
  const [gpRunning, setGpRunning] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [gpResult, setGpResult] = useState<any>(null)
  const [lastRun, setLastRun] = useState<LeadRun | null>(null)
  // 自動取得（Cron）巡回状況
  const [qlog, setQlog] = useState<{ query: string; prefecture: string | null; area: string | null; last_run_at: string; hot_count: number; places_count: number }[]>([])
  const [savingCfg, setSavingCfg] = useState(false)

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

  const loadRuns = useCallback(async () => {
    if (!isSupabaseConfigured) return
    const { data } = await supabase.from('auto_lead_runs').select('*').order('created_date', { ascending: false }).limit(1)
    setLastRun(data && data[0] ? (data[0] as LeadRun) : null)
  }, [])

  const loadQlog = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try { setQlog(await LeadQueryLogApi.recent(7)) } catch { /* テーブル未作成等は無視 */ }
  }, [])

  useEffect(() => { load(); loadRuns(); loadQlog() }, [load, loadRuns, loadQlog])

  // Google Places API 接続状態
  const checkGpStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/leads/google-places/run', { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setGpReachable(r.ok)
      setGpConfigured(!!j.configured)
      setGpDiag(j)
    } catch {
      setGpReachable(false)
      setGpConfigured(false)
      setGpDiag(null)
    }
  }, [])

  useEffect(() => { checkGpStatus() }, [checkGpStatus])

  async function runPlaces(testFixed = false) {
    if (!testFixed && !settings.placesEnabled) { toast.error('設定でGoogle Places実行がOFFです'); return }
    if (gpConfigured === false) { toast.error('GOOGLE_MAPS_API_KEYが未設定です'); return }
    setGpRunning(true); setGpResult(null)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      if (!token) { toast.error('ログインが必要です'); return }
      const res = await fetch('/api/leads/google-places/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            testFixed,
            autoImport: settings.autoImport,
            dailyCap: settings.dailyCap,
            areaPreset: settings.areaPreset,
            areas: parseList(settings.areas),
            industries: parseList(settings.industries),
            maxPerQuery: settings.maxPerQuery,
            maxQueriesPerDay: settings.maxQueriesPerDay,
            rotation: settings.rotation,
            hotMaxReviews: settings.hotMaxReviews,
            warmMaxReviews: settings.warmMaxReviews,
            exclude100: settings.exclude100,
            unknownHold: settings.unknownHold,
          },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || 'Google Places実行に失敗しました')
        setGpResult({ error: json.error })
        return
      }
      setGpResult(json)
      toast.success(`Google Places完了: 取得${json.fetched ?? 0} / HOT${json.hot ?? 0} / 投入${json.imported ?? 0}`)
      load(); loadRuns(); loadQlog()
    } catch (e) {
      toast.error('実行に失敗しました: ' + jpError(e))
    } finally {
      setGpRunning(false)
    }
  }

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

  // 自動取得設定をサーバー(app_config)へ保存 → 毎朝6:00のCronが参照
  async function saveAutoConfig() {
    setSavingCfg(true)
    try {
      await AppConfigApi.set('lead_auto', {
        autoFetch: settings.autoFetch,
        autoImport: settings.autoImport,
        areaPreset: settings.areaPreset,
        areas: parseList(settings.areas),
        industries: parseList(settings.industries),
        maxPerQuery: settings.maxPerQuery,
        maxQueriesPerDay: settings.maxQueriesPerDay,
        dailyCap: settings.dailyCap,
        rotation: settings.rotation,
        hotMaxReviews: settings.hotMaxReviews,
        warmMaxReviews: settings.warmMaxReviews,
        exclude100: settings.exclude100,
        unknownHold: settings.unknownHold,
      })
      toast.success('自動取得設定を保存しました（毎朝6:00のCronに反映）')
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setSavingCfg(false)
    }
  }

  // 都県別の巡回進捗（直近7日に実行済みのエリア数 / 全市区町村数）
  const rotationProgress = useMemo(() => {
    const totals = prefectureAreaTotals()
    const runByPref = new Map<string, Set<string>>()
    let todayQueries = 0
    const startToday = moment().startOf('day')
    for (const r of qlog) {
      if (r.area) {
        const set = runByPref.get(r.prefecture || 'その他') || new Set<string>()
        set.add(r.area)
        runByPref.set(r.prefecture || 'その他', set)
      }
      if (moment(r.last_run_at).isSameOrAfter(startToday)) todayQueries++
    }
    const perPref = totals.map((t) => ({ ...t, done: runByPref.get(t.label)?.size || 0 }))
    const allAreas = AREA_PRESETS.ittokensanken.areas.length
    const doneAreas = perPref.reduce((s, p) => s + p.done, 0)
    return { perPref, allAreas, doneAreas, remainingAreas: Math.max(0, allAreas - doneAreas), todayQueries, skipped7d: qlog.length }
  }, [qlog])

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
            <div className="grid gap-3 rounded-xl border bg-card p-3 md:grid-cols-2 lg:grid-cols-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.placesEnabled} onChange={(e) => saveSettings({ ...settings, placesEnabled: e.target.checked })} />
                Google Places実行を有効化
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.autoImport} onChange={(e) => saveSettings({ ...settings, autoImport: e.target.checked })} />
                HOTを自動でcasesへ投入
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.autoFetch} onChange={(e) => saveSettings({ ...settings, autoFetch: e.target.checked })} />
                毎朝6:00に自動取得（Cron）
              </label>
              <div className="flex items-center md:col-span-2 lg:col-span-2">
                <Button size="sm" variant="outline" onClick={saveAutoConfig} disabled={savingCfg}>
                  {savingCfg ? '保存中...' : '自動取得設定を保存（Cronに反映）'}
                </Button>
                <span className="ml-2 text-[10px] text-muted-foreground">この設定を毎朝6:00のCronに反映します（手動実行はこの保存に関係なく即時実行）。</span>
              </div>
              <div className="space-y-1">
                <Label>エリアプリセット</Label>
                <select
                  value={settings.areaPreset}
                  onChange={(e) => saveSettings({ ...settings, areaPreset: e.target.value })}
                  className="h-8 w-full rounded border border-input bg-card px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {AREA_PRESET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>1日あたり最大クエリ数</Label>
                <Input type="number" min={1} value={settings.maxQueriesPerDay} onChange={(e) => saveSettings({ ...settings, maxQueriesPerDay: Math.max(1, Number(e.target.value) || 1) })} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label>1クエリ最大取得件数（最大20）</Label>
                <Input type="number" min={1} max={20} value={settings.maxPerQuery} onChange={(e) => saveSettings({ ...settings, maxPerQuery: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label>1日あたりの投入上限</Label>
                <Input type="number" min={1} value={settings.dailyCap} onChange={(e) => saveSettings({ ...settings, dailyCap: Math.max(1, Number(e.target.value) || 1) })} className="h-8" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.rotation} onChange={(e) => saveSettings({ ...settings, rotation: e.target.checked })} />
                ローテーション（7日以内の同一クエリは再実行しない）
              </label>
              <div className="space-y-1">
                <Label>HOT判定の最大口コミ数</Label>
                <Input type="number" min={0} value={settings.hotMaxReviews} onChange={(e) => saveSettings({ ...settings, hotMaxReviews: Math.max(0, Number(e.target.value) || 0) })} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label>WARM判定の最大口コミ数</Label>
                <Input type="number" min={0} value={settings.warmMaxReviews} onChange={(e) => saveSettings({ ...settings, warmMaxReviews: Math.max(0, Number(e.target.value) || 0) })} className="h-8" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.exclude100} onChange={(e) => saveSettings({ ...settings, exclude100: e.target.checked })} />
                口コミ100件以上は自動除外
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.unknownHold} onChange={(e) => saveSettings({ ...settings, unknownHold: e.target.checked })} />
                口コミ件数不明はHOLD
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground lg:col-span-2">
                <input type="checkbox" checked readOnly />
                first_seen_at だけで新規扱いしない（常時ON）
              </label>
              <div className="space-y-1 lg:col-span-2">
                <Label>対象エリア{settings.areaPreset === 'custom' ? '（1行に1つ）' : '（プリセットで自動展開）'}</Label>
                {settings.areaPreset === 'custom' ? (
                  <Textarea value={settings.areas} onChange={(e) => saveSettings({ ...settings, areas: e.target.value })} rows={4} />
                ) : (
                  <div className="rounded border bg-muted/30 p-2 text-[10px] text-muted-foreground">
                    「{AREA_PRESET_OPTIONS.find((o) => o.value === settings.areaPreset)?.label}」の主要市区町村＋主要駅を自動展開します（毎日ローテーションで巡回）。細かいエリアの手入力は不要です。
                  </div>
                )}
              </div>
              <div className="space-y-1 lg:col-span-2">
                <Label>対象業種（1行に1つ）</Label>
                <Textarea value={settings.industries} onChange={(e) => saveSettings({ ...settings, industries: e.target.value })} rows={4} />
              </div>
              <div className="text-[10px] text-muted-foreground lg:col-span-4">
                ※検索クエリは「エリア × 業種」で生成されます（例:「東京都葛飾区 美容室」）。毎朝6:00の自動実行は Vercel Cron（/api/cron/auto-leads）で行います。
              </div>
            </div>
          )}

          {/* Google Places API パネル */}
          <div className="rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">Google Places API 連携（新規GBP）</span>
                {gpReachable === null ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">確認中…</span>
                ) : gpReachable === false ? (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-600">API未到達（関数未デプロイ?）</span>
                ) : gpConfigured ? (
                  <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-600">接続OK（キー設定済み）</span>
                ) : (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-600">未設定（GOOGLE_MAPS_API_KEY）</span>
                )}
                <button className="text-[10px] text-primary underline" onClick={checkGpStatus}>再確認</button>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => runPlaces(true)} disabled={gpRunning || gpConfigured === false} title="葛飾区×整体×5件で動作確認">
                  <Play className="h-3.5 w-3.5" />{gpRunning ? '実行中…' : 'テスト実行(葛飾区×整体×5)'}
                </Button>
                <Button size="sm" onClick={() => runPlaces(false)} disabled={gpRunning || gpConfigured !== true}>
                  <Play className="h-3.5 w-3.5" />{gpRunning ? '取得中…' : '取得・投入'}
                </Button>
              </div>
            </div>
            {gpReachable === false && (
              <div className="mt-2 rounded-md bg-amber-50 p-2 text-2xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                <span className="font-mono">/api/leads/google-places/run</span> に到達できません。Vercelに <span className="font-mono">api/</span> の関数がデプロイされているか（最新デプロイ・本番URLか）を確認してください。ローカル(<span className="font-mono">npm run dev</span>)では関数が無いため常にこの表示になります。
              </div>
            )}
            {gpReachable === true && gpConfigured === false && (
              <div className="mt-2 rounded-md bg-amber-50 p-2 text-2xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                関数は動作していますが、サーバーに <span className="font-mono">GOOGLE_MAPS_API_KEY</span> が見えていません（長さ {gpDiag?.keyLength ?? 0}）。Vercelの Environment Variables で <b>Production</b> に <span className="font-mono">GOOGLE_MAPS_API_KEY</span> を追加し（<span className="font-mono">VITE_</span>は付けない）、<b>本番デプロイをRedeploy</b>してから「再確認」を押してください。表示中のURLが本番ドメインか（プレビューでないか）もご確認ください。
              </div>
            )}
            {gpReachable === true && (
              <div className="mt-1.5 flex flex-wrap gap-2 text-[9px] text-muted-foreground">
                <span>診断:</span>
                <span>GOOGLE_MAPS_API_KEY 長さ {gpDiag?.keyLength ?? 0}</span>
                <span>SUPABASE_URL {gpDiag?.hasSupabaseUrl ? 'あり' : 'なし'}</span>
                <span>SERVICE_ROLE {gpDiag?.hasServiceRole ? 'あり' : 'なし'}</span>
              </div>
            )}
            {gpResult && !gpResult.ok && gpResult.error && (
              <div className="mt-2 rounded-md bg-red-50 p-2 text-2xs text-red-700 dark:bg-red-500/15 dark:text-red-300">
                実行エラー: {String(gpResult.error)}
              </div>
            )}
            {gpResult && gpResult.ok && (
              <div className="mt-2 space-y-2">
                {/* 段階別カウント */}
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded bg-muted px-1.5 py-0.5">クエリ {gpResult.queries ?? 0}</span>
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">API取得 {gpResult.fetched ?? 0}</span>
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT {gpResult.hot ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {gpResult.hold ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {gpResult.excluded ?? 0}</span>
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">DB保存 {gpResult.saved ?? 0}</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">案件投入 {gpResult.imported ?? 0}</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">重複 {gpResult.duplicate ?? 0}</span>
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話あり {gpResult.phoneYes ?? 0}</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">最古口コミ30日内 {gpResult.oldestRecent ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">電話なし {gpResult.noPhone ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">チェーン/施設内(深掘りせず除外) {gpResult.chainExcluded ?? 0}</span>
                  {Number(gpResult.error ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">APIエラー {gpResult.error}</span>}
                  {Number(gpResult.saveError ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">保存エラー {gpResult.saveError}</span>}
                </div>

                {/* 口コミ件数の内訳 */}
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="text-muted-foreground">口コミ内訳:</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">0〜5件 {gpResult.review0_5 ?? 0}</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">6〜15件 {gpResult.review6_15 ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">16〜99件 {gpResult.review16_99 ?? 0}</span>
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">100件以上(除外) {gpResult.review100 ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">不明 {gpResult.reviewUnknown ?? 0}</span>
                </div>

                {Array.isArray(gpResult.debug?.saveErrors) && gpResult.debug.saveErrors.length > 0 && (
                  <div className="rounded-md bg-red-50 p-2 text-[10px] text-red-700 dark:bg-red-500/15 dark:text-red-300">
                    <div className="font-bold">DB書き込みエラー（投入0の原因）:</div>
                    {gpResult.debug.saveErrors.map((m: string, i: number) => <div key={i} className="truncate" title={m}>・{m}</div>)}
                    <div className="mt-0.5">→ 多くは <span className="font-mono">migrations/2026-06-27_google_places.sql</span> 未実行（google_place_id / raw_payload 等の列不足）。SQLを実行してください。</div>
                  </div>
                )}

                {/* 使用した条件・ローテーション状況 */}
                {gpResult.debug && (
                  <div className="rounded-md border bg-muted/30 p-2 text-[10px]">
                    <div><b>エリアプリセット:</b> {AREA_PRESET_OPTIONS.find((o) => o.value === gpResult.debug.preset)?.label || gpResult.debug.preset}（エリア {(gpResult.debug.areas || []).length} / 業種 {(gpResult.debug.industries || []).length}）</div>
                    <div className="text-muted-foreground">
                      実行クエリ {gpResult.debug.ranQueries ?? 0}（新規オープン系 {gpResult.newOpenRan ?? 0} / 通常 {gpResult.normalRan ?? 0}）・
                      生成総数 {gpResult.debug.totalQueries ?? 0} ・ 7日内スキップ {gpResult.debug.recentSkipped ?? 0} ・ 残り {gpResult.debug.remaining ?? 0}
                    </div>
                    <div className="text-muted-foreground">
                      1クエリ{gpResult.debug.perQuery ?? '—'}件 ・ 推定API呼び出し {gpResult.debug.estApiCalls ?? '—'}回（検索{gpResult.debug.ranQueries ?? 0}＋詳細{gpResult.detailCalls ?? 0}）
                    </div>
                    {Array.isArray(gpResult.debug.queries) && (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-primary">実行クエリ一覧（{gpResult.debug.queries.length}）</summary>
                        <div className="mt-1 max-h-32 overflow-y-auto">
                          {gpResult.debug.queries.map((q: string, i: number) => <div key={i}>{i + 1}. {q}</div>)}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                {/* クエリ別の取得状況（0件の切り分け・クエリ別HOT/HOLD/EXCLUDED） */}
                {Array.isArray(gpResult.debug?.queryResults) && gpResult.debug.queryResults.length > 0 && (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full min-w-[560px] text-[10px]">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="p-1 text-left">検索クエリ</th>
                          <th className="p-1 text-center">HTTP</th>
                          <th className="p-1 text-center">places数</th>
                          <th className="p-1 text-center">HOT</th>
                          <th className="p-1 text-center">HOLD</th>
                          <th className="p-1 text-center">除外</th>
                          <th className="p-1 text-left">エラー</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gpResult.debug.queryResults.map((q: any, i: number) => (
                          <tr key={i} className="border-t">
                            <td className="p-1">{q.query}</td>
                            <td className={cn('p-1 text-center font-bold', q.status === 200 ? 'text-green-600' : 'text-red-600')}>{q.status}</td>
                            <td className="p-1 text-center">{q.placesLength}</td>
                            <td className="p-1 text-center font-bold text-red-600">{q.hot ?? 0}</td>
                            <td className="p-1 text-center">{q.hold ?? 0}</td>
                            <td className="p-1 text-center text-muted-foreground">{q.excluded ?? 0}</td>
                            <td className={cn('max-w-[220px] truncate p-1', q.error ? 'text-red-600' : 'text-muted-foreground')} title={q.error || ''}>{q.error || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 先頭1件のサンプル（なぜHOTにならないか） */}
                {gpResult.debug?.sample && (
                  <div className="rounded-md border bg-muted/30 p-2 text-[10px]">
                    <div className="font-bold">先頭サンプルの判定</div>
                    <div className="mt-0.5 grid gap-x-3 gap-y-0.5 md:grid-cols-2">
                      <div>店名: {gpResult.debug.sample.place?.name || '—'}</div>
                      <div>住所: {gpResult.debug.sample.place?.address || '—'}</div>
                      <div>電話: {gpResult.debug.sample.place?.nationalPhoneNumber || gpResult.debug.sample.place?.internationalPhoneNumber || '（なし）'}</div>
                      <div>primaryType: {gpResult.debug.sample.place?.primaryType || '—'}</div>
                      <div className="font-bold">口コミ数: {gpResult.debug.sample.place?.userRatingCount ?? '不明'}</div>
                      <div>最新口コミ日: {fmtDate(gpResult.debug.sample.classified?.latest_review_publish_time)}</div>
                      <div className="font-bold">一番古い口コミ日: {fmtDate(gpResult.debug.sample.classified?.oldest_review_publish_time)}</div>
                      <div className="font-bold">最古口コミから: {gpResult.debug.sample.classified?.oldest_review_days_ago ?? '—'}日前</div>
                      <div className="md:col-span-2">口コミ日付判定: {gpResult.debug.sample.classified?.review_newness_reason || '—'}</div>
                      <div>開店日(openingDate): {gpResult.debug.sample.place?.openingDate || gpResult.debug.sample.classified?.opening_date || '取得不可'}</div>
                      <div>RST初回発見からの日数: {gpResult.debug.sample.classified?.days_since_first_seen ?? 0}日</div>
                      <div>新規オープン系クエリ: <b>{String(gpResult.debug.sample.classified?.from_new_open_query)}</b></div>
                      <div>新規開業候補: <b>{String(gpResult.debug.sample.classified?.is_new_opening_candidate)}</b></div>
                      <div>温度: <b>{gpResult.debug.sample.classified?.lead_temperature}</b></div>
                      <div>到達スコア: {gpResult.debug.sample.classified?.owner_reachability_score}</div>
                      <div className="md:col-span-2">新規判定理由（HOT理由）: {gpResult.debug.sample.classified?.newness_reason || '—'}</div>
                      <div className="md:col-span-2">HOTにしなかった理由 / 除外理由: {gpResult.debug.sample.classified?.exclusion_reason || '—'}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* 自動取得（毎朝6:00 Cron）の巡回状況 */}
            <div className="mt-2 rounded-lg border bg-card p-3 text-[11px]">
              <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold">自動取得（毎朝6:00）</span>
                <span className={cn('rounded px-1.5 py-0.5 text-[10px]', settings.autoFetch ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-700')}>
                  {settings.autoFetch ? 'ON' : 'OFF'}
                </span>
                <span className="text-muted-foreground">次回実行予定: 毎朝6:00（JST）</span>
                <span className="text-muted-foreground">プリセット: {presetLabel(settings.areaPreset)}</span>
                {lastRun && <span className="text-muted-foreground">最終実行: {moment(lastRun.created_date).format('MM/DD HH:mm')}（{lastRun.status}）</span>}
              </div>
              <div className="mb-1 flex flex-wrap gap-1.5 text-[10px]">
                <span className="rounded bg-muted px-1.5 py-0.5">今日の実行クエリ {rotationProgress.todayQueries}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">直近7日 実行クエリ {rotationProgress.skipped7d}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">巡回済みエリア {rotationProgress.doneAreas} / {rotationProgress.allAreas}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">残り未巡回エリア {rotationProgress.remainingAreas}</span>
                {lastRun && <span className="rounded bg-muted px-1.5 py-0.5">前回 取得{lastRun.fetched_count}/HOT{lastRun.hot_count}/投入{lastRun.imported_count}/除外{lastRun.excluded_count}</span>}
              </div>
              <div className="grid grid-cols-2 gap-1 md:grid-cols-4">
                {rotationProgress.perPref.map((p) => {
                  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
                  return (
                    <div key={p.key} className="rounded border bg-muted/30 p-1.5">
                      <div className="flex justify-between"><span>{p.label}</span><span className="text-muted-foreground">{p.done}/{p.total}</span></div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted">
                        <div className="h-full rounded bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
              {lastRun?.error_message && <div className="mt-1 text-red-600">エラー: {lastRun.error_message}</div>}
              <div className="mt-1 text-[10px] text-muted-foreground">
                ※ 一都三県の全{rotationProgress.allAreas}市区町村を、1日最大{settings.maxQueriesPerDay}クエリでローテーション巡回（7日以内の同一クエリはスキップ）。HOTが0件の日もあります（厳格判定のため）。
              </div>
            </div>
          </div>

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
                    <th className="p-2 text-center">口コミ</th>
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
                        <div className="mt-0.5 flex flex-wrap gap-0.5">
                          {c.is_new_opening_candidate && <span className="rounded-sm bg-green-100 px-1 text-[9px] text-green-700 dark:bg-green-500/20 dark:text-green-300">新規開業候補</span>}
                          {c.from_new_open_query && <span className="rounded-sm bg-sky-100 px-1 text-[9px] text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">新規Q</span>}
                          {c.opening_date && <span className="rounded-sm bg-muted px-1 text-[9px] text-muted-foreground">開店{c.opening_date}</span>}
                          {c.days_since_first_seen != null && <span className="text-[9px] text-muted-foreground">発見{c.days_since_first_seen}日前</span>}
                        </div>
                      </td>
                      <td className="p-2 text-center">
                        {(() => {
                          const n = c.user_rating_count
                          if (n == null) return <span className="text-muted-foreground" title="口コミ件数不明">不明</span>
                          const cls = n <= 5 ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
                            : n <= 15 ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
                              : n < 100 ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
                                : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
                          const label = n <= 5 ? '新規候補' : n <= 15 ? '中' : n < 100 ? '既存寄り' : '人気既存'
                          return (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-bold">{n}</span>
                              <span className={cn('rounded-sm px-1 text-[8px]', cls)}>{label}</span>
                              {c.oldest_review_days_ago != null && (
                                <span className={cn('text-[8px]', c.oldest_review_is_recent ? 'text-green-600' : 'text-muted-foreground')} title={`最古口コミ ${fmtDate(c.oldest_review_publish_time)}`}>
                                  最古{c.oldest_review_days_ago}日前
                                </span>
                              )}
                            </div>
                          )
                        })()}
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
                      <td className="max-w-[300px] p-2">
                        {c.review_newness_reason && <div className="text-[10px] text-sky-700 dark:text-sky-300">口コミ日付: {c.review_newness_reason}</div>}
                        {c.newness_reason && <div className="text-[10px] text-green-700 dark:text-green-300">新規理由: {c.newness_reason}</div>}
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

import { useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import {
  Pencil, Trash2, Save, ExternalLink, MapPin, PhoneCall, CalendarClock,
  Copy, Search, Building2, Flag, AlertTriangle, ChevronLeft, ChevronRight, SkipForward, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CaseApi, CallLogApi, AuditApi, changeCaseStatus } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { SALES_REPS, STATUSES, PRIORITIES, PRIORITY_COLORS, statusColor } from '@/lib/constants'
import { mapUrl, googleSearchUrl, normalizeUrl, copyToClipboard, cn, jpError } from '@/lib/utils'
import type { Case, CallLog, Recall, Template } from '@/lib/types'

interface Props {
  selectedCase: Case | null
  callLogs: CallLog[]
  recalls: Recall[]
  templates: Template[]
  canWrite: boolean
  onEdit: () => void
  onAddCallLog: () => void
  onAddRecall: () => void
  onChanged: () => void
  onPrev?: () => void
  onNext?: () => void
  onNextUncalled?: () => void
  hasPrev?: boolean
  hasNext?: boolean
}

const NONE = '__none__'

/** ワンタップで記録できる定番アウトカム（状態変更＋コール履歴を自動記録） */
const QUICK_OUTCOMES = ['不在', '受付NG', '担当者不在', '資料送付', '折返し待ち', 'アポ獲得'] as const
/** アウトカム → 接触種別（KPIの接続/代表接触の判定に使用） */
const OUTCOME_CONTACT: Record<string, '接触' | '非接触'> = {
  不在: '非接触',
  受付NG: '非接触',
  担当者不在: '非接触',
  資料送付: '接触',
  折返し待ち: '接触',
  アポ獲得: '接触',
}

export default function CaseDetail({
  selectedCase, callLogs, recalls, templates, canWrite, onEdit, onAddCallLog, onAddRecall, onChanged,
  onPrev, onNext, onNextUncalled, hasPrev, hasNext,
}: Props) {
  const { user, displayName } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [salesRep, setSalesRep] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [quickMemo, setQuickMemo] = useState('')

  useEffect(() => {
    setSalesRep(selectedCase?.sales_rep ?? '')
    setStatus(selectedCase?.status ?? '')
    setQuickMemo('')
  }, [selectedCase])

  const lastCallAt = useMemo(() => {
    if (!selectedCase) return null
    const logs = callLogs.filter((l) => l.case_id === selectedCase.id).map((l) => l.call_at).sort()
    return logs.length ? logs[logs.length - 1] : null
  }, [callLogs, selectedCase])

  const nextRecallAt = useMemo(() => {
    if (!selectedCase) return null
    const future = recalls.filter((r) => r.case_id === selectedCase.id && !r.done).map((r) => r.target_at).sort()
    return future.length ? future[0] : null
  }, [recalls, selectedCase])

  if (!selectedCase) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        左の一覧から案件を選択してください
      </div>
    )
  }

  const c = selectedCase
  const dirty = salesRep !== (c.sales_rep ?? '') || status !== c.status

  async function copy(text: string | null | undefined, label: string) {
    if (!text) return
    const ok = await copyToClipboard(text)
    ok ? toast.success(`${label}をコピーしました`) : toast.error('コピーに失敗しました')
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (status !== c.status) {
        await changeCaseStatus(c, status, { sales_rep: salesRep || null, userId: user?.id ?? null, actorName: displayName })
      } else {
        await CaseApi.update(c.id, { sales_rep: salesRep || null })
      }
      toast.success('保存しました')
      onChanged()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setSaving(false)
    }
  }

  async function quickStatus(s: string) {
    try {
      const contact = OUTCOME_CONTACT[s] ?? '非接触'
      const changed = s !== c.status
      // コール履歴として記録（KPIのコール数/接続/代表接触に算入）
      await CallLogApi.create({
        case_id: c.id,
        case_name: c.name,
        call_at: new Date().toISOString(),
        contact_type: contact,
        result: s,
        summary: s,
        prev_status: changed ? c.status : null,
        next_status: changed ? s : null,
        sales_rep: c.sales_rep ?? null,
        created_by_id: user?.id ?? null,
      })
      if (changed) await CaseApi.update(c.id, { status: s })
      toast.success(`「${s}」を記録しました`)
      onChanged()
    } catch (e) {
      toast.error('記録に失敗しました: ' + jpError(e))
    }
  }

  async function setPriority(p: string) {
    try {
      await CaseApi.update(c.id, { priority: p || null })
      toast.success('優先度を更新しました')
      onChanged()
    } catch (e) {
      toast.error('更新に失敗しました: ' + jpError(e))
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: '案件を削除しますか？',
      body: `「${c.name}」を削除します。この操作は元に戻せません。`,
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await CaseApi.remove(c.id)
      AuditApi.log({ action: 'delete', entity: 'case', entity_id: c.id, entity_name: c.name, actor_id: user?.id ?? null, actor_name: displayName })
      toast.success('削除しました')
      onChanged()
    } catch (e) {
      toast.error('削除に失敗しました: ' + jpError(e))
    }
  }

  async function handleQuickMemo() {
    if (!quickMemo.trim()) return
    try {
      await CallLogApi.create({
        case_id: c.id, case_name: c.name, call_at: new Date().toISOString(),
        contact_type: '非接触', memo: quickMemo.trim(), summary: '通話メモ',
        sales_rep: c.sales_rep ?? null, created_by_id: user?.id ?? null,
      })
      setQuickMemo('')
      toast.success('通話メモを記録しました')
      onChanged()
    } catch (e) {
      toast.error('記録に失敗しました: ' + jpError(e))
    }
  }

  const memoTemplates = templates.filter((t) => t.category === 'memo').slice(0, 8)

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex border-b py-1.5">
      <div className="w-24 shrink-0 text-xs text-muted-foreground">{label}</div>
      <div className="flex-1 text-sm">{value || <span className="text-muted-foreground">—</span>}</div>
    </div>
  )

  const phoneCell = (p?: string | null) =>
    p ? (
      <span className="inline-flex items-center gap-1.5">
        <a href={`tel:${p}`} className="text-primary hover:underline">{p}</a>
        <button onClick={() => copy(p, '電話番号')} className="text-muted-foreground hover:text-foreground" title="コピー">
          <Copy className="h-3 w-3" />
        </button>
      </span>
    ) : null

  const urlCell = (label: string, url?: string | null) => {
    if (!url) return null
    const href = normalizeUrl(url)
    return (
      <span className="inline-flex items-center gap-1.5">
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
          {label}<ExternalLink className="h-3 w-3" />
        </a>
        <button onClick={() => copy(href, 'URL')} className="text-muted-foreground hover:text-foreground" title="コピー">
          <Copy className="h-3 w-3" />
        </button>
      </span>
    )
  }

  // データ品質の警告
  const warnings: string[] = []
  if (!c.phone1?.trim()) warnings.push('電話番号が未登録です')
  if (!c.address?.trim()) warnings.push('住所が未登録です')

  return (
    <div className="flex h-full flex-col">
      {/* ヘッダ */}
      <div className="flex items-start justify-between gap-2 border-b bg-card p-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-bold">{c.name}</span>
            <span className={cn('shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium', statusColor(c.status))}>{c.status}</span>
            {c.priority && (
              <span className={cn('flex items-center gap-0.5 rounded-sm border px-1.5 py-0.5 text-2xs', PRIORITY_COLORS[c.priority])}>
                <Flag className="h-2.5 w-2.5" />優先度{c.priority}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">{c.address}</div>
          {(c.tags ?? []).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {(c.tags ?? []).map((t) => (
                <span key={t} className="rounded-sm bg-sky-50 px-1.5 py-0.5 text-2xs text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">#{t}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" onClick={onPrev} disabled={!hasPrev} title="前の案件 (k)"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" onClick={onNext} disabled={!hasNext} title="次の案件 (j)"><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={onNextUncalled} title="次の未架電へ"><SkipForward className="h-3.5 w-3.5" />次の未架電</Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={!canWrite}><Pencil className="h-3.5 w-3.5" />編集</Button>
          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={!canWrite}><Trash2 className="h-3.5 w-3.5" />削除</Button>
        </div>
      </div>

      {/* データ品質警告 */}
      {warnings.length > 0 && (
        <div className="flex items-center gap-1.5 border-b bg-amber-50 px-3 py-1 text-2xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {warnings.join(' / ')}
        </div>
      )}

      {/* クイックアクション */}
      <div className="flex flex-wrap gap-1.5 border-b bg-muted/30 p-2">
        <Button size="sm" onClick={onAddCallLog} disabled={!canWrite}><PhoneCall className="h-3.5 w-3.5" />通話履歴を登録</Button>
        <Button variant="outline" size="sm" onClick={onAddRecall} disabled={!canWrite}><CalendarClock className="h-3.5 w-3.5" />再コール予定</Button>
        <a href={mapUrl(c.address, c.name)} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm"><MapPin className="h-3.5 w-3.5" />地図で開く</Button>
        </a>
        <a href={googleSearchUrl(c.name, c.address)} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm"><Search className="h-3.5 w-3.5" />Google検索</Button>
        </a>
        <a href={googleSearchUrl(c.name, c.address, 'Googleビジネスプロフィール')} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm"><Building2 className="h-3.5 w-3.5" />ビジネスPF</Button>
        </a>
      </div>

      {/* ワンタップ結果記録（状態変更＋履歴自動） */}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-1 border-b bg-card px-2 py-1.5">
          <span className="mr-0.5 flex items-center gap-0.5 text-2xs text-muted-foreground"><Zap className="h-3 w-3" />ワンタップ:</span>
          {QUICK_OUTCOMES.map((s) => (
            <button
              key={s}
              onClick={() => quickStatus(s)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-2xs transition-colors hover:bg-accent',
                c.status === s ? 'border-primary bg-primary/10 text-primary' : 'border-input text-foreground',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* 担当/ステータス/優先度 インライン編集 */}
      <div className="flex items-end gap-2 border-b bg-muted/30 p-2">
        <div className="flex-1 space-y-0.5">
          <div className="text-xs text-muted-foreground">営業担当</div>
          <Select value={salesRep || NONE} onValueChange={(v) => setSalesRep(v === NONE ? '' : v)} disabled={!canWrite}>
            <SelectTrigger><SelectValue placeholder="未割当" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未割当</SelectItem>
              {SALES_REPS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 space-y-0.5">
          <div className="text-xs text-muted-foreground">ステータス変更</div>
          <Select value={status} onValueChange={setStatus} disabled={!canWrite}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-24 space-y-0.5">
          <div className="text-xs text-muted-foreground">優先度</div>
          <Select value={c.priority || NONE} onValueChange={(v) => setPriority(v === NONE ? '' : v)} disabled={!canWrite}>
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未設定</SelectItem>
              {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={handleSave} disabled={!dirty || saving || !canWrite}><Save className="h-3.5 w-3.5" />{saving ? '...' : '保存'}</Button>
      </div>

      {/* 詳細 */}
      <div className="flex-1 overflow-y-auto p-3">
        {row('業種', c.industry)}
        {row('電話番号1', phoneCell(c.phone1))}
        {row('電話番号2', phoneCell(c.phone2))}
        {row('電話番号3', phoneCell(c.phone3))}
        {row('住所', c.address && (
          <span className="inline-flex items-center gap-1.5">
            {c.address}
            <button onClick={() => copy(c.address, '住所')} className="text-muted-foreground hover:text-foreground" title="コピー"><Copy className="h-3 w-3" /></button>
          </span>
        ))}
        {row('GoogleマップURL', urlCell('地図を開く', mapUrl(c.address, c.name)))}
        {row('公式サイト', (
          <div className="flex flex-wrap gap-3">
            {urlCell('HP1', c.hp1)}
            {urlCell('HP2', c.hp2)}
            {!c.hp1 && !c.hp2 && <span className="text-muted-foreground">—</span>}
          </div>
        ))}
        {row('Instagram', urlCell('Instagram', c.instagram))}
        {row('代表者名', c.representative)}
        {row('最終架電日', lastCallAt ? moment(lastCallAt).format('YYYY/MM/DD HH:mm') : null)}
        {row('次回再コール', nextRecallAt ? (
          <span className={cn(moment(nextRecallAt).isBefore(moment()) && 'font-bold text-red-600')}>
            {moment(nextRecallAt).format('YYYY/MM/DD HH:mm')}
          </span>
        ) : null)}
        {row('担当者', c.sales_rep)}
        {row('作成日', moment(c.created_date).format('YYYY/MM/DD HH:mm'))}
        {row('更新日', moment(c.updated_date).format('YYYY/MM/DD HH:mm'))}
        {row('メモ', <span className="whitespace-pre-wrap">{c.memo}</span>)}
        {c.source_urls && row('情報源', (
          <div className="space-y-0.5">
            {c.source_urls.split('\n').filter(Boolean).map((u, i) => (
              <div key={i}>{urlCell(u, u)}</div>
            ))}
          </div>
        ))}

        {/* 通話メモ クイック入力 + 定型文 */}
        {canWrite && (
        <div className="mt-3 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">通話メモ（即時記録）</div>
          {memoTemplates.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {memoTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setQuickMemo((m) => (m ? m + '\n' : '') + t.body)}
                  className="rounded-full border border-input bg-card px-2 py-0.5 text-2xs text-muted-foreground hover:bg-accent"
                  title={t.body}
                >
                  + {t.title}
                </button>
              ))}
            </div>
          )}
          <Textarea value={quickMemo} onChange={(e) => setQuickMemo(e.target.value)} rows={2} placeholder="例: 代表不在、夕方かけ直し依頼" />
          <div className="flex justify-end">
            <Button size="sm" onClick={handleQuickMemo} disabled={!quickMemo.trim()}>メモを記録</Button>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

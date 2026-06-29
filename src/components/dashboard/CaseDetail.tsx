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
import { STATUSES, PRIORITIES, PRIORITY_COLORS, statusColor, displayStatus } from '@/lib/constants'
import { useAssignableUsers, withCurrent } from '@/hooks/useAssignableUsers'
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

export default function CaseDetail({
  selectedCase, callLogs, recalls, canWrite, onEdit, onChanged,
  onPrev, onNext, onNextUncalled, hasPrev, hasNext,
}: Props) {
  const { user, displayName } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const { users: assignableUsers, names: assignableNames } = useAssignableUsers()
  const [salesRep, setSalesRep] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSalesRep(selectedCase?.sales_rep ?? '')
    setStatus(displayStatus(selectedCase?.status))
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
  const baseStatus = displayStatus(c.status)
  const dirty = salesRep !== (c.sales_rep ?? '') || status !== baseStatus
  // 現在値が統一一覧に無い旧ステータスは先頭に補完して選択可能にする
  const statusOptions = (STATUSES as readonly string[]).includes(status) ? [...STATUSES] : [status, ...STATUSES]

  async function copy(text: string | null | undefined, label: string) {
    if (!text) return
    const ok = await copyToClipboard(text)
    ok ? toast.success(`${label}をコピーしました`) : toast.error('コピーに失敗しました')
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (status !== (c.status ?? '')) {
        // ステータス変更（履歴/監査は changeCaseStatus 側で処理）
        await changeCaseStatus(c, status, { sales_rep: salesRep || null, userId: user?.id ?? null, actorName: displayName })
      } else {
        await CaseApi.update(c.id, { sales_rep: salesRep || null })
      }
      // 営業担当をユーザーID＋名前で保存（作成者/投入者は変更しない）。列が無い環境でも壊さない。
      try {
        const matched = assignableUsers.find((u) => u.name === salesRep)
        await CaseApi.update(c.id, { assigned_user_name: salesRep || null, assigned_user_id: matched?.id ?? null })
      } catch { /* 列未適用環境は無視 */ }
      toast.success('保存しました')
      onChanged()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setSaving(false)
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
            <span className={cn('shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium', statusColor(displayStatus(c.status)))}>{displayStatus(c.status)}</span>
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

      {/* 本体（縦スクロール） */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {/* ステータス変更カード */}
        <section className="rounded-lg border bg-muted/20 p-2.5">
          <div className="mb-2 text-xs font-bold text-muted-foreground">ステータス変更</div>
          <div className="flex flex-wrap items-end gap-2">
            {/* 左: 営業担当 → 右: ステータス（担当を確認してから状態変更する流れ） */}
            <div className="min-w-[150px] flex-1 space-y-0.5">
              <div className="text-2xs text-muted-foreground">営業担当</div>
              <Select value={salesRep || NONE} onValueChange={(v) => setSalesRep(v === NONE ? '' : v)} disabled={!canWrite}>
                <SelectTrigger><SelectValue placeholder="未割当" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>未割当</SelectItem>
                  {withCurrent(assignableNames, salesRep).map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[150px] flex-1 space-y-0.5">
              <div className="text-2xs text-muted-foreground">ステータス</div>
              <Select value={status} onValueChange={setStatus} disabled={!canWrite}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {statusOptions.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleSave} disabled={!dirty || saving || !canWrite}><Save className="h-3.5 w-3.5" />{saving ? '...' : '保存'}</Button>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">※ コール結果（不在・受付NG 等）は右の「コール履歴」から記録します。ステータスは案件の現在状態のみを表します。</p>
        </section>

        {/* 基本情報 */}
        <section className="rounded-lg border bg-card px-3 py-1">
          <div className="border-b py-1.5 text-xs font-bold text-muted-foreground">基本情報</div>
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
        {row('リスト作成者', c.created_by_name)}
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
        </section>
      </div>
    </div>
  )
}

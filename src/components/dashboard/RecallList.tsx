import { useMemo, useState } from 'react'
import moment from 'moment'
import { Plus, Pencil, Check, X, CheckCircle2, Phone, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RecallApi, CallLogApi, AuditApi } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { cn, jpError, roundTo15 } from '@/lib/utils'
import { statusColor } from '@/lib/constants'
import type { Case, Recall } from '@/lib/types'

interface Props {
  recalls: Recall[]
  cases: Case[]
  canWrite: boolean
  onAdd: () => void
  onSelectCase: (caseId: string) => void
  onChanged: () => void
}

type Section = { key: string; label: string; items: Recall[]; tone: 'danger' | 'today' | 'normal' }

export default function RecallList({ recalls, cases, canWrite, onAdd, onSelectCase, onChanged }: Props) {
  const { user, displayName } = useAuth()
  const toast = useToast()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [showDone, setShowDone] = useState(false)

  const caseById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases])

  const doneRecalls = useMemo(
    () => recalls.filter((r) => r.done).sort((a, b) => b.target_at.localeCompare(a.target_at)).slice(0, 30),
    [recalls],
  )

  const sections = useMemo<Section[]>(() => {
    const now = moment()
    const endToday = moment().endOf('day')
    const active = recalls
      .filter((r) => !r.done)
      .sort((a, b) => a.target_at.localeCompare(b.target_at))
    const overdue: Recall[] = []
    const today: Recall[] = []
    const future: Recall[] = []
    for (const r of active) {
      const t = moment(r.target_at)
      if (t.isBefore(now)) overdue.push(r)
      else if (t.isSameOrBefore(endToday)) today.push(r)
      else future.push(r)
    }
    return [
      { key: 'overdue', label: '期限切れ', items: overdue, tone: 'danger' },
      { key: 'today', label: '今日', items: today, tone: 'today' },
      { key: 'future', label: '明日以降', items: future, tone: 'normal' },
    ]
  }, [recalls])

  function startEdit(r: Recall) {
    setEditingId(r.id)
    setEditValue(moment(r.target_at).format('YYYY-MM-DDTHH:mm'))
  }

  async function saveEdit(id: string) {
    if (!editValue || !moment(editValue).isValid()) { toast.error('日時を入力してください'); return }
    try {
      await RecallApi.update(id, { target_at: moment(roundTo15(editValue)).toISOString() })
      setEditingId(null)
      toast.success('更新しました')
      onChanged()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    }
  }

  async function snooze(r: Recall, amount: number, unit: 'hours' | 'days') {
    const base = moment(r.target_at).isAfter(moment()) ? moment(r.target_at) : moment()
    try {
      await RecallApi.update(r.id, { target_at: base.add(amount, unit).toISOString() })
      toast.success('再コールを延期しました')
      onChanged()
    } catch (e) {
      toast.error('延期に失敗しました: ' + jpError(e))
    }
  }

  async function snoozeTomorrow(r: Recall) {
    try {
      await RecallApi.update(r.id, { target_at: moment().add(1, 'day').hour(9).minute(0).second(0).toISOString() })
      toast.success('明日の朝に延期しました')
      onChanged()
    } catch (e) {
      toast.error('延期に失敗しました: ' + jpError(e))
    }
  }

  async function complete(r: Recall) {
    try {
      await RecallApi.update(r.id, { done: true })
      // call_logs にも履歴を残す
      const c = caseById.get(r.case_id)
      await CallLogApi.create({
        case_id: r.case_id,
        case_name: r.case_name,
        call_at: new Date().toISOString(),
        contact_type: '非接触',
        result: '再コール予定 完了',
        memo: r.memo ?? null,
        summary: '再コール完了',
        sales_rep: c?.sales_rep ?? null,
        created_by_id: user?.id ?? null,
      })
      AuditApi.log({ action: 'recall_done', entity: 'recall', entity_id: r.id, entity_name: r.case_name, actor_id: user?.id ?? null, actor_name: displayName })
      toast.success('再コールを完了にしました')
      onChanged()
    } catch (e) {
      toast.error('更新に失敗しました: ' + jpError(e))
    }
  }

  const total = sections.reduce((n, s) => n + s.items.length, 0)

  return (
    <div className="flex h-full flex-col border-t">
      <div className="flex items-center justify-between border-b bg-card p-2">
        <span className="text-sm font-bold">
          再コール予定 {total > 0 && <span className="text-muted-foreground">({total})</span>}
        </span>
        <Button size="sm" onClick={onAdd} disabled={!canWrite}>
          <Plus className="h-3.5 w-3.5" />登録
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {total === 0 && (
          <div className="p-3 text-center text-xs text-muted-foreground">予定がありません</div>
        )}
        {sections.map((sec) =>
          sec.items.length === 0 ? null : (
            <div key={sec.key}>
              <div
                className={cn(
                  'sticky top-0 px-2 py-0.5 text-2xs font-bold',
                  sec.tone === 'danger' && 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
                  sec.tone === 'today' && 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
                  sec.tone === 'normal' && 'bg-muted text-muted-foreground',
                )}
              >
                {sec.label}（{sec.items.length}）
              </div>
              {sec.items.map((r) => {
                const c = caseById.get(r.case_id)
                const editing = editingId === r.id
                return (
                  <div
                    key={r.id}
                    className={cn(
                      'border-b px-2 py-1.5',
                      sec.tone === 'danger' && 'bg-red-50 dark:bg-red-500/10',
                    )}
                  >
                    {editing ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="datetime-local"
                          step={900}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="h-7 flex-1"
                        />
                        <button className="rounded p-1 text-green-600 hover:bg-green-100" onClick={() => saveEdit(r.id)}>
                          <Check className="h-4 w-4" />
                        </button>
                        <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => setEditingId(null)}>
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-start gap-1">
                        <button className="min-w-0 flex-1 text-left" onClick={() => onSelectCase(r.case_id)}>
                          <div className="flex items-center gap-1.5">
                            <span className={cn('text-2xs font-bold', sec.tone === 'danger' ? 'text-red-600' : 'text-foreground')}>
                              {moment(r.target_at).format('MM/DD HH:mm')}
                            </span>
                            {c && (
                              <span className={cn('rounded-sm px-1 text-[9px]', statusColor(c.status))}>{c.status}</span>
                            )}
                          </div>
                          <div className="truncate text-sm font-medium">{r.case_name}</div>
                          <div className="flex items-center gap-2">
                            {c?.phone1 && (
                              <a
                                href={`tel:${c.phone1}`}
                                className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Phone className="h-2.5 w-2.5" />{c.phone1}
                              </a>
                            )}
                            {c?.sales_rep && <span className="text-2xs text-primary">担当:{c.sales_rep}</span>}
                          </div>
                          {r.memo && <div className="truncate text-2xs text-muted-foreground">{r.memo}</div>}
                        </button>
                        {canWrite && (
                          <div className="flex shrink-0 flex-col items-end gap-0.5">
                            <div className="flex gap-0.5">
                              <button className="rounded border px-1 text-[9px] text-muted-foreground hover:bg-accent" onClick={() => snooze(r, 1, 'hours')} title="1時間後に延期">+1h</button>
                              <button className="rounded border px-1 text-[9px] text-muted-foreground hover:bg-accent" onClick={() => snoozeTomorrow(r)} title="明日の朝9時に延期">明日</button>
                              <button className="rounded border px-1 text-[9px] text-muted-foreground hover:bg-accent" onClick={() => snooze(r, 3, 'days')} title="3日後に延期">+3d</button>
                            </div>
                            <div className="flex gap-0.5">
                              <button className="rounded p-1 text-green-600 hover:bg-green-100" onClick={() => complete(r)} title="完了">
                                <CheckCircle2 className="h-4 w-4" />
                              </button>
                              <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => startEdit(r)} title="日時を編集">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ),
        )}

        {/* 完了済み */}
        {doneRecalls.length > 0 && (
          <div>
            <button
              className="flex w-full items-center gap-1 bg-muted px-2 py-0.5 text-2xs font-bold text-muted-foreground"
              onClick={() => setShowDone((v) => !v)}
            >
              {showDone ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              完了済み（{doneRecalls.length}）
            </button>
            {showDone &&
              doneRecalls.map((r) => (
                <button
                  key={r.id}
                  className="block w-full border-b px-2 py-1 text-left text-muted-foreground hover:bg-accent"
                  onClick={() => onSelectCase(r.case_id)}
                >
                  <span className="text-2xs line-through">{moment(r.target_at).format('MM/DD HH:mm')}</span>
                  <span className="ml-1 truncate text-xs">{r.case_name}</span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

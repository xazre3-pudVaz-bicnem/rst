import { useEffect, useState } from 'react'
import moment from 'moment'
import { Plus, Pencil, Trash2, ArrowRight, PhoneMissed, CalendarCheck, Handshake, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CallLogApi, VisitReportApi } from '@/lib/api'
import { CONTRACT_PRODUCTS } from '@/lib/constants'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { jpError } from '@/lib/utils'
import type { Case, CallLog, VisitReport } from '@/lib/types'

interface Props {
  callLogs: CallLog[]
  selectedCase: Case | null
  onAdd: () => void
  onAbsent: () => void
  onEdit: (log: CallLog) => void
  onChanged: () => void
  canWrite?: boolean
}

export default function CallLogPanel({ callLogs, selectedCase, onAdd, onAbsent, onEdit, onChanged, canWrite = true }: Props) {
  const toast = useToast()
  const confirm = useConfirm()
  const logs = selectedCase
    ? callLogs.filter((l) => l.case_id === selectedCase.id)
    : callLogs

  // 選択案件の訪問結果（成約/失注）をコール履歴の下に表示
  const [visits, setVisits] = useState<VisitReport[]>([])
  useEffect(() => {
    let alive = true
    if (!selectedCase) { setVisits([]); return }
    VisitReportApi.listByCase(selectedCase.id).then((v) => { if (alive) setVisits(v) }).catch(() => { if (alive) setVisits([]) })
    return () => { alive = false }
  }, [selectedCase, callLogs])

  async function handleDelete(id: string) {
    if (!(await confirm({ title: 'コール履歴を削除しますか？', confirmLabel: '削除する', danger: true }))) return
    try {
      await CallLogApi.remove(id)
      toast.success('削除しました')
      onChanged()
    } catch (e) {
      toast.error('削除に失敗しました: ' + jpError(e))
    }
  }

  return (
    <div className="flex h-full flex-col border-l">
      <div className="flex items-center justify-between gap-1 border-b bg-card p-2">
        <span className="text-sm font-bold">コール履歴 {logs.length > 0 && <span className="text-muted-foreground">({logs.length})</span>}</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onAbsent}
            disabled={!selectedCase || !canWrite}
            title="不在をコール履歴として記録（ステータスは変更しません）"
          >
            <PhoneMissed className="h-3.5 w-3.5" />不在
          </Button>
          <Button size="sm" onClick={onAdd} disabled={!selectedCase || !canWrite}>
            <Plus className="h-3.5 w-3.5" />登録
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {logs.length === 0 && (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {selectedCase ? '履歴はまだありません' : '案件を選択すると履歴が表示されます'}
          </div>
        )}
        {logs.map((l) => (
          <div key={l.id} className="mb-2 rounded-md border bg-card p-2 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-2xs font-medium text-muted-foreground">
                  {moment(l.call_at).format('MM/DD HH:mm')}
                </span>
                <Badge variant={l.contact_type === '接触' ? 'success' : 'secondary'}>
                  {l.contact_type}
                </Badge>
                {l.sales_rep && <Badge variant="outline">記録者: {l.sales_rep}</Badge>}
              </div>
              <div className="flex gap-0.5">
                <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => onEdit(l)} title="編集">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button className="rounded p-1 text-destructive hover:bg-destructive/10" onClick={() => handleDelete(l.id)} title="削除">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {!selectedCase && (
              <div className="mt-0.5 truncate text-2xs text-muted-foreground">{l.case_name}</div>
            )}

            {/* ステータス変更 */}
            {l.prev_status && l.next_status && (
              <div className="mt-1 flex items-center gap-1 text-2xs">
                <span className="rounded bg-muted px-1 py-0.5 text-muted-foreground">{l.prev_status}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="rounded bg-primary/10 px-1 py-0.5 font-medium text-primary">{l.next_status}</span>
              </div>
            )}

            {l.result && !l.result.startsWith('ステータス変更') && (
              <div className="mt-1 text-xs">
                <span className="text-muted-foreground">結果: </span>
                <span className="font-medium">{l.result}</span>
              </div>
            )}

            {l.summary && !l.summary.startsWith('ステータス') && (
              <div className="mt-1 whitespace-pre-wrap text-sm font-bold">{l.summary}</div>
            )}

            {l.memo && (
              <div className="mt-1 whitespace-pre-wrap text-sm text-foreground">{l.memo}</div>
            )}

            {l.appo_at && (
              <div className="mt-1 inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-2xs font-bold text-green-800 dark:bg-green-500/15 dark:text-green-300">
                <CalendarCheck className="h-3 w-3" />
                アポ日時: {moment(l.appo_at).format('MM/DD HH:mm')}
              </div>
            )}

            {l.next_recall_at && (
              <div className="mt-1 text-2xs text-orange-700">
                次回再コール: {moment(l.next_recall_at).format('MM/DD HH:mm')}
              </div>
            )}
          </div>
        ))}

        {/* 訪問結果（成約/失注） */}
        {visits.length > 0 && (
          <div className="mt-3 border-t pt-2">
            <div className="mb-1 text-2xs font-bold text-muted-foreground">訪問結果</div>
            {visits.map((v) => (
              <div key={v.id} className={`mb-1.5 rounded-md border p-2 ${v.result === '成約' ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10' : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10'}`}>
                <div className="flex items-center gap-1 text-xs font-bold">
                  {v.result === '成約' ? <Handshake className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                  <span className={v.result === '成約' ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'}>{v.result}</span>
                  {v.result === '失注' && v.lost_reason && <span className="text-2xs font-normal text-muted-foreground">（{v.lost_reason}）</span>}
                  <span className="ml-auto text-2xs font-normal text-muted-foreground">{moment(v.visited_at).format('MM/DD HH:mm')}</span>
                </div>
                {v.result === '成約' && (
                  <div className="mt-1 space-y-0.5 text-2xs">
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                      {CONTRACT_PRODUCTS.map((p) => {
                        const price = v[p.key as keyof VisitReport] as number | null | undefined
                        return price != null ? <span key={p.key} className="rounded bg-emerald-100 px-1 py-0.5 font-medium text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200">{p.label} ¥{price.toLocaleString()}</span> : null
                      })}
                    </div>
                    <div className="text-muted-foreground">
                      合計 <span className="font-bold text-foreground">¥{(v.total_price ?? 0).toLocaleString()}</span>
                      {v.contract_date && ` / 契約${moment(v.contract_date).format('YYYY/MM/DD')}`}
                      {v.min_contract_months != null && ` / 最低${v.min_contract_months}ヶ月`}
                      {v.payment_method && ` / ${v.payment_method}`}
                    </div>
                  </div>
                )}
                {v.memo && <div className="mt-1 whitespace-pre-wrap text-xs text-foreground">{v.memo}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

import moment from 'moment'
import { Plus, Pencil, Trash2, ArrowRight, PhoneMissed } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CallLogApi } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { jpError } from '@/lib/utils'
import type { Case, CallLog } from '@/lib/types'

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
              <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{l.memo}</div>
            )}

            {l.next_recall_at && (
              <div className="mt-1 text-2xs text-orange-700">
                次回再コール: {moment(l.next_recall_at).format('MM/DD HH:mm')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

import moment from 'moment'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CallLogApi } from '@/lib/api'
import type { Case, CallLog } from '@/lib/types'

interface Props {
  callLogs: CallLog[]
  selectedCase: Case | null
  onAdd: () => void
  onEdit: (log: CallLog) => void
  onChanged: () => void
}

export default function CallLogPanel({
  callLogs,
  selectedCase,
  onAdd,
  onEdit,
  onChanged,
}: Props) {
  const logs = selectedCase
    ? callLogs.filter((l) => l.case_id === selectedCase.id)
    : callLogs

  async function handleDelete(id: string) {
    if (!confirm('このコール履歴を削除しますか？')) return
    try {
      await CallLogApi.remove(id)
      onChanged()
    } catch (e) {
      alert('削除に失敗しました: ' + (e instanceof Error ? e.message : e))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b bg-card p-1.5">
        <span className="text-xs font-bold">コール履歴</span>
        <Button size="sm" onClick={onAdd} disabled={!selectedCase}>
          <Plus className="h-3 w-3" />
          登録
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {logs.length === 0 && (
          <div className="p-3 text-center text-2xs text-muted-foreground">
            履歴がありません
          </div>
        )}
        {logs.map((l) => (
          <div key={l.id} className="mb-1.5 rounded-md border bg-card p-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <span className="text-[9px] text-muted-foreground">
                  {moment(l.call_at).format('MM/DD HH:mm')}
                </span>
                <Badge variant={l.contact_type === '接触' ? 'success' : 'secondary'}>
                  {l.contact_type}
                </Badge>
                {l.result && <Badge variant="outline">{l.result}</Badge>}
              </div>
              <div className="flex gap-0.5">
                <button
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                  onClick={() => onEdit(l)}
                  title="編集"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  className="rounded p-0.5 text-destructive hover:bg-destructive/10"
                  onClick={() => handleDelete(l.id)}
                  title="削除"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
            {!selectedCase && (
              <div className="mt-0.5 truncate text-[9px] text-muted-foreground">
                {l.case_name}
              </div>
            )}
            {l.summary && (
              <div className="mt-0.5 whitespace-pre-wrap text-xs font-bold">
                {l.summary}
              </div>
            )}
            {l.memo && (
              <div className="mt-0.5 whitespace-pre-wrap text-2xs text-muted-foreground">
                {l.memo}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

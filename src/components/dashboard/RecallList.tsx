import { useState } from 'react'
import moment from 'moment'
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RecallApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Recall } from '@/lib/types'

interface Props {
  recalls: Recall[]
  onAdd: () => void
  onSelectCase: (caseId: string) => void
  onChanged: () => void
}

export default function RecallList({ recalls, onAdd, onSelectCase, onChanged }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  // 1日以上経過したものは非表示
  const visible = recalls.filter((r) =>
    moment(r.target_at).isAfter(moment().subtract(1, 'day')),
  )

  function startEdit(r: Recall) {
    setEditingId(r.id)
    setEditValue(moment(r.target_at).format('YYYY-MM-DDTHH:mm'))
  }

  async function saveEdit(id: string) {
    try {
      await RecallApi.update(id, { target_at: moment(editValue).toISOString() })
      setEditingId(null)
      onChanged()
    } catch (e) {
      alert('保存に失敗しました: ' + (e instanceof Error ? e.message : e))
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('この再コール予定を削除しますか？')) return
    try {
      await RecallApi.remove(id)
      onChanged()
    } catch (e) {
      alert('削除に失敗しました: ' + (e instanceof Error ? e.message : e))
    }
  }

  return (
    <div className="flex h-full flex-col border-t">
      <div className="flex items-center justify-between border-b bg-card p-1.5">
        <span className="text-xs font-bold">再コール予定</span>
        <Button size="sm" onClick={onAdd}>
          <Plus className="h-3 w-3" />
          登録
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <div className="p-2 text-center text-2xs text-muted-foreground">
            予定がありません
          </div>
        )}
        {visible.map((r) => {
          // 10分前(過去含む)で緊急扱い
          const isUrgent = moment(r.target_at).isBefore(moment().add(10, 'minutes'))
          const editing = editingId === r.id
          return (
            <div
              key={r.id}
              className={cn(
                'flex items-center gap-1 border-b px-2 py-1',
                isUrgent && 'bg-red-50',
              )}
            >
              {editing ? (
                <>
                  <Input
                    type="datetime-local"
                    step={900}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="h-6 flex-1"
                  />
                  <button
                    className="rounded p-0.5 text-green-600 hover:bg-green-100"
                    onClick={() => saveEdit(r.id)}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelectCase(r.case_id)}
                  >
                    <div
                      className={cn(
                        'text-[9px]',
                        isUrgent ? 'font-bold text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {moment(r.target_at).format('MM/DD HH:mm')}
                    </div>
                    <div className="truncate text-xs">{r.case_name}</div>
                  </button>
                  <button
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                    onClick={() => startEdit(r)}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    className="rounded p-0.5 text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(r.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

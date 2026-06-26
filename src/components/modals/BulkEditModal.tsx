import { useEffect, useState } from 'react'
import moment from 'moment'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { CaseApi, RecallApi, AuditApi, changeCaseStatus } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { STATUSES, SALES_REPS, PRIORITIES, TAG_PRESETS } from '@/lib/constants'
import { jpError } from '@/lib/utils'
import type { Case } from '@/lib/types'

type Action = 'status' | 'rep' | 'priority' | 'tag' | 'recall'

interface Props {
  open: boolean
  onClose: () => void
  cases: Case[]
  selectedIds: string[]
  onDone: () => void
}

const NONE = '__none__'

export default function BulkEditModal({ open, onClose, cases, selectedIds, onDone }: Props) {
  const { user, displayName } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [action, setAction] = useState<Action>('status')
  const [status, setStatus] = useState<string>(STATUSES[0])
  const [rep, setRep] = useState<string>(NONE)
  const [priority, setPriority] = useState<string>(PRIORITIES[0])
  const [tag, setTag] = useState<string>(TAG_PRESETS[0])
  const [recallAt, setRecallAt] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setRecallAt(moment().add(1, 'day').hour(10).minute(0).format('YYYY-MM-DDTHH:mm'))
  }, [open])

  const targets = cases.filter((c) => selectedIds.includes(c.id))

  async function apply() {
    if (targets.length === 0) return
    const ok = await confirm({
      title: '一括操作を実行しますか？',
      body: `選択中の ${targets.length} 件に適用します。`,
      confirmLabel: '実行する',
    })
    if (!ok) return
    setBusy(true)
    try {
      if (action === 'status') {
        for (const c of targets) {
          await changeCaseStatus(c, status, { userId: user?.id ?? null, actorName: displayName })
        }
      } else if (action === 'rep') {
        const value = rep === NONE ? null : rep
        await CaseApi.bulkUpdate(selectedIds, { sales_rep: value })
      } else if (action === 'priority') {
        await CaseApi.bulkUpdate(selectedIds, { priority })
      } else if (action === 'tag') {
        // 既存タグに追加（重複排除）
        for (const c of targets) {
          const next = Array.from(new Set([...(c.tags ?? []), tag]))
          await CaseApi.update(c.id, { tags: next })
        }
      } else if (action === 'recall') {
        for (const c of targets) {
          await RecallApi.create({
            case_id: c.id, case_name: c.name,
            target_at: moment(recallAt).toISOString(),
            created_by_id: user?.id ?? null,
          })
        }
      }
      AuditApi.log({
        action: 'bulk', entity: 'case',
        detail: `${action} を ${targets.length}件に適用`,
        actor_id: user?.id ?? null, actor_name: displayName,
      })
      toast.success(`${targets.length}件に適用しました`)
      onDone()
      onClose()
    } catch (e) {
      toast.error('一括操作に失敗しました: ' + jpError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>一括操作（{targets.length}件）</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>操作</Label>
            <Select value={action} onValueChange={(v) => setAction(v as Action)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="status">ステータス一括変更</SelectItem>
                <SelectItem value="rep">担当者一括変更</SelectItem>
                <SelectItem value="priority">優先度一括変更</SelectItem>
                <SelectItem value="tag">タグ一括付与</SelectItem>
                <SelectItem value="recall">再コール一括設定</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {action === 'status' && (
            <div className="space-y-1">
              <Label>変更後ステータス</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {action === 'rep' && (
            <div className="space-y-1">
              <Label>担当者</Label>
              <Select value={rep} onValueChange={setRep}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>未割当</SelectItem>
                  {SALES_REPS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {action === 'priority' && (
            <div className="space-y-1">
              <Label>優先度</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {action === 'tag' && (
            <div className="space-y-1">
              <Label>付与するタグ</Label>
              <Select value={tag} onValueChange={setTag}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TAG_PRESETS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {action === 'recall' && (
            <div className="space-y-1">
              <Label>再コール日時</Label>
              <Input type="datetime-local" step={900} value={recallAt} onChange={(e) => setRecallAt(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button onClick={apply} disabled={busy}>{busy ? '適用中...' : '適用する'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

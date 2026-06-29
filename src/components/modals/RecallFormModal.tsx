import { useEffect, useState } from 'react'
import moment from 'moment'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RecallApi } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { jpError, roundTo15 } from '@/lib/utils'
import type { Case } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  cases: Case[]
  defaultCaseId?: string | null
  onSaved: () => void
}

export default function RecallFormModal({
  open,
  onClose,
  cases,
  defaultCaseId,
  onSaved,
}: Props) {
  const { user } = useAuth()
  const toast = useToast()
  const [caseId, setCaseId] = useState('')
  const [targetAt, setTargetAt] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setCaseId(defaultCaseId ?? '')
      setTargetAt(moment().add(1, 'hour').format('YYYY-MM-DDTHH:mm'))
      setMemo('')
    }
  }, [open, defaultCaseId])

  async function handleSave() {
    if (!caseId) {
      toast.error('案件を選択してください')
      return
    }
    if (!targetAt) {
      toast.error('日時を入力してください')
      return
    }
    const c = cases.find((x) => x.id === caseId)
    if (!c) return
    setBusy(true)
    try {
      await RecallApi.create({
        case_id: c.id,
        case_name: c.name,
        target_at: moment(roundTo15(targetAt)).toISOString(),
        memo: memo || null,
        created_by_id: user?.id ?? null,
      })
      toast.success('再コール予定を登録しました')
      onSaved()
      onClose()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>再コール予定を登録</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>案件</Label>
            <Select value={caseId || undefined} onValueChange={setCaseId}>
              <SelectTrigger>
                <SelectValue placeholder="案件を選択" />
              </SelectTrigger>
              <SelectContent>
                {cases.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>予定日時</Label>
            <Input
              type="datetime-local"
              step={900}
              value={targetAt}
              onChange={(e) => setTargetAt(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>メモ（任意）</Label>
            <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} placeholder="例: 夕方に再架電" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            {busy ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import moment from 'moment'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { TravelExpenseApi, EmployeeApi } from '@/lib/api'
import { TRANSPORT_TYPES } from '@/lib/labor'
import { jpError } from '@/lib/utils'
import type { Case, TravelExpense } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  /** 申請対象の案件（案件詳細から開く。null なら案件なしの移動として登録） */
  selectedCase: Case | null
  /** 編集対象。null なら新規申請 */
  editing?: TravelExpense | null
  onSaved: () => void
}

const EMPTY = {
  expense_date: moment().format('YYYY-MM-DD'),
  transport_type: '電車' as string,
  departure: '',
  destination: '',
  round_trip: true,
  amount: '',
  purpose: '',
  memo: '',
}

export default function TravelExpenseModal({ open, onClose, selectedCase, editing, onSaved }: Props) {
  const toast = useToast()
  const { user, displayName } = useAuth()
  const [form, setForm] = useState({ ...EMPTY })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (editing) {
      setForm({
        expense_date: moment(editing.expense_date).format('YYYY-MM-DD'),
        transport_type: editing.transport_type || '電車',
        departure: editing.departure ?? '',
        destination: editing.destination ?? '',
        round_trip: editing.round_trip !== false,
        amount: editing.amount != null ? String(editing.amount) : '',
        purpose: editing.purpose ?? '',
        memo: editing.memo ?? '',
      })
    } else {
      // 訪問先＝案件の住所を初期値に（毎回打ち直さずに済む）
      setForm({ ...EMPTY, destination: selectedCase?.address ?? '' })
    }
  }, [open, editing, selectedCase])

  const set = (k: keyof typeof EMPTY, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  async function handleSave() {
    const amount = Number(String(form.amount).replace(/[^0-9.-]/g, ''))
    if (!form.expense_date) { toast.error('発生日を入力してください'); return }
    if (!Number.isFinite(amount) || amount <= 0) { toast.error('金額を入力してください'); return }
    setSaving(true)
    try {
      // 申請者の従業員レコード（労務側の集計キー）。ユーザー未紐付けなら employee_id なしで登録し、
      // 集計画面では「氏名」で束ねる（従業員同期後に紐付け直せる）。
      let employeeId: string | null = null
      let employeeName = displayName || ''
      if (user?.id) {
        try {
          const emps = await EmployeeApi.listDirectory()
          const me = emps.find((e) => e.user_id === user.id)
          if (me) { employeeId = me.id; employeeName = me.name || employeeName }
        } catch { /* 従業員マスタが読めなくても申請自体は通す */ }
      }
      const payload: Partial<TravelExpense> = {
        case_id: selectedCase?.id ?? null,
        case_name: selectedCase?.name ?? null,
        expense_date: form.expense_date,
        transport_type: form.transport_type || null,
        departure: form.departure.trim() || null,
        destination: form.destination.trim() || null,
        round_trip: form.round_trip,
        amount,
        purpose: form.purpose.trim() || null,
        memo: form.memo.trim() || null,
      }
      if (editing) {
        // 申請内容を直したら承認前の状態に戻す（承認済みの金額が黙って変わらないようにする）
        await TravelExpenseApi.update(editing.id, {
          ...payload,
          status: '申請中', approved_by: null, approved_at: null, rejected_reason: null,
        })
      } else {
        await TravelExpenseApi.create({
          ...payload,
          employee_id: employeeId, employee_name: employeeName || null,
          user_id: user?.id ?? null, created_by_id: user?.id ?? null,
          status: '申請中',
        })
      }
      toast.success(editing ? '交通費申請を更新しました' : '交通費を申請しました')
      onSaved()
      onClose()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {editing ? '交通費申請を編集' : '交通費を申請'}
            {selectedCase && <span className="ml-2 text-2xs font-normal text-muted-foreground">{selectedCase.name}</span>}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>発生日</Label>
              <Input type="date" value={form.expense_date} onChange={(e) => set('expense_date', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>金額（円）</Label>
              <Input inputMode="numeric" placeholder="例: 1240" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>交通手段</Label>
            <Select value={form.transport_type} onValueChange={(v) => set('transport_type', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TRANSPORT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>出発地</Label>
            <Input placeholder="例: 大宮駅" value={form.departure} onChange={(e) => set('departure', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>到着地<span className="ml-1 text-2xs font-normal text-muted-foreground">案件の住所を初期表示</span></Label>
            <Input value={form.destination} onChange={(e) => set('destination', e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={form.round_trip} onChange={(e) => set('round_trip', e.target.checked)} />
            往復（金額は往復の実費を入力）
          </label>
          <div className="space-y-1">
            <Label>訪問目的</Label>
            <Input placeholder="例: 初回訪問 / 商談 / 納品" value={form.purpose} onChange={(e) => set('purpose', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>メモ</Label>
            <Textarea rows={2} value={form.memo} onChange={(e) => set('memo', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? '保存中…' : '申請する'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

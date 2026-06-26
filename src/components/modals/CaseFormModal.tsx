import { useEffect, useState } from 'react'
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
import { CaseApi } from '@/lib/api'
import { INDUSTRIES, SALES_REPS, STATUSES } from '@/lib/constants'
import { normalizePhone, phoneDigits } from '@/lib/utils'
import type { Case } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  editingCase: Case | null
  existingCases: Case[]
  onSaved: () => void
}

const EMPTY = {
  name: '',
  address: '',
  phone1: '',
  phone2: '',
  phone3: '',
  industry: '',
  representative: '',
  status: '新規',
  sales_rep: '',
  hp1: '',
  hp2: '',
  instagram: '',
  source_urls: '',
  memo: '',
}

export default function CaseFormModal({
  open,
  onClose,
  editingCase,
  existingCases,
  onSaved,
}: Props) {
  const [form, setForm] = useState({ ...EMPTY })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (editingCase) {
      setForm({
        name: editingCase.name ?? '',
        address: editingCase.address ?? '',
        phone1: editingCase.phone1 ?? '',
        phone2: editingCase.phone2 ?? '',
        phone3: editingCase.phone3 ?? '',
        industry: editingCase.industry ?? '',
        representative: editingCase.representative ?? '',
        status: editingCase.status ?? '新規',
        sales_rep: editingCase.sales_rep ?? '',
        hp1: editingCase.hp1 ?? '',
        hp2: editingCase.hp2 ?? '',
        instagram: editingCase.instagram ?? '',
        source_urls: editingCase.source_urls ?? '',
        memo: editingCase.memo ?? '',
      })
    } else {
      setForm({ ...EMPTY })
    }
  }, [editingCase, open])

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  function blurPhone(k: 'phone1' | 'phone2' | 'phone3') {
    set(k, normalizePhone(form[k]))
  }

  async function handleSave() {
    if (!form.name.trim() || !form.address.trim() || !form.phone1.trim()) {
      alert('案件名・住所・電話番号1は必須です')
      return
    }

    // 電話番号重複チェック（既存案件の phone1/2/3 と照合）
    const newDigits = [form.phone1, form.phone2, form.phone3]
      .map(phoneDigits)
      .filter(Boolean)
    const dup = existingCases.find((c) => {
      if (editingCase && c.id === editingCase.id) return false
      const exist = [c.phone1, c.phone2, c.phone3].map(phoneDigits).filter(Boolean)
      return exist.some((e) => newDigits.includes(e))
    })
    if (dup) {
      alert(`電話番号が既存案件「${dup.name}」と重複しています。登録を中止しました。`)
      return
    }

    setBusy(true)
    try {
      const payload: Partial<Case> = {
        name: form.name.trim(),
        address: form.address.trim(),
        phone1: normalizePhone(form.phone1),
        phone2: normalizePhone(form.phone2) || null,
        phone3: normalizePhone(form.phone3) || null,
        industry: form.industry || null,
        representative: form.representative || null,
        status: form.status || '新規',
        sales_rep: form.sales_rep || null,
        hp1: form.hp1 || null,
        hp2: form.hp2 || null,
        instagram: form.instagram || null,
        source_urls: form.source_urls || null,
        memo: form.memo || null,
      }
      if (editingCase) {
        await CaseApi.update(editingCase.id, payload)
      } else {
        await CaseApi.create(payload)
      }
      onSaved()
      onClose()
    } catch (e) {
      alert('保存に失敗しました: ' + (e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editingCase ? '案件を編集' : '新規案件登録'}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2 space-y-1">
            <Label>案件名 *</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>住所 *</Label>
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>電話番号1 *</Label>
            <Input
              value={form.phone1}
              onChange={(e) => set('phone1', e.target.value)}
              onBlur={() => blurPhone('phone1')}
            />
          </div>
          <div className="space-y-1">
            <Label>電話番号2</Label>
            <Input
              value={form.phone2}
              onChange={(e) => set('phone2', e.target.value)}
              onBlur={() => blurPhone('phone2')}
            />
          </div>
          <div className="space-y-1">
            <Label>電話番号3</Label>
            <Input
              value={form.phone3}
              onChange={(e) => set('phone3', e.target.value)}
              onBlur={() => blurPhone('phone3')}
            />
          </div>
          <div className="space-y-1">
            <Label>業種</Label>
            <Select value={form.industry || undefined} onValueChange={(v) => set('industry', v)}>
              <SelectTrigger>
                <SelectValue placeholder="選択" />
              </SelectTrigger>
              <SelectContent>
                {INDUSTRIES.map((i) => (
                  <SelectItem key={i} value={i}>
                    {i}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>代表者名</Label>
            <Input
              value={form.representative}
              onChange={(e) => set('representative', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>営業担当</Label>
            <Select value={form.sales_rep || undefined} onValueChange={(v) => set('sales_rep', v)}>
              <SelectTrigger>
                <SelectValue placeholder="選択" />
              </SelectTrigger>
              <SelectContent>
                {SALES_REPS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label>ステータス</Label>
            <Select value={form.status} onValueChange={(v) => set('status', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>HP1</Label>
            <Input value={form.hp1} onChange={(e) => set('hp1', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>HP2</Label>
            <Input value={form.hp2} onChange={(e) => set('hp2', e.target.value)} />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>Instagram</Label>
            <Input value={form.instagram} onChange={(e) => set('instagram', e.target.value)} />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>情報源URL（改行区切り）</Label>
            <Textarea
              value={form.source_urls}
              onChange={(e) => set('source_urls', e.target.value)}
              rows={2}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>メモ</Label>
            <Textarea value={form.memo} onChange={(e) => set('memo', e.target.value)} rows={2} />
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

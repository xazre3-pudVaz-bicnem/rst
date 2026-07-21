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
import { CaseApi, AuditApi } from '@/lib/api'
import { INDUSTRIES, STATUSES, DEFAULT_STATUS } from '@/lib/constants'
import { useAssignableUsers, withCurrent } from '@/hooks/useAssignableUsers'
import { normalizePhone, phoneDigits, normalizeUrl, jpError } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
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
  status: DEFAULT_STATUS,
  sales_rep: '',
  hp1: '',
  hp2: '',
  instagram: '',
  business_hours: '',
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
  const { user, displayName } = useAuth()
  const { users: assignableUsers, names: assignableNames } = useAssignableUsers()
  const toast = useToast()
  const [form, setForm] = useState({ ...EMPTY })
  // 優先度・タグは新規登録フォームからは非表示。編集時の既存値は保持して再送する。
  const [priority, setPriority] = useState('')
  const [tags, setTags] = useState<string[]>([])
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
        status: editingCase.status ?? DEFAULT_STATUS,
        sales_rep: editingCase.sales_rep ?? '',
        hp1: editingCase.hp1 ?? '',
        hp2: editingCase.hp2 ?? '',
        instagram: editingCase.instagram ?? '',
        business_hours: editingCase.business_hours ?? '',
        source_urls: editingCase.source_urls ?? '',
        memo: editingCase.memo ?? '',
      })
      setPriority(editingCase.priority ?? '')
      setTags(editingCase.tags ?? [])
    } else {
      // 新規作成時は営業担当の初期値をログイン中ユーザー（作成者）にする
      setForm({ ...EMPTY, sales_rep: displayName || '' })
      setPriority('')
      setTags([])
    }
  }, [editingCase, open, displayName])

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  function blurPhone(k: 'phone1' | 'phone2' | 'phone3') {
    set(k, normalizePhone(form[k]))
  }

  async function handleSave() {
    // 必須項目のうち「実際に空のものだけ」を挙げる（全項目を並べると何が足りないか分からないため）
    const missing = [
      !form.name.trim() && '店舗名',
      !form.address.trim() && '住所',
      !form.phone1.trim() && '電話番号1',
      !form.industry && '業種',
    ].filter(Boolean)
    if (missing.length) {
      toast.error(`未入力: ${missing.join('・')}`)
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
      toast.error(`電話番号が既存案件「${dup.name}」と重複しています。登録を中止しました。`)
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
        status: form.status || DEFAULT_STATUS,
        sales_rep: form.sales_rep || null,
        hp1: normalizeUrl(form.hp1) || null,
        hp2: normalizeUrl(form.hp2) || null,
        instagram: normalizeUrl(form.instagram) || null,
        business_hours: form.business_hours.trim() || null,
        source_urls: form.source_urls.trim() || null,
        memo: form.memo.trim() || null,
        priority: priority || null,
        tags: tags.length ? tags : null,
      }
      if (editingCase) {
        // 編集ではリスト作成者(created_by_name)は変更しない
        await CaseApi.update(editingCase.id, payload)
        AuditApi.log({ action: 'update', entity: 'case', entity_id: editingCase.id, entity_name: payload.name, actor_id: user?.id ?? null })
      } else {
        // 作成者=固定 / 営業担当=初期値は作成者（後で変更可）。コア列のみで作成し、
        // user_id 系（未適用環境で無い可能性）は作成後に best-effort で付与し、insert失敗を防ぐ。
        const repName = payload.sales_rep || displayName || null
        const matched = assignableUsers.find((u) => u.name === repName)
        const created = await CaseApi.create({
          ...payload,
          sales_rep: repName,
          created_by_id: user?.id ?? null,
          created_by_name: displayName || null,
        })
        try {
          await CaseApi.update(created.id, {
            created_by_user_id: user?.id ?? null,
            created_by_user_name: displayName || null,
            assigned_user_id: matched?.id ?? user?.id ?? null,
            assigned_user_name: repName,
          })
        } catch { /* 列未適用環境は無視 */ }
        AuditApi.log({ action: 'create', entity: 'case', entity_id: created.id, entity_name: created.name, actor_id: user?.id ?? null })
      }
      toast.success(editingCase ? '案件を更新しました' : '案件を登録しました')
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
            <Label>業種 *</Label>
            <Select value={form.industry || undefined} onValueChange={(v) => set('industry', v)}>
              <SelectTrigger>
                <SelectValue placeholder="選択" />
              </SelectTrigger>
              <SelectContent>
                {/* 旧業種など一覧に無い現在値は先頭に補完して選択維持 */}
                {(form.industry && !(INDUSTRIES as readonly string[]).includes(form.industry) ? [form.industry, ...INDUSTRIES] : INDUSTRIES).map((i) => (
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
                {/* 営業担当候補はユーザー管理から。現在値が候補に無くても選択維持 */}
                {withCurrent(assignableNames, form.sales_rep).map((r) => (
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
            <Label>営業時間</Label>
            <Input value={form.business_hours} onChange={(e) => set('business_hours', e.target.value)} placeholder="例: 11:00〜22:00（不明なら空欄）" />
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

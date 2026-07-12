import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Search, Users, UserCheck, UserMinus, Trash2 } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { EmployeeApi, LaborAuditApi } from '@/lib/api'
import {
  laborPerms, employeeStatusColor,
  EMPLOYMENT_TYPES, EMPLOYEE_STATUSES, WORK_STYLES, ACCOUNT_TYPES, LABOR_ROLES,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee } from '@/lib/types'

// フォームの内部状態（number/date もすべて文字列で保持し、保存時に変換）
type FormState = Record<string, string>

const NUMBER_FIELDS = [
  'base_salary', 'hourly_wage', 'fixed_overtime_hours', 'fixed_overtime_pay',
  'standard_break_minutes', 'weekly_work_days', 'closing_day', 'payment_day',
] as const

const TEXT_FIELDS = [
  'employee_code', 'name', 'name_kana', 'email', 'phone', 'department', 'position',
  'standard_work_start', 'standard_work_end',
  'emergency_contact_name', 'emergency_contact_phone',
  'bank_name', 'branch_name', 'account_number', 'account_holder',
  'social_insurance_status', 'employment_insurance_status', 'memo',
] as const

const DATE_FIELDS = [
  'hire_date', 'resignation_date', 'trial_period_end_date',
  'contract_start_date', 'contract_end_date',
] as const

const SELECT_FIELDS = ['employment_type', 'status', 'work_style', 'role', 'account_type'] as const

function emptyForm(): FormState {
  const f: FormState = {}
  for (const k of [...NUMBER_FIELDS, ...TEXT_FIELDS, ...DATE_FIELDS, ...SELECT_FIELDS]) f[k] = ''
  return f
}

function toForm(emp: Employee): FormState {
  const f = emptyForm()
  for (const k of Object.keys(f)) {
    const v = (emp as unknown as Record<string, unknown>)[k]
    f[k] = v == null ? '' : String(v)
  }
  return f
}

/** フォーム → クリーンな Partial<Employee>（'' → null、number は Number 変換） */
function toPayload(f: FormState): Partial<Employee> {
  const p: Record<string, unknown> = {}
  for (const k of TEXT_FIELDS) p[k] = f[k].trim() === '' ? null : f[k].trim()
  for (const k of DATE_FIELDS) p[k] = f[k] === '' ? null : f[k]
  for (const k of SELECT_FIELDS) p[k] = f[k] === '' ? null : f[k]
  for (const k of NUMBER_FIELDS) {
    const raw = f[k].trim()
    const n = raw === '' ? null : Number(raw)
    p[k] = n == null || Number.isNaN(n) ? null : n
  }
  // name は必須なので空文字は許容しない（呼び出し側でガード）
  p.name = f.name.trim()
  return p as Partial<Employee>
}

const SELECT_NONE = '__none__' // 「未設定」を表す番兵（SelectItem は空文字不可）

export default function Employees() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('すべて')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const rows = await EmployeeApi.list()
      setEmployees(rows)
    } catch (e) {
      console.error('[Employees]', e)
      toast.error(e instanceof Error ? e.message : '従業員の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  // selfOnly（一般従業員）は自分のレコードのみ
  const scoped = useMemo(
    () => (perms.selfOnly ? employees.filter((e) => e.user_id === user?.id) : employees),
    [employees, perms.selfOnly, user?.id],
  )

  const counts = useMemo(() => {
    let active = 0, leave = 0, resigned = 0
    for (const e of scoped) {
      if (e.status === '在籍中') active++
      else if (e.status === '休職中') leave++
      else if (e.status === '退職済み') resigned++
    }
    return { active, leave, resigned }
  }, [scoped])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return scoped.filter((e) => {
      if (statusFilter !== 'すべて' && e.status !== statusFilter) return false
      if (!q) return true
      return [e.name, e.name_kana, e.employee_code, e.department]
        .some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [scoped, search, statusFilter])

  function openCreate() {
    setEditing(null)
    setForm({ ...emptyForm(), status: '在籍中' })
    setDialogOpen(true)
  }

  function openEdit(emp: Employee) {
    setEditing(emp)
    setForm(toForm(emp))
    setDialogOpen(true)
  }

  const setField = (k: string, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  async function handleSave() {
    if (!perms.canManage) return
    const payload = toPayload(form)
    if (!payload.name) { toast.error('氏名は必須です'); return }
    setSaving(true)
    try {
      if (editing) {
        await EmployeeApi.update(editing.id, payload)
        await LaborAuditApi.log({
          actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: editing.id,
          action: '従業員情報変更', target_table: 'employees', target_id: editing.id, after_data: payload,
        })
        toast.success('従業員情報を更新しました')
      } else {
        const created = await EmployeeApi.create(payload)
        await LaborAuditApi.log({
          actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: created.id,
          action: '従業員情報変更', target_table: 'employees', target_id: created.id, after_data: payload,
        })
        toast.success('従業員を追加しました')
      }
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!perms.canManage || !editing) return
    if (!window.confirm(`「${editing.name}」を削除します。よろしいですか？`)) return
    setSaving(true)
    try {
      await EmployeeApi.remove(editing.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: editing.id,
        action: '従業員情報変更', target_table: 'employees', target_id: editing.id,
        after_data: { deleted: true, name: editing.name },
      })
      toast.success('従業員を削除しました')
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <LaborLayout>
        <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Supabase が未設定です。.env を設定すると従業員マスタが表示されます。
        </div>
      </LaborLayout>
    )
  }

  return (
    <LaborLayout>
      <div className="mx-auto max-w-6xl space-y-3">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">従業員マスタ</h1>
            <p className="text-2xs text-muted-foreground">従業員情報の登録・編集</p>
          </div>
          {perms.canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />従業員を追加
            </Button>
          )}
        </div>

        {/* サマリー */}
        <div className="grid grid-cols-3 gap-2">
          <SummaryCard icon={<UserCheck className="h-4 w-4 text-white" />} color="bg-green-600" label="在籍中" value={counts.active} />
          <SummaryCard icon={<Users className="h-4 w-4 text-white" />} color="bg-amber-500" label="休職中" value={counts.leave} />
          <SummaryCard icon={<UserMinus className="h-4 w-4 text-white" />} color="bg-zinc-500" label="退職済み" value={counts.resigned} />
        </div>

        {/* 検索・フィルタ */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="氏名・カナ・従業員コード・部署で検索"
              className="pl-7"
            />
          </div>
          <div className="w-40">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="すべて">すべて</SelectItem>
                {EMPLOYEE_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">従業員一覧（{filtered.length}）</div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {employees.length === 0 ? '従業員が登録されていません' : '条件に一致する従業員がいません'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">従業員コード</th>
                    <th className="px-2 py-1.5 text-left font-medium">氏名</th>
                    <th className="px-2 py-1.5 text-left font-medium">雇用形態</th>
                    <th className="px-2 py-1.5 text-left font-medium">部署</th>
                    <th className="px-2 py-1.5 text-left font-medium">役職</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    <th className="px-2 py-1.5 text-left font-medium">入社日</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((emp) => (
                    <tr
                      key={emp.id}
                      onClick={() => openEdit(emp)}
                      className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                    >
                      <td className="px-2 py-1.5 text-muted-foreground">{emp.employee_code || '—'}</td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium">{emp.name}</div>
                        {emp.name_kana && <div className="text-2xs text-muted-foreground">{emp.name_kana}</div>}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{emp.employment_type || '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{emp.department || '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{emp.position || '—'}</td>
                      <td className="px-2 py-1.5">
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', employeeStatusColor(emp.status))}>
                          {emp.status || '—'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{emp.hire_date || '—'}</td>
                      {perms.canManage && (
                        <td className="px-2 py-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); openEdit(emp) }}
                          >
                            <Pencil className="h-3.5 w-3.5" />編集
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 作成・編集ダイアログ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? '従業員情報の編集' : '従業員を追加'}</DialogTitle>
          </DialogHeader>

          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
            {/* 基本情報 */}
            <FormSection title="基本情報">
              <TextField label="従業員コード" value={form.employee_code} onChange={(v) => setField('employee_code', v)} />
              <TextField label="氏名 *" value={form.name} onChange={(v) => setField('name', v)} required />
              <TextField label="氏名（カナ）" value={form.name_kana} onChange={(v) => setField('name_kana', v)} />
              <TextField label="メール" value={form.email} onChange={(v) => setField('email', v)} type="email" />
              <TextField label="電話番号" value={form.phone} onChange={(v) => setField('phone', v)} />
              <SelectField label="労務ロール" value={form.role} onChange={(v) => setField('role', v)} options={LABOR_ROLES} />
            </FormSection>

            {/* 雇用条件 */}
            <FormSection title="雇用条件">
              <SelectField label="雇用形態" value={form.employment_type} onChange={(v) => setField('employment_type', v)} options={EMPLOYMENT_TYPES} />
              <SelectField label="ステータス" value={form.status} onChange={(v) => setField('status', v)} options={EMPLOYEE_STATUSES} />
              <TextField label="部署" value={form.department} onChange={(v) => setField('department', v)} />
              <TextField label="役職" value={form.position} onChange={(v) => setField('position', v)} />
              <SelectField label="勤務形態" value={form.work_style} onChange={(v) => setField('work_style', v)} options={WORK_STYLES} />
              <DateField label="入社日" value={form.hire_date} onChange={(v) => setField('hire_date', v)} />
              <DateField label="退職日" value={form.resignation_date} onChange={(v) => setField('resignation_date', v)} />
            </FormSection>

            {/* 勤務時間 */}
            <FormSection title="勤務時間">
              {/* type="time" で HH:mm 以外の不正値（"9時"等）を排除し、遅刻/所定労働の split(':') 破損を防止 */}
              <TextField label="所定始業" type="time" value={form.standard_work_start} onChange={(v) => setField('standard_work_start', v)} placeholder="09:00" />
              <TextField label="所定終業" type="time" value={form.standard_work_end} onChange={(v) => setField('standard_work_end', v)} placeholder="18:00" />
              <NumberField label="休憩（分）" value={form.standard_break_minutes} onChange={(v) => setField('standard_break_minutes', v)} />
              <NumberField label="週所定労働日数" value={form.weekly_work_days} onChange={(v) => setField('weekly_work_days', v)} />
              <NumberField label="締め日" value={form.closing_day} onChange={(v) => setField('closing_day', v)} />
              <NumberField label="支払日" value={form.payment_day} onChange={(v) => setField('payment_day', v)} />
            </FormSection>

            {/* 契約 */}
            <FormSection title="契約">
              <DateField label="試用期間終了日" value={form.trial_period_end_date} onChange={(v) => setField('trial_period_end_date', v)} />
              <DateField label="契約開始日" value={form.contract_start_date} onChange={(v) => setField('contract_start_date', v)} />
              <DateField label="契約終了日" value={form.contract_end_date} onChange={(v) => setField('contract_end_date', v)} />
              <TextField label="社会保険" value={form.social_insurance_status} onChange={(v) => setField('social_insurance_status', v)} />
              <TextField label="雇用保険" value={form.employment_insurance_status} onChange={(v) => setField('employment_insurance_status', v)} />
            </FormSection>

            {/* 給与・振込 */}
            <FormSection title="給与・振込">
              <NumberField label="基本給" value={form.base_salary} onChange={(v) => setField('base_salary', v)} />
              <NumberField label="時給" value={form.hourly_wage} onChange={(v) => setField('hourly_wage', v)} />
              <NumberField label="固定残業時間" value={form.fixed_overtime_hours} onChange={(v) => setField('fixed_overtime_hours', v)} />
              <NumberField label="固定残業代" value={form.fixed_overtime_pay} onChange={(v) => setField('fixed_overtime_pay', v)} />
              <TextField label="銀行名" value={form.bank_name} onChange={(v) => setField('bank_name', v)} />
              <TextField label="支店名" value={form.branch_name} onChange={(v) => setField('branch_name', v)} />
              <SelectField label="口座種別" value={form.account_type} onChange={(v) => setField('account_type', v)} options={ACCOUNT_TYPES} />
              <TextField label="口座番号" value={form.account_number} onChange={(v) => setField('account_number', v)} />
              <TextField label="口座名義" value={form.account_holder} onChange={(v) => setField('account_holder', v)} />
            </FormSection>

            {/* 緊急連絡先・その他 */}
            <FormSection title="緊急連絡先・その他">
              <TextField label="緊急連絡先（氏名）" value={form.emergency_contact_name} onChange={(v) => setField('emergency_contact_name', v)} />
              <TextField label="緊急連絡先（電話）" value={form.emergency_contact_phone} onChange={(v) => setField('emergency_contact_phone', v)} />
              <div className="col-span-2 space-y-1">
                <Label>メモ</Label>
                <Textarea value={form.memo} onChange={(e) => setField('memo', e.target.value)} rows={3} />
              </div>
            </FormSection>
          </div>

          <DialogFooter>
            {editing && perms.canManage && (
              <Button variant="destructive" size="sm" onClick={handleDelete} disabled={saving} className="mr-auto">
                <Trash2 className="h-3.5 w-3.5" />削除
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>キャンセル</Button>
            {perms.canManage && (
              <Button size="sm" onClick={handleSave} disabled={saving || form.name.trim() === ''}>
                {saving ? '保存中…' : editing ? '更新' : '追加'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

// ============================================================
// 小さな表示・入力コンポーネント（同一ファイル内）
// ============================================================
function SummaryCard({ icon, color, label, value }: { icon: React.ReactNode; color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-card p-3">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', color)}>{icon}</div>
      <div className="min-w-0">
        <div className="text-2xs text-muted-foreground">{label}</div>
        <div className="text-lg font-bold">{value}</div>
      </div>
    </div>
  )
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-sm font-bold">{title}</div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  )
}

function TextField({ label, value, onChange, type, placeholder, required }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; required?: boolean
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input type={type} value={value} placeholder={placeholder} required={required} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input type="number" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: readonly string[]
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select
        value={value === '' ? SELECT_NONE : value}
        onValueChange={(v) => onChange(v === SELECT_NONE ? '' : v)}
      >
        <SelectTrigger><SelectValue placeholder="選択" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={SELECT_NONE}>未設定</SelectItem>
          {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Calculator, Plus, Pencil, Trash2, Users, CheckCircle2, ArrowDownCircle, ArrowUpCircle,
} from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { EmployeeApi, YearEndApi, LaborAuditApi } from '@/lib/api'
import { laborPerms, fmtYen, YEAR_END_STATUSES, procedureStatusColor } from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, YearEndAdjustment } from '@/lib/types'

const CURRENT_YEAR = 2026
const YEARS = [2024, 2025, 2026, 2027] as const
const DEFAULT_BASIC = 480000

/** 所得税 速算表（年間・課税所得ベース） */
function incomeTax(taxable: number): number {
  const t = Math.max(0, taxable)
  let base: number
  if (t <= 1_950_000) base = t * 0.05
  else if (t <= 3_300_000) base = t * 0.10 - 97_500
  else if (t <= 6_950_000) base = t * 0.20 - 427_500
  else if (t <= 9_000_000) base = t * 0.23 - 636_000
  else if (t <= 18_000_000) base = t * 0.33 - 1_536_000
  else if (t <= 40_000_000) base = t * 0.40 - 2_796_000
  else base = t * 0.45 - 4_796_000
  return Math.max(0, base)
}

/** 数値入力用のフォーム状態（文字列で保持） */
interface FormState {
  id: string | null
  employee_id: string
  total_income: string
  total_withholding: string
  social_insurance_deduction: string
  life_insurance_deduction: string
  earthquake_insurance_deduction: string
  spouse_deduction: string
  dependent_deduction: string
  basic_deduction: string
  housing_loan_deduction: string
  taxable_income: number | null
  calculated_tax: number | null
  settlement_amount: number | null
  status: string
  note: string
}

function emptyForm(): FormState {
  return {
    id: null,
    employee_id: '',
    total_income: '',
    total_withholding: '',
    social_insurance_deduction: '',
    life_insurance_deduction: '',
    earthquake_insurance_deduction: '',
    spouse_deduction: '',
    dependent_deduction: '',
    basic_deduction: String(DEFAULT_BASIC),
    housing_loan_deduction: '',
    taxable_income: null,
    calculated_tax: null,
    settlement_amount: null,
    status: YEAR_END_STATUSES[0],
    note: '',
  }
}

function formFromRecord(r: YearEndAdjustment): FormState {
  const s = (n?: number | null) => (n == null ? '' : String(n))
  return {
    id: r.id,
    employee_id: r.employee_id,
    total_income: s(r.total_income),
    total_withholding: s(r.total_withholding),
    social_insurance_deduction: s(r.social_insurance_deduction),
    life_insurance_deduction: s(r.life_insurance_deduction),
    earthquake_insurance_deduction: s(r.earthquake_insurance_deduction),
    spouse_deduction: s(r.spouse_deduction),
    dependent_deduction: s(r.dependent_deduction),
    basic_deduction: r.basic_deduction == null ? String(DEFAULT_BASIC) : String(r.basic_deduction),
    housing_loan_deduction: s(r.housing_loan_deduction),
    taxable_income: r.taxable_income ?? null,
    calculated_tax: r.calculated_tax ?? null,
    settlement_amount: r.settlement_amount ?? null,
    status: r.status ?? YEAR_END_STATUSES[0],
    note: r.note ?? '',
  }
}

/** 文字列 → 数値（空欄は0） */
function num(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export default function YearEnd() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [year, setYear] = useState<number>(CURRENT_YEAR)
  const [rows, setRows] = useState<YearEndAdjustment[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [list, emps] = await Promise.all([
        YearEndApi.listByYear(year),
        EmployeeApi.list(),
      ])
      setRows(list)
      setEmployees(emps)
    } catch (e) {
      console.error('[YearEnd]', e)
      toast.error(e instanceof Error ? e.message : '年末調整データの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [year, toast])

  useEffect(() => { load() }, [load])

  const empMap = useMemo(() => {
    const m = new Map<string, Employee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  const activeEmployees = useMemo(
    () => employees.filter((e) => e.status === '在籍中'),
    [employees],
  )

  const summary = useMemo(() => {
    let done = 0, refund = 0, collect = 0
    for (const r of rows) {
      if (r.status === '完了') done++
      const s = r.settlement_amount ?? 0
      if (s > 0) refund += s
      else if (s < 0) collect += -s
    }
    return { count: rows.length, done, refund, collect }
  }, [rows])

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => {
      const na = empMap.get(a.employee_id)?.name ?? ''
      const nb = empMap.get(b.employee_id)?.name ?? ''
      return na.localeCompare(nb, 'ja')
    }),
    [rows, empMap],
  )

  function openAdd() {
    setForm(emptyForm())
    setDialogOpen(true)
  }

  function openEdit(r: YearEndAdjustment) {
    setForm(formFromRecord(r))
    setDialogOpen(true)
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  /** 自動計算：課税所得・年税額・過不足額 */
  function handleCompute() {
    const totalIncome = num(form.total_income)
    const deductions =
      num(form.social_insurance_deduction) +
      num(form.life_insurance_deduction) +
      num(form.earthquake_insurance_deduction) +
      num(form.spouse_deduction) +
      num(form.dependent_deduction) +
      num(form.basic_deduction)
    const rawTaxable = Math.max(0, totalIncome - deductions)
    const taxable = Math.floor(rawTaxable / 1000) * 1000

    const baseTax = incomeTax(taxable)
    const afterLoan = Math.max(0, baseTax - num(form.housing_loan_deduction))
    // 復興特別所得税（2.1%）込み、100円未満切り捨て
    const calcTax = Math.floor((afterLoan * 1.021) / 100) * 100

    const settlement = num(form.total_withholding) - calcTax

    setForm((f) => ({
      ...f,
      taxable_income: taxable,
      calculated_tax: calcTax,
      settlement_amount: settlement,
    }))
    toast.success('自動計算しました')
  }

  async function handleSave() {
    if (!perms.canManage) return
    if (!form.employee_id) { toast.error('従業員を選択してください'); return }
    setSaving(true)
    try {
      const payload = {
        employee_id: form.employee_id,
        fiscal_year: year,
        total_income: num(form.total_income),
        total_withholding: num(form.total_withholding),
        social_insurance_deduction: num(form.social_insurance_deduction),
        life_insurance_deduction: num(form.life_insurance_deduction),
        earthquake_insurance_deduction: num(form.earthquake_insurance_deduction),
        spouse_deduction: num(form.spouse_deduction),
        dependent_deduction: num(form.dependent_deduction),
        basic_deduction: form.basic_deduction === '' ? DEFAULT_BASIC : num(form.basic_deduction),
        housing_loan_deduction: num(form.housing_loan_deduction),
        taxable_income: form.taxable_income,
        calculated_tax: form.calculated_tax,
        settlement_amount: form.settlement_amount,
        status: form.status,
        note: form.note.trim() || null,
      }
      const saved = await YearEndApi.upsert(payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        employee_id: form.employee_id,
        action: '年末調整更新',
        target_table: 'year_end_adjustments',
        target_id: saved.id,
        after_data: payload,
      })
      toast.success('年末調整データを保存しました')
      setDialogOpen(false)
      await load()
    } catch (e) {
      console.error('[YearEnd] save', e)
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!perms.canManage || !form.id) return
    if (!window.confirm('この年末調整データを削除しますか？')) return
    setSaving(true)
    try {
      await YearEndApi.remove(form.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        employee_id: form.employee_id,
        action: '年末調整更新',
        target_table: 'year_end_adjustments',
        target_id: form.id,
        after_data: { deleted: true, fiscal_year: year },
      })
      toast.success('削除しました')
      setDialogOpen(false)
      await load()
    } catch (e) {
      console.error('[YearEnd] delete', e)
      toast.error(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <LaborLayout>
        <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Supabase が未設定です。
        </div>
      </LaborLayout>
    )
  }

  if (perms.selfOnly) {
    return (
      <LaborLayout>
        <div className="mx-auto max-w-6xl space-y-3">
          <div>
            <h1 className="text-lg font-bold">年末調整</h1>
            <p className="text-2xs text-muted-foreground">従業員別の年末調整データ管理・年税額計算</p>
          </div>
          <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
            この画面は管理者向けです。閲覧権限がありません。
          </div>
        </div>
      </LaborLayout>
    )
  }

  const cards: { label: string; value: string; icon: React.ReactNode; color: string }[] = [
    { label: '対象者数', value: `${summary.count}名`, icon: <Users className="h-4 w-4 text-white" />, color: 'bg-slate-500' },
    { label: '完了数', value: `${summary.done}名`, icon: <CheckCircle2 className="h-4 w-4 text-white" />, color: 'bg-green-600' },
    { label: '還付合計', value: fmtYen(summary.refund), icon: <ArrowDownCircle className="h-4 w-4 text-white" />, color: 'bg-emerald-600' },
    { label: '徴収合計', value: fmtYen(summary.collect), icon: <ArrowUpCircle className="h-4 w-4 text-white" />, color: 'bg-rose-500' },
  ]

  return (
    <LaborLayout>
      <div className="mx-auto max-w-6xl space-y-4">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">年末調整</h1>
            <p className="text-2xs text-muted-foreground">従業員別の年末調整データ管理・年税額計算</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="年度" /></SelectTrigger>
              <SelectContent>
                {YEARS.map((y) => <SelectItem key={y} value={String(y)}>{y}年</SelectItem>)}
              </SelectContent>
            </Select>
            {perms.canManage && (
              <Button size="sm" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" />対象者を追加
              </Button>
            )}
          </div>
        </div>

        {/* サマリーカード */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {cards.map((c) => (
            <div key={c.label} className="flex items-center gap-2.5 rounded-lg border bg-card p-2.5">
              <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', c.color)}>{c.icon}</div>
              <div className="min-w-0">
                <div className="text-2xs text-muted-foreground">{c.label}</div>
                <div className="text-base font-bold">{c.value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">対象者一覧（{year}年）</div>
          <div className="max-h-[34rem] overflow-auto">
            {loading ? (
              <div className="p-3"><SkeletonRows count={8} /></div>
            ) : sortedRows.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">対象者が登録されていません</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    <th className="px-2 py-1.5 text-left font-medium">給与総額</th>
                    <th className="px-2 py-1.5 text-left font-medium">課税所得</th>
                    <th className="px-2 py-1.5 text-left font-medium">年税額</th>
                    <th className="px-2 py-1.5 text-left font-medium">過不足</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => {
                    const s = r.settlement_amount ?? 0
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                        <td className="px-2 py-1.5 font-medium">{empMap.get(r.employee_id)?.name ?? '—'}</td>
                        <td className="px-2 py-1.5">
                          <Badge className={cn('border-transparent', procedureStatusColor(r.status))}>
                            {r.status ?? '未着手'}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5">{fmtYen(r.total_income)}</td>
                        <td className="px-2 py-1.5">{fmtYen(r.taxable_income)}</td>
                        <td className="px-2 py-1.5">{fmtYen(r.calculated_tax)}</td>
                        <td className="px-2 py-1.5">
                          {s > 0 ? (
                            <span className="font-medium text-green-600 dark:text-green-400">還付 {fmtYen(s)}</span>
                          ) : s < 0 ? (
                            <span className="font-medium text-rose-600 dark:text-rose-400">徴収 {fmtYen(-s)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        {perms.canManage && (
                          <td className="px-2 py-1.5">
                            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => openEdit(r)}>
                              <Pencil className="h-3 w-3" />編集
                            </Button>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* 追加/編集ダイアログ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? '年末調整を編集' : '対象者を追加'}（{year}年）</DialogTitle>
          </DialogHeader>

          <div className="max-h-[65vh] space-y-3 overflow-auto pr-1">
            {/* 従業員 */}
            <div className="space-y-1">
              <label className="text-2xs font-medium text-muted-foreground">従業員</label>
              <Select
                value={form.employee_id || undefined}
                onValueChange={(v) => setField('employee_id', v)}
                disabled={!!form.id}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 金額入力 */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {([
                ['total_income', '給与総額'],
                ['total_withholding', '源泉徴収税額'],
                ['social_insurance_deduction', '社会保険料控除'],
                ['life_insurance_deduction', '生命保険料控除'],
                ['earthquake_insurance_deduction', '地震保険料控除'],
                ['spouse_deduction', '配偶者控除'],
                ['dependent_deduction', '扶養控除'],
                ['basic_deduction', '基礎控除'],
                ['housing_loan_deduction', '住宅ローン控除'],
              ] as [keyof FormState, string][]).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <label className="text-2xs font-medium text-muted-foreground">{label}</label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={form[key] as string}
                    onChange={(e) => setField(key, e.target.value as FormState[typeof key])}
                    className="h-8 text-xs"
                  />
                </div>
              ))}
            </div>

            {/* 自動計算 */}
            <div className="rounded-lg border bg-muted/30 p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-2xs font-bold text-muted-foreground">年税額計算</span>
                <Button variant="outline" size="sm" className="h-7" onClick={handleCompute}>
                  <Calculator className="h-3.5 w-3.5" />自動計算
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <label className="text-2xs font-medium text-muted-foreground">課税所得</label>
                  <Input readOnly disabled value={form.taxable_income == null ? '' : fmtYen(form.taxable_income)} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <label className="text-2xs font-medium text-muted-foreground">年税額</label>
                  <Input readOnly disabled value={form.calculated_tax == null ? '' : fmtYen(form.calculated_tax)} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <label className="text-2xs font-medium text-muted-foreground">過不足額</label>
                  <Input
                    readOnly
                    disabled
                    value={
                      form.settlement_amount == null
                        ? ''
                        : form.settlement_amount >= 0
                          ? `還付 ${fmtYen(form.settlement_amount)}`
                          : `徴収 ${fmtYen(-form.settlement_amount)}`
                    }
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            </div>

            {/* ステータス */}
            <div className="space-y-1">
              <label className="text-2xs font-medium text-muted-foreground">ステータス</label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {YEAR_END_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* 備考 */}
            <div className="space-y-1">
              <label className="text-2xs font-medium text-muted-foreground">備考</label>
              <Textarea
                value={form.note}
                onChange={(e) => setField('note', e.target.value)}
                rows={2}
                className="text-xs"
              />
            </div>
          </div>

          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            <div>
              {form.id && perms.canManage && (
                <Button variant="destructive" size="sm" onClick={handleDelete} disabled={saving}>
                  <Trash2 className="h-3.5 w-3.5" />削除
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>
                キャンセル
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !perms.canManage}>
                保存
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

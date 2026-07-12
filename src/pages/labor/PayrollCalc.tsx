import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Calculator, Download, Lock, LockOpen, CheckCircle2, RefreshCw, Wallet, Info,
} from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import {
  EmployeeApi, AttendanceApi, LeaveRequestApi, PayrollRunApi, PayslipApi, LaborAuditApi,
} from '@/lib/api'
import { laborPerms, fmtYen, fmtMinutes, monthStr, procedureStatusColor, toCsv, downloadCsv } from '@/lib/labor'
import { calcPayslip, recalcDeductions, ratesForMonth, hourlyRateOf } from '@/lib/payrollCalc'
import { cn } from '@/lib/utils'
import type { Employee, AttendanceRecord, LeaveRequest, PayrollRun, Payslip } from '@/lib/types'

/** 数値入力の安全パース */
function num(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/** 率 → パーセント表記（例 0.04925 → "4.925%"） */
function pct(n: number): string {
  return `${(n * 100).toFixed(3)}%`
}

/** 従業員ごとの当月勤怠を集計し PayrollInput を作る */
function aggregate(
  emp: Employee,
  month: string,
  records: AttendanceRecord[],
  leaves: LeaveRequest[],
): Parameters<typeof calcPayslip>[2] {
  let workMinutes = 0, overtimeMinutes = 0, lateNightMinutes = 0, holidayWorkMinutes = 0
  let workDays = 0, absentDays = 0
  for (const r of records) {
    if (r.employee_id !== emp.id) continue
    workMinutes += r.work_minutes ?? 0
    overtimeMinutes += r.overtime_minutes ?? 0
    lateNightMinutes += r.late_night_minutes ?? 0
    holidayWorkMinutes += r.holiday_work_minutes ?? 0
    if (r.clock_in_at) workDays++
    if (r.status === '欠勤') absentDays++
  }
  let paidLeaveDays = 0
  for (const lv of leaves) {
    if (lv.employee_id !== emp.id) continue
    if (lv.status !== 'approved') continue
    if (lv.leave_type !== '有給' && lv.leave_type !== '半休') continue
    if (lv.start_date?.slice(0, 7) !== month) continue
    paidLeaveDays += lv.days ?? 0
  }
  return {
    workMinutes, overtimeMinutes, lateNightMinutes, holidayWorkMinutes,
    workDays, absentDays, paidLeaveDays,
    commuteAllowance: 0, positionAllowance: 0, otherAllowance: 0,
    longTermCareApplicable: false,
  }
}

interface EditState {
  commute_allowance: string
  position_allowance: string
  other_allowance: string
  resident_tax: string
  other_deduction: string
  note: string
}

export default function PayrollCalc() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)
  const [searchParams] = useSearchParams()

  // 勤怠画面などから ?month=YYYY-MM で対象月を引き継ぐ（不正値は当月にフォールバック）
  const [month, setMonth] = useState(() => {
    const m = searchParams.get('month')
    return m && /^\d{4}-\d{2}$/.test(m) ? m : monthStr()
  })
  const [employees, setEmployees] = useState<Employee[]>([])
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [leaves, setLeaves] = useState<LeaveRequest[]>([])
  const [run, setRun] = useState<PayrollRun | null>(null)
  const [payslips, setPayslips] = useState<Payslip[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)

  const [selected, setSelected] = useState<Payslip | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      if (perms.selfOnly) {
        const emps = await EmployeeApi.list()
        setEmployees(emps)
        const me = emps.find((e) => e.user_id && e.user_id === user?.id)
        setPayslips(me ? (await PayslipApi.listByEmployee(me.id)) : [])
        setRun(null)
        setRecords([])
        setLeaves([])
      } else {
        const [emps, recs, lvs, r, slips] = await Promise.all([
          EmployeeApi.list(),
          AttendanceApi.listByMonth(month),
          LeaveRequestApi.list(),
          PayrollRunApi.getByMonth(month),
          PayslipApi.listByMonth(month),
        ])
        setEmployees(emps)
        setRecords(recs)
        setLeaves(lvs)
        setRun(r)
        setPayslips(slips)
      }
    } catch (e) {
      console.error('[PayrollCalc]', e)
      toast.error(e instanceof Error ? e.message : '給与データの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [month, perms.selfOnly, user?.id, toast])

  useEffect(() => { load() }, [load])

  const empById = useMemo(() => {
    const m = new Map<string, Employee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  const runStatus = run?.status ?? '未計算'
  // 確定・締め済みは上書き禁止（締めは再計算そのものを不可、確定は確認のうえ未確定へ）
  const locked = runStatus === '確定' || runStatus === '締め'
  // 対象月に適用する料率セット（注意バナーで動的表示）
  const rates = useMemo(() => ratesForMonth(month), [month])

  const slipByEmp = useMemo(() => {
    const m = new Map<string, Payslip>()
    for (const s of payslips) m.set(s.employee_id, s)
    return m
  }, [payslips])

  const sortedSlips = useMemo(() => {
    return [...payslips].sort((a, b) => {
      const ea = empById.get(a.employee_id), eb = empById.get(b.employee_id)
      return (ea?.employee_code ?? '').localeCompare(eb?.employee_code ?? '', 'ja')
        || (ea?.name ?? '').localeCompare(eb?.name ?? '', 'ja')
    })
  }, [payslips, empById])

  const totals = useMemo(() => sortedSlips.reduce((acc, s) => ({
    gross: acc.gross + (s.gross_pay ?? 0),
    deduction: acc.deduction + (s.total_deduction ?? 0),
    net: acc.net + (s.net_pay ?? 0),
  }), { gross: 0, deduction: 0, net: 0 }), [sortedSlips])

  // --- 給与計算を実行 ---
  async function handleRun() {
    if (!perms.canManage || running) return
    // 締め済みは再計算不可。確定済みは確認のうえ未確定へ戻す。
    if (runStatus === '締め') { toast.error('締め済みです。締め解除してから再計算してください'); return }
    if (runStatus === '確定'
      && !window.confirm('確定済みの明細を再計算して未確定に戻します。よろしいですか？')) return
    const active = employees.filter((e) => e.status === '在籍中')
    // 勤怠0件ガード：一時エラー等で0件のまま満額/0円明細を正規データとして保存する事故を防ぐ
    if (records.length === 0 && active.length > 0
      && !window.confirm('この月の勤怠データが0件です。このまま計算しますか？（月給者は満額・時給者は0円で計算されます）')) return
    setRunning(true)
    try {
      for (const emp of active) {
        const prev = slipByEmp.get(emp.id)
        const input = aggregate(emp, month, records, leaves)
        // 既存明細の手入力（手当・住民税・その他控除・介護該当）を再計算後も引き継ぐ
        input.commuteAllowance = prev?.commute_allowance ?? 0
        input.positionAllowance = prev?.position_allowance ?? 0
        input.otherAllowance = prev?.other_allowance ?? 0
        input.residentTax = prev?.resident_tax ?? 0
        input.otherDeduction = prev?.other_deduction ?? 0
        // 介護保険該当は birth_date 未管理のため、既存明細に控除があれば維持する
        input.longTermCareApplicable = (prev?.long_term_care_insurance ?? 0) > 0
        const draft = calcPayslip(emp, month, input)
        draft.note = prev?.note ?? null // 備考も維持
        await PayslipApi.upsert(draft)
      }
      const saved = await PayrollRunApi.upsert({
        target_month: month,
        status: '計算済',
        run_by: user?.id ?? null,
        run_at: new Date().toISOString(),
        title: `${month} 給与`,
      })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: '給与計算実行',
        target_table: 'payslips',
        after_data: { month, employee_count: active.length, run_id: saved.id },
      })
      toast.success(`給与計算を実行しました（${active.length}名）`)
      await load()
    } catch (e) {
      console.error('[PayrollCalc] run', e)
      toast.error(e instanceof Error ? e.message : '給与計算に失敗しました')
    } finally {
      setRunning(false)
    }
  }

  // --- 確定 / 締め ---
  async function handleConfirm() {
    if (!perms.canManage || !run || busy) return
    setBusy(true)
    try {
      await PayrollRunApi.update(run.id, { status: '確定' })
      for (const s of payslips) await PayslipApi.update(s.id, { status: '確定' })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: '給与確定',
        target_table: 'payslips',
        after_data: { month, run_id: run.id },
      })
      toast.success('給与を確定しました')
      await load()
    } catch (e) {
      console.error('[PayrollCalc] confirm', e)
      toast.error(e instanceof Error ? e.message : '確定に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  async function handleClose() {
    if (!perms.canManage || !run || busy) return
    setBusy(true)
    try {
      await PayrollRunApi.update(run.id, { status: '締め', closed_at: new Date().toISOString() })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: '給与締め',
        target_table: 'payslips',
        after_data: { month, run_id: run.id },
      })
      toast.success('給与を締めました')
      await load()
    } catch (e) {
      console.error('[PayrollCalc] close', e)
      toast.error(e instanceof Error ? e.message : '締めに失敗しました')
    } finally {
      setBusy(false)
    }
  }

  // --- 締め解除（管理者のみ）。締め後の修正が必要になった場合に計算済へ戻す ---
  async function handleReopen() {
    if (!perms.canConfigure || !run || busy) return
    if (runStatus !== '締め') return
    if (!window.confirm('締めを解除して再計算可能な状態に戻します。よろしいですか？')) return
    setBusy(true)
    try {
      await PayrollRunApi.update(run.id, { status: '計算済', closed_at: null })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: '給与締め解除',
        target_table: 'payroll_runs',
        after_data: { month, run_id: run.id },
      })
      toast.success('締めを解除しました')
      await load()
    } catch (e) {
      console.error('[PayrollCalc] reopen', e)
      toast.error(e instanceof Error ? e.message : '締め解除に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  // --- CSV出力 ---
  async function handleExport() {
    if (!perms.canExport) return
    if (sortedSlips.length === 0) { toast.error('出力する給与明細がありません'); return }
    try {
      const header = [
        '従業員コード', '氏名', '総支給', '基本給', '残業手当', '深夜手当', '休日手当',
        '通勤手当', '健康保険', '介護保険', '厚生年金', '雇用保険', '所得税', '住民税',
        '控除合計', '差引支給',
      ]
      const body: (string | number)[][] = sortedSlips.map((s) => {
        const emp = empById.get(s.employee_id)
        return [
          emp?.employee_code ?? '', emp?.name ?? '',
          s.gross_pay ?? 0, s.base_salary ?? 0, s.overtime_pay ?? 0, s.late_night_pay ?? 0,
          s.holiday_pay ?? 0, s.commute_allowance ?? 0, s.health_insurance ?? 0,
          s.long_term_care_insurance ?? 0, s.pension_insurance ?? 0, s.employment_insurance ?? 0,
          s.income_tax ?? 0, s.resident_tax ?? 0, s.total_deduction ?? 0, s.net_pay ?? 0,
        ]
      })
      downloadCsv(`payslips_${month}.csv`, toCsv([header, ...body]))
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: 'CSV出力',
        target_table: 'payslips',
        after_data: { month, count: sortedSlips.length },
      })
      toast.success(`CSVを出力しました（${sortedSlips.length}名）`)
    } catch (e) {
      console.error('[PayrollCalc] export', e)
      toast.error(e instanceof Error ? e.message : 'CSV出力に失敗しました')
    }
  }

  // --- 明細ダイアログ ---
  function openDetail(s: Payslip) {
    setSelected(s)
    setEdit({
      commute_allowance: String(s.commute_allowance ?? 0),
      position_allowance: String(s.position_allowance ?? 0),
      other_allowance: String(s.other_allowance ?? 0),
      resident_tax: String(s.resident_tax ?? 0),
      other_deduction: String(s.other_deduction ?? 0),
      note: s.note ?? '',
    })
  }

  function closeDetail() {
    setSelected(null)
    setEdit(null)
  }

  async function handleSaveDetail() {
    if (!selected || !edit || !perms.canManage || saving) return
    // 確定済み明細は上書き禁止（締め解除・再計算で変更する運用）
    if (selected.status === '確定') { toast.error('確定済みの明細は編集できません。締め解除・再計算が必要です'); return }
    setSaving(true)
    try {
      const commute = num(edit.commute_allowance)
      const position = num(edit.position_allowance)
      const other = num(edit.other_allowance)
      const residentTax = num(edit.resident_tax)
      const otherDeduction = num(edit.other_deduction)
      // 手当変更に連動して雇用保険・源泉所得税も再計算する（社保は標準報酬ベースで据え置き）。
      // これがないと総支給と控除が矛盾した明細になる。
      const d = recalcDeductions(
        selected.target_month,
        {
          base: selected.base_salary ?? 0,
          overtimePay: selected.overtime_pay ?? 0,
          lateNightPay: selected.late_night_pay ?? 0,
          holidayPay: selected.holiday_pay ?? 0,
          fixedOtPay: selected.fixed_overtime_pay ?? 0,
          commute, position, other,
        },
        {
          health: selected.health_insurance ?? 0,
          care: selected.long_term_care_insurance ?? 0,
          pension: selected.pension_insurance ?? 0,
        },
        residentTax,
        otherDeduction,
      )
      const patch: Partial<Payslip> = {
        commute_allowance: commute,
        position_allowance: position,
        other_allowance: other,
        resident_tax: residentTax,
        other_deduction: otherDeduction,
        note: edit.note || null,
        employment_insurance: d.employmentInsurance,
        income_tax: d.incomeTax,
        gross_pay: d.gross,
        total_deduction: d.totalDeduction,
        net_pay: d.netPay,
      }
      await PayslipApi.update(selected.id, patch)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: '給与明細修正',
        target_table: 'payslips',
        after_data: { id: selected.id, ...patch },
      })
      toast.success('給与明細を保存しました')
      closeDetail()
      await load()
    } catch (e) {
      console.error('[PayrollCalc] save detail', e)
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleRecalc() {
    if (!selected || !perms.canManage || saving) return
    // 確定済み明細は再計算不可（締め解除・全体再計算で扱う）
    if (selected.status === '確定') { toast.error('確定済みの明細は再計算できません。締め解除が必要です'); return }
    const emp = empById.get(selected.employee_id)
    if (!emp) { toast.error('従業員が見つかりません'); return }
    setSaving(true)
    try {
      const input = aggregate(emp, month, records, leaves)
      // 手入力（手当・住民税・その他控除・介護該当）を再計算後も引き継ぐ
      input.commuteAllowance = selected.commute_allowance ?? 0
      input.positionAllowance = selected.position_allowance ?? 0
      input.otherAllowance = selected.other_allowance ?? 0
      input.residentTax = selected.resident_tax ?? 0
      input.otherDeduction = selected.other_deduction ?? 0
      input.longTermCareApplicable = (selected.long_term_care_insurance ?? 0) > 0
      const draft = calcPayslip(emp, month, input)
      draft.note = selected.note ?? null // 備考も維持
      await PayslipApi.upsert(draft)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: '給与明細再計算',
        target_table: 'payslips',
        after_data: { employee_id: emp.id, month },
      })
      toast.success(`${emp.name} を再計算しました`)
      closeDetail()
      await load()
    } catch (e) {
      console.error('[PayrollCalc] recalc', e)
      toast.error(e instanceof Error ? e.message : '再計算に失敗しました')
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

  // 残業手当に合算済みの「月60h超割増(+25%)」を内訳表示用に概算で切り出す
  // （明細に専用カラムがないため、保存済みの残業分数と現在の時間単価から再導出＝概算）
  const selEmp = selected ? empById.get(selected.employee_id) : undefined
  const over60Min = selected ? Math.max(0, (selected.overtime_minutes ?? 0) - 3600) : 0
  const over60Approx = selEmp && over60Min > 0
    ? Math.round(hourlyRateOf(selEmp) * 0.25 * (over60Min / 60))
    : 0
  const payRows: { label: string; value: number | null | undefined; muted?: boolean }[] = selected ? [
    { label: '基本給', value: selected.base_salary },
    { label: '残業手当', value: selected.overtime_pay },
    ...(over60Min > 0
      ? [{ label: `　└ うち60h超割増（+25%）`, value: over60Approx, muted: true }]
      : []),
    { label: '深夜手当', value: selected.late_night_pay },
    { label: '休日手当', value: selected.holiday_pay },
    { label: '固定残業', value: selected.fixed_overtime_pay },
    { label: '通勤手当', value: selected.commute_allowance },
    { label: '役職手当', value: selected.position_allowance },
    { label: 'その他手当', value: selected.other_allowance },
  ] : []
  const dedRows: { label: string; value: number | null | undefined }[] = selected ? [
    { label: '健康保険', value: selected.health_insurance },
    { label: '介護保険', value: selected.long_term_care_insurance },
    { label: '厚生年金', value: selected.pension_insurance },
    { label: '雇用保険', value: selected.employment_insurance },
    { label: '所得税', value: selected.income_tax },
    { label: '住民税', value: selected.resident_tax },
    { label: 'その他控除', value: selected.other_deduction },
  ] : []

  const detailDialog = selected && edit ? (
    <Dialog open onOpenChange={(o) => { if (!o) closeDetail() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            給与明細 — {empById.get(selected.employee_id)?.name ?? '—'}（{selected.target_month}）
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-auto">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* 支給 */}
            <div className="rounded-xl border bg-card">
              <div className="border-b px-3 py-2 text-sm font-bold">支給内訳</div>
              <div className="divide-y">
                {payRows.map((row) => (
                  <div key={row.label} className={cn('flex items-center justify-between px-3 text-xs', row.muted ? 'py-1 text-2xs' : 'py-1.5')}>
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className={cn('tabular-nums', row.muted && 'text-muted-foreground')}>{row.muted ? '≈ ' : ''}{fmtYen(row.value)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 text-sm font-bold">
                  <span>総支給</span>
                  <span className="tabular-nums">{fmtYen(selected.gross_pay)}</span>
                </div>
              </div>
            </div>
            {/* 控除 */}
            <div className="rounded-xl border bg-card">
              <div className="border-b px-3 py-2 text-sm font-bold">控除内訳</div>
              <div className="divide-y">
                {dedRows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="tabular-nums">{fmtYen(row.value)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 text-sm font-bold">
                  <span>控除合計</span>
                  <span className="tabular-nums">{fmtYen(selected.total_deduction)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 差引支給 */}
          <div className="flex items-center justify-between rounded-xl border bg-primary/5 px-4 py-3">
            <span className="text-sm font-bold">差引支給額</span>
            <span className="text-xl font-bold tabular-nums text-primary">{fmtYen(selected.net_pay)}</span>
          </div>

          {/* 勤怠サマリ */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-2xs text-muted-foreground">
            <span>実働 {fmtMinutes(selected.work_minutes)}</span>
            <span>残業 {fmtMinutes(selected.overtime_minutes)}</span>
            <span>深夜 {fmtMinutes(selected.late_night_minutes)}</span>
            <span>休日 {fmtMinutes(selected.holiday_work_minutes)}</span>
            <span>出勤 {selected.work_days ?? 0}日</span>
            <span>有給 {selected.paid_leave_days ?? 0}日</span>
            <span>欠勤 {selected.absent_days ?? 0}日</span>
          </div>

          {/* 確定済みは編集不可の注記 */}
          {perms.canManage && selected.status === '確定' && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              この明細は確定済みのため編集できません。締め解除・再計算で変更してください。
            </div>
          )}

          {/* 編集（確定前のみ） */}
          {perms.canManage && selected.status !== '確定' && (
            <div className="space-y-2 rounded-xl border bg-card p-3">
              <div className="text-xs font-bold">調整（手当・控除）</div>
              <div className="text-2xs text-muted-foreground">手当を変更すると雇用保険・所得税も連動して再計算されます。</div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {([
                  ['通勤手当', 'commute_allowance'],
                  ['役職手当', 'position_allowance'],
                  ['その他手当', 'other_allowance'],
                  ['住民税', 'resident_tax'],
                  ['その他控除', 'other_deduction'],
                ] as [string, keyof EditState][]).map(([label, key]) => (
                  <label key={key} className="space-y-1">
                    <span className="text-2xs text-muted-foreground">{label}</span>
                    <Input
                      type="number"
                      value={edit[key]}
                      onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </label>
                ))}
              </div>
              <label className="block space-y-1">
                <span className="text-2xs text-muted-foreground">備考</span>
                <Textarea
                  value={edit.note}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  rows={2}
                  className="text-xs"
                />
              </label>
            </div>
          )}
        </div>
        <DialogFooter>
          {perms.canManage && selected.status !== '確定' && (
            <Button variant="outline" size="sm" onClick={handleRecalc} disabled={saving}>
              <RefreshCw className="h-3.5 w-3.5" />この従業員を再計算
            </Button>
          )}
          {perms.canManage && selected.status !== '確定' && (
            <Button size="sm" onClick={handleSaveDetail} disabled={saving}>保存</Button>
          )}
          <Button variant="ghost" size="sm" onClick={closeDetail}>閉じる</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  // --- 一般従業員（自分の明細のみ） ---
  if (perms.selfOnly) {
    return (
      <LaborLayout>
        <div className="mx-auto max-w-3xl space-y-4">
          <div>
            <h1 className="text-lg font-bold">給与明細</h1>
            <p className="text-2xs text-muted-foreground">あなたの給与明細を確認できます</p>
          </div>
          <div className="rounded-xl border bg-card">
            <div className="border-b px-3 py-2 text-sm font-bold">明細一覧</div>
            {loading ? (
              <div className="p-3"><SkeletonRows count={5} /></div>
            ) : sortedSlips.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">給与明細はまだありません。</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">対象月</th>
                    <th className="px-2 py-1.5 text-left font-medium">総支給</th>
                    <th className="px-2 py-1.5 text-left font-medium">控除合計</th>
                    <th className="px-2 py-1.5 text-left font-medium">差引支給</th>
                    <th className="px-2 py-1.5 text-left font-medium">状態</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSlips.map((s) => (
                    <tr
                      key={s.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                      onClick={() => openDetail(s)}
                    >
                      <td className="px-2 py-1.5 font-medium">{s.target_month}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtYen(s.gross_pay)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtYen(s.total_deduction)}</td>
                      <td className="px-2 py-1.5 font-bold tabular-nums">{fmtYen(s.net_pay)}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="secondary" className={procedureStatusColor(s.status)}>{s.status ?? '—'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        {detailDialog}
      </LaborLayout>
    )
  }

  // --- 管理者・マネージャー ---
  return (
    <LaborLayout>
      <div className="mx-auto max-w-6xl space-y-4">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">給与計算</h1>
            <p className="text-2xs text-muted-foreground">勤怠を集計し給与明細を自動計算</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
            />
            {perms.canExport && (
              <Button variant="outline" size="sm" disabled={loading || sortedSlips.length === 0} onClick={handleExport}>
                <Download className="h-3.5 w-3.5" />CSV出力
              </Button>
            )}
          </div>
        </div>

        {/* 注意バナー */}
        <div className="flex items-start gap-2 rounded-lg border bg-amber-50 p-3 text-2xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            適用料率セット <b>{rates.from}〜</b>（健保{pct(rates.healthInsurance + rates.childSupport)}・厚年{pct(rates.pension)}・雇用{pct(rates.employmentInsurance)}／協会けんぽ東京・折半後）。
            保険料率・所得税は概算です。実運用時は最新の料率表・源泉徴収税額表(甲欄)で検証してください。
          </span>
        </div>

        {/* 実行ステータスカード */}
        <div className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-sm font-bold">
            <span className="flex items-center gap-1.5">
              <Wallet className="h-4 w-4 text-primary" />{month} の給与処理
              <Badge variant="secondary" className={procedureStatusColor(runStatus)}>{runStatus}</Badge>
            </span>
            {perms.canManage && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  className="bg-green-600 text-white hover:bg-green-700"
                  disabled={running || loading || runStatus === '締め'}
                  onClick={handleRun}
                >
                  <Calculator className="h-3.5 w-3.5" />{running ? '計算中…' : '給与計算を実行'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || runStatus !== '計算済'}
                  onClick={handleConfirm}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />確定
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || runStatus !== '確定'}
                  onClick={handleClose}
                >
                  <Lock className="h-3.5 w-3.5" />締め
                </Button>
                {/* 締め解除：締め後の修正が必要になった場合の巻き戻し（管理者のみ） */}
                {perms.canConfigure && runStatus === '締め' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={handleReopen}
                  >
                    <LockOpen className="h-3.5 w-3.5" />締め解除
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 px-3 py-2 text-2xs text-muted-foreground">
            <span>対象人数 {sortedSlips.length}名</span>
            <span>総支給 {fmtYen(totals.gross)}</span>
            <span>控除合計 {fmtYen(totals.deduction)}</span>
            <span>差引支給 {fmtYen(totals.net)}</span>
            {run?.run_at && <span>計算日時 {new Date(run.run_at).toLocaleString('ja-JP')}</span>}
          </div>
        </div>

        {/* 明細テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">給与明細一覧</div>
          <div className="max-h-[34rem] overflow-auto">
            {loading ? (
              <div className="p-3"><SkeletonRows count={8} /></div>
            ) : sortedSlips.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                この月の給与明細はありません。給与計算を実行してください。
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">実働</th>
                    <th className="px-2 py-1.5 text-left font-medium">残業</th>
                    <th className="px-2 py-1.5 text-left font-medium">総支給</th>
                    <th className="px-2 py-1.5 text-left font-medium">控除合計</th>
                    <th className="px-2 py-1.5 text-left font-medium">差引支給</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSlips.map((s) => (
                    <tr
                      key={s.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                      onClick={() => openDetail(s)}
                    >
                      <td className="px-2 py-1.5 font-medium">{empById.get(s.employee_id)?.name ?? '—'}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtMinutes(s.work_minutes)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtMinutes(s.overtime_minutes)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtYen(s.gross_pay)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtYen(s.total_deduction)}</td>
                      <td className="px-2 py-1.5 font-bold tabular-nums">{fmtYen(s.net_pay)}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="secondary" className={procedureStatusColor(s.status)}>{s.status ?? '—'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 border-t bg-muted/60 font-medium">
                  <tr>
                    <td className="px-2 py-1.5" colSpan={3}>合計（{sortedSlips.length}名）</td>
                    <td className="px-2 py-1.5 tabular-nums">{fmtYen(totals.gross)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{fmtYen(totals.deduction)}</td>
                    <td className="px-2 py-1.5 font-bold tabular-nums">{fmtYen(totals.net)}</td>
                    <td className="px-2 py-1.5" />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </div>
      {detailDialog}
    </LaborLayout>
  )
}

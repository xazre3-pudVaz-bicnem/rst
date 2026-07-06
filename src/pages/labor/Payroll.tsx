import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Download, FileSpreadsheet, CheckCircle2, AlertTriangle, Clock, Users, ClipboardCheck,
} from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { EmployeeApi, AttendanceApi, LeaveRequestApi, ApprovalApi, LaborAuditApi } from '@/lib/api'
import { laborPerms, monthStr, CSV_FORMATS, toCsv, downloadCsv } from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, AttendanceRecord, LeaveRequest } from '@/lib/types'

/** 分 → 時間（0.1h 単位に丸め） */
function toHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10
}

interface Row {
  employee: Employee
  normalHours: number
  overtimeHours: number
  nightHours: number
  holidayHours: number
  paidDays: number
  absentDays: number
  lateEarly: number
}

export default function Payroll() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [leaves, setLeaves] = useState<LeaveRequest[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [month, setMonth] = useState(monthStr())
  const [format, setFormat] = useState<string>(CSV_FORMATS[0].value)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'未出力' | '出力済み'>('未出力')

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, recs, lvs, pending] = await Promise.all([
        EmployeeApi.list(),
        AttendanceApi.listByMonth(month),
        LeaveRequestApi.list(),
        ApprovalApi.listPending(),
      ])
      setEmployees(emps)
      setRecords(recs)
      setLeaves(lvs)
      setPendingCount(pending.length)
      setStatus('未出力')
    } catch (e) {
      console.error('[Payroll]', e)
      toast.error(e instanceof Error ? e.message : '給与連携データの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [month, toast])

  useEffect(() => { load() }, [load])

  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])

  // 事前チェック
  const clockErrors = useMemo(
    () => records.filter((r) => r.clock_in_at && !r.clock_out_at).length,
    [records],
  )
  const unclosedCount = activeEmployees.length
  const canOutput = clockErrors === 0 && pendingCount === 0

  // 従業員別集計
  const rows = useMemo<Row[]>(() => {
    const recsByEmp = new Map<string, AttendanceRecord[]>()
    for (const r of records) {
      const arr = recsByEmp.get(r.employee_id)
      if (arr) arr.push(r)
      else recsByEmp.set(r.employee_id, [r])
    }
    // 当月に開始する承認済み有給日数（ベストエフォート）
    const paidByEmp = new Map<string, number>()
    for (const lv of leaves) {
      if (lv.status !== 'approved') continue
      if (lv.leave_type !== '有給') continue
      if (!lv.start_date || lv.start_date.slice(0, 7) !== month) continue
      paidByEmp.set(lv.employee_id, (paidByEmp.get(lv.employee_id) ?? 0) + (lv.days ?? 0))
    }

    return activeEmployees.map((employee) => {
      const recs = recsByEmp.get(employee.id) ?? []
      let work = 0, overtime = 0, night = 0, holiday = 0, absent = 0, lateEarly = 0
      for (const r of recs) {
        work += r.work_minutes ?? 0
        overtime += r.overtime_minutes ?? 0
        night += r.late_night_minutes ?? 0
        holiday += r.holiday_work_minutes ?? 0
        if (r.status === '欠勤') absent++
        if (r.is_late) lateEarly++
        if (r.is_early_leave) lateEarly++
      }
      const normal = Math.max(0, work - overtime)
      return {
        employee,
        normalHours: toHours(normal),
        overtimeHours: toHours(overtime),
        nightHours: toHours(night),
        holidayHours: toHours(holiday),
        paidDays: paidByEmp.get(employee.id) ?? 0,
        absentDays: absent,
        lateEarly,
      }
    }).sort((a, b) =>
      (a.employee.employee_code ?? '').localeCompare(b.employee.employee_code ?? '', 'ja')
      || a.employee.name.localeCompare(b.employee.name, 'ja'),
    )
  }, [records, leaves, activeEmployees, month])

  const totals = useMemo(() => rows.reduce((acc, r) => ({
    normalHours: acc.normalHours + r.normalHours,
    overtimeHours: acc.overtimeHours + r.overtimeHours,
    nightHours: acc.nightHours + r.nightHours,
    holidayHours: acc.holidayHours + r.holidayHours,
    paidDays: acc.paidDays + r.paidDays,
    absentDays: acc.absentDays + r.absentDays,
    lateEarly: acc.lateEarly + r.lateEarly,
  }), {
    normalHours: 0, overtimeHours: 0, nightHours: 0, holidayHours: 0,
    paidDays: 0, absentDays: 0, lateEarly: 0,
  }), [rows])

  // --- CSV出力 ---
  async function handleExport() {
    if (!perms.canExport) return
    if (rows.length === 0) { toast.error('対象月の勤怠データがありません'); return }
    const fmt = CSV_FORMATS.find((f) => f.value === format) ?? CSV_FORMATS[0]
    try {
      const header = [
        '従業員コード', '氏名', '部署',
        '通常労働時間', '残業時間', '深夜時間', '休日労働時間',
        '有給日数', '欠勤日数', '遅刻早退回数',
        '交通費', '手当', '控除',
      ]
      const body: (string | number)[][] = rows.map((r) => [
        r.employee.employee_code ?? '',
        r.employee.name,
        r.employee.department ?? '',
        r.normalHours,
        r.overtimeHours,
        r.nightHours,
        r.holidayHours,
        r.paidDays,
        r.absentDays,
        r.lateEarly,
        0, 0, 0,
      ])
      const csv = toCsv([header, ...body])
      const filename = `payroll_${month}_${fmt.value}.csv`
      downloadCsv(filename, csv)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null,
        actor_name: displayName,
        action: 'CSV出力',
        target_table: 'attendance_monthly_summaries',
        after_data: { month, format: fmt.value, employee_count: rows.length },
      })
      setStatus('出力済み')
      toast.success(`${fmt.label}形式でCSVを出力しました（${rows.length}名）`)
    } catch (e) {
      console.error('[Payroll] export', e)
      toast.error(e instanceof Error ? e.message : 'CSV出力に失敗しました')
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

  // 一般従業員には非公開
  if (perms.selfOnly) {
    return (
      <LaborLayout>
        <div className="mx-auto max-w-6xl space-y-3">
          <div>
            <h1 className="text-lg font-bold">給与連携</h1>
            <p className="text-2xs text-muted-foreground">月次勤怠を集計しCSV出力</p>
          </div>
          <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
            この画面は管理者向けです。閲覧権限がありません。
          </div>
        </div>
      </LaborLayout>
    )
  }

  const checks: { label: string; value: string; icon: React.ReactNode; color: string }[] = [
    { label: '勤怠未締め', value: `${unclosedCount}名`, icon: <Users className="h-4 w-4 text-white" />, color: 'bg-slate-500' },
    { label: '打刻エラー', value: `${clockErrors}名`, icon: <Clock className="h-4 w-4 text-white" />, color: clockErrors > 0 ? 'bg-rose-500' : 'bg-green-600' },
    { label: '承認待ち', value: `${pendingCount}名`, icon: <ClipboardCheck className="h-4 w-4 text-white" />, color: pendingCount > 0 ? 'bg-amber-500' : 'bg-green-600' },
  ]

  return (
    <LaborLayout>
      <div className="mx-auto max-w-6xl space-y-4">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">給与連携</h1>
            <p className="text-2xs text-muted-foreground">月次勤怠を集計しCSV出力</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
            />
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="出力形式" /></SelectTrigger>
              <SelectContent>
                {CSV_FORMATS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {perms.canExport && (
              <Button size="sm" disabled={loading || rows.length === 0} onClick={handleExport}>
                <Download className="h-3.5 w-3.5" />CSV出力
              </Button>
            )}
          </div>
        </div>

        {/* 給与連携前チェック */}
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-bold">
            <span>給与連携前チェック</span>
            <span
              className={cn(
                'rounded px-2 py-0.5 text-2xs font-medium',
                status === '出力済み'
                  ? 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300',
              )}
            >
              今月のステータス：{status}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center gap-2.5 rounded-lg border bg-background p-2.5">
                <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', c.color)}>{c.icon}</div>
                <div className="min-w-0">
                  <div className="text-2xs text-muted-foreground">{c.label}</div>
                  <div className="text-base font-bold">{c.value}</div>
                </div>
              </div>
            ))}
            <div
              className={cn(
                'flex items-center gap-2.5 rounded-lg border p-2.5',
                canOutput
                  ? 'border-green-500/40 bg-green-50 dark:bg-green-500/10'
                  : 'border-amber-500/40 bg-amber-50 dark:bg-amber-500/10',
              )}
            >
              <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', canOutput ? 'bg-green-600' : 'bg-amber-500')}>
                {canOutput
                  ? <CheckCircle2 className="h-4 w-4 text-white" />
                  : <AlertTriangle className="h-4 w-4 text-white" />}
              </div>
              <div className="min-w-0">
                <div className="text-2xs text-muted-foreground">CSV出力可否</div>
                <div className={cn('text-sm font-bold', canOutput ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300')}>
                  {canOutput ? '出力可能 ✓' : '要確認'}
                </div>
              </div>
            </div>
          </div>
          {!canOutput && (
            <div className="border-t px-3 py-1.5 text-2xs text-muted-foreground">
              打刻エラーや承認待ちが残っています。締め後の出力を推奨します。
            </div>
          )}
        </div>

        {/* 集計テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="flex items-center gap-1.5 border-b px-3 py-2 text-sm font-bold">
            <FileSpreadsheet className="h-4 w-4 text-primary" />月次勤怠集計（{month}）
          </div>
          <div className="max-h-[32rem] overflow-auto">
            {loading ? (
              <div className="p-3"><SkeletonRows count={8} /></div>
            ) : rows.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">対象月の勤怠データがありません</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">従業員コード</th>
                    <th className="px-2 py-1.5 text-left font-medium">氏名</th>
                    <th className="px-2 py-1.5 text-left font-medium">部署</th>
                    <th className="px-2 py-1.5 text-left font-medium">通常(h)</th>
                    <th className="px-2 py-1.5 text-left font-medium">残業(h)</th>
                    <th className="px-2 py-1.5 text-left font-medium">深夜(h)</th>
                    <th className="px-2 py-1.5 text-left font-medium">休日(h)</th>
                    <th className="px-2 py-1.5 text-left font-medium">有給(日)</th>
                    <th className="px-2 py-1.5 text-left font-medium">欠勤(日)</th>
                    <th className="px-2 py-1.5 text-left font-medium">遅刻早退(回)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.employee.id} className="border-b last:border-0 hover:bg-accent/50">
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{r.employee.employee_code ?? '—'}</td>
                      <td className="px-2 py-1.5 font-medium">{r.employee.name}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.employee.department ?? '—'}</td>
                      <td className="px-2 py-1.5">{r.normalHours}</td>
                      <td className="px-2 py-1.5">{r.overtimeHours}</td>
                      <td className="px-2 py-1.5">{r.nightHours}</td>
                      <td className="px-2 py-1.5">{r.holidayHours}</td>
                      <td className="px-2 py-1.5">{r.paidDays}</td>
                      <td className="px-2 py-1.5">{r.absentDays}</td>
                      <td className="px-2 py-1.5">{r.lateEarly}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 border-t bg-muted/60 font-medium">
                  <tr>
                    <td className="px-2 py-1.5" colSpan={3}>合計（{rows.length}名）</td>
                    <td className="px-2 py-1.5">{Math.round(totals.normalHours * 10) / 10}</td>
                    <td className="px-2 py-1.5">{Math.round(totals.overtimeHours * 10) / 10}</td>
                    <td className="px-2 py-1.5">{Math.round(totals.nightHours * 10) / 10}</td>
                    <td className="px-2 py-1.5">{Math.round(totals.holidayHours * 10) / 10}</td>
                    <td className="px-2 py-1.5">{totals.paidDays}</td>
                    <td className="px-2 py-1.5">{totals.absentDays}</td>
                    <td className="px-2 py-1.5">{totals.lateEarly}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </div>
    </LaborLayout>
  )
}

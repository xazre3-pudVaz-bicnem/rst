import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users, LogIn, LogOut, Coffee, Home as HomeIcon, MapPin, AlertTriangle, ClipboardCheck,
  Clock, CalendarDays, FileWarning, TrendingUp, CircleDollarSign, CheckCircle2, ChevronRight,
} from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { SkeletonCards } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import {
  EmployeeApi, AttendanceApi, ApprovalApi, LaborAlertApi, LeaveBalanceApi,
  LaborSettingsApi, LaborAuditApi,
} from '@/lib/api'
import {
  laborPerms, attendanceStatusColor, alertSeverityColor, ALERT_SEVERITY_LABEL,
  APPROVAL_STATUS_LABEL, computeAttendance, estimateMonthlyCost, fmtMinutes, fmtTime,
  todayStr, monthStr,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import type {
  Employee, AttendanceRecord, ApprovalRequest, LaborAlert, LeaveBalance, LaborSettings,
} from '@/lib/types'

const JP_DATE = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })

export default function LaborHome() {
  const navigate = useNavigate()
  const toast = useToast()
  const { user, displayName, role } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([])
  const [monthAttendance, setMonthAttendance] = useState<AttendanceRecord[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [alerts, setAlerts] = useState<LaborAlert[]>([])
  const [balances, setBalances] = useState<LeaveBalance[]>([])
  const [settings, setSettings] = useState<LaborSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [punching, setPunching] = useState(false)

  const today = todayStr()
  const month = monthStr()

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, att, mAtt, apps, alrt, bals, st] = await Promise.all([
        EmployeeApi.list(),
        AttendanceApi.listByDate(today),
        AttendanceApi.listByMonth(month),
        ApprovalApi.listPending(),
        LaborAlertApi.listOpen(),
        LeaveBalanceApi.list(),
        LaborSettingsApi.get(),
      ])
      setEmployees(emps); setAttendance(att); setMonthAttendance(mAtt)
      setApprovals(apps); setAlerts(alrt); setBalances(bals); setSettings(st)
    } catch (e) {
      console.error('[LaborHome]', e)
    } finally {
      setLoading(false)
    }
  }, [today, month])

  useEffect(() => { load() }, [load])

  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])
  const myEmployee = useMemo(
    () => employees.find((e) => e.user_id && user?.id && e.user_id === user.id) ?? null,
    [employees, user],
  )
  const attByEmp = useMemo(() => new Map(attendance.map((a) => [a.employee_id, a])), [attendance])
  const myRecord = myEmployee ? attByEmp.get(myEmployee.id) ?? null : null

  // --- 本日の勤怠サマリー ---
  const summary = useMemo(() => {
    let present = 0, working = 0, notClockedIn = 0, late = 0, earlyLeave = 0, onLeave = 0, remote = 0, direct = 0
    for (const emp of activeEmployees) {
      const r = attByEmp.get(emp.id)
      if (!r) { notClockedIn++; continue }
      if (r.status === '休暇' || r.status === '欠勤') { onLeave++; continue }
      if (r.clock_in_at) present++
      else notClockedIn++
      if (r.status === '出勤中' || r.status === '休憩中') working++
      if (r.is_late) late++
      if (r.is_early_leave) earlyLeave++
      if (r.work_location_type === 'remote') remote++
      if (r.work_location_type === 'direct') direct++
    }
    return { present, working, notClockedIn, late, earlyLeave, onLeave, remote, direct }
  }, [activeEmployees, attByEmp])

  // --- 承認待ちを種別で集計 ---
  const approvalByType = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of approvals) m.set(a.request_type, (m.get(a.request_type) ?? 0) + 1)
    return m
  }, [approvals])

  // --- 今月の勤怠集計（全社） ---
  const monthAgg = useMemo(() => {
    const sched = settings?.scheduled_daily_minutes ?? 480
    let work = 0, ot = 0, ln = 0, holiday = 0, paid = 0, absent = 0, lateEarly = 0
    for (const r of monthAttendance) {
      const c = computeAttendance(r, sched)
      work += r.work_minutes ?? c.workMinutes
      ot += r.overtime_minutes ?? c.overtimeMinutes
      ln += r.late_night_minutes ?? c.lateNightMinutes
      holiday += r.holiday_work_minutes ?? 0
      if (r.status === '休暇') paid++
      if (r.status === '欠勤') absent++
      if (r.is_late || r.is_early_leave) lateEarly++
    }
    return { work, ot, ln, holiday, paid, absent, lateEarly }
  }, [monthAttendance, settings])

  // --- 有給5日未取得リスク ---
  const paidLeaveRisk = useMemo(
    () => balances.filter((b) => (b.required_5days_used ?? 0) < 5 && (b.paid_leave_granted_days ?? 0) >= 10).length,
    [balances],
  )

  // --- 契約更新 / 試用期間 期限 ---
  const contractSoon = useMemo(() => {
    const in30 = new Date(); in30.setDate(in30.getDate() + 30)
    const iso = in30.toISOString().slice(0, 10)
    return activeEmployees.filter(
      (e) => (e.contract_end_date && e.contract_end_date <= iso) || (e.trial_period_end_date && e.trial_period_end_date <= iso),
    )
  }, [activeEmployees])

  // --- 人件費見込み ---
  const monthlyCost = useMemo(
    () => activeEmployees.reduce((sum, e) => sum + estimateMonthlyCost(e), 0),
    [activeEmployees],
  )

  // --- 給与連携前チェック ---
  const payrollCheck = useMemo(() => {
    const unclosedCount = activeEmployees.length // 締め機能は月次集計側。ここでは全員未締め扱いの目安
    const punchErrors = monthAttendance.filter((r) => r.clock_in_at && !r.clock_out_at).length
    const canExport = punchErrors === 0 && approvals.length === 0
    return { unclosedCount, punchErrors, pendingCount: approvals.length, canExport }
  }, [activeEmployees, monthAttendance, approvals])

  // --- 打刻処理 ---
  async function punch(action: '出勤' | '退勤' | '休憩開始' | '休憩終了' | '直行' | '直帰') {
    if (!myEmployee) { toast.error('あなたに紐付く従業員情報がありません。管理者に登録を依頼してください。'); return }
    setPunching(true)
    try {
      const now = new Date().toISOString()
      const existing = myRecord
      const sched = settings?.scheduled_daily_minutes ?? myEmployee.standard_break_minutes ?? 480
      const payload: Partial<AttendanceRecord> & { employee_id: string; work_date: string } = {
        employee_id: myEmployee.id, work_date: today,
      }
      if (action === '出勤' || action === '直行') {
        payload.clock_in_at = existing?.clock_in_at ?? now
        payload.status = '出勤中'
        payload.clock_in_method = 'web'
        payload.work_location_type = action === '直行' ? 'direct' : (existing?.work_location_type ?? 'office')
        // 遅刻判定（所定始業を過ぎていれば）
        const start = myEmployee.standard_work_start || settings?.standard_work_start || '09:00'
        const [sh, sm] = start.split(':').map(Number)
        const nowD = new Date()
        payload.is_late = action === '出勤' && (nowD.getHours() > sh || (nowD.getHours() === sh && nowD.getMinutes() > sm))
      } else if (action === '休憩開始') {
        payload.break_start_at = now; payload.status = '休憩中'
      } else if (action === '休憩終了') {
        payload.break_end_at = now; payload.status = '出勤中'
        const bmin = existing?.total_break_minutes ?? 0
        if (existing?.break_start_at) {
          payload.total_break_minutes = bmin + Math.round((Date.now() - new Date(existing.break_start_at).getTime()) / 60000)
        }
      } else if (action === '退勤' || action === '直帰') {
        payload.clock_out_at = now; payload.status = '退勤済'
        payload.clock_out_method = 'web'
        if (action === '直帰') payload.work_location_type = 'direct'
        const merged = { ...existing, ...payload }
        const c = computeAttendance(merged, sched)
        payload.work_minutes = c.workMinutes
        payload.overtime_minutes = c.overtimeMinutes
        payload.late_night_minutes = c.lateNightMinutes
        // 早退判定
        const end = myEmployee.standard_work_end || settings?.standard_work_end || '18:00'
        const [eh, em] = end.split(':').map(Number)
        const nowD = new Date()
        payload.is_early_leave = action === '退勤' && (nowD.getHours() < eh || (nowD.getHours() === eh && nowD.getMinutes() < em))
      }
      await AttendanceApi.upsert(payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: myEmployee.id,
        action: '打刻', target_table: 'attendance_records', after_data: { action, at: now },
      })
      toast.success(`${action}を記録しました`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打刻に失敗しました')
    } finally {
      setPunching(false)
    }
  }

  // --- カード描画 ---
  const stat = (icon: React.ReactNode, label: string, value: React.ReactNode, color: string, onClick?: () => void) => (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition-shadow hover:shadow-sm',
        onClick && 'cursor-pointer',
      )}
    >
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', color)}>{icon}</div>
      <div className="min-w-0">
        <div className="text-2xs text-muted-foreground">{label}</div>
        <div className="text-xl font-bold">{value}</div>
      </div>
    </button>
  )

  if (!isSupabaseConfigured) {
    return (
      <LaborLayout>
        <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Supabase が未設定です。.env を設定すると労務管理ダッシュボードが表示されます。
        </div>
      </LaborLayout>
    )
  }

  return (
    <LaborLayout>
      {loading ? (
        <div className="mx-auto max-w-6xl space-y-4">
          <SkeletonCards count={8} className="grid-cols-2 md:grid-cols-4" />
        </div>
      ) : (
        <div className="mx-auto max-w-6xl space-y-4">
          {/* ヘッダー */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-lg font-bold">労務管理ダッシュボード</h1>
              <p className="text-2xs text-muted-foreground">
                本日の勤怠状況・申請承認・労務アラートを確認できます — {JP_DATE.format(new Date())}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-lg border bg-card px-2 py-1 text-2xs">
                承認待ち <b className="text-primary">{approvals.length}</b>
              </span>
              <span className="rounded-lg border bg-card px-2 py-1 text-2xs">
                アラート <b className="text-red-600">{alerts.length}</b>
              </span>
            </div>
          </div>

          {/* 自分の打刻バー */}
          <div className="rounded-xl border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-bold">
                <Clock className="h-4 w-4 text-primary" />
                打刻
                {myEmployee ? (
                  <span className="text-2xs font-normal text-muted-foreground">
                    {myEmployee.name}／
                    <span className={cn('rounded px-1', attendanceStatusColor(myRecord?.status))}>{myRecord?.status ?? '未出勤'}</span>
                    {myRecord?.clock_in_at && <> ・出勤 {fmtTime(myRecord.clock_in_at)}</>}
                    {myRecord?.clock_out_at && <> ・退勤 {fmtTime(myRecord.clock_out_at)}</>}
                  </span>
                ) : (
                  <span className="text-2xs font-normal text-amber-600">従業員未登録（管理者に登録を依頼してください）</span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={punching || !myEmployee} onClick={() => punch('出勤')}>
                <LogIn className="h-3.5 w-3.5" />出勤
              </Button>
              <Button size="sm" variant="outline" disabled={punching || !myEmployee} onClick={() => punch('退勤')}>
                <LogOut className="h-3.5 w-3.5" />退勤
              </Button>
              <Button size="sm" variant="outline" disabled={punching || !myEmployee} onClick={() => punch('休憩開始')}>
                <Coffee className="h-3.5 w-3.5" />休憩開始
              </Button>
              <Button size="sm" variant="outline" disabled={punching || !myEmployee} onClick={() => punch('休憩終了')}>
                <Coffee className="h-3.5 w-3.5" />休憩終了
              </Button>
              <Button size="sm" variant="outline" disabled={punching || !myEmployee} onClick={() => punch('直行')}>
                <MapPin className="h-3.5 w-3.5" />直行
              </Button>
              <Button size="sm" variant="outline" disabled={punching || !myEmployee} onClick={() => punch('直帰')}>
                <MapPin className="h-3.5 w-3.5" />直帰
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate('/labor/approvals?new=打刻修正')}>
                打刻忘れ申請
              </Button>
            </div>
          </div>

          {/* 1. 本日の勤怠サマリー */}
          <section>
            <h2 className="mb-2 text-sm font-bold">本日の勤怠サマリー</h2>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {stat(<Users className="h-5 w-5 text-white" />, '出勤済み', summary.present, 'bg-green-600', () => navigate('/labor/attendance'))}
              {stat(<Clock className="h-5 w-5 text-white" />, '未打刻', summary.notClockedIn, 'bg-slate-500', () => navigate('/labor/attendance'))}
              {stat(<AlertTriangle className="h-5 w-5 text-white" />, '遅刻', summary.late, 'bg-amber-500')}
              {stat(<LogOut className="h-5 w-5 text-white" />, '早退', summary.earlyLeave, 'bg-orange-500')}
              {stat(<CalendarDays className="h-5 w-5 text-white" />, '休暇中', summary.onLeave, 'bg-violet-500', () => navigate('/labor/leaves'))}
              {stat(<HomeIcon className="h-5 w-5 text-white" />, '在宅勤務', summary.remote, 'bg-sky-500')}
              {stat(<MapPin className="h-5 w-5 text-white" />, '直行直帰', summary.direct, 'bg-teal-500')}
              {stat(<CircleDollarSign className="h-5 w-5 text-white" />, '今月人件費見込', `¥${(monthlyCost / 10000).toFixed(0)}万`, 'bg-indigo-500', () => navigate('/labor/payroll'))}
            </div>
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            {/* 2. 承認待ち */}
            <div className="rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-1.5 text-sm font-bold"><ClipboardCheck className="h-4 w-4 text-primary" />承認待ち（{approvals.length}）</div>
                <button className="text-2xs text-primary hover:underline" onClick={() => navigate('/labor/approvals')}>すべて表示</button>
              </div>
              <div className="max-h-64 overflow-y-auto p-2">
                {approvals.length === 0 ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">承認待ち申請はありません</div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    {[...approvalByType.entries()].map(([type, count]) => (
                      <button
                        key={type}
                        onClick={() => navigate('/labor/approvals')}
                        className="flex items-center justify-between rounded-lg border px-2 py-1.5 text-xs hover:bg-accent"
                      >
                        <span className="truncate">{type}</span>
                        <span className="ml-1 shrink-0 rounded-full bg-primary/10 px-1.5 font-bold text-primary">{count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 3. 労務アラート */}
            <div className="rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-1.5 text-sm font-bold"><AlertTriangle className="h-4 w-4 text-red-500" />労務アラート（{alerts.length}）</div>
                <button className="text-2xs text-primary hover:underline" onClick={() => navigate('/labor/alerts')}>すべて表示</button>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {alerts.length === 0 ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">労務アラートはありません 👍</div>
                ) : (
                  alerts.slice(0, 12).map((a) => (
                    <button
                      key={a.id}
                      onClick={() => navigate('/labor/alerts')}
                      className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left last:border-0 hover:bg-accent"
                    >
                      <span className={cn('shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-medium', alertSeverityColor(a.severity))}>
                        {ALERT_SEVERITY_LABEL[a.severity ?? 'info']}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">{a.title || a.alert_type}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* 4. 今日の従業員一覧 */}
          <div className="rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <div className="text-sm font-bold">今日の従業員一覧（{activeEmployees.length}）</div>
              <button className="text-2xs text-primary hover:underline" onClick={() => navigate('/labor/employees')}>従業員管理</button>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {activeEmployees.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  従業員が登録されていません。<button className="text-primary hover:underline" onClick={() => navigate('/labor/employees')}>従業員を登録</button>してください。
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">従業員名</th>
                      <th className="px-2 py-1.5 text-left font-medium">状況</th>
                      <th className="px-2 py-1.5 text-left font-medium">出勤</th>
                      <th className="px-2 py-1.5 text-left font-medium">退勤</th>
                      <th className="px-2 py-1.5 text-left font-medium">休憩</th>
                      <th className="px-2 py-1.5 text-left font-medium">区分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeEmployees.map((emp) => {
                      const r = attByEmp.get(emp.id)
                      return (
                        <tr key={emp.id} className="border-b last:border-0 hover:bg-accent/50">
                          <td className="px-2 py-1.5 font-medium">{emp.name}</td>
                          <td className="px-2 py-1.5">
                            <span className={cn('rounded px-1.5 py-0.5 text-[10px]', attendanceStatusColor(r?.status))}>{r?.status ?? '未出勤'}</span>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{fmtTime(r?.clock_in_at)}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{fmtTime(r?.clock_out_at)}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{r?.total_break_minutes ? fmtMinutes(r.total_break_minutes) : '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{emp.work_style ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* 下段: 今月集計 / 有給 / 契約 / 給与連携チェック */}
          <div className="grid gap-3 md:grid-cols-2">
            {/* 5. 今月の勤怠集計 */}
            <div className="rounded-xl border bg-card p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-bold"><TrendingUp className="h-4 w-4 text-primary" />今月の勤怠集計（全社）</div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  ['総労働', fmtMinutes(monthAgg.work)],
                  ['残業', fmtMinutes(monthAgg.ot)],
                  ['深夜', fmtMinutes(monthAgg.ln)],
                  ['休日労働', fmtMinutes(monthAgg.holiday)],
                  ['有給取得', `${monthAgg.paid}日`],
                  ['遅刻早退', `${monthAgg.lateEarly}回`],
                ].map(([label, val]) => (
                  <div key={label} className="rounded-lg border p-2">
                    <div className="text-2xs text-muted-foreground">{label}</div>
                    <div className="text-sm font-bold">{val}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* 6. 給与連携前チェック + アラート系 */}
            <div className="rounded-xl border bg-card p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-bold"><FileWarning className="h-4 w-4 text-primary" />給与連携前チェック</div>
              <div className="space-y-1 text-xs">
                <CheckRow label="勤怠未締め" value={`${payrollCheck.unclosedCount}人`} bad={payrollCheck.unclosedCount > 0} />
                <CheckRow label="打刻エラー（退勤漏れ）" value={`${payrollCheck.punchErrors}人`} bad={payrollCheck.punchErrors > 0} />
                <CheckRow label="承認待ち" value={`${payrollCheck.pendingCount}件`} bad={payrollCheck.pendingCount > 0} />
                <CheckRow label="有給5日未取得リスク" value={`${paidLeaveRisk}人`} bad={paidLeaveRisk > 0} />
                <CheckRow label="契約更新/試用終了 30日内" value={`${contractSoon.length}人`} bad={contractSoon.length > 0} />
                <div className="mt-2 flex items-center justify-between rounded-lg border p-2">
                  <span className="flex items-center gap-1 font-medium">
                    {payrollCheck.canExport
                      ? <><CheckCircle2 className="h-3.5 w-3.5 text-green-600" />CSV出力可能</>
                      : <><AlertTriangle className="h-3.5 w-3.5 text-amber-600" />要確認あり</>}
                  </span>
                  {perms.canExport && (
                    <Button size="sm" variant="outline" onClick={() => navigate('/labor/payroll')}>給与連携へ</Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </LaborLayout>
  )
}

function CheckRow({ label, value, bad }: { label: string; value: string; bad: boolean }) {
  return (
    <div className="flex items-center justify-between border-b py-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-bold', bad ? 'text-amber-600' : 'text-green-600')}>{value}</span>
    </div>
  )
}

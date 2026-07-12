import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Clock, Moon, TrendingUp, AlertTriangle, LogOut, Pencil, UserPlus, Calculator } from 'lucide-react'
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
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { EmployeeApi, AttendanceApi, LaborAuditApi, LaborSettingsApi } from '@/lib/api'
import {
  laborPerms, attendanceStatusColor, computeAttendance, fmtMinutes, fmtTime, scheduledMinutesFor,
  monthStr, todayStr, ATTENDANCE_STATUSES, WORK_LOCATION_TYPES,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, AttendanceRecord, LaborSettings } from '@/lib/types'

const ALL = '__all__'

/** レコードの時刻を <Input type="time"> 用の HH:mm に */
function hhmm(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** HH:mm + 対象日 → ISO 文字列（空なら null） */
function toIso(dateStr: string, time: string): string | null {
  if (!time) return null
  const d = new Date(`${dateStr}T${time}:00`)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** YYYY-MM-DD の翌日を YYYY-MM-DD で返す（日跨ぎ夜勤の退勤/休憩終了に使用） */
function nextDayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return todayStr(d)
}

const locationLabel = (v?: string | null) =>
  WORK_LOCATION_TYPES.find((t) => t.value === v)?.label ?? '—'

interface EditForm {
  status: string
  clockIn: string
  clockOut: string
  breakStart: string
  breakEnd: string
  totalBreak: string
  location: string
  isLate: boolean
  isEarlyLeave: boolean
  note: string
}

export default function Attendance() {
  const navigate = useNavigate()
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [settings, setSettings] = useState<LaborSettings | null>(null)
  const [month, setMonth] = useState(monthStr())
  const [empFilter, setEmpFilter] = useState<string>(ALL)
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 修正ダイアログ
  const [editing, setEditing] = useState<AttendanceRecord | null>(null)
  const [form, setForm] = useState<EditForm | null>(null)

  // 代理打刻ダイアログ
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxyEmp, setProxyEmp] = useState<string>('')
  const [proxyDate, setProxyDate] = useState(todayStr())

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      if (perms.canViewAll) {
        // 管理者・マネージャー・閲覧者: 全社の従業員（修正時の所定時刻算出に給与項目付き list が必要）と月次勤怠
        const [emps, recs, st] = await Promise.all([
          EmployeeApi.list(),
          AttendanceApi.listByMonth(month),
          LaborSettingsApi.get(),
        ])
        setEmployees(emps)
        setRecords(recs)
        setSettings(st)
      } else {
        // 一般従業員(selfOnly): 同僚の給与・勤怠を露出させないため listDirectory + 自分の勤怠のみ取得
        const [dir, st] = await Promise.all([EmployeeApi.listDirectory(), LaborSettingsApi.get()])
        setSettings(st)
        const meLite = dir.find((e) => e.user_id && user?.id && e.user_id === user.id)
        setEmployees(meLite ? [meLite as Employee] : [])
        const mine = meLite ? await AttendanceApi.listByEmployee(meLite.id) : []
        setRecords(mine.filter((r) => r.work_date.startsWith(month)))
      }
    } catch (e) {
      console.error('[Attendance]', e)
      toast.error(e instanceof Error ? e.message : '勤怠の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [month, perms.canViewAll, user])

  useEffect(() => { load() }, [load])

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])

  // selfOnly の場合、自分の従業員レコードのみ対象
  const myEmployee = useMemo(
    () => employees.find((e) => e.user_id && user?.id && e.user_id === user.id) ?? null,
    [employees, user],
  )

  const empName = useCallback((id: string) => empById.get(id)?.name ?? '—', [empById])

  const filtered = useMemo(() => {
    let rows = records
    if (perms.selfOnly) {
      rows = myEmployee ? rows.filter((r) => r.employee_id === myEmployee.id) : []
    }
    if (empFilter !== ALL) rows = rows.filter((r) => r.employee_id === empFilter)
    if (statusFilter !== ALL) rows = rows.filter((r) => (r.status ?? '') === statusFilter)
    return [...rows].sort((a, b) => {
      if (a.work_date !== b.work_date) return a.work_date < b.work_date ? 1 : -1
      return empName(a.employee_id).localeCompare(empName(b.employee_id), 'ja')
    })
  }, [records, perms.selfOnly, myEmployee, empFilter, statusFilter, empName])

  // サマリー集計
  const summary = useMemo(() => {
    let work = 0, ot = 0, ln = 0, late = 0, early = 0
    for (const r of filtered) {
      work += r.work_minutes ?? 0
      ot += r.overtime_minutes ?? 0
      ln += r.late_night_minutes ?? 0
      if (r.is_late) late++
      if (r.is_early_leave) early++
    }
    return { work, ot, ln, late, early }
  }, [filtered])

  // --- 修正ダイアログを開く ---
  function openEdit(rec: AttendanceRecord) {
    setEditing(rec)
    setForm({
      status: rec.status ?? '未出勤',
      clockIn: hhmm(rec.clock_in_at),
      clockOut: hhmm(rec.clock_out_at),
      breakStart: hhmm(rec.break_start_at),
      breakEnd: hhmm(rec.break_end_at),
      totalBreak: String(rec.total_break_minutes ?? 0),
      location: rec.work_location_type ?? 'office',
      isLate: !!rec.is_late,
      isEarlyLeave: !!rec.is_early_leave,
      note: rec.note ?? '',
    })
  }

  // --- 修正を保存 ---
  async function saveEdit() {
    if (!editing || !form) return
    setSaving(true)
    try {
      const wd = editing.work_date
      const clock_in_at = toIso(wd, form.clockIn)
      // 退勤が出勤以前なら日跨ぎ夜勤とみなし翌日日付で再生成（実働0分・深夜0分の誤算出を防止）
      let clock_out_at = toIso(wd, form.clockOut)
      if (clock_in_at && clock_out_at && new Date(clock_out_at) <= new Date(clock_in_at)) {
        clock_out_at = toIso(nextDayStr(wd), form.clockOut)
      }
      const break_start_at = toIso(wd, form.breakStart)
      let break_end_at = toIso(wd, form.breakEnd)
      if (break_start_at && break_end_at && new Date(break_end_at) <= new Date(break_start_at)) {
        break_end_at = toIso(nextDayStr(wd), form.breakEnd)
      }
      const total_break_minutes = Number(form.totalBreak) || 0
      // 所定労働は従業員マスタ→労務設定の順で決定（480固定を廃止し時短勤務者の残業も正しく算出）
      const sched = scheduledMinutesFor(empById.get(editing.employee_id), settings)
      const c = computeAttendance(
        { clock_in_at, clock_out_at, break_start_at, break_end_at, total_break_minutes },
        sched,
      )
      const payload: Partial<AttendanceRecord> = {
        status: form.status,
        clock_in_at,
        clock_out_at,
        break_start_at,
        break_end_at,
        total_break_minutes,
        work_minutes: c.workMinutes,
        overtime_minutes: c.overtimeMinutes,
        late_night_minutes: c.lateNightMinutes,
        work_location_type: form.location,
        is_late: form.isLate,
        is_early_leave: form.isEarlyLeave,
        note: form.note || null,
      }
      const before = {
        status: editing.status, clock_in_at: editing.clock_in_at, clock_out_at: editing.clock_out_at,
        break_start_at: editing.break_start_at, break_end_at: editing.break_end_at,
        total_break_minutes: editing.total_break_minutes, work_minutes: editing.work_minutes,
        overtime_minutes: editing.overtime_minutes, work_location_type: editing.work_location_type,
        is_late: editing.is_late, is_early_leave: editing.is_early_leave, note: editing.note,
      }
      await AttendanceApi.update(editing.id, payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: editing.employee_id,
        action: '打刻修正', target_table: 'attendance_records', target_id: editing.id,
        before_data: before, after_data: payload,
      })
      toast.success('打刻を修正しました')
      setEditing(null); setForm(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '修正に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  // --- 代理打刻（新規作成） ---
  async function createProxy() {
    if (!proxyEmp || !proxyDate) { toast.error('従業員と日付を選択してください'); return }
    setSaving(true)
    try {
      const created = await AttendanceApi.upsert({
        employee_id: proxyEmp,
        work_date: proxyDate,
        status: '出勤中',
        clock_in_method: 'proxy',
        work_location_type: 'office',
      })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: proxyEmp,
        action: '代理打刻', target_table: 'attendance_records', target_id: created.id,
        after_data: { work_date: proxyDate, status: '出勤中', by: 'proxy' },
      })
      toast.success('代理打刻レコードを作成しました。時刻は修正から入力してください。')
      setProxyOpen(false)
      // 作成した月を表示していれば再読込
      if (proxyDate.slice(0, 7) === month) load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '代理打刻に失敗しました')
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

  const tiles: { label: string; value: string; icon: React.ReactNode; color: string }[] = [
    { label: '総労働', value: fmtMinutes(summary.work), icon: <TrendingUp className="h-4 w-4 text-white" />, color: 'bg-green-600' },
    { label: '残業', value: fmtMinutes(summary.ot), icon: <Clock className="h-4 w-4 text-white" />, color: 'bg-orange-500' },
    { label: '深夜', value: fmtMinutes(summary.ln), icon: <Moon className="h-4 w-4 text-white" />, color: 'bg-indigo-500' },
    { label: '遅刻回数', value: `${summary.late}回`, icon: <AlertTriangle className="h-4 w-4 text-white" />, color: 'bg-amber-500' },
    { label: '早退回数', value: `${summary.early}回`, icon: <LogOut className="h-4 w-4 text-white" />, color: 'bg-rose-500' },
  ]

  return (
    <LaborLayout>
      <div className="mx-auto max-w-6xl space-y-4">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">勤怠管理</h1>
            <p className="text-2xs text-muted-foreground">月次の打刻記録の確認・修正</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
            />
            {perms.canManage && (
              <Button size="sm" variant="outline" onClick={() => { setProxyEmp(''); setProxyDate(todayStr()); setProxyOpen(true) }}>
                <UserPlus className="h-3.5 w-3.5" />代理打刻
              </Button>
            )}
            {perms.canManage && (
              // 月次締めフロー: 表示中の月をそのまま給与計算画面へ引き継ぐ
              <Button size="sm" onClick={() => navigate(`/labor/payroll-calc?month=${month}`)}>
                <Calculator className="h-3.5 w-3.5" />この月を給与計算へ
              </Button>
            )}
          </div>
        </div>

        {/* フィルタ */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Select value={empFilter} onValueChange={setEmpFilter}>
            <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="従業員" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>すべての従業員</SelectItem>
              {activeEmployees.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="状況" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>すべての状況</SelectItem>
              {ATTENDANCE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-2xs text-muted-foreground">{filtered.length}件</span>
        </div>

        {/* サマリータイル */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          {tiles.map((t) => (
            <div key={t.label} className="flex items-center gap-2.5 rounded-xl border bg-card p-3">
              <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', t.color)}>{t.icon}</div>
              <div className="min-w-0">
                <div className="text-2xs text-muted-foreground">{t.label}</div>
                <div className="text-base font-bold">{t.value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="flex items-center gap-1.5 border-b px-3 py-2 text-sm font-bold">
            <CalendarDays className="h-4 w-4 text-primary" />打刻記録
          </div>
          <div className="max-h-[32rem] overflow-auto">
            {loading ? (
              <div className="p-3"><SkeletonRows count={8} /></div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">この月の打刻記録はありません</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">日付</th>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">状況</th>
                    <th className="px-2 py-1.5 text-left font-medium">出勤</th>
                    <th className="px-2 py-1.5 text-left font-medium">退勤</th>
                    <th className="px-2 py-1.5 text-left font-medium">休憩</th>
                    <th className="px-2 py-1.5 text-left font-medium">実働</th>
                    <th className="px-2 py-1.5 text-left font-medium">残業</th>
                    <th className="px-2 py-1.5 text-left font-medium">区分</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                      <td className="px-2 py-1.5 whitespace-nowrap">{r.work_date}</td>
                      <td className="px-2 py-1.5 font-medium">{empName(r.employee_id)}</td>
                      <td className="px-2 py-1.5">
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', attendanceStatusColor(r.status))}>
                          {r.status ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtTime(r.clock_in_at)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtTime(r.clock_out_at)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtMinutes(r.total_break_minutes)}</td>
                      <td className="px-2 py-1.5">{fmtMinutes(r.work_minutes)}</td>
                      <td className="px-2 py-1.5">{fmtMinutes(r.overtime_minutes)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{locationLabel(r.work_location_type)}</td>
                      {perms.canManage && (
                        <td className="px-2 py-1.5">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                            <Pencil className="h-3.5 w-3.5" />修正
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* 修正ダイアログ */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) { setEditing(null); setForm(null) } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>打刻修正</DialogTitle>
          </DialogHeader>
          {editing && form && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                <span className="text-muted-foreground">対象</span>
                <span className="font-medium">{empName(editing.employee_id)}／{editing.work_date}</span>
              </div>

              <label className="block space-y-1">
                <span className="text-2xs text-muted-foreground">状況</span>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ATTENDANCE_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-2xs text-muted-foreground">出勤</span>
                  <Input type="time" className="h-8 text-xs" value={form.clockIn} onChange={(e) => setForm({ ...form, clockIn: e.target.value })} />
                </label>
                <label className="block space-y-1">
                  <span className="text-2xs text-muted-foreground">退勤</span>
                  <Input type="time" className="h-8 text-xs" value={form.clockOut} onChange={(e) => setForm({ ...form, clockOut: e.target.value })} />
                </label>
                <label className="block space-y-1">
                  <span className="text-2xs text-muted-foreground">休憩開始</span>
                  <Input type="time" className="h-8 text-xs" value={form.breakStart} onChange={(e) => setForm({ ...form, breakStart: e.target.value })} />
                </label>
                <label className="block space-y-1">
                  <span className="text-2xs text-muted-foreground">休憩終了</span>
                  <Input type="time" className="h-8 text-xs" value={form.breakEnd} onChange={(e) => setForm({ ...form, breakEnd: e.target.value })} />
                </label>
                <label className="block space-y-1">
                  <span className="text-2xs text-muted-foreground">休憩合計（分）</span>
                  <Input type="number" min={0} className="h-8 text-xs" value={form.totalBreak} onChange={(e) => setForm({ ...form, totalBreak: e.target.value })} />
                </label>
                <label className="block space-y-1">
                  <span className="text-2xs text-muted-foreground">区分</span>
                  <Select value={form.location} onValueChange={(v) => setForm({ ...form, location: v })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {WORK_LOCATION_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
              </div>

              <div className="flex items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={form.isLate} onChange={(e) => setForm({ ...form, isLate: e.target.checked })} />
                  遅刻
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={form.isEarlyLeave} onChange={(e) => setForm({ ...form, isEarlyLeave: e.target.checked })} />
                  早退
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-2xs text-muted-foreground">メモ</span>
                <Textarea rows={2} className="text-xs" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </label>

              <p className="text-2xs text-muted-foreground">保存時に実働・残業・深夜を自動再計算します。退勤が出勤より前の時刻の場合は翌日扱い（日跨ぎ夜勤）として計算します。</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setEditing(null); setForm(null) }}>キャンセル</Button>
            <Button size="sm" disabled={saving} onClick={saveEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 代理打刻ダイアログ */}
      <Dialog open={proxyOpen} onOpenChange={setProxyOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>代理打刻（新規作成）</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <label className="block space-y-1">
              <span className="text-2xs text-muted-foreground">従業員</span>
              <Select value={proxyEmp} onValueChange={setProxyEmp}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-2xs text-muted-foreground">日付</span>
              <Input type="date" className="h-8 text-xs" value={proxyDate} onChange={(e) => setProxyDate(e.target.value)} />
            </label>
            <p className="text-2xs text-muted-foreground">レコード作成後、一覧の「修正」から時刻を入力してください。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setProxyOpen(false)}>キャンセル</Button>
            <Button size="sm" disabled={saving || !proxyEmp} onClick={createProxy}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

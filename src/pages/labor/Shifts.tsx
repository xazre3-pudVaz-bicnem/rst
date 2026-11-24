import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Trash2, CalendarDays } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
import { EmployeeApi, ShiftApi, LaborAuditApi } from '@/lib/api'
import { laborPerms, SHIFT_TYPES, SHIFT_STATUSES, fmtTime, monthStr } from '@/lib/labor'
import type { Employee, WorkShift } from '@/lib/types'

const ALL = '__all__'
const WEEK = ['日', '月', '火', '水', '木', '金', '土']

/** その月の日付（YYYY-MM-DD）を1日から末日まで並べる */
function daysOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return []
  const last = new Date(y, m, 0).getDate()
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
}
/** 予定の実働分（開始〜終了 − 休憩）。時間が入っていなければ0 */
function plannedMinutes(s: WorkShift): number {
  if (!s.planned_start_at || !s.planned_end_at) return 0
  const diff = (Date.parse(s.planned_end_at) - Date.parse(s.planned_start_at)) / 60000
  if (!Number.isFinite(diff) || diff <= 0) return 0
  return Math.max(0, Math.round(diff) - (s.planned_break_minutes ?? 0))
}
/** セルに出す短い表記。9:00〜18:00 → 「9-18」、分があれば「9:30-18」 */
function cellLabel(s: WorkShift): string {
  if (s.shift_type === '休み') return '休'
  const short = (ts?: string | null) => {
    if (!ts) return ''
    const d = new Date(ts)
    return d.getMinutes() === 0 ? String(d.getHours()) : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const a = short(s.planned_start_at), b = short(s.planned_end_at)
  return a || b ? `${a}-${b}` : (s.shift_type || '—')
}

/** TIMESTAMPTZ → "HH:mm"（time input 用）。null/不正は空文字。 */
function hhmm(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 日付(YYYY-MM-DD) + "HH:mm" → ISO 文字列。どちらか空なら null。 */
function toIso(date: string, time: string): string | null {
  if (!date || !time) return null
  const d = new Date(`${date}T${time}:00`)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** ローカルの本日 YYYY-MM-DD */
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface ShiftForm {
  employee_id: string
  shift_date: string
  shift_type: string
  start: string
  end: string
  break: string
  status: string
  note: string
}

function emptyForm(): ShiftForm {
  return {
    employee_id: '', shift_date: todayLocal(), shift_type: '通常',
    start: '', end: '', break: '60', status: '希望', note: '',
  }
}

function shiftStatusVariant(status?: string | null): 'default' | 'secondary' | 'warning' | 'success' | 'outline' {
  switch (status) {
    case '確定': return 'success'
    case '申請中': return 'warning'
    case '変更申請中': return 'warning'
    case '希望': return 'secondary'
    default: return 'outline'
  }
}

export default function Shifts() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [month, setMonth] = useState<string>(monthStr())
  const [empFilter, setEmpFilter] = useState<string>(ALL)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [shifts, setShifts] = useState<WorkShift[]>([])
  const [loading, setLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<WorkShift | null>(null)
  const [form, setForm] = useState<ShiftForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, rows] = await Promise.all([
        EmployeeApi.list(),
        ShiftApi.listByMonth(month),
      ])
      setEmployees(emps)
      setShifts(rows)
    } catch (e) {
      console.error('[Shifts]', e)
      toast.error(e instanceof Error ? e.message : 'シフトの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [month, toast])

  useEffect(() => { load() }, [load])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])

  const scoped = useMemo(() => {
    if (perms.selfOnly) {
      const me = employees.find((e) => e.user_id && user?.id && e.user_id === user.id)
      return me ? shifts.filter((s) => s.employee_id === me.id) : []
    }
    return shifts
  }, [shifts, employees, perms.selfOnly, user?.id])

  const filtered = useMemo(
    () => (empFilter === ALL ? scoped : scoped.filter((s) => s.employee_id === empFilter)),
    [scoped, empFilter],
  )

  // 月間シフト表: 「従業員 × 日付」で引けるようにしておく
  const days = useMemo(() => daysOfMonth(month), [month])
  const gridEmployees = useMemo(
    () => (empFilter === ALL ? activeEmployees : activeEmployees.filter((e) => e.id === empFilter)),
    [activeEmployees, empFilter],
  )
  const shiftAt = useMemo(() => {
    const m = new Map<string, WorkShift>()
    for (const s of scoped) m.set(`${s.employee_id}|${s.shift_date}`, s)
    return m
  }, [scoped])
  /** 人ごとの合計（予定時間と、時給者はおおよその人件費） */
  const totals = useMemo(() => {
    const m = new Map<string, { minutes: number; days: number; cost: number }>()
    for (const e of gridEmployees) {
      let minutes = 0, dcount = 0
      for (const d of days) {
        const s = shiftAt.get(`${e.id}|${d}`)
        if (!s || s.shift_type === '休み') continue
        const mm = plannedMinutes(s)
        if (mm > 0) { minutes += mm; dcount++ }
      }
      m.set(e.id, { minutes, days: dcount, cost: Math.round((e.hourly_wage || 0) * (minutes / 60)) })
    }
    return m
  }, [gridEmployees, days, shiftAt])

  const setField = (k: keyof ShiftForm, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  function openCreate() {
    setEditing(null)
    setForm({ ...emptyForm(), shift_date: `${month}-01` })
    setDialogOpen(true)
  }

  /** シフト表のセルから。その人・その日で新規作成する */
  function openCreateAt(employeeId: string, date: string) {
    setEditing(null)
    setForm({ ...emptyForm(), employee_id: employeeId, shift_date: date })
    setDialogOpen(true)
  }

  function openEdit(s: WorkShift) {
    setEditing(s)
    setForm({
      employee_id: s.employee_id,
      shift_date: s.shift_date,
      shift_type: s.shift_type ?? '通常',
      start: hhmm(s.planned_start_at),
      end: hhmm(s.planned_end_at),
      break: s.planned_break_minutes == null ? '' : String(s.planned_break_minutes),
      status: s.status ?? '希望',
      note: s.note ?? '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!perms.canManage) return
    if (!form.employee_id) { toast.error('従業員を選択してください'); return }
    if (!form.shift_date) { toast.error('日付を入力してください'); return }
    const breakNum = form.break.trim() === '' ? null : Number(form.break)
    const payload: Partial<WorkShift> & { employee_id: string; shift_date: string } = {
      employee_id: form.employee_id,
      shift_date: form.shift_date,
      shift_type: form.shift_type || null,
      planned_start_at: toIso(form.shift_date, form.start),
      planned_end_at: toIso(form.shift_date, form.end),
      planned_break_minutes: breakNum == null || Number.isNaN(breakNum) ? null : breakNum,
      status: form.status || null,
      note: form.note.trim() === '' ? null : form.note.trim(),
    }
    setSaving(true)
    try {
      let targetId: string
      if (editing) {
        await ShiftApi.update(editing.id, payload)
        targetId = editing.id
      } else {
        payload.created_by = user?.id ?? null
        const created = await ShiftApi.upsert(payload)
        targetId = created.id
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: form.employee_id,
        action: 'シフト登録', target_table: 'work_shifts', target_id: targetId, after_data: payload,
      })
      toast.success(editing ? 'シフトを更新しました' : 'シフトを登録しました')
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
    const empName = empMap.get(editing.employee_id)?.name ?? '従業員'
    if (!window.confirm(`「${empName}」${editing.shift_date} のシフトを削除します。よろしいですか？`)) return
    setSaving(true)
    try {
      await ShiftApi.remove(editing.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: editing.employee_id,
        action: 'シフト登録', target_table: 'work_shifts', target_id: editing.id,
        after_data: { deleted: true, shift_date: editing.shift_date },
      })
      toast.success('シフトを削除しました')
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
          Supabase が未設定です。
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
            <h1 className="flex items-center gap-1.5 text-lg font-bold">
              <CalendarDays className="h-5 w-5 text-primary" />シフト管理
            </h1>
            <p className="text-2xs text-muted-foreground">従業員ごとのシフト登録・確認</p>
          </div>
          {perms.canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />シフト登録
            </Button>
          )}
        </div>

        {/* フィルタ */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <div className="w-52">
            <Select value={empFilter} onValueChange={setEmpFilter}>
              <SelectTrigger><SelectValue placeholder="従業員" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての従業員</SelectItem>
                {employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 月間シフト表（縦=従業員 / 横=日）。セルを押すとその人のその日を編集できる */}
        <div className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-sm font-bold">月間シフト表</span>
            <span className="text-2xs text-muted-foreground">
              空いているマスを押すとシフトを登録できます（「休」は休み・数字は開始〜終了時刻）
            </span>
          </div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={5} /></div>
          ) : gridEmployees.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">在籍中の従業員がいません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-2xs">
                <thead>
                  <tr className="bg-muted/60">
                    <th className="sticky left-0 z-10 min-w-[108px] bg-muted/60 px-2 py-1.5 text-left font-medium">従業員</th>
                    {days.map((d) => {
                      const w = new Date(`${d}T00:00:00`).getDay()
                      return (
                        <th key={d} className={`min-w-[42px] px-1 py-1 text-center font-medium ${w === 0 ? 'text-red-600 dark:text-red-400' : w === 6 ? 'text-sky-600 dark:text-sky-400' : 'text-muted-foreground'}`}>
                          <div>{Number(d.slice(-2))}</div>
                          <div className="text-[9px]">{WEEK[w]}</div>
                        </th>
                      )
                    })}
                    <th className="min-w-[96px] px-2 py-1 text-right font-medium text-muted-foreground">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {gridEmployees.map((e) => {
                    const t = totals.get(e.id)
                    return (
                      <tr key={e.id} className="border-t">
                        <td className="sticky left-0 z-10 bg-card px-2 py-1 font-medium">
                          <div className="truncate">{e.name}</div>
                          <div className="text-[9px] font-normal text-muted-foreground">
                            {e.employment_type || '—'}{e.hourly_wage ? ` / 時給¥${e.hourly_wage.toLocaleString()}` : ''}
                          </div>
                        </td>
                        {days.map((d) => {
                          const sh = shiftAt.get(`${e.id}|${d}`)
                          const w = new Date(`${d}T00:00:00`).getDay()
                          const rest = sh?.shift_type === '休み'
                          return (
                            <td key={d} className={`border-l p-0 text-center ${w === 0 || w === 6 ? 'bg-muted/40' : ''}`}>
                              <button
                                type="button"
                                disabled={!perms.canManage}
                                onClick={() => (sh ? openEdit(sh) : openCreateAt(e.id, d))}
                                title={sh ? `${e.name} ${d}` : `${e.name} ${d} にシフトを登録`}
                                className={`h-9 w-full px-0.5 leading-tight transition-colors ${
                                  rest ? 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                                    : sh ? 'bg-emerald-100 font-medium text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-100'
                                      : 'text-muted-foreground/40 hover:bg-accent'
                                } ${perms.canManage ? 'cursor-pointer' : 'cursor-default'}`}
                              >
                                {sh ? cellLabel(sh) : '+'}
                              </button>
                            </td>
                          )
                        })}
                        <td className="border-l px-2 py-1 text-right tabular-nums">
                          <div className="font-bold">{Math.floor((t?.minutes ?? 0) / 60)}時間{(t?.minutes ?? 0) % 60 ? `${(t?.minutes ?? 0) % 60}分` : ''}</div>
                          <div className="text-[9px] text-muted-foreground">
                            {t?.days ?? 0}日{t?.cost ? ` / 約¥${t.cost.toLocaleString()}` : ''}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
            合計は予定時間（開始〜終了−休憩）です。時給を設定している人は、おおよその人件費も出します。
            アポ歩合は実績ぶんなので、給与計算の画面で加算されます。
          </p>
        </div>

        {/* テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">シフト一覧（{filtered.length}）</div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">この月のシフトはありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">日付</th>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">区分</th>
                    <th className="px-2 py-1.5 text-left font-medium">予定開始</th>
                    <th className="px-2 py-1.5 text-left font-medium">予定終了</th>
                    <th className="px-2 py-1.5 text-left font-medium">休憩(分)</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr key={s.id} className="border-b last:border-0 hover:bg-accent/50">
                      <td className="px-2 py-1.5 font-medium">{s.shift_date}</td>
                      <td className="px-2 py-1.5">{empMap.get(s.employee_id)?.name ?? '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{s.shift_type ?? '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtTime(s.planned_start_at)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtTime(s.planned_end_at)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{s.planned_break_minutes ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant={shiftStatusVariant(s.status)}>{s.status ?? '—'}</Badge>
                      </td>
                      {perms.canManage && (
                        <td className="px-2 py-1.5">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(s)}>
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

      {/* 登録・編集ダイアログ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'シフトの編集' : 'シフト登録'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>従業員 *</Label>
              <Select value={form.employee_id} onValueChange={(v) => setField('employee_id', v)}>
                <SelectTrigger><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>日付 *</Label>
              <Input type="date" value={form.shift_date} onChange={(e) => setField('shift_date', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>区分</Label>
              <Select value={form.shift_type} onValueChange={(v) => setField('shift_type', v)}>
                <SelectTrigger><SelectValue placeholder="区分" /></SelectTrigger>
                <SelectContent>
                  {SHIFT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>予定開始</Label>
              <Input type="time" value={form.start} onChange={(e) => setField('start', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>予定終了</Label>
              <Input type="time" value={form.end} onChange={(e) => setField('end', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>休憩（分）</Label>
              <Input type="number" value={form.break} onChange={(e) => setField('break', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>ステータス</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
                <SelectContent>
                  {SHIFT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>メモ</Label>
              <Textarea value={form.note} onChange={(e) => setField('note', e.target.value)} rows={2} />
            </div>
          </div>

          <DialogFooter>
            {editing && perms.canManage && (
              <Button variant="destructive" size="sm" onClick={handleDelete} disabled={saving} className="mr-auto">
                <Trash2 className="h-3.5 w-3.5" />削除
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>キャンセル</Button>
            {perms.canManage && (
              <Button size="sm" onClick={handleSave} disabled={saving || !form.employee_id || !form.shift_date}>
                {saving ? '保存中…' : editing ? '更新' : '登録'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

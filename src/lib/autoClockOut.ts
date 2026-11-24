// ============================================================
// 自動退勤。退勤打刻を忘れた人を、決まった時刻（既定18:30）で退勤にする。
//
//   打刻忘れがあると勤怠が「出勤中」のまま残り、労働時間も残業も集計できない。
//   毎日しめ忘れを手で直すのは現実的でないため、巡回Cronのついでに閉じる。
//
//   閉じる時刻 = その日の labor_settings.auto_clock_out_time（JST）。
//   ※Vercelの実行環境はUTCなので、日付の切り出しは必ずJSTに直してから行う。
//   出勤が締め時刻より後だった日（夜だけ働いた等）は締め時刻で閉じると0分や
//   マイナスになるため、その日が終わってから23:59で閉じる。
//   休憩の開始だけ残っている場合は、退勤と同じ時刻で休憩も閉じる。
// ============================================================
import { computeAttendance, scheduledMinutesFor } from './labor.js'

const JST_OFFSET_MS = 9 * 3600000

/** UTCのDate → JSTの「YYYY-MM-DD」 */
function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}
/** JSTの「YYYY-MM-DD HH:mm」→ UTCのISO文字列 */
function jstToIso(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00+09:00`).toISOString()
}
/** 'HH:MM' の体裁か */
function validTime(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

export interface AutoClockOutResult {
  ok: boolean
  skipped?: string
  /** 自動で閉じた件数 */
  closed: number
  /** 閉じた内訳（画面やログ用） */
  details: { employeeId: string; workDate: string; clockOutAt: string; minutes: number }[]
  error?: string
}

/**
 * 退勤打刻のない勤怠を自動で閉じる。過去7日ぶんまで面倒を見る（連休明けの取りこぼし対策）。
 * 何度呼んでも同じ結果になる（既に退勤済みの行は対象外）。
 */
export async function runAutoClockOut(admin: any, nowMs = Date.now()): Promise<AutoClockOutResult> {
  const out: AutoClockOutResult = { ok: true, closed: 0, details: [] }
  try {
    const { data: st } = await admin.from('labor_settings').select('*').limit(1)
    const settings = st?.[0] || null
    if (settings && settings.auto_clock_out_enabled === false) return { ...out, skipped: '自動退勤はOFF' }
    const cutoffTime = validTime(String(settings?.auto_clock_out_time || '')) ? String(settings.auto_clock_out_time) : '18:30'

    const today = jstDate(nowMs)
    const since = jstDate(nowMs - 7 * 86400000)
    const { data: recs, error } = await admin
      .from('attendance_records')
      .select('id,employee_id,work_date,clock_in_at,clock_out_at,break_start_at,break_end_at,total_break_minutes,status,note')
      .is('clock_out_at', null)
      .not('clock_in_at', 'is', null)
      .gte('work_date', since)
      .lte('work_date', today)
      .limit(200)
    if (error) return { ...out, ok: false, error: error.message }
    if (!recs?.length) return out

    // 所定労働時間は人ごとに違う（残業の計算に使う）
    const empIds = [...new Set(recs.map((r: any) => r.employee_id).filter(Boolean))]
    const { data: emps } = empIds.length
      ? await admin.from('employees').select('id,standard_work_start,standard_work_end,standard_break_minutes').in('id', empIds)
      : { data: [] as any[] }
    const empById = new Map((emps || []).map((e: any) => [e.id, e]))

    for (const r of recs as any[]) {
      const cutoffIso = jstToIso(r.work_date, cutoffTime)
      const cutoffMs = Date.parse(cutoffIso)
      const inMs = Date.parse(r.clock_in_at)
      let closeIso = cutoffIso

      if (!Number.isFinite(inMs)) continue
      if (inMs >= cutoffMs) {
        // 締め時刻より後に出勤した日。その日が終わるまでは手で退勤できるよう待ち、
        // 日付が変わってから23:59で閉じる。
        if (r.work_date >= today) continue
        closeIso = jstToIso(r.work_date, '23:59')
        if (Date.parse(closeIso) <= inMs) continue   // それでも整合しない行は触らない
      } else if (nowMs < cutoffMs) {
        continue   // まだ締め時刻前
      }

      // 休憩が開始したままなら、退勤と同じ時刻で閉じる
      const breakEnd = r.break_start_at && !r.break_end_at ? closeIso : r.break_end_at
      const emp = empById.get(r.employee_id) || null
      const scheduled = scheduledMinutesFor(emp as any, settings as any)
      const calc = computeAttendance(
        { clock_in_at: r.clock_in_at, clock_out_at: closeIso, break_start_at: r.break_start_at, break_end_at: breakEnd, total_break_minutes: r.total_break_minutes },
        scheduled, 540,   // 深夜帯はJSTで判定（Vercelの関数はUTCで動くため）
      )
      const note = [r.note, `${cutoffTime}に自動退勤（退勤打刻なし）`].filter(Boolean).join(' / ').slice(0, 500)
      const { error: ue } = await admin.from('attendance_records').update({
        clock_out_at: closeIso,
        break_end_at: breakEnd,
        clock_out_method: '自動',
        status: '退勤済',
        work_minutes: calc.workMinutes,
        overtime_minutes: calc.overtimeMinutes,
        late_night_minutes: calc.lateNightMinutes,
        total_break_minutes: calc.breakMinutes,
        note,
        updated_at: new Date().toISOString(),
      }).eq('id', r.id).is('clock_out_at', null)   // 手で退勤された直後の上書きを防ぐ
      if (ue) continue
      out.closed++
      out.details.push({ employeeId: r.employee_id, workDate: r.work_date, clockOutAt: closeIso, minutes: calc.workMinutes })
    }
    return out
  } catch (e: any) {
    return { ...out, ok: false, error: String(e?.message || e) }
  }
}

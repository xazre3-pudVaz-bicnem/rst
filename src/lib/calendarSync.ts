// ============================================================
// 訪問予定→Googleカレンダー反映のクライアント側ヘルパー。
// 反映ON/OFFは app_config('calendar_sync').enabled。実処理・秘密鍵はサーバー(/api/calendar/sync)側。
// ============================================================
import { supabase } from './supabaseClient'
import type { Appointment, Case } from './types'
import moment from 'moment'

export interface CalStatus { configured: boolean; reachable?: boolean; error?: string | null; calendarId?: string | null; enabled?: boolean }

export const CalendarApi = {
  /** サーバーの接続状態＋設定のON/OFF。 */
  async status(): Promise<CalStatus> {
    try {
      const r = await fetch('/api/calendar/sync', { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      const { data } = await supabase.from('app_config').select('value').eq('key', 'calendar_sync').maybeSingle()
      return { configured: !!j.configured, reachable: j.reachable, error: j.error, calendarId: j.calendarId, enabled: (data?.value as any)?.enabled === true }
    } catch { return { configured: false } }
  },
  async setEnabled(enabled: boolean): Promise<void> {
    await supabase.from('app_config').upsert({ key: 'calendar_sync', value: { enabled }, updated_date: new Date().toISOString() }, { onConflict: 'key' })
  },
  async isEnabled(): Promise<boolean> {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'calendar_sync').maybeSingle()
    return (data?.value as any)?.enabled === true
  },
  async post(payload: any): Promise<any> {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return { ok: false, error: 'no-auth' }
    const r = await fetch('/api/calendar/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) })
    return r.json().catch(() => ({ ok: false }))
  },
}

export interface SyncResult { synced: boolean; skipped?: boolean; reason?: string; error?: string; eventId?: string | null }

/** 訪問予定→カレンダー予定を作成/更新し、成功/スキップ/失敗を返す（画面に明確表示する用途）。例外は投げない。 */
export async function syncAppointmentResult(appt: Appointment, kase?: Case | null): Promise<SyncResult> {
  try {
    if (!(await CalendarApi.isEnabled())) return { synced: false, skipped: true, reason: 'Googleカレンダー反映がOFF（設定でON可）' }
    const summary = `訪問: ${appt.case_name || kase?.name || '案件'}`
    const description = [`案件: ${appt.case_name || ''}`, appt.sales_rep ? `担当: ${appt.sales_rep}` : '', kase?.phone1 ? `電話: ${kase.phone1}` : '', appt.memo ? `メモ: ${appt.memo}` : '', 'RSTの訪問予定から自動反映（TimeRexの空き枠に反映されます）'].filter(Boolean).join('\n')
    const r = await CalendarApi.post({ action: appt.google_event_id ? 'update' : 'create', eventId: appt.google_event_id || undefined, appointmentId: appt.id, summary, description, location: appt.address || kase?.address || '', start: moment(appt.appo_at).toISOString(), durationMin: 60 })
    if (r?.skipped) return { synced: false, skipped: true, reason: r.reason || 'Googleカレンダー未設定（サーバー環境変数）' }
    if (r?.ok) return { synced: true, eventId: r.eventId ?? appt.google_event_id ?? null }
    return { synced: false, error: r?.error || 'カレンダー反映に失敗しました' }
  } catch (e: any) { return { synced: false, error: String(e?.message || e) } }
}

/** 訪問予定→カレンダー予定の作成/更新。設定OFFや未設定なら何もしない。失敗しても例外は投げない（訪問登録は成功させる）。 */
export async function syncAppointment(appt: Appointment, kase?: Case | null): Promise<void> {
  try {
    if (!(await CalendarApi.isEnabled())) return
    const summary = `訪問: ${appt.case_name || kase?.name || '案件'}`
    const description = [`案件: ${appt.case_name || ''}`, appt.sales_rep ? `担当: ${appt.sales_rep}` : '', kase?.phone1 ? `電話: ${kase.phone1}` : '', appt.memo ? `メモ: ${appt.memo}` : '', 'RSTの訪問予定から自動反映（TimeRexの空き枠に反映されます）'].filter(Boolean).join('\n')
    await CalendarApi.post({ action: appt.google_event_id ? 'update' : 'create', eventId: appt.google_event_id || undefined, appointmentId: appt.id, summary, description, location: appt.address || kase?.address || '', start: moment(appt.appo_at).toISOString(), durationMin: 60 })
  } catch { /* 反映失敗は訪問登録を妨げない */ }
}

/** 訪問予定の削除に合わせてカレンダー予定も削除。 */
export async function deleteAppointmentEvent(appt: Appointment): Promise<void> {
  try { if (appt.google_event_id && (await CalendarApi.isEnabled())) await CalendarApi.post({ action: 'delete', eventId: appt.google_event_id }) } catch { /* noop */ }
}

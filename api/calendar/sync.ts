// ============================================================
// /api/calendar/sync … 訪問予定 → Googleカレンダー反映（サービスアカウント・サーバー専用）
//   GET  … 接続状態（configured / test）。秘密鍵は返さない。
//   POST … 要ログイン(JWT)。action: create/update/delete。TimeRexが連携カレンダーを見て空き枠を外す用途。
// 12関数制限のため専用エンドポイント（旧 cron/regional-media-leads を整理して枠を確保）。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { isCalendarConfigured, testCalendar, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from '../../src/lib/googleCalendar.js'

export const config = { maxDuration: 30 }

export default async function handler(req: any, res: any) {
  // 接続状態（キー本体は出さない）
  if (req.method === 'GET') {
    const configured = isCalendarConfigured()
    if (!configured) return res.status(200).json({ ok: true, configured: false, calendarId: null })
    const t = await testCalendar()
    return res.status(200).json({ ok: true, configured: true, reachable: t.ok, error: t.error || null, calendarId: process.env.GOOGLE_CALENDAR_ID || null })
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' })

  // 認可（要ログイン）
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ ok: false, error: 'SUPABASE未設定' })
  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ ok: false, error: 'ログインが必要です' })
  const { data: userData } = await admin.auth.getUser(token)
  if (!userData?.user) return res.status(401).json({ ok: false, error: 'セッション切れの可能性' })

  if (!isCalendarConfigured()) return res.status(200).json({ ok: true, skipped: true, reason: 'Googleカレンダー未設定（サービスアカウント/カレンダーID）。反映はスキップしました。' })

  const b = req.body || {}
  const action = b.action
  try {
    if (action === 'delete') {
      if (b.eventId) await deleteCalendarEvent(String(b.eventId))
      return res.status(200).json({ ok: true, deleted: true })
    }
    const ev = { summary: String(b.summary || '訪問予定').slice(0, 200), description: String(b.description || '').slice(0, 2000), location: String(b.location || '').slice(0, 300), startIso: String(b.start), durationMin: Number(b.durationMin) || 60 }
    if (!ev.startIso || Number.isNaN(Date.parse(ev.startIso))) return res.status(400).json({ ok: false, error: '開始日時が不正です' })
    if (action === 'update' && b.eventId) { await updateCalendarEvent(String(b.eventId), ev); return res.status(200).json({ ok: true, eventId: String(b.eventId) }) }
    const eventId = await createCalendarEvent(ev)
    // appointmentに紐付け保存（idがあれば）
    if (b.appointmentId) await admin.from('appointments').update({ google_event_id: eventId, google_synced_at: new Date().toISOString(), google_sync_error: null }).eq('id', b.appointmentId).then(() => {}, () => {})
    return res.status(200).json({ ok: true, eventId })
  } catch (e: any) {
    if (b.appointmentId) await admin.from('appointments').update({ google_sync_error: String(e?.message || e).slice(0, 300) }).eq('id', b.appointmentId).then(() => {}, () => {})
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

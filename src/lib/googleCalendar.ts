// ============================================================
// Googleカレンダー連携（サービスアカウント）。サーバー専用・秘密鍵はフロントに出さない。
// 用途: RSTの訪問登録 → 連携カレンダーに予定作成 → TimeRexがそのカレンダーを見て枠を空きから外す。
// 必要な環境変数（未設定なら機能は自動スキップ）:
//   GOOGLE_CALENDAR_ID              … TimeRexが連携しているカレンダーID（例: xxxx@group.calendar.google.com）
//   GOOGLE_SA_CLIENT_EMAIL          … サービスアカウントのメール（このカレンダーに「予定の変更」権限で共有しておく）
//   GOOGLE_SA_PRIVATE_KEY           … サービスアカウントの秘密鍵（\n はそのままでOK）
// 依存追加なし（Node crypto で RS256 署名 → OAuthトークン交換 → Calendar REST）。
// ============================================================
import crypto from 'crypto'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/calendar'
const TZ = 'Asia/Tokyo'

export function isCalendarConfigured(): boolean {
  return !!(process.env.GOOGLE_CALENDAR_ID && process.env.GOOGLE_SA_CLIENT_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY)
}
function privateKey(): string { return String(process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n') }
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

let cachedToken: { token: string; exp: number } | null = null
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({ iss: process.env.GOOGLE_SA_CLIENT_EMAIL, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now }))
  const signingInput = `${header}.${claim}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey()).toString('base64url')
  const jwt = `${signingInput}.${signature}`
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) })
  const j: any = await res.json()
  if (!res.ok || !j.access_token) throw new Error(`Googleトークン取得失敗: ${j.error_description || j.error || res.status}`)
  cachedToken = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) }
  return j.access_token
}

export interface CalEvent { summary: string; description?: string; location?: string; startIso: string; endIso?: string; durationMin?: number }
function toBody(e: CalEvent) {
  const start = new Date(e.startIso)
  const end = e.endIso ? new Date(e.endIso) : new Date(start.getTime() + (e.durationMin || 60) * 60000)
  return { summary: e.summary, description: e.description || '', location: e.location || '', start: { dateTime: start.toISOString(), timeZone: TZ }, end: { dateTime: end.toISOString(), timeZone: TZ } }
}
function calUrl(path = '') { return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(process.env.GOOGLE_CALENDAR_ID))}/events${path}` }

/** 予定を作成 → eventId を返す。 */
export async function createCalendarEvent(e: CalEvent): Promise<string> {
  const token = await getAccessToken()
  const res = await fetch(calUrl(), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(toBody(e)) })
  const j: any = await res.json()
  if (!res.ok || !j.id) throw new Error(`カレンダー予定作成失敗: ${j.error?.message || res.status}`)
  return j.id
}
/** 既存予定を更新。 */
export async function updateCalendarEvent(eventId: string, e: CalEvent): Promise<void> {
  const token = await getAccessToken()
  const res = await fetch(calUrl(`/${encodeURIComponent(eventId)}`), { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(toBody(e)) })
  if (!res.ok) { const j: any = await res.json().catch(() => ({})); throw new Error(`カレンダー予定更新失敗: ${j.error?.message || res.status}`) }
}
/** 予定を削除（404は成功扱い）。 */
export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const token = await getAccessToken()
  const res = await fetch(calUrl(`/${encodeURIComponent(eventId)}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok && res.status !== 404 && res.status !== 410) { const j: any = await res.json().catch(() => ({})); throw new Error(`カレンダー予定削除失敗: ${j.error?.message || res.status}`) }
}
/** freebusyで指定期間の予定占有時間帯を取得（[startIso,endIso)の配列）。未設定/失敗時は空配列。 */
export async function getBusyTimes(startIso: string, endIso: string): Promise<{ start: string; end: string }[]> {
  if (!isCalendarConfigured()) return []
  try {
    const token = await getAccessToken()
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: startIso, timeMax: endIso, timeZone: TZ, items: [{ id: String(process.env.GOOGLE_CALENDAR_ID) }] }),
    })
    const j: any = await res.json().catch(() => ({}))
    const cal = j?.calendars?.[String(process.env.GOOGLE_CALENDAR_ID)]
    return Array.isArray(cal?.busy) ? cal.busy : []
  } catch { return [] }
}

/** 平日の営業時間帯(10-17時)で、Googleカレンダーの空き枠を生成して返す。 */
export async function getAvailableSlots(days = 3, count = 6): Promise<string[]> {
  const now = new Date()
  const startIso = now.toISOString()
  const end = new Date(now.getTime() + (days + 2) * 86400000)
  const busy = await getBusyTimes(startIso, end.toISOString())
  const overlaps = (s: Date, e: Date) => busy.some((b) => new Date(b.start) < e && new Date(b.end) > s)
  const slots: string[] = []
  for (let d = 1; d <= days + 3 && slots.length < count; d++) {
    const day = new Date(now.getTime() + d * 86400000)
    const dow = day.getDay()
    if (dow === 0 || dow === 6) continue // 土日除外
    for (const h of [10, 11, 13, 14, 15, 16]) {
      if (slots.length >= count) break
      const s = new Date(day); s.setHours(h, 0, 0, 0)
      const e = new Date(s.getTime() + 60 * 60000)
      if (!overlaps(s, e)) slots.push(s.toISOString())
    }
  }
  return slots
}

/** 接続テスト（トークン取得＋カレンダー存在確認）。 */
export async function testCalendar(): Promise<{ ok: boolean; error?: string }> {
  try { const token = await getAccessToken(); const res = await fetch(calUrl('?maxResults=1'), { headers: { Authorization: `Bearer ${token}` } }); if (!res.ok) { const j: any = await res.json().catch(() => ({})); return { ok: false, error: j.error?.message || `HTTP ${res.status}` } } return { ok: true } }
  catch (e: any) { return { ok: false, error: String(e?.message || e) } }
}

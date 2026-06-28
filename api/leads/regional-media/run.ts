// ============================================================
// POST /api/leads/regional-media/run … 地域メディア巡回 手動実行（要ログイン）
// GET  /api/leads/regional-media/run … 接続状態（有効サイト数・MAPSキー有無）
// ============================================================
import { getAdminClient } from '../../../src/lib/googlePlacesRun.js'
import { runRegionalMedia } from '../../../src/lib/regionalMediaRun.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(200).json({ ok: true, configured: false, activeSites: 0, hasMapsKey: !!process.env.GOOGLE_MAPS_API_KEY })
    }
    try {
      const admin = getAdminClient()
      const { count } = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true)
      return res.status(200).json({ ok: true, configured: (count || 0) > 0, activeSites: count || 0, hasMapsKey: !!process.env.GOOGLE_MAPS_API_KEY })
    } catch (e: any) {
      return res.status(200).json({ ok: true, configured: false, activeSites: 0, error: String(e?.message || e) })
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ error: String(e?.message || e) }) }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'ログインが必要です' })
  const { data: userData } = await admin.auth.getUser(token)
  if (!userData?.user) return res.status(401).json({ error: 'ログインが必要です（セッション切れの可能性）' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  try {
    const result = await runRegionalMedia(admin, process.env.GOOGLE_MAPS_API_KEY || null, body?.settings || {}, userData.user.id)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return {} } }

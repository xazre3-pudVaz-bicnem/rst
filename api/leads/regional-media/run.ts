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
    const supaUrl = process.env.SUPABASE_URL || ''
    const hasUrl = supaUrl.length > 0
    const hasRole = !!process.env.SUPABASE_SERVICE_ROLE_KEY
    let projectRef: string | null = null
    try { projectRef = hasUrl ? new URL(supaUrl).host.split('.')[0] : null } catch { projectRef = null }

    if (!hasUrl || !hasRole) {
      return res.status(200).json({
        ok: true, configured: false, totalSites: null, activeSites: null,
        hasUrl, hasRole, projectRef, hasMapsKey: !!process.env.GOOGLE_MAPS_API_KEY,
        error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（Vercel環境変数）',
      })
    }
    try {
      const admin = getAdminClient()
      // service role で総数と有効数を取得（RLSはバイパス）
      const total = await admin.from('source_sites').select('id', { count: 'exact', head: true })
      const active = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true)
      const err = total.error?.message || active.error?.message || null
      const totalSites = total.count ?? null
      const activeSites = active.count ?? null
      return res.status(200).json({
        ok: true, configured: (activeSites || 0) > 0, totalSites, activeSites,
        hasUrl, hasRole, projectRef, hasMapsKey: !!process.env.GOOGLE_MAPS_API_KEY,
        error: err,
      })
    } catch (e: any) {
      return res.status(200).json({
        ok: true, configured: false, totalSites: null, activeSites: null,
        hasUrl, hasRole, projectRef, hasMapsKey: !!process.env.GOOGLE_MAPS_API_KEY,
        error: String(e?.message || e),
      })
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

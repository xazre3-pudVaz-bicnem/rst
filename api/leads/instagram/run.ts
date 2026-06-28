// ============================================================
// POST /api/leads/instagram/run … Instagram新店取得 手動実行（要ログイン）
// GET  /api/leads/instagram/run … 接続状態（IGトークン/ユーザーID/MAPSキー設定有無）
// 共通処理は src/lib/instagramRun.ts を静的import。キーはサーバー専用。
// ============================================================
import { getAdminClient } from '../../../src/lib/googlePlacesRun.js'
import { runInstagram } from '../../../src/lib/instagramRun.js'

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    const token = process.env.IG_ACCESS_TOKEN || ''
    const userId = process.env.IG_USER_ID || ''
    return res.status(200).json({
      ok: true,
      configured: token.length > 0 && userId.length > 0,
      hasToken: token.length > 0,
      hasUserId: userId.length > 0,
      hasMapsKey: !!process.env.GOOGLE_MAPS_API_KEY,
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

  const igToken = process.env.IG_ACCESS_TOKEN
  const igUserId = process.env.IG_USER_ID
  if (!igToken || !igUserId) return res.status(400).json({ error: 'IG_ACCESS_TOKEN / IG_USER_ID が未設定です' })
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ error: String(e?.message || e) }) }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'ログインが必要です' })
  const { data: userData } = await admin.auth.getUser(token)
  if (!userData?.user) return res.status(401).json({ error: 'ログインが必要です（セッション切れの可能性）' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const settings = body?.settings || {}

  try {
    const result = await runInstagram(admin, igToken, igUserId, process.env.GOOGLE_MAPS_API_KEY || null, settings, userData.user.id)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return {} } }

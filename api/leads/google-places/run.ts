// ============================================================
// POST /api/leads/google-places/run  … 手動実行（要ログイン）
// GET  /api/leads/google-places/run  … 接続状態（APIキー設定有無）
// ============================================================
import { getAdminClient, runGooglePlaces } from '../../_lib/runGooglePlaces'

export default async function handler(req: any, res: any) {
  // 接続状態（フロントの「未設定」表示用）
  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!process.env.GOOGLE_MAPS_API_KEY })
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEYが未設定です' })
  }

  let admin: any
  try {
    admin = getAdminClient()
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }

  // ログインユーザー確認（フロントから Supabase アクセストークンを送る）
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'ログインが必要です' })
  const { data: userData } = await admin.auth.getUser(token)
  if (!userData?.user) return res.status(401).json({ error: 'ログインが必要です' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const settings = body?.settings || {}

  try {
    const result = await runGooglePlaces(admin, apiKey, settings, userData.user.id)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s) } catch { return {} }
}

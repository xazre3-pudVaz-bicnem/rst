// ============================================================
// POST /api/leads/google-places/run  … 手動実行（要ログイン）
// GET  /api/leads/google-places/run  … 接続状態（APIキー設定有無）
//
// 共通処理は src/lib/googlePlacesRun.ts に置き、静的importで取り込む
// （Vercel/esbuild が関数にバンドルするため実行時の module 解決が不要）。
// ============================================================
import { getAdminClient, runGooglePlaces, rejudgeExistingPlaces } from '../../../src/lib/googlePlacesRun.js'

export default async function handler(req: any, res: any) {
  // ---- 接続状態（依存コードを実行せず process.env のみで即応答） ----
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    const key = process.env.GOOGLE_MAPS_API_KEY || ''
    return res.status(200).json({
      ok: true,
      configured: key.length > 0,
      keyLength: key.length,
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      node: process.version,
    })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEYが未設定です' })
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(400).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です' })
  }

  let admin: any
  try {
    admin = getAdminClient()
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }

  // ログインユーザー確認
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'ログインが必要です' })
  const { data: userData } = await admin.auth.getUser(token)
  if (!userData?.user) return res.status(401).json({ error: 'ログインが必要です（セッション切れの可能性）' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const settings = body?.settings || {}

  // 既存Google Places候補の openingDate 再判定（item9）
  if (body?.rejudge) {
    try {
      const out = await rejudgeExistingPlaces(admin, apiKey, { limit: Number(body.rejudge.limit) || 100, nowIso: new Date().toISOString() })
      return res.status(200).json({ ok: true, ...out })
    } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }
  }

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

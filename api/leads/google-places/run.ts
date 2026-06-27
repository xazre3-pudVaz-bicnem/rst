// ============================================================
// POST /api/leads/google-places/run  … 手動実行（要ログイン）
// GET  /api/leads/google-places/run  … 接続状態（APIキー設定有無）
//
// 重要: GET（状態確認）は依存ゼロで動くようにし、重いアダプタ(@supabase/
// google-places/src参照)は POST のときだけ動的importする。これにより、
// 万一アダプタのバンドルに失敗しても状態確認は確実に応答する。
// ============================================================

export default async function handler(req: any, res: any) {
  // ---- 接続状態（フロントの「未設定」表示用。依存なしで即応答） ----
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    const key = process.env.GOOGLE_MAPS_API_KEY || ''
    return res.status(200).json({
      ok: true,
      configured: key.length > 0,
      keyLength: key.length, // 値は返さない（長さのみで設定有無を確認）
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

  // 重いアダプタは実行時のみ読み込む（状態確認を巻き込まない）
  let mod: any
  try {
    mod = await import('../../_lib/runGooglePlaces')
  } catch (e: any) {
    return res.status(500).json({ error: 'サーバーモジュールの読み込みに失敗しました: ' + String(e?.message || e) })
  }

  let admin: any
  try {
    admin = mod.getAdminClient()
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

  try {
    const result = await mod.runGooglePlaces(admin, apiKey, settings, userData.user.id)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s) } catch { return {} }
}

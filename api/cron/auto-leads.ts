// ============================================================
// GET /api/cron/auto-leads … 毎朝の自動実行（Vercel Cron）
// CRON_SECRET で保護。Vercel Cron は Authorization: Bearer <CRON_SECRET> を送る。
// 重いアダプタは実行時のみ動的import。
// ============================================================

export default async function handler(req: any, res: any) {
  const secret = process.env.CRON_SECRET
  const auth = String(req.headers.authorization || '')
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEYが未設定です' })
  }

  let mod: any
  try {
    mod = await import('../_lib/runGooglePlaces')
  } catch (e: any) {
    return res.status(500).json({ error: 'サーバーモジュールの読み込みに失敗しました: ' + String(e?.message || e) })
  }

  let admin: any
  try {
    admin = mod.getAdminClient()
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }

  try {
    const result = await mod.runGooglePlaces(admin, apiKey, mod.getDefaultSettings(), null)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
}

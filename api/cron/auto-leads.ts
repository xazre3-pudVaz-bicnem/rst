// ============================================================
// GET /api/cron/auto-leads … 毎朝の自動実行（Vercel Cron）
// CRON_SECRET で保護。Vercel Cron は Authorization: Bearer <CRON_SECRET> を送る。
// ============================================================
import { getAdminClient, getDefaultSettings, runGooglePlaces } from '../_lib/runGooglePlaces'

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

  let admin: any
  try {
    admin = getAdminClient()
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }

  try {
    const result = await runGooglePlaces(admin, apiKey, getDefaultSettings(), null)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
}

// ============================================================
// GET /api/cron/regional-media-leads … 地域メディア巡回の自動実行
// 保護: Authorization: Bearer ${CRON_SECRET} もしくは ?secret=${CRON_SECRET}
// 設定は app_config(key='regional_auto') を参照（UIから保存）。
// 注: Hobbyのcron上限のため、auto-leads cron からも順番に呼ばれます（このエンドポイントは手動テスト用）。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { runRegionalMedia, getDefaultRegionalSettings } from '../../src/lib/regionalMediaRun.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  const secret = process.env.CRON_SECRET
  const auth = String(req.headers.authorization || '')
  const qsecret = String(req.query?.secret || '')
  if (!secret || (auth !== `Bearer ${secret}` && qsecret !== secret)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(400).json({ ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です' })
  }

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  try {
    let cfg: any = {}
    try { const { data } = await admin.from('app_config').select('value').eq('key', 'regional_auto').maybeSingle(); cfg = data?.value || {} } catch { cfg = {} }
    if (cfg.regionalEnabled === false) return res.status(200).json({ ok: true, skipped: true, reason: '地域メディア自動取得がOFFです' })

    const settings = { ...getDefaultRegionalSettings(), ...cfg }
    const result = await runRegionalMedia(admin, process.env.GOOGLE_MAPS_API_KEY || null, settings, null)
    return res.status(200).json({
      ok: true, source: 'regional_media_auto',
      sites: result.sites, newArticles: result.newArticles, candidates: result.candidates,
      placeMatched: result.placeMatched, phoneYes: result.phoneYes,
      hot: result.hot, hold: result.hold, excluded: result.excluded, importedCases: result.imported, runId: result.runId,
    })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

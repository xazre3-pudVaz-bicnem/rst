// ============================================================
// GET /api/cron/instagram-leads … 毎朝の Instagram自動取得（Vercel Cron）
// 保護: Authorization: Bearer ${CRON_SECRET} もしくは ?secret=${CRON_SECRET}
// 自動取得設定は app_config(key='instagram_auto') を参照（UIから保存）。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { runInstagram, getDefaultIgSettings } from '../../src/lib/instagramRun.js'

export default async function handler(req: any, res: any) {
  const secret = process.env.CRON_SECRET
  const auth = String(req.headers.authorization || '')
  const qsecret = String(req.query?.secret || '')
  if (!secret || (auth !== `Bearer ${secret}` && qsecret !== secret)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }

  const igToken = process.env.IG_ACCESS_TOKEN
  const igUserId = process.env.IG_USER_ID
  if (!igToken || !igUserId) return res.status(400).json({ ok: false, error: 'IG_ACCESS_TOKEN / IG_USER_ID が未設定です' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  try {
    let cfg: any = {}
    try {
      const { data } = await admin.from('app_config').select('value').eq('key', 'instagram_auto').maybeSingle()
      cfg = data?.value || {}
    } catch { cfg = {} }

    if (cfg.igEnabled === false) return res.status(200).json({ ok: true, skipped: true, reason: 'Instagram自動取得がOFFです' })

    const settings = { ...getDefaultIgSettings(), ...cfg }
    const result = await runInstagram(admin, igToken, igUserId, process.env.GOOGLE_MAPS_API_KEY || null, settings, null)

    return res.status(200).json({
      ok: true, source: 'instagram_hashtag_auto',
      hashtags: result.hashtags, recentPosts: result.recent, extracted: result.extracted,
      placeMatched: result.placeMatched, phoneYes: result.phoneYes,
      googleHot: result.googleHot, igOnlyHot: result.igOnlyHot, hold: result.hold, excluded: result.excluded,
      importedCases: result.imported, runId: result.runId,
    })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

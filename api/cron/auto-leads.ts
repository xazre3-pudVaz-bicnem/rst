// ============================================================
// GET /api/cron/auto-leads … 毎朝6:00(JST) の自動実行（Vercel Cron / Hobby=1日1回）
// 保護: Authorization: Bearer ${CRON_SECRET} もしくは ?secret=${CRON_SECRET}
// 自動取得設定は app_config(key='lead_auto') を参照（UIから保存・無ければ既定値）。
// 共通処理は src/lib/googlePlacesRun.ts を静的import。
// ============================================================
import { getAdminClient, getDefaultSettings, runGooglePlaces } from '../../src/lib/googlePlacesRun.js'
import { presetLabel } from '../../src/lib/areaPresets.js'
import { runRegionalMedia, getDefaultRegionalSettings } from '../../src/lib/regionalMediaRun.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  const secret = process.env.CRON_SECRET
  const auth = String(req.headers.authorization || '')
  const qsecret = String(req.query?.secret || '')
  const authorized = !!secret && (auth === `Bearer ${secret}` || qsecret === secret)
  if (!authorized) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'GOOGLE_MAPS_API_KEYが未設定です' })
  }

  let admin: any
  try {
    admin = getAdminClient()
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }

  try {
    // UIから保存された自動取得設定（無ければ既定）
    let cfg: any = {}
    try {
      const { data } = await admin.from('app_config').select('value').eq('key', 'lead_auto').maybeSingle()
      cfg = data?.value || {}
    } catch { cfg = {} }

    if (cfg.autoFetch === false) {
      return res.status(200).json({ ok: true, skipped: true, reason: '自動取得がOFFです（AI投入設定）' })
    }

    const settings = { ...getDefaultSettings(), ...cfg }
    const result = await runGooglePlaces(admin, apiKey, settings, null)

    // 地域メディア巡回も同cron内で順番に実行（Hobbyのcron数制限対策）。失敗してもPlaces結果は返す。
    let regional: any = { skipped: true }
    try {
      let rcfg: any = {}
      try { const { data } = await admin.from('app_config').select('value').eq('key', 'regional_auto').maybeSingle(); rcfg = data?.value || {} } catch { rcfg = {} }
      if (rcfg.regionalEnabled !== false) {
        const r = await runRegionalMedia(admin, apiKey, { ...getDefaultRegionalSettings(), ...rcfg }, null)
        regional = { sites: r.sites, newArticles: r.newArticles, hot: r.hot, hold: r.hold, excluded: r.excluded, importedCases: r.imported }
      }
    } catch (re: any) { regional = { error: String(re?.message || re) } }

    return res.status(200).json({
      ok: true,
      source: 'google_places_auto',
      preset: presetLabel(settings.areaPreset),
      executedQueries: result.queries,
      apiFetched: result.fetched,
      detailCalls: result.detailCalls,
      hot: result.hot,
      hold: result.hold,
      excluded: result.excluded,
      importedCases: result.imported,
      phoneYes: result.phoneYes,
      remaining: result.debug?.remaining ?? null,
      recentSkipped: result.debug?.recentSkipped ?? null,
      runId: result.runId,
      regionalMedia: regional,
    })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

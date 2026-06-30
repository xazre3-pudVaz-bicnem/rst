// ============================================================
// POST /api/leads/regional-media/run … 地域メディア巡回 手動実行（要ログイン）
// GET  /api/leads/regional-media/run … 接続状態（有効サイト数・MAPSキー有無）
// ============================================================
import { getAdminClient } from '../../../src/lib/googlePlacesRun.js'
import { runRegionalMedia } from '../../../src/lib/regionalMediaRun.js'
import { enrichCandidate } from '../../../src/lib/instagramWebRun.js'
import { isJapanPhone, isJapanAddress, isForeignAddress } from '../../../src/lib/japanFilter.js'
import { buildHotReject, type HotCheck } from '../../../src/lib/hotReject.js'
import { runSiteDiscovery, registerSiteCandidate } from '../../../src/lib/siteDiscovery.js'
import { runAllSequentialProbes, runSequentialProbe, testProbeSite } from '../../../src/lib/sequentialProbe.js'

// 地域メディア候補のHOT再計算＋未達理由
function recomputeRmHot(cand: any, opts: { phone?: string | null; address?: string | null; prefecture?: string | null; area?: string | null; hasOpening?: boolean; placeMatched?: boolean; confidence?: number }) {
  const phone = opts.phone || cand.phone_number || ''
  const address = opts.address || cand.address || null
  const area = opts.area || cand.extracted_area || null
  const haveArea = !!(area || address)
  const strongOpening = !!(opts.hasOpening ?? cand.has_google_opening_date)
  const placeMatched = !!(opts.placeMatched ?? (cand.matched_google_place_id || cand.google_place_id))
  const foreignFinal = isForeignAddress(address) || (!!phone && !isJapanPhone(phone))
  const japanOk = !foreignFinal && (!!opts.prefecture || isJapanAddress(address) || isJapanPhone(phone))
  let temperature = 'HOLD'
  if (foreignFinal) temperature = 'EXCLUDED'
  else if (!!phone && isJapanPhone(phone) && japanOk && (haveArea || strongOpening)) temperature = 'HOT'
  const checks: HotCheck[] = [
    { key: 'has_japan', label: '日本国内', ok: foreignFinal ? false : (japanOk ? true : null), reasonKey: 'not_japan' },
    { key: 'has_shop_name', label: '店名あり', ok: !!(cand.extracted_shop_name_from_article || cand.extracted_shop_name || cand.name), reasonKey: 'shop_name_missing' },
    { key: 'has_industry', label: '業種推定', ok: cand.extracted_industry ? true : null, reasonKey: 'industry_unknown' },
    { key: 'has_area', label: '住所/市区町村あり', ok: haveArea ? true : false, reasonKey: 'address_missing', value: (address || area) || undefined },
    { key: 'has_phone', label: '日本の電話番号あり', ok: (phone && isJapanPhone(phone)) ? true : false, reasonKey: 'phone_missing', value: phone || undefined },
    { key: 'has_newness', label: '新店記事根拠あり', ok: true, reasonKey: 'newness_missing' },
    { key: 'has_opening_date', label: 'openingDate/開業予定あり', ok: strongOpening ? true : false, reasonKey: 'opening_date_missing' },
    { key: 'has_official', label: '公式/Places裏取りあり', ok: (cand.official_url || placeMatched) ? true : null, reasonKey: 'official_unverified' },
    { key: 'places_matched', label: 'Google Places一致', ok: placeMatched ? true : null, reasonKey: 'places_no_match' },
  ]
  const hr = buildHotReject({ source: 'regional_media', temperature, confidence: opts.confidence ?? (cand.match_confidence ?? 0), checks })
  return { temperature, hr }
}

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

  // 連番URL探索（全 sequential_id_probe サイト）
  if (body?.probe) {
    try {
      const result = await runAllSequentialProbes(admin, process.env.GOOGLE_MAPS_API_KEY || null, { ...(body.settings || {}), forwardCount: body.probe.forwardCount, backfillCount: body.probe.backfillCount, force: body.probe.force }, userData.user.id)
      return res.status(200).json(result)
    } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }
  }
  // 連番探索: 1サイトのみ（テスト/次のN件/指定IDから/前回範囲再確認）
  if (body?.probeSite?.id) {
    const { data: site } = await admin.from('source_sites').select('*').eq('id', body.probeSite.id).maybeSingle()
    if (!site) return res.status(404).json({ ok: false, error: 'サイトが見つかりません' })
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: probedToday } = await admin.from('sequential_probe_results').select('id', { count: 'exact', head: true }).gte('checked_at', startToday.toISOString())
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    const pr = await runSequentialProbe(admin, process.env.GOOGLE_MAPS_API_KEY || null, site, {
      userId: userData.user.id, runId: null, nowIso: new Date().toISOString(), mode: (body.settings?.aiInjectMode) || 'standard',
      forwardCount: Number(body.probeSite.forwardCount) || 20, backfillCount: Number(body.probeSite.backfillCount ?? 5), startIdOverride: body.probeSite.startId != null ? Number(body.probeSite.startId) : undefined, force: !!body.probeSite.force,
      dayRemaining: Math.max(0, 100 - (probedToday || 0)), autoImportPerRun: 50, autoImportPerDay: 200, importedToday: importedToday || 0, delayMs: 800,
    })
    return res.status(200).json({ ok: true, ...pr })
  }
  // 連番探索サイトの位置編集（current_probe_id / last_checked_id）
  if (body?.updateProbeSite?.id) {
    const u: any = {}
    if (body.updateProbeSite.current_probe_id != null) u.current_probe_id = Number(body.updateProbeSite.current_probe_id)
    if (body.updateProbeSite.last_checked_id != null) u.last_checked_id = Number(body.updateProbeSite.last_checked_id)
    if (body.updateProbeSite.probe_enabled != null) u.probe_enabled = !!body.updateProbeSite.probe_enabled
    if (body.updateProbeSite.is_active != null) u.is_active = !!body.updateProbeSite.is_active
    if (Object.keys(u).length) { u.updated_at = new Date().toISOString(); await admin.from('source_sites').update(u).eq('id', body.updateProbeSite.id) }
    return res.status(200).json({ ok: true })
  }
  // 連番探索: 既知URL（または指定ID）でパーサー単体テスト（DB保存なし）
  if (body?.probeTest?.id) {
    const { data: site } = await admin.from('source_sites').select('*').eq('id', body.probeTest.id).maybeSingle()
    if (!site) return res.status(404).json({ ok: false, error: 'サイトが見つかりません' })
    const ids = Array.isArray(body.probeTest.ids) ? body.probeTest.ids.map((x: any) => Number(x)).filter((x: any) => !Number.isNaN(x)) : undefined
    const result = await testProbeSite(site, ids)
    return res.status(200).json(result)
  }
  // 連番探索サイト一覧
  if (body?.listProbeSites) {
    const { data } = await admin.from('source_sites').select('*').eq('source_type', 'sequential_id_probe').order('name')
    return res.status(200).json({ ok: true, sites: data || [] })
  }

  // 巡回サイト自動発見（検索→診断→候補保存→高スコア自動登録）
  if (body?.discover) {
    try {
      const stats = await runSiteDiscovery(admin, { userId: userData.user.id, maxQueries: Number(body.discover.maxQueries) || 20, perQuery: Number(body.discover.perQuery) || 10, maxTests: Number(body.discover.maxTests) || 50, maxAutoRegister: Number(body.discover.maxAutoRegister) ?? 10 })
      return res.status(200).json({ ok: true, discovered: true, ...stats })
    } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }
  }
  // 発見候補一覧
  if (body?.listCandidates) {
    const { data } = await admin.from('source_site_candidates').select('*').order('confidence_score', { ascending: false }).limit(200)
    return res.status(200).json({ ok: true, candidates: data || [] })
  }
  // 候補を source_sites へ登録（手動）
  if (body?.registerCandidate?.id) {
    const r = await registerSiteCandidate(admin, body.registerCandidate.id)
    return res.status(r.ok ? 200 : 400).json(r)
  }

  // 1件だけ再補完（電話/住所/公式/Instagram/予約/LINEの探索。AI再判定とは別）
  if (body?.reenrich?.id) {
    const { data: cand } = await admin.from('lead_candidates').select('*').eq('id', body.reenrich.id).maybeSingle()
    if (!cand) return res.status(404).json({ ok: false, error: '候補が見つかりません' })
    const shop = cand.extracted_shop_name_from_article || cand.extracted_shop_name || cand.name || ''
    const areaHint = cand.extracted_area_from_article || cand.extracted_area || ''
    const e = await enrichCandidate(process.env.GOOGLE_MAPS_API_KEY || null,
      { shop, username: '', areaHint, industry: cand.extracted_industry || '', havePhone: cand.phone_number || '', haveAddress: cand.address || '' },
      { maxQueries: 3, perQuery: 5 })
    const phone = cand.phone_number || e.phone || null
    const prefecture = cand.extracted_prefecture || e.prefecture || null
    const city = cand.extracted_city || e.city || null
    const area = cand.extracted_area || [prefecture, city].filter(Boolean).join('') || null
    // 補完結果でHOT再計算＋未達理由を更新
    const rc = recomputeRmHot(cand, { phone, address: cand.address || e.address || null, prefecture, area, hasOpening: e.has_opening || cand.has_google_opening_date, placeMatched: !!e.place_id, confidence: e.confidence ?? cand.match_confidence ?? 0 })
    await admin.from('lead_candidates').update({
      phone_number: phone, extracted_phone: phone, address: cand.address || e.address || null,
      lead_temperature: rc.temperature, should_exclude_from_call_list: rc.temperature === 'EXCLUDED',
      hot_reject_reasons: rc.hr.hot_reject_reasons, hot_reject_summary: rc.hr.hot_reject_summary,
      hot_check_result: rc.hr.hot_check_result, hot_missing_requirements: rc.hr.hot_missing_requirements,
      hot_blocking_reason: rc.hr.hot_blocking_reason, hot_required_score: rc.hr.hot_required_score,
      extracted_area: area, extracted_prefecture: prefecture, extracted_city: city,
      official_url: cand.official_url || e.official || null, reservation_url: cand.reservation_url || e.reservation || null,
      line_url: cand.line_url || e.line || null, instagram_url: cand.instagram_url || e.instagram || null,
      enrichment_status: e.status, enrichment_sources: e.sources, enriched_phone: e.phone || null, enriched_address: e.address || null,
      enriched_prefecture: e.prefecture || null, enriched_city: e.city || null, enriched_official_url: e.official || null,
      enriched_instagram_url: e.instagram || null, enriched_reservation_url: e.reservation || null, enriched_line_url: e.line || null,
      enriched_google_place_id: e.place_id || null, enrichment_reason: e.reason, enrichment_confidence: e.confidence,
      match_confidence: e.confidence, last_enriched_at: new Date().toISOString(),
      google_business_status: e.business_status || null, google_opening_date_raw: e.opening_raw || null,
      google_opening_date_year: e.opening_year ?? null, google_opening_date_month: e.opening_month ?? null, google_opening_date_day: e.opening_day ?? null,
      has_google_opening_date: e.has_opening, opening_date_confidence: e.opening_confidence ?? null,
      days_until_opening: e.days_until_opening ?? null, days_since_opening: e.days_since_opening ?? null,
      opening_date_source: e.has_opening ? 'external_enrichment' : null,
      google_places_checked_at: e.place_id ? new Date().toISOString() : null, opening_date_checked_at: e.has_opening ? new Date().toISOString() : null,
    }).eq('id', body.reenrich.id)
    return res.status(200).json({ ok: true, reenriched: true, id: body.reenrich.id, phone, area, temperature: rc.temperature, hot_reject_summary: rc.hr.hot_reject_summary, enrich: e })
  }

  try {
    const result = await runRegionalMedia(admin, process.env.GOOGLE_MAPS_API_KEY || null, body?.settings || {}, userData.user.id)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return {} } }

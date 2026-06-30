// ============================================================
// /api/cron/instagram-web-leads
//   GET  … 接続/キー診断（キー本体は出さず hasKey/keyLength/prefix のみ）
//   POST … 実行（Cron: ?secret / X-Admin-Secret、UI: ログインJWT のいずれかで認可）
// Meta API不使用。公開Web検索(Serper/Bing) + Anthropic判定。
// 設定は app_config(key='instagram_web_auto')。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { runInstagramWeb, getDefaultIwSettings, searchProvider, anthropicJudge, heuristicJudge, enrichCandidate, usernameFromUrl } from '../../src/lib/instagramWebRun.js'
import { authorizeAdmin } from '../../src/lib/regionalAdmin.js'
import { isJapanPhone, isJapanAddress, isForeignAddress, isOrgNonStore } from '../../src/lib/japanFilter.js'
import { buildHotReject, type HotCheck } from '../../src/lib/hotReject.js'

// Instagram Web候補のHOT再計算＋HOT未達理由を生成（再補完/再判定で共通利用）
function recomputeIwHot(cand: any, opts: { phone?: string | null; address?: string | null; prefecture?: string | null; area?: string | null; industry?: string | null; hasOpening?: boolean; placeMatched?: boolean; newnessType?: string | null; confidence?: number }) {
  const finalPhone = opts.phone || cand.phone_number || ''
  const addressVal = opts.address || cand.address || null
  const area = opts.area || cand.extracted_area || null
  const industry = opts.industry || cand.extracted_industry || null
  const shop = cand.extracted_shop_name || cand.name || ''
  const hasOpening = !!(opts.hasOpening ?? cand.has_google_opening_date)
  const placeMatched = !!(opts.placeMatched ?? (cand.matched_google_place_id || cand.google_place_id))
  const newnessOk = !!((opts.newnessType ?? cand.newness_type) && (opts.newnessType ?? cand.newness_type) !== 'unknown') || hasOpening
  const foreignFinal = isForeignAddress(addressVal) || (!!finalPhone && !isJapanPhone(finalPhone))
  const japanOk = !foreignFinal && (!!opts.prefecture || isJapanAddress(addressVal) || isJapanPhone(finalPhone))
  let temperature = 'HOLD'
  if (foreignFinal) temperature = 'EXCLUDED'
  else if (!!finalPhone && isJapanPhone(finalPhone) && !!area && newnessOk && japanOk && !isOrgNonStore(shop)) temperature = 'HOT'
  const checks: HotCheck[] = [
    { key: 'has_japan', label: '日本国内', ok: foreignFinal ? false : (japanOk ? true : null), reasonKey: 'not_japan' },
    { key: 'has_shop_name', label: '店名あり', ok: !!shop, reasonKey: 'shop_name_missing' },
    { key: 'has_industry', label: '業種推定', ok: industry ? true : null, reasonKey: 'industry_unknown' },
    { key: 'has_area', label: '住所/市区町村あり', ok: (area || addressVal) ? true : false, reasonKey: 'address_missing', value: (addressVal || area) || undefined },
    { key: 'has_phone', label: '日本の電話番号あり', ok: (finalPhone && isJapanPhone(finalPhone)) ? true : false, reasonKey: 'phone_missing', value: finalPhone || undefined },
    { key: 'has_newness', label: '新規オープン根拠あり', ok: newnessOk ? true : null, reasonKey: 'newness_missing' },
    { key: 'has_opening_date', label: 'openingDate/開業予定あり', ok: hasOpening ? true : false, reasonKey: 'opening_date_missing' },
    { key: 'has_official', label: '公式/Places裏取りあり', ok: (cand.official_url || placeMatched) ? true : null, reasonKey: 'official_unverified' },
    { key: 'places_matched', label: 'Google Places一致', ok: placeMatched ? true : null, reasonKey: 'places_no_match' },
  ]
  const hr = buildHotReject({ source: 'instagram_web', temperature, confidence: opts.confidence ?? (cand.match_confidence ?? 0), checks })
  return { temperature, hr }
}

export const config = { maxDuration: 60 }

function keyDiag(v: string | undefined) {
  const k = v || ''
  return { hasKey: k.length > 0, keyLength: k.length, prefix: k ? k.slice(0, 4) : '' }
}

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    return res.status(200).json({
      ok: true,
      provider: searchProvider(),
      serper: keyDiag(process.env.SERPER_API_KEY),
      bing: keyDiag(process.env.BING_SEARCH_API_KEY),
      anthropic: keyDiag(process.env.ANTHROPIC_API_KEY),
      googleMaps: keyDiag(process.env.GOOGLE_MAPS_API_KEY),
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      configured: !!searchProvider() && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    })
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ ok: false, error: 'SUPABASE env 未設定' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  const auth = await authorizeAdmin(admin, req.headers)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  try {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})

    // 1件だけ再補完（外部サイト/予約サイト/Placesから電話・住所を探す。AI判定とは別）
    if (body?.reenrich?.id) {
      const { data: cand } = await admin.from('lead_candidates').select('*').eq('id', body.reenrich.id).maybeSingle()
      if (!cand) return res.status(404).json({ ok: false, error: '候補が見つかりません' })
      const shop = cand.extracted_shop_name || cand.name || ''
      const username = usernameFromUrl(cand.instagram_url || '')
      // 手動の再補完は強制実行（プロフィール/Maps/外部リンク/Places照合）
      const e = await enrichCandidate(process.env.GOOGLE_MAPS_API_KEY || null,
        { shop, username, areaHint: cand.extracted_area || '', industry: cand.extracted_industry || '', havePhone: cand.phone_number || '', haveAddress: cand.address || '', instagramUrl: cand.instagram_url || '' },
        { maxQueries: 3, perQuery: 5, fetchProfile: true })
      // 補完で得た値を優先（再補完は最新情報で上書き）
      const phone = e.phone || cand.phone_number || null
      const prefecture = e.prefecture || cand.extracted_prefecture || null
      const city = e.city || cand.extracted_city || null
      const area = [prefecture, city].filter(Boolean).join('') || cand.extracted_area || null
      const address = e.address || cand.address || null
      // 補完で電話/住所/openingDateが取れたらHOT判定を再計算＋未達理由を更新
      const rc = recomputeIwHot(cand, { phone, address, prefecture, area, hasOpening: e.has_opening || cand.has_google_opening_date, placeMatched: !!e.place_id, confidence: e.confidence ?? cand.match_confidence ?? 0 })
      await admin.from('lead_candidates').update({
        phone_number: phone, extracted_phone: phone, address,
        lead_temperature: rc.temperature, should_exclude_from_call_list: rc.temperature === 'EXCLUDED',
        hot_reject_reasons: rc.hr.hot_reject_reasons, hot_reject_summary: rc.hr.hot_reject_summary,
        hot_check_result: rc.hr.hot_check_result, hot_missing_requirements: rc.hr.hot_missing_requirements,
        hot_blocking_reason: rc.hr.hot_blocking_reason, hot_required_score: rc.hr.hot_required_score,
        extracted_area: area, extracted_prefecture: prefecture, extracted_city: city,
        official_url: cand.official_url || e.official || null, reservation_url: cand.reservation_url || e.reservation || null, line_url: cand.line_url || e.line || null,
        enrichment_status: e.status, enrichment_sources: e.sources, enriched_phone: e.phone || null, enriched_address: e.address || null,
        enriched_prefecture: e.prefecture || null, enriched_city: e.city || null, enriched_official_url: e.official || null,
        enriched_reservation_url: e.reservation || null, enriched_line_url: e.line || null, enriched_google_place_id: e.place_id || null,
        enrichment_reason: e.reason, enrichment_confidence: e.confidence, last_enriched_at: new Date().toISOString(),
        enriched_phone_source: e.phone_source || null, enriched_address_source: e.address_source || null, enriched_google_maps_url: e.google_maps_url || null,
        enrichment_profile_fetched: e.profile_fetched ?? null, enrichment_fail_reason: e.fail_reason || null,
        google_business_status: e.business_status || null, google_opening_date_raw: e.opening_raw || null,
        google_opening_date_year: e.opening_year ?? null, google_opening_date_month: e.opening_month ?? null, google_opening_date_day: e.opening_day ?? null,
        has_google_opening_date: e.has_opening, opening_date_confidence: e.opening_confidence ?? null,
        days_until_opening: e.days_until_opening ?? null, days_since_opening: e.days_since_opening ?? null,
        opening_date_source: e.has_opening ? 'external_enrichment' : null,
        google_places_checked_at: e.place_id ? new Date().toISOString() : null, opening_date_checked_at: e.has_opening ? new Date().toISOString() : null,
      }).eq('id', body.reenrich.id)
      return res.status(200).json({ ok: true, reenriched: true, id: body.reenrich.id, phone, area, temperature: rc.temperature, hot_reject_summary: rc.hr.hot_reject_summary, enrich: e })
    }

    // 1件だけ再判定（UIの「再判定」ボタン）
    if (body?.rejudge?.id) {
      const { data: cand } = await admin.from('lead_candidates').select('*').eq('id', body.rejudge.id).maybeSingle()
      if (!cand) return res.status(404).json({ ok: false, error: '候補が見つかりません' })
      const r = { title: cand.search_title || '', snippet: cand.search_snippet || '', url: cand.instagram_url || '' }
      const j = (await anthropicJudge(r)) || heuristicJudge(r)
      const area = [j.prefecture, j.city].filter(Boolean).join('') || cand.extracted_area || null
      // HOT再計算＋未達理由（補完済みの電話/住所/openingDateも加味）
      const rc = recomputeIwHot(cand, {
        prefecture: j.prefecture || cand.extracted_prefecture, area, industry: j.industry || cand.extracted_industry,
        newnessType: j.newness_type, confidence: j.confidence_score ?? cand.match_confidence ?? 0,
      })
      const temperature = j.is_foreign ? 'EXCLUDED' : rc.temperature
      await admin.from('lead_candidates').update({
        lead_temperature: temperature, recommended_status: j.recommended_status || temperature, anthropic_judgement: j, newness_type: j.newness_type || null,
        match_confidence: j.confidence_score ?? null, should_exclude_from_call_list: temperature === 'EXCLUDED',
        ai_comment: j.exclusion_reason ? `除外: ${j.exclusion_reason}` : `再判定(${j.newness_type || 'unknown'}) 確度${j.confidence_score ?? '-'} / 地域:${area || '不明'} / ${j.evidence_text || ''}`,
        instagram_newness_reason: j.evidence_text || null, extracted_shop_name: j.shop_name || cand.extracted_shop_name || null,
        extracted_area: area, extracted_prefecture: j.prefecture || cand.extracted_prefecture || null, extracted_city: j.city || cand.extracted_city || null,
        hot_reject_reasons: rc.hr.hot_reject_reasons, hot_reject_summary: rc.hr.hot_reject_summary,
        hot_check_result: rc.hr.hot_check_result, hot_missing_requirements: rc.hr.hot_missing_requirements,
        hot_blocking_reason: rc.hr.hot_blocking_reason, hot_required_score: rc.hr.hot_required_score,
      }).eq('id', body.rejudge.id)
      return res.status(200).json({ ok: true, rejudged: true, id: body.rejudge.id, temperature, hot_reject_summary: rc.hr.hot_reject_summary, judgement: j })
    }

    // body.settings(UI手動) が無ければ app_config を参照
    let cfg: any = body?.settings || null
    if (!cfg) {
      try { const { data } = await admin.from('app_config').select('value').eq('key', 'instagram_web_auto').maybeSingle(); cfg = data?.value || {} } catch { cfg = {} }
      if (cfg.iwEnabled === false) return res.status(200).json({ ok: true, skipped: true, reason: 'Instagram Web検索がOFFです' })
    }
    const settings = { ...getDefaultIwSettings(), ...cfg }
    const result = await runInstagramWeb(admin, process.env.GOOGLE_MAPS_API_KEY || null, settings, auth.userId)
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return {} } }

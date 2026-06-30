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
      const e = await enrichCandidate(process.env.GOOGLE_MAPS_API_KEY || null,
        { shop, username, areaHint: cand.extracted_area || '', industry: cand.extracted_industry || '', havePhone: cand.phone_number || '', haveAddress: cand.address || '' },
        { maxQueries: 3, perQuery: 5 })
      // 既存値は保持し、空のところだけ補完
      const phone = cand.phone_number || e.phone || null
      const prefecture = cand.extracted_prefecture || e.prefecture || null
      const city = cand.extracted_city || e.city || null
      const area = [prefecture, city].filter(Boolean).join('') || cand.extracted_area || null
      await admin.from('lead_candidates').update({
        phone_number: phone, extracted_phone: phone, address: cand.address || e.address || null,
        extracted_area: area, extracted_prefecture: prefecture, extracted_city: city,
        official_url: cand.official_url || e.official || null, reservation_url: cand.reservation_url || e.reservation || null, line_url: cand.line_url || e.line || null,
        enrichment_status: e.status, enrichment_sources: e.sources, enriched_phone: e.phone || null, enriched_address: e.address || null,
        enriched_prefecture: e.prefecture || null, enriched_city: e.city || null, enriched_official_url: e.official || null,
        enriched_reservation_url: e.reservation || null, enriched_line_url: e.line || null, enriched_google_place_id: e.place_id || null,
        enrichment_reason: e.reason, enrichment_confidence: e.confidence, last_enriched_at: new Date().toISOString(),
      }).eq('id', body.reenrich.id)
      return res.status(200).json({ ok: true, reenriched: true, id: body.reenrich.id, phone, area, enrich: e })
    }

    // 1件だけ再判定（UIの「再判定」ボタン）
    if (body?.rejudge?.id) {
      const { data: cand } = await admin.from('lead_candidates').select('id,search_title,search_snippet,instagram_url,extracted_area').eq('id', body.rejudge.id).maybeSingle()
      if (!cand) return res.status(404).json({ ok: false, error: '候補が見つかりません' })
      const r = { title: cand.search_title || '', snippet: cand.search_snippet || '', url: cand.instagram_url || '' }
      const j = (await anthropicJudge(r)) || heuristicJudge(r)
      const temperature = j.recommended_status || 'HOLD'
      const area = [j.prefecture, j.city].filter(Boolean).join('') || null
      await admin.from('lead_candidates').update({
        lead_temperature: temperature, recommended_status: j.recommended_status || temperature, anthropic_judgement: j, newness_type: j.newness_type || null,
        match_confidence: j.confidence_score ?? null, should_exclude_from_call_list: temperature === 'EXCLUDED',
        ai_comment: j.exclusion_reason ? `除外: ${j.exclusion_reason}` : `再判定(${j.newness_type || 'unknown'}) 確度${j.confidence_score ?? '-'} / 地域:${area || '不明'} / ${j.evidence_text || ''}`,
        instagram_newness_reason: j.evidence_text || null, extracted_shop_name: j.shop_name || null,
        extracted_area: area, extracted_prefecture: j.prefecture || null, extracted_city: j.city || null,
      }).eq('id', body.rejudge.id)
      return res.status(200).json({ ok: true, rejudged: true, id: body.rejudge.id, temperature, judgement: j })
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

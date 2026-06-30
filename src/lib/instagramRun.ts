// ============================================================
// Instagram新店リスト実行ロジック（サーバー専用）
// ハッシュタグ検索(IG Graph API)→14日以内→caption抽出→任意でPlaces照合→A/B/C分類
// Google Places照合は必須にしない。IG単体HOT候補も保存（初期は自動投入OFF）。
// ============================================================
import { classifyLead } from './leadScoring.js'
import { DEFAULT_STATUS } from './constants.js'
import { searchLight, placeDetails, phoneOf, reviewDates, parseOpeningDate } from './googlePlacesRun.js'
import { extractFromCaption, classifyInstagram, IG_HASHTAGS, type IgClassifyOpts } from './instagramExtract.js'

const GRAPH = 'https://graph.facebook.com/v19.0'

export function getDefaultIgSettings() {
  return {
    igEnabled: true,
    igAutoImport: false,          // IG単体HOT候補をcasesへ自動投入（初期OFF）
    igRequirePhone: true,         // 自動投入は電話必須
    igAllowWithoutPlace: false,   // Places未照合でも自動投入可
    igRequireOpenWord: true,
    igRequireArea: true,
    igPeriodDays: 14,
    igMaxHashtagsPerDay: 5,
    dailyCap: 30,
  }
}

async function igHashtagId(token: string, igUserId: string, tag: string): Promise<{ id: string | null; error: string | null }> {
  try {
    const url = `${GRAPH}/ig_hashtag_search?user_id=${encodeURIComponent(igUserId)}&q=${encodeURIComponent(tag)}&access_token=${encodeURIComponent(token)}`
    const res = await fetch(url)
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return { id: null, error: String(j?.error?.message || `HTTP ${res.status}`).slice(0, 300) }
    return { id: j?.data?.[0]?.id || null, error: null }
  } catch (e: any) { return { id: null, error: String(e?.message || e) } }
}

async function igRecentMedia(token: string, igUserId: string, hashtagId: string): Promise<{ media: any[]; error: string | null }> {
  try {
    const fields = 'id,caption,permalink,timestamp,media_type'
    const url = `${GRAPH}/${encodeURIComponent(hashtagId)}/recent_media?user_id=${encodeURIComponent(igUserId)}&fields=${fields}&limit=30&access_token=${encodeURIComponent(token)}`
    const res = await fetch(url)
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return { media: [], error: String(j?.error?.message || `HTTP ${res.status}`).slice(0, 300) }
    return { media: Array.isArray(j?.data) ? j.data : [], error: null }
  } catch (e: any) { return { media: [], error: String(e?.message || e) } }
}

/** 店名トークンの重なりで照合信頼度(0-100)を概算 */
function matchConfidence(shop: string, placeName: string): number {
  if (!shop || !placeName) return 0
  const norm = (s: string) => s.replace(/[\s　・,.。、（）()【】\[\]]/g, '')
  const a = norm(shop), b = norm(placeName)
  if (!a || !b) return 0
  if (a === b) return 100
  if (b.includes(a) || a.includes(b)) return 80
  // 2-gram 重なり
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)))
  const ga = grams(a), gb = grams(b)
  let inter = 0
  ga.forEach((g) => { if (gb.has(g)) inter++ })
  const denom = Math.max(ga.size, gb.size) || 1
  return Math.round((inter / denom) * 100)
}

/** ローテーション選択: 今日未検索のtagを古い順に、7日30ユニーク制限内で最大N件 */
function pickHashtags(logRows: any[], maxPerDay: number): string[] {
  const now = Date.now()
  const lastByTag = new Map<string, number>()
  for (const r of logRows) lastByTag.set(r.hashtag, Date.parse(r.last_searched_at))
  const within = (ms: number | undefined, days: number) => ms != null && (now - ms) < days * 86400000
  const recent7 = new Set(IG_HASHTAGS.filter((t) => within(lastByTag.get(t), 7)))
  const candidates = IG_HASHTAGS
    .filter((t) => !within(lastByTag.get(t), 1)) // 今日未検索
    .sort((a, b) => (lastByTag.get(a) ?? 0) - (lastByTag.get(b) ?? 0)) // 古い/未検索が先
  const picked: string[] = []
  for (const t of candidates) {
    if (picked.length >= maxPerDay) break
    if (recent7.has(t)) { picked.push(t); continue }
    if (recent7.size < 30) { recent7.add(t); picked.push(t) }
  }
  return picked
}

export async function runInstagram(admin: any, igToken: string, igUserId: string, mapsKey: string | null, rawSettings: any, userId: string | null) {
  const def = getDefaultIgSettings()
  const s = { ...def, ...(rawSettings || {}) }
  const igOpts: IgClassifyOpts = {
    requireOpenWord: s.igRequireOpenWord, requireArea: s.igRequireArea, requirePhone: s.igRequirePhone,
    igAutoImport: s.igAutoImport, igAllowWithoutPlace: s.igAllowWithoutPlace,
  }
  const periodMs = Math.max(1, Number(s.igPeriodDays) || 14) * 86400000
  const maxPerDay = Math.max(1, Number(s.igMaxHashtagsPerDay) || 5)
  const dailyCap = Math.max(1, Number(s.dailyCap) || 30)

  const counts = {
    hashtags: 0, posts: 0, recent: 0, extracted: 0, placeMatched: 0, phoneYes: 0,
    googleHot: 0, igOnlyHot: 0, hold: 0, excluded: 0, imported: 0, saved: 0, saveError: 0, error: 0,
  }
  const debug: any = { hashtagResults: [] as any[], sample: null, saveErrors: [] as string[] }
  let errorMessage = ''

  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'instagram', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  try {
    const { data: logRows } = await admin.from('ig_hashtag_log').select('hashtag,last_searched_at').limit(200)
    const tags = pickHashtags(logRows || [], maxPerDay)
    counts.hashtags = tags.length
    const nowIso = new Date().toISOString()
    const now = Date.now()

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount = importedToday || 0

    for (const tag of tags) {
      const before = { gh: counts.googleHot, io: counts.igOnlyHot, hold: counts.hold, ex: counts.excluded }
      const { id: hid, error: e1 } = await igHashtagId(igToken, igUserId, tag)
      if (!hid) {
        if (e1) { counts.error++; errorMessage = e1 }
        debug.hashtagResults.push({ hashtag: tag, hashtagId: null, media: 0, error: e1 })
        await admin.from('ig_hashtag_log').upsert({ hashtag: tag, last_searched_at: nowIso, searches: 1, media_count: 0 }, { onConflict: 'hashtag' }).then(() => {}, () => {})
        continue
      }
      const { media, error: e2 } = await igRecentMedia(igToken, igUserId, hid)
      if (e2) { counts.error++; errorMessage = e2 }

      let mediaUsed = 0
      for (const m of media) {
        counts.posts++
        const ts = m.timestamp ? Date.parse(m.timestamp) : NaN
        if (Number.isNaN(ts) || (now - ts) > periodMs) continue // 期間外
        counts.recent++; mediaUsed++

        const ex = extractFromCaption(m.caption || '')
        counts.extracted++
        if (ex.phone) counts.phoneYes++

        // 任意: Google Places照合（必須ではない）
        let placeMatched = false, placeHot = false
        let matchedPlaceId: string | null = null, confidence = 0
        let placeFields: any = {}
        if (mapsKey && ex.shop_name && ex.area && !ex.is_excluded) {
          const r = await searchLight(mapsKey, `${ex.shop_name} ${ex.area}`, 3)
          const top = r.places?.[0]
          if (top) {
            confidence = matchConfidence(ex.shop_name, top.displayName?.text || '')
            if (confidence >= 60) {
              placeMatched = true
              matchedPlaceId = top.id || null
              counts.placeMatched++
              const detail = matchedPlaceId ? await placeDetails(mapsKey, matchedPlaceId) : null
              const p = detail || top
              placeFields = p
              const { oldest, latest } = reviewDates(p)
              const classified: any = classifyLead({
                name: ex.shop_name, address: ex.address || top.formattedAddress || '', industry: ex.industry || undefined,
                phone_number: phoneOf(p) || ex.phone, website_url: p.websiteUri || ex.website_url || '', place_id: matchedPlaceId || undefined,
                is_new_gbp: true, review_count: typeof p.userRatingCount === 'number' ? p.userRatingCount : undefined,
                business_status: p.businessStatus || undefined, opening_date: parseOpeningDate(p.openingDate) || undefined,
                from_new_open_query: true, oldest_review_publish_time: oldest || undefined, latest_review_publish_time: latest || undefined,
              }, [], { hotMaxReviews: 5, warmMaxReviews: 15, exclude100: true, unknownHold: true })
              placeHot = classified.lead_temperature === 'HOT'
            }
          }
        }

        const verdict = classifyInstagram(ex, placeMatched, placeHot, igOpts)
        if (verdict.classification === 'google_match_hot') counts.googleHot++
        else if (verdict.classification === 'ig_only_hot') counts.igOnlyHot++
        else if (verdict.classification === 'excluded') counts.excluded++
        else counts.hold++

        const phone = ex.phone || (placeMatched ? phoneOf(placeFields) : '')
        const name = ex.shop_name || `${ex.area}${ex.industry}`.trim() || 'Instagram候補'

        const payload: any = {
          name, address: ex.address || null, industry: ex.industry || null,
          phone_number: phone || null, website_url: ex.website_url || placeFields.websiteUri || null,
          instagram_url: ex.account_url || null, instagram_account_url: ex.account_url || null,
          lead_source: 'instagram_hashtag', source_type: 'AI自動投入(Instagram)',
          lead_temperature: verdict.temperature, ig_classification: verdict.classification,
          is_new_instagram: true, is_new_gbp: placeMatched,
          should_exclude_from_call_list: verdict.temperature === 'EXCLUDED',
          owner_reachability_score: ex.phone_reachable_score,
          auto_import_reason: verdict.classification.includes('hot') ? verdict.reason : null,
          ai_comment: verdict.reason, exclusion_reason: verdict.temperature === 'EXCLUDED' ? verdict.reason : null,
          // Instagram 由来
          instagram_media_id: m.id, instagram_permalink: m.permalink || null, instagram_caption: (m.caption || '').slice(0, 4000),
          instagram_timestamp: m.timestamp || null, source_hashtag: tag,
          extracted_shop_name: ex.shop_name || null, extracted_area: ex.area || null, extracted_industry: ex.industry || null,
          extracted_address: ex.address || null, extracted_phone: ex.phone || null, extracted_url: ex.website_url || null,
          extracted_line_url: ex.line_url || null, extracted_reservation_url: ex.reservation_url || null,
          matched_google_place_id: matchedPlaceId, match_confidence: confidence || null,
          google_place_id: matchedPlaceId, instagram_newness_reason: verdict.reason,
          gbp_unregistered_candidate: verdict.gbp_unregistered_candidate, ig_auto_importable: verdict.auto_importable,
          ig_phone_reachable_score: ex.phone_reachable_score, ig_newness_score: ex.newness_score,
          last_seen_at: nowIso, source_run_id: runId,
        }

        // dedup: 同一 media_id は更新
        const { data: existing } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('instagram_media_id', m.id).limit(1)
        let candidateId: string | null = existing?.[0]?.id || null
        const alreadyImported = !!existing?.[0]?.imported_to_cases
        if (candidateId) {
          const { error: upErr } = await admin.from('lead_candidates').update(payload).eq('id', candidateId)
          if (upErr) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(upErr.message) } else counts.saved++
        } else {
          const { data: ins, error: insErr } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
          if (insErr) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(insErr.message) } else counts.saved++
          candidateId = ins?.id || null
        }

        // 自動投入: A は常に対象 / B は auto_importable のときのみ
        const importable = verdict.classification === 'google_match_hot' || verdict.auto_importable
        if (importable && candidateId && !alreadyImported && importedCount < dailyCap) {
          const memo = [`【AI自動投入 / Instagram】`, `分類: ${verdict.classification}`, `理由: ${verdict.reason}`, `投稿: ${m.permalink || ''}`, `#${tag}`].join('\n')
          const { data: created } = await admin.from('cases').insert({
            name, address: ex.address || '', phone1: phone || '', industry: ex.industry || null,
            status: DEFAULT_STATUS, hp1: ex.website_url || null, instagram: ex.account_url || null,
            source_urls: 'AI自動投入(Instagram)', memo, created_by_id: userId,
          }).select('id').single()
          if (created?.id) {
            await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId)
            counts.imported++; importedCount++
          }
        }

        if (!debug.sample) debug.sample = { hashtag: tag, permalink: m.permalink, timestamp: m.timestamp, extracted: ex, verdict, matchConfidence: confidence, matchedPlaceId }
      }

      await admin.from('ig_hashtag_log').upsert({ hashtag: tag, hashtag_id: hid, last_searched_at: nowIso, searches: 1, media_count: mediaUsed }, { onConflict: 'hashtag' }).then(() => {}, () => {})
      debug.hashtagResults.push({
        hashtag: tag, hashtagId: hid, media: media.length, used: mediaUsed, error: e2,
        googleHot: counts.googleHot - before.gh, igOnlyHot: counts.igOnlyHot - before.io, hold: counts.hold - before.hold, excluded: counts.excluded - before.ex,
      })
    }

    await admin.from('auto_lead_runs').update({
      status: 'success', finished_at: new Date().toISOString(), search_queries_count: counts.hashtags,
      fetched_count: counts.recent, hot_count: counts.googleHot + counts.igOnlyHot, hold_count: counts.hold,
      excluded_count: counts.excluded, imported_count: counts.imported, error_count: counts.error, error_message: errorMessage || null,
    }).eq('id', runId)

    return { ok: true, runId, ...counts, errorCount: counts.error, error: errorMessage || null, debug }
  } catch (e: any) {
    const msg = String(e?.message || e)
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: msg }).eq('id', runId)
    throw new Error(msg)
  }
}

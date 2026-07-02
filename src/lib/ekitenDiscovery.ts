// ============================================================
// エキテン 公開日ベースの新規掲載候補探索（Serper/Bing）。サーバー専用。
// 過去7日の「公開日」を検索 → エキテン詳細ページで公開日・電話・住所を再確認 → 公開日7日以内のみ HOT-B。
// 公開日は店舗の開業日ではなく「エキテン上の掲載公開日」。新店確定ではなく新規掲載候補として扱う。
// ============================================================
import { parseEkiten, daysSinceDate } from './sequentialProbe.js'
import { webSearch } from './instagramWebRun.js'
import { sanitizeShopName, isValidJpPhone } from './regionalParsers.js'
import { isJapanPhone } from './japanFilter.js'
import { detectChain } from './chainFilter.js'
import { detectBigOrPublic, looksLikeBranchStore } from './targetFilter.js'
import { autoImportAllowed, type InjectMode } from './hotTier.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { findCaseIdByPhone } from './caseDedup.js'
import { computeQuality } from './leadQuality.js'
import { DEFAULT_STATUS } from './constants.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 RST-CRM-bot/1.0'

/** 過去7日の日付（YYYY/MM/DD と YYYY年M月D日）を生成。 */
export function recent7Dates(): { slash: string; jp: string }[] {
  const out: { slash: string; jp: string }[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000)
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate()
    out.push({ slash: `${y}/${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}`, jp: `${y}年${m}月${day}日` })
  }
  return out
}

export async function runEkitenDiscovery(admin: any, mapsKey: string | null, settings: any, userId: string | null): Promise<any> {
  const s = settings || {}
  const mode: InjectMode = (s.aiInjectMode === 'strict' || s.aiInjectMode === 'aggressive') ? s.aiInjectMode : 'standard'
  const nowIso = new Date().toISOString()
  const perQuery = Math.max(1, Math.min(20, Number(s.ekitenPerQuery) || 10))
  const maxDetails = Math.max(1, Math.min(60, Number(s.ekitenMaxDetails) || 30))
  const autoImportPerRun = Math.max(1, Number(s.autoImportPerRun) || 50)
  const dates = recent7Dates()
  const queries: string[] = []
  for (const dt of dates) { queries.push(`site:ekiten.jp/shop_ "公開日 ${dt.slash}"`); queries.push(`site:ekiten.jp/shop_ "公開日 ${dt.jp}"`) }
  const counts: any = { dateRange: `${dates[dates.length - 1].slash}〜${dates[0].slash}`, searchDates: dates.map((d) => d.slash), queries: queries.length, results: 0, ekitenUrls: 0, detailFetched: 0, pub7: 0, pubOld: 0, noPub: 0, phoneYes: 0, addrYes: 0, hot: 0, hotB: 0, hold: 0, excluded: 0, saved: 0, imported: 0, dup: 0, error: 0 }
  const seen = new Set<string>()
  const debug: any = { queries, samples: [] as any[] }
  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'ekiten_discovery', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null
  const startMs = Date.now()
  let importedThisRun = 0
  try {
    for (const q of queries) {
      if (Date.now() - startMs > 50000) { debug.stoppedEarly = true; break }
      if (counts.detailFetched >= maxDetails) break
      const { results, error } = await webSearch(q, perQuery)
      if (error) counts.error++
      counts.results += results.length
      for (const rr of results) {
        const m = String(rr.url || '').match(/https?:\/\/(?:www\.)?ekiten\.jp\/shop_\d+\/?/)
        if (!m) continue
        const url = m[0].endsWith('/') ? m[0] : m[0] + '/'
        if (seen.has(url)) continue
        seen.add(url); counts.ekitenUrls++
        if (counts.detailFetched >= maxDetails) break
        let html = ''
        try {
          const fr = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } })
          if (fr.ok) html = await fr.text()
        } catch { /* noop */ }
        await new Promise((rs) => setTimeout(rs, 300))
        counts.detailFetched++
        if (!html) { counts.error++; continue }
        const sp = parseEkiten(html, false)
        const pubDays = daysSinceDate(sp.published)
        if (pubDays == null) counts.noPub++
        else if (pubDays <= 7) counts.pub7++
        else counts.pubOld++
        const sn = sanitizeShopName(sp.name, { placesMatched: false })
        const name = sn.valid ? sn.name : '店名未確定'
        const phone = sp.phone, address = sp.address
        const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone)
        if (phoneOk) counts.phoneYes++
        if (address) counts.addrYes++
        const ch = detectChain(sp.name)
        const big = detectBigOrPublic(`${sp.name} ${address}`)
        // 公開日7日以内のみHOT-B（電話+住所必須）。8日以上前/取得不可/大手/チェーンは対象外
        let temperature = 'HOLD'
        let hotTier: 'A' | 'B' | null = null
        if (big.exclude || ch.definite || looksLikeBranchStore(name)) temperature = 'EXCLUDED'
        else if (pubDays == null) temperature = 'HOLD'
        else if (pubDays > 7) temperature = 'EXCLUDED'
        else if (phoneOk && address) { temperature = 'HOT'; hotTier = 'B' }
        else temperature = 'HOLD'
        if (temperature === 'HOT') { counts.hot++; counts.hotB++ }
        else if (temperature === 'EXCLUDED') counts.excluded++
        else counts.hold++
        const reason = `エキテン公開日 ${sp.published || '不明'}（${pubDays != null ? pubDays + '日前' : '取得不可'}${pubDays != null && pubDays <= 7 ? '・直近7日以内の新規掲載候補' : pubDays != null ? '・8日以上前で対象外' : ''}）。※公開日は開業日ではなくエキテン上の掲載公開日。`
        const payload: any = {
          name, address: address || null, industry: classifyIndustry(name) || normalizeIndustry(sp.category) || null, phone_number: phone || null, website_url: sp.official || null,
          source: 'ekiten_discovery', lead_source: 'ekiten_discovery', source_type: 'AI自動投入(エキテン)', source_site_type: 'ekiten', parser_used: 'ekiten_shop_detail', source_site_name: 'エキテン',
          source_detail_url: url, source_list_url: 'https://www.ekiten.jp/', search_title: name.slice(0, 300), search_snippet: (rr.snippet || '').slice(0, 300),
          source_published_date: sp.published || null, source_updated_date: sp.updated || null, source_date_type: 'ekiten_published_date',
          newness_type: 'source_new_listing', regional_media_newness_reason: reason, regional_media_detected_at: nowIso, first_discovered_at: nowIso,
          lead_temperature: temperature, hot_tier: hotTier, recommended_status: temperature === 'HOT' ? 'HOT_B' : temperature, should_exclude_from_call_list: temperature === 'EXCLUDED',
          name_unconfirmed_hot: temperature === 'HOT' && !sn.valid, phone_source: phone ? 'detail_page' : null,
          owner_reachability_score: phone ? 65 : 30, auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason,
          extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null, extracted_industry: sp.category || null, extracted_official_url: sp.official || null,
          last_seen_at: nowIso, source_run_id: runId,
        }
        const qr = computeQuality({ ...payload, lead_temperature: temperature, hot_tier: hotTier })
        payload.quality_score = qr.score; payload.quality_grade = qr.grade; payload.industry_category = qr.category
        payload.dedup_key = qr.dedupKey; payload.quality_flags = qr.flags; payload.phone_pref_match = qr.phoneMatch; payload.quality_computed_at = nowIso
        const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_detail_url', url).limit(1)
        let candidateId: string | null = exC?.[0]?.id || null
        if (!candidateId && phone) { const { data: byPhone } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = byPhone?.[0]?.id || null; if (candidateId) counts.dup++ }
        const alreadyImported = !!exC?.[0]?.imported_to_cases
        if (candidateId) { await admin.from('lead_candidates').update(payload).eq('id', candidateId).then(() => {}, () => {}) }
        else { const { data: ins } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single(); candidateId = ins?.id || null; counts.saved++ }
        if (temperature === 'HOT' && phoneOk && address && candidateId && !alreadyImported && importedThisRun < autoImportPerRun && autoImportAllowed('HOT_B' as any, mode)) {
          const dupCaseId = await findCaseIdByPhone(admin, phone)
          if (dupCaseId) {
            await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId, auto_insert_skipped_reason: '既存案件と電話重複のためリンク' }).eq('id', candidateId)
          } else {
            const { data: created } = await admin.from('cases').insert({ name, address: address || '', phone1: phone, industry: classifyIndustry(name) || normalizeIndustry(sp.category) || null, status: DEFAULT_STATUS, priority: '中', hp1: sp.official || null, source_urls: url, memo: `【AI自動投入 / エキテン新規掲載候補 / HOT-B】${reason}\n電話: ${phone}\n住所: ${address}\nURL: ${url}\n※公開日は掲載公開日（開業日ではない）。営業前に確認推奨。`, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
            if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id }).eq('id', candidateId); counts.imported++; importedThisRun++ }
          }
        }
        if (debug.samples.length < 15) debug.samples.push({ url, name, phone, address, published: sp.published, pubDays, temperature })
      }
    }
    await admin.from('auto_lead_runs').update({ status: 'success', finished_at: new Date().toISOString(), search_queries_count: counts.queries, fetched_count: counts.detailFetched, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded, imported_count: counts.imported }).eq('id', runId).then(() => {}, () => {})
    return { ok: true, runId, ...counts, debug }
  } catch (e: any) {
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: String(e?.message || e) }).eq('id', runId).then(() => {}, () => {})
    return { ok: false, error: String(e?.message || e), ...counts, debug }
  }
}

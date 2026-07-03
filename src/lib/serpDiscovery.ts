// ============================================================
// 汎用SERPディスカバリ・エンジン（Google/Serper検索駆動）。サーバー専用。
// query-based の複数 source_type を1エンジンで処理: source実行→candidate抽出→詳細取得→
// 店名/電話/住所/URL/新規根拠抽出→Places/公式補完→検証→重複判定→HOT/HOLD/EXCLUDED→
// lead_candidates保存→HOTならcases投入→lead_signals保存→営業優先度→架電前メモ→ログ。
// 件数より質。電話/住所なしはHOT禁止。日本国内のみ。大手/公共/閉店/重複は除外。差分(既読URLスキップ)対応。
// ============================================================
import { webSearch, enrichCandidate } from './instagramWebRun.js'
import { sanitizeShopName, isValidJpPhone, extractJpPhone, isTollFreeJp } from './regionalParsers.js'
import { hardExcludeReason } from './excludeGate.js'
import { isJapanPhone, isJapanAddress, isForeignAddress } from './japanFilter.js'
import { detectBigOrPublic, detectMultiStore } from './targetFilter.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { detectChain } from './chainFilter.js'
import { computeQuality, detectNegative, isRealStoreAddress } from './leadQuality.js'
import { addSignals, applySalesScore } from './leadSignals.js'
import { getSourceDef, pastDates } from './discoverySources.js'
import { autoImportAllowed, type InjectMode } from './hotTier.js'
import { findCaseIdByPhone } from './caseDedup.js'
import { placesEstablishmentSignal, BIG_GOOGLE_REVIEWS } from './importHot.js'
import { DEFAULT_STATUS } from './constants.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 RST-CRM-bot/1.0'
const PREF_RE = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)[一-龥ぁ-んァ-ヶ0-9０-９丁目番地号－−\-]{2,40}/
// 新店根拠（HOT必須）: クエリが新店系でも着地ページが古い既存店のことがあるため、本文/タイトルで実際の新店文脈を確認する。
const NEW_OPEN_RE = /(新規オープン|ニューオープン|グランドオープン|プレオープン|オープンしました|オープンいたしました|オープン予定|オープンいたします|近日オープン|まもなくオープン|もうすぐオープン|本日オープン|明日オープン|移転オープン|リニューアルオープン|開店しました|開店いたしました|開業しました|開業いたしました|開院しました|開院いたしました|開設しました|新規開業|新規開店|開業予定|開院予定|開院のお知らせ|開業のお知らせ|オープンのお知らせ|オープニング|グランドオープン|プレオープン|new[\s_]?open|grand[\s_]?open|now[\s_]?open|coming[\s_]?soon)/i
// 開業日/オープン日 表記（YYYY年M月/M月D日 OPEN 等）。新店の裏取りを補強。
const OPEN_DATE_RE = /(20\d{2}年\s?\d{1,2}月|(0?[1-9]|1[0-2])月\s?([0-3]?\d)日)\s?(グランド|ニュー|プレ)?オープン|オープン日|開店日|開業日|開院日/i

function urlHash(u: string): string { let h = 0; const s = String(u); for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 } return String(h >>> 0) }
const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()

async function fetchPage(url: string, timeoutMs = 9000): Promise<string> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: ctrl.signal, redirect: 'follow' })
    clearTimeout(t); if (!r.ok) return ''
    return await r.text()
  } catch { return '' }
}
// 詳細ページから 店名/電話/住所/公式 を抽出
function extractDetail(html: string): { name: string; phone: string; address: string; official: string } {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] || ''
  const h1 = strip(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
  let name = (h1 || og || title).replace(/\s*[|｜-].*$/, '').replace(/\s*[（(][^）)]*[)）]\s*$/, '').trim().slice(0, 60)
  const body = strip(html)
  let phone = (html.match(/href=["']tel:(\+?[\d-]{9,15})/i)?.[1] || '').replace(/^\+81/, '0')
  if (!phone) phone = extractJpPhone(body)
  const address = (body.match(PREF_RE)?.[0] || '').replace(/(地図|アクセス|MAP|電話|TEL|営業時間).*$/i, '').slice(0, 70)
  const official = html.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*(?:公式|ホームページ|オフィシャル)/i)?.[1] || ''
  return { name, phone, address, official }
}

async function readCost(admin: any): Promise<any> {
  const today = new Date().toISOString().slice(0, 10)
  try { const { data } = await admin.from('app_config').select('value').eq('key', 'discovery_cost').maybeSingle(); const v = data?.value || {}; return v.date === today ? v : { date: today, serper: 0, scrapingbee: 0, aiMemo: 0 } } catch { return { date: today, serper: 0, scrapingbee: 0, aiMemo: 0 } }
}
async function writeCost(admin: any, cost: any): Promise<void> { try { await admin.from('app_config').upsert({ key: 'discovery_cost', value: cost, updated_date: new Date().toISOString() }, { onConflict: 'key' }) } catch { /* noop */ } }

export interface SerpOpts { perQuery?: number; maxQueriesPerRun?: number; maxDetails?: number; runBudgetMs?: number; serperDailyCap?: number; autoImportPerRun?: number; aiInjectMode?: InjectMode; recrawlAll?: boolean }

/** 1つの source_type をSERP駆動で巡回。 */
export async function runSerpDiscovery(admin: any, sourceType: string, mapsKey: string | null, opts: SerpOpts, userId: string | null): Promise<any> {
  const def = getSourceDef(sourceType)
  if (!def) return { ok: false, error: `未知のsource_type: ${sourceType}` }
  if (def.mode === 'foundation') return { ok: true, skipped: true, reason: `${def.label} は土台のみ（外部API/対象確認後に有効化）`, sourceType }
  if (def.mode !== 'serp' || !def.queries?.length) return { ok: true, skipped: true, reason: `${def.label} はSERP対象外`, sourceType }

  const perQuery = Math.max(1, Math.min(15, opts.perQuery || 8))
  const maxQ = Math.max(1, Math.min(20, opts.maxQueriesPerRun || 6))
  const maxDetails = Math.max(1, Math.min(40, opts.maxDetails || 14))
  const budgetMs = Math.max(15000, Math.min(50000, opts.runBudgetMs || 45000))
  const serperCap = Math.max(0, opts.serperDailyCap ?? 50)
  const autoImportPerRun = Math.max(0, opts.autoImportPerRun ?? 30)
  const mode: InjectMode = (opts.aiInjectMode === 'strict' || opts.aiInjectMode === 'aggressive') ? opts.aiInjectMode : 'standard'
  const nowIso = new Date().toISOString()
  const startMs = Date.now()
  const cost = await readCost(admin)

  // クエリ生成（公開日系は過去7日の日付を展開）
  let queries = [...def.queries]
  if (/published_date|portal/.test(def.type)) { const ds = pastDates(7); queries = ds.flatMap((d) => def.queries!.map((q) => q.replace('{date}', d.slash))) }
  // クエリ回転: 以前は queries.slice(0, maxQ) 固定で、maxQ(既定6)より後ろのクエリが永久に実行されなかった。
  // このsource_typeの過去実行回数でウィンドウをずらし、全クエリを順に網羅する。
  const allQ = queries
  if (allQ.length > maxQ) {
    const { count: srcRuns } = await admin.from('auto_lead_runs').select('id', { count: 'exact', head: true }).eq('source', sourceType)
    const start = ((srcRuns || 0) * maxQ) % allQ.length
    queries = [...allQ.slice(start), ...allQ.slice(0, start)].slice(0, maxQ)
  } else {
    queries = allQ.slice(0, maxQ)
  }

  const counts: any = { sourceType, label: def.label, queries: 0, results: 0, newUrls: 0, seenSkipped: 0, detailFetched: 0, phoneYes: 0, addrYes: 0, hot: 0, hotB: 0, hold: 0, excluded: 0, saved: 0, imported: 0, dup: 0, error: 0, serperUsed: 0 }
  const debug: any = { samples: [] as any[] }
  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: sourceType, status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null
  const seen = new Set<string>()
  const importedCases: { id: string; name: string; phone: string; address: string }[] = []
  let importedThisRun = 0
  let establishmentLookups = 0
  const MAX_ESTABLISHMENT_LOOKUPS = 20 // 既存店ガードのPlaces確認は1実行あたり上限（60秒枠を守る）

  try {
    for (const q of queries) {
      if (Date.now() - startMs > budgetMs) { debug.stoppedEarly = true; break }
      if (counts.detailFetched >= maxDetails) break
      if (serperCap > 0 && cost.serper >= serperCap) { debug.serperCapReached = true; break }
      const { results, error } = await webSearch(q, perQuery)
      cost.serper++; counts.serperUsed++; counts.queries++
      if (error) counts.error++
      counts.results += results.length
      for (const rr of results) {
        if (counts.detailFetched >= maxDetails) break
        const url = String(rr.url || '').split('#')[0]
        if (!/^https?:\/\//.test(url)) continue
        const h = urlHash(url)
        if (seen.has(h)) continue; seen.add(h)
        // 差分: 既読URL or 既存候補はスキップ
        if (!opts.recrawlAll) {
          const { data: su } = await admin.from('discovery_seen_urls').select('id').eq('source_type', sourceType).eq('url_hash', h).limit(1)
          const { data: ec } = await admin.from('lead_candidates').select('id').eq('source_detail_url', url).limit(1)
          if (su?.[0] || ec?.[0]) { counts.seenSkipped++; continue }
        }
        counts.newUrls++
        await admin.from('discovery_seen_urls').upsert({ source_type: sourceType, url_hash: h, url }, { onConflict: 'source_type,url_hash' }).then(() => {}, () => {})

        const html = await fetchPage(url)
        counts.detailFetched++
        await new Promise((rs) => setTimeout(rs, 250))
        if (!html) { counts.error++; continue }
        const bodyStrip = strip(html)
        const closed = detectNegative(bodyStrip.slice(0, 3000))
        const d = extractDetail(html)
        // 新店根拠: 着地ページ本文＋タイトル＋スニペットに実際の新店文脈があるか（クエリ由来だけを信用しない）
        const newnessText = `${d.name} ${bodyStrip.slice(0, 4000)} ${rr.title || ''} ${rr.snippet || ''}`
        const hasNewness = NEW_OPEN_RE.test(newnessText) || OPEN_DATE_RE.test(newnessText)
        // 補完: 電話 or 住所が欠ければ Places/検索で補完（コスト節約のため不足時のみ・両方欠けは2クエリまで）
        let enrich: any = null
        const sn0 = sanitizeShopName(d.name, { placesMatched: false })
        const needEnrich = (!d.phone || !d.address) && sn0.valid && !!mapsKey
        if (needEnrich) { try { enrich = await enrichCandidate(mapsKey, { shop: sn0.name, username: '', areaHint: d.address || '', industry: '', havePhone: d.phone || '', haveAddress: d.address || '' }, { maxQueries: (!d.phone && !d.address) ? 2 : 1, perQuery: 5 }) } catch { /* noop */ } }
        const phone = d.phone || enrich?.phone || ''
        const address = d.address || enrich?.address || ''
        const official = d.official || enrich?.official || (/(instagram\.com|prtimes\.jp|ekiten|camp-fire|makuake)/i.test(url) ? '' : url)
        const matchedPlaceId = enrich?.place_id || null
        const sn = sanitizeShopName(enrich?.place_name || d.name, { placesMatched: !!matchedPlaceId })
        const name = sn.valid ? sn.name : '店名未確定'
        const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
        if (phoneOk) counts.phoneYes++; if (address) counts.addrYes++
        const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || !!enrich?.prefecture)
        const big = detectBigOrPublic(`${name} ${address}`)
        const chain = detectChain(name)
        const multi = detectMultiStore(`${name} ${d.name}`)

        // HOT/HOLD/EXCLUDED 判定（質優先）。電話+住所必須・大手/閉店/外国/多店舗/ポータル・ツール・まとめ系は除外。
        // SERPはノイズが多いため、HOTは「実店舗名が確定 or Google Places一致」を要件に追加（店名未確定だけのノイズはHOLD）。
        const noiseText = `${name} ${rr.title || ''} ${rr.snippet || ''}`
        const portalNoise = closed.portal || /ツール|まとめ記事|ランキング|比較サイト|一覧表|収集|代行業者|料金表|求人サイト|ポータル|事業者様|業者向け|toB|BtoB|システム|アプリ/.test(noiseText)
        const genericName = !sn.valid || /^(店舗|お店|新規オープン|ショップ|サロン|クリニック|会社|お知らせ|ニュース)$/.test(name)
        const shopConfirmed = (sn.valid && !genericName) || !!matchedPlaceId
        // 共通ハード除外（フリーダイヤル/○○店支店/大手量販モール/2店舗以上FC/大手チェーン/記事まとめ）を全ソース一貫適用
        const hardEx = hardExcludeReason({ name, phone, text: `${d.name} ${rr.title || ''} ${rr.snippet || ''}` })
        let temperature = 'HOLD'; let hotTier: 'A' | 'B' | null = null
        let holdReason = ''
        if (closed.closed || big.exclude || chain.definite || multi.exclude || isForeignAddress(address) || portalNoise || hardEx) temperature = 'EXCLUDED'
        // HOT要件（質優先）: 電話+実店舗住所+日本+実店舗名確定 に加え、着地ページで新店根拠を確認できること。
        // 新店根拠が無い候補（クエリはヒットしたが本文が既存店/無関係）は営業前確認のためHOLDに留める。
        else if (phoneOk && address && isRealStoreAddress(address) && isJapan && shopConfirmed && hasNewness) { temperature = 'HOT'; hotTier = 'B' }
        else {
          temperature = 'HOLD'
          holdReason = !phoneOk ? '電話番号なし/無効' : !address || !isRealStoreAddress(address) ? '実店舗住所なし' : !shopConfirmed ? '実店舗名が未確定' : !hasNewness ? '新店根拠が本文で確認できず' : '要確認'
        }
        if (temperature === 'HOT') { counts.hot++; counts.hotB++ } else if (temperature === 'EXCLUDED') counts.excluded++; else { counts.hold++; if (!hasNewness && phoneOk && address) counts.holdNoNewness = (counts.holdNoNewness || 0) + 1 }

        const reason = `${def.label}: 「${rr.title || name}」${hasNewness ? ' / 新店根拠あり' : ''}${holdReason ? `（HOLD理由: ${holdReason}）` : ''}${closed.closed ? `（${closed.reason}）` : ''}${enrich?.status ? ` / 補完[${enrich.status}]` : ''}`
        const payload: any = {
          name, address: address || null, phone_number: phone || null, website_url: official || null, instagram_url: enrich?.instagram || null,
          source: sourceType, lead_source: sourceType, discovery_source_type: sourceType, source_type: `AI自動投入(${def.label})`, source_site_name: def.label, parser_used: 'serp_discovery',
          source_detail_url: url, source_list_url: null, search_title: (rr.title || name).slice(0, 300), search_snippet: (rr.snippet || '').slice(0, 300),
          newness_type: def.signalType, regional_media_newness_reason: reason, regional_media_detected_at: nowIso, first_discovered_at: nowIso,
          lead_temperature: temperature, hot_tier: hotTier, recommended_status: temperature === 'HOT' ? 'HOT_B' : temperature, should_exclude_from_call_list: temperature === 'EXCLUDED',
          name_unconfirmed_hot: temperature === 'HOT' && !sn.valid, phone_source: phone ? (matchedPlaceId ? 'google_places' : 'detail_page') : null,
          matched_google_place_id: matchedPlaceId, extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null, extracted_official_url: official || null,
          owner_reachability_score: phone ? 65 : 30, auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason, last_seen_at: nowIso, source_run_id: runId,
          auto_insert_skipped_reason: temperature === 'HOLD' && holdReason ? holdReason : null,
        }
        const qr = computeQuality(payload)
        Object.assign(payload, { quality_score: qr.score, quality_grade: qr.grade, industry_category: qr.category, dedup_key: qr.dedupKey, quality_flags: qr.flags, phone_pref_match: qr.phoneMatch, quality_computed_at: nowIso })

        // 重複判定（source_detail_url / 電話）
        const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_detail_url', url).limit(1)
        let candidateId: string | null = exC?.[0]?.id || null
        if (!candidateId && phone) { const { data: bp } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = bp?.[0]?.id || null; if (candidateId) counts.dup++ }
        const already = !!exC?.[0]?.imported_to_cases
        if (candidateId) { await admin.from('lead_candidates').update(payload).eq('id', candidateId).then(() => {}, () => {}) }
        else { const { data: ins } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single(); candidateId = ins?.id || null; counts.saved++ }

        if (candidateId) {
          await addSignals(admin, candidateId, [{ type: def.signalType, source: def.label, url, date: null, text: (rr.title || '').slice(0, 200), confidence: 0.6 }])
          const { data: full } = await admin.from('lead_candidates').select('*').eq('id', candidateId).single()
          const { data: sigs } = await admin.from('lead_signals').select('signal_type').eq('lead_candidate_id', candidateId)
          if (full) await applySalesScore(admin, full, Array.from(new Set((sigs || []).map((s: any) => s.signal_type))))
          // HOT-B自動投入（電話必須・重複なし）
          if (temperature === 'HOT' && phoneOk && address && !already && importedThisRun < autoImportPerRun && autoImportAllowed('HOT_B' as any, mode)) {
            // 確立済みガード: Google口コミ30件以上 or 最古クチコミ1ヶ月超 = 既存店。投入前にPlacesで確認し、該当なら降格して架電しない。
            // （SERP自動投入は一括投入スイープを経由しないため、ここでスイープ相当の既存店チェックを行う）
            // 時間予算・回数上限を守る（Places確認が積み重なって60秒枠を超えないよう、残り8秒未満/上限到達なら確認せず投入）。
            let established: { count: number | null; oldestDays: number | null } | null = null
            if (mapsKey && sn.valid && name !== '店名未確定' && establishmentLookups < MAX_ESTABLISHMENT_LOOKUPS && (Date.now() - startMs) < budgetMs - 8000) {
              establishmentLookups++
              try { established = await placesEstablishmentSignal(mapsKey, name, address) } catch { established = null }
            }
            const isEstablished = !!established && ((established.count != null && established.count >= BIG_GOOGLE_REVIEWS) || (established.oldestDays != null && established.oldestDays > 30))
            if (isEstablished) {
              const why = (established!.count != null && established!.count >= BIG_GOOGLE_REVIEWS)
                ? `Google口コミ${established!.count}件(30件以上=確立済み)のため投入せず`
                : `Google最古クチコミ${established!.oldestDays}日前(1ヶ月超=既存店)のため投入せず`
              await admin.from('lead_candidates').update({
                lead_temperature: (established!.count != null && established!.count >= BIG_GOOGLE_REVIEWS) ? 'EXCLUDED' : 'HOLD', hot_tier: null,
                should_exclude_from_call_list: (established!.count != null && established!.count >= BIG_GOOGLE_REVIEWS),
                user_rating_count: established!.count ?? null, google_user_rating_count: established!.count ?? null,
                oldest_review_days_ago: established!.oldestDays ?? null, auto_insert_skipped_reason: why, auto_import_reason: null,
              }).eq('id', candidateId).then(() => {}, () => {})
              counts.hot = Math.max(0, counts.hot - 1); counts.hotB = Math.max(0, counts.hotB - 1)
              counts.establishedSkipped = (counts.establishedSkipped || 0) + 1
              if (debug.samples.length < 12) debug.samples.push({ url, name, phone, address, temperature: 'DOWNGRADED(既存店)', why })
              continue
            }
            const dupCaseId = await findCaseIdByPhone(admin, phone)
            if (dupCaseId) {
              await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId, auto_insert_skipped_reason: '既存案件と電話重複のためリンク' }).eq('id', candidateId)
            } else {
              const memo = (full as any)?.call_memo ? `\n\n${(full as any).call_memo}` : ''
              const { data: created } = await admin.from('cases').insert({ name, address: address || '', phone1: phone, industry: classifyIndustry(name) || normalizeIndustry(qr.category) || null, status: DEFAULT_STATUS, priority: '中', hp1: official || null, source_urls: url, memo: `【AI自動投入 / ${def.label} / HOT-B】${reason}\n電話: ${phone}\n住所: ${address}\nURL: ${url}${memo}`, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
              if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id }).eq('id', candidateId); counts.imported++; importedThisRun++; importedCases.push({ id: created.id, name, phone, address }) }
            }
          }
        }
        if (debug.samples.length < 12) debug.samples.push({ url, name, phone, address, temperature })
      }
    }
    await writeCost(admin, cost)
    await admin.from('auto_lead_runs').update({ status: 'success', finished_at: new Date().toISOString(), search_queries_count: counts.queries, fetched_count: counts.detailFetched, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded, imported_count: counts.imported }).eq('id', runId).then(() => {}, () => {})
    return { ok: true, runId, ...counts, importedCases, debug }
  } catch (e: any) {
    await writeCost(admin, cost)
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: String(e?.message || e) }).eq('id', runId).then(() => {}, () => {})
    return { ok: false, error: String(e?.message || e), ...counts, debug }
  }
}

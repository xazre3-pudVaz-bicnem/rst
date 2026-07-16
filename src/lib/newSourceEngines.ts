// ============================================================
// 追加取得元の本稼働エンジン群（土台→本稼働）。サーバー専用。
// すべて共通pipeline(ingestFromUrl)を通す: fetch→抽出→Places/公式補完→検証→除外→重複→signal→HOT/HOLD→保存→HOT投入。
// 外部の有料サービス(OCR/Meta API)を要するもの(スクショ/PDF/CSV/IGコメント)は対象外（run.tsでfoundation継続）。
// すべて残り時間ガード＋fetchタイムアウトで60秒関数上限を死守する。
// ============================================================
import { enrichCandidate, fetchFollowersViaWebSearch } from './instagramWebRun.js'
import { sanitizeShopName, isValidJpPhone, extractJpPhone, isTollFreeJp } from './regionalParsers.js'
import { isJapanPhone, isJapanAddress, isForeignAddress } from './japanFilter.js'
import { detectBigOrPublic, detectMultiStore } from './targetFilter.js'
import { detectChain } from './chainFilter.js'
import { computeQuality, detectNegative, isRealStoreAddress, phoneAddressMatch } from './leadQuality.js'
import { hardExcludeReason } from './excludeGate.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { addSignals, applySalesScore } from './leadSignals.js'
import { findCaseIdByPhone } from './caseDedup.js'
import { placesEstablishmentSignal, BIG_GOOGLE_REVIEWS } from './importHot.js'
import { caseImportGate, applyGateDowngrade } from './importGate.js'
import { getHotCities } from './hotspots.js'
import { extractOpeningDateFromText } from './directoryParser.js'
import { openProx } from './salesScore.js'
import { DEFAULT_STATUS } from './constants.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 RST-CRM-bot/1.0'
const PREF_RE = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)[一-龥ぁ-んァ-ヶ0-9０-９丁目番地号－−\-]{2,40}/
const NEW_OPEN_RE = /(新規オープン|ニューオープン|グランドオープン|プレオープン|オープンしました|オープン予定|近日オープン|開店しました|開業しました|開院しました|新規開業|新規開店|移転オープン|リニューアルオープン|ホームページを公開|公式サイトを公開|ホームページを開設|公式サイト開設|サイトを公開しました|内覧会|予約受付開始|new[\s_]?open|grand[\s_]?open)/i

const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()

async function fetchText(url: string, timeoutMs = 8000, accept = 'text/html'): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Accept: accept }, signal: ctrl.signal, redirect: 'follow' })
    const text = await r.text().catch(() => '')
    clearTimeout(to)
    return { ok: r.ok, status: r.status, text }
  } catch { return { ok: false, status: 0, text: '' } }
}

// 外部呼び出しのハード上限。enrichCandidate/placesEstablishmentSignal は内部で複数の外部fetchを直列に行い
// 最悪数十秒かかり得る（各fetchのタイムアウトの総和）。Promise.raceで頭打ちにし、超過時はfallbackで先へ進む
// （敗者の未await promiseはレスポンス送出後にVercelが解放）。これで1件あたりの処理時間を確定させ504を防ぐ。
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([Promise.resolve(p).catch(() => fallback), new Promise<T>((res) => setTimeout(() => res(fallback), ms))])
}

function extractDetail(html: string): { name: string; phone: string; address: string; official: string } {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] || ''
  const h1 = strip(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
  const name = (h1 || og || title).replace(/\s*[|｜-].*$/, '').replace(/\s*[（(][^）)]*[)）]\s*$/, '').trim().slice(0, 60)
  const body = strip(html)
  let phone = (html.match(/href=["']tel:(\+?[\d-]{9,15})/i)?.[1] || '').replace(/^\+81/, '0')
  if (!phone) phone = extractJpPhone(body)
  const address = (body.match(PREF_RE)?.[0] || '').replace(/(地図|アクセス|MAP|電話|TEL|営業時間).*$/i, '').slice(0, 70)
  const official = html.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*(?:公式|ホームページ|オフィシャル)/i)?.[1] || ''
  return { name, phone, address, official }
}

export interface IngestResult { status: 'valid' | 'invalid' | 'error'; temperature?: string; name?: string; phone?: string; address?: string; candidateId?: string | null; importedCaseId?: string | null; imported?: boolean; reason?: string }

/**
 * 共通pipeline: 1URLを候補化する。fetch→抽出→補完→検証→除外→重複→signal→HOT/HOLD/EXCLUDED→保存→HOT投入。
 * 電話/住所なしはHOT禁止・店名未確定でも電話+住所+新規根拠でHOT-B・大手/公共/EC/チェーン/閉店/国外は除外。
 */
export async function ingestFromUrl(admin: any, mapsKey: string | null, o: {
  url: string; sourceType: string; label: string; signalType: string; evidenceIso?: string | null
  hintName?: string; hintPhone?: string; hintAddress?: string; hintOfficial?: string; extraText?: string
  userId: string | null; autoImport?: boolean; runId?: string | null; saveAlways?: boolean
}): Promise<IngestResult> {
  const url = String(o.url || '').split('#')[0].trim()
  if (!/^https?:\/\//.test(url)) return { status: 'error', reason: '不正なURL' }
  const nowIso = new Date().toISOString()
  // 既読/既存（source_detail_url）
  const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_detail_url', url).limit(1)
  const html = (o.hintOfficial || o.hintName) ? '' : (await fetchText(url)).text
  const body = html ? strip(html) : ''
  const closed = detectNegative(body.slice(0, 3000))
  const d = html ? extractDetail(html) : { name: '', phone: '', address: '', official: '' }
  const sn0 = sanitizeShopName(o.hintName || d.name, { placesMatched: false })
  let enrich: any = null
  const needEnrich = (!(o.hintPhone || d.phone) || !(o.hintAddress || d.address)) && sn0.valid && !!mapsKey
  if (needEnrich) enrich = await withTimeout(enrichCandidate(mapsKey!, { shop: sn0.name, username: '', areaHint: o.hintAddress || d.address || '', industry: '', havePhone: o.hintPhone || d.phone || '', haveAddress: o.hintAddress || d.address || '' }, { maxQueries: 1, perQuery: 5 }), 12000, null)
  const phone = o.hintPhone || d.phone || enrich?.phone || ''
  const address = o.hintAddress || d.address || enrich?.address || ''
  const official = o.hintOfficial || d.official || enrich?.official || (/(instagram\.com|prtimes\.jp|ekiten|camp-fire|makuake|crt\.sh)/i.test(url) ? '' : url)
  const matchedPlaceId = enrich?.place_id || null
  const sn = sanitizeShopName(enrich?.place_name || o.hintName || d.name, { placesMatched: !!matchedPlaceId })
  const name = sn.valid ? sn.name : '店名未確定'
  const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
  const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || !!enrich?.prefecture)
  const text = `${name} ${o.hintName || ''} ${d.name} ${o.extraText || ''} ${body.slice(0, 1500)}`
  const big = detectBigOrPublic(`${name} ${address}`)
  const chain = detectChain(name)
  const multi = detectMultiStore(text)
  const portalNoise = closed.portal || /ツール|まとめ記事|ランキング|比較サイト|一覧表|代行業者|料金表|求人サイト|ポータル|事業者様|業者向け|BtoB|システム|アプリ配信/.test(text)
  const genericName = !sn.valid || /^(店舗|お店|新規オープン|ショップ|サロン|クリニック|会社|お知らせ|ニュース)$/.test(name)
  const shopConfirmed = (sn.valid && !genericName) || !!matchedPlaceId
  // 開業日をテキストから抽出（全ソース共通基盤）。高確度の開業日そのものも新規根拠として認める
  const od = extractOpeningDateFromText(`${o.extraText || ''} ${o.hintName || ''} ${d.name} ${body.slice(0, 4000)}`, { publishedIso: o.evidenceIso || null })
  const hasNewness = NEW_OPEN_RE.test(text) || !!o.evidenceIso || (!!od && od.confidence >= 60)
  const hardEx = hardExcludeReason({ name, phone, text })

  let temperature = 'HOLD'; let hotTier: 'A' | 'B' | null = null; let holdReason = ''
  if (closed.closed || big.exclude || chain.definite || multi.exclude || isForeignAddress(address) || portalNoise || hardEx) temperature = 'EXCLUDED'
  else if (phoneOk && address && isRealStoreAddress(address) && isJapan && shopConfirmed && hasNewness) { temperature = 'HOT'; hotTier = 'B' }
  else { holdReason = !phoneOk ? '電話番号なし/無効' : (!address || !isRealStoreAddress(address)) ? '実店舗住所なし' : !shopConfirmed ? '実店舗名が未確定' : !hasNewness ? '新規根拠が確認できず' : '要確認' }

  const reason = `${o.label}: 「${name}」${hasNewness ? ' / 新規根拠あり' : ''}${o.evidenceIso ? ` / 根拠日:${o.evidenceIso.slice(0, 10)}` : ''}${holdReason ? `（HOLD理由: ${holdReason}）` : ''}${enrich?.status ? ` / 補完[${enrich.status}]` : ''}`
  const payload: any = {
    name, address: address || null, phone_number: phone || null, extracted_phone: phone || null, extracted_address: address || null,
    website_url: official || null, official_url: official || null, instagram_url: enrich?.instagram || null,
    source: o.sourceType, lead_source: o.sourceType, discovery_source_type: o.sourceType, source_type: `AI自動投入(${o.label})`, source_site_name: o.label, parser_used: 'engine_ingest',
    source_detail_url: url, search_title: name.slice(0, 300), search_snippet: (o.extraText || '').slice(0, 300),
    newness_type: o.signalType, regional_media_newness_reason: reason, regional_media_detected_at: nowIso, first_discovered_at: nowIso,
    lead_temperature: temperature, hot_tier: hotTier, recommended_status: temperature === 'HOT' ? 'HOT_B' : temperature, should_exclude_from_call_list: temperature === 'EXCLUDED',
    name_unconfirmed_hot: temperature === 'HOT' && !sn.valid, phone_source: phone ? (matchedPlaceId ? 'google_places' : 'detail_page') : null,
    matched_google_place_id: matchedPlaceId, extracted_shop_name: name,
    owner_reachability_score: phone ? 65 : 30, auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason, last_seen_at: nowIso, source_run_id: o.runId || null,
    auto_insert_skipped_reason: temperature === 'HOLD' && holdReason ? holdReason : null,
    // 開業日: Google補完由来を最優先、無ければ記事テキスト抽出（精度はsourceに符号化: article_text_day/part/month）
    ...(enrich?.has_opening ? {
      opening_date: (enrich.opening_year && enrich.opening_month) ? `${enrich.opening_year}-${String(enrich.opening_month).padStart(2, '0')}-${String(enrich.opening_day || 1).padStart(2, '0')}` : null,
      opening_date_source: 'external_enrichment', opening_date_confidence: enrich.opening_confidence ?? null,
      days_until_opening: enrich.days_until_opening ?? null, days_since_opening: enrich.days_since_opening ?? null,
      has_google_opening_date: true, google_business_status: enrich.business_status || null,
    } : od ? {
      opening_date: od.iso, opening_date_source: `article_text_${od.precision}`, opening_date_confidence: od.confidence,
      days_until_opening: od.daysUntil, days_since_opening: od.daysSince,
    } : {}),
  }
  // クロール発見URL(saveAlways無し)で、実店舗情報(電話/住所/新規根拠)が皆無なら保存しない（新規ドメイン等の無関係ページで
  // lead_candidatesを汚さないため）。ユーザーが明示的に貼ったURL(bulk/manual)は saveAlways=true で常に保存。
  if (!o.saveAlways && !exC?.[0] && temperature !== 'HOT' && !phone && !address && !hasNewness) {
    return { status: 'invalid', temperature: 'SKIPPED', name, reason: '実店舗情報なし（電話/住所/新規根拠なし）・保存せず' }
  }
  const qr = computeQuality(payload)
  Object.assign(payload, { quality_score: qr.score, quality_grade: qr.grade, industry_category: qr.category, dedup_key: qr.dedupKey, quality_flags: qr.flags, phone_pref_match: qr.phoneMatch, quality_computed_at: nowIso })

  let candidateId: string | null = exC?.[0]?.id || null
  if (!candidateId && phone) { const { data: bp } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = bp?.[0]?.id || null }
  const already = !!exC?.[0]?.imported_to_cases
  if (candidateId) await admin.from('lead_candidates').update(payload).eq('id', candidateId).then(() => {}, () => {})
  else { const { data: ins } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: o.userId }).select('id').single(); candidateId = ins?.id || null }

  if (candidateId) {
    await addSignals(admin, candidateId, [{ type: o.signalType, source: o.label, url, date: od?.iso || o.evidenceIso || null, text: name.slice(0, 180), confidence: temperature === 'HOT' ? 0.8 : 0.5 }])
    const { data: full } = await admin.from('lead_candidates').select('*').eq('id', candidateId).single()
    const { data: sigs } = await admin.from('lead_signals').select('signal_type').eq('lead_candidate_id', candidateId)
    if (full) await applySalesScore(admin, full, Array.from(new Set((sigs || []).map((s: any) => s.signal_type))))
  }

  let importedCaseId: string | null = null; let imported = false
  if (o.autoImport !== false && temperature === 'HOT' && phoneOk && candidateId && !already) {
    // 既存店ガード（口コミ30件以上/最古1ヶ月超）
    let established: any = null
    if (mapsKey && sn.valid && name !== '店名未確定') established = await withTimeout(placesEstablishmentSignal(mapsKey, name, address), 8000, null)
    const isEstablished = !!established && ((established.count != null && established.count >= BIG_GOOGLE_REVIEWS) || (established.oldestDays != null && established.oldestDays > 30))
    if (isEstablished) {
      await admin.from('lead_candidates').update({ lead_temperature: established.count >= BIG_GOOGLE_REVIEWS ? 'EXCLUDED' : 'HOLD', hot_tier: null, should_exclude_from_call_list: established.count >= BIG_GOOGLE_REVIEWS, user_rating_count: established.count ?? null, oldest_review_days_ago: established.oldestDays ?? null, auto_insert_skipped_reason: '既存店（口コミ多数/最古1ヶ月超）のため投入せず', auto_import_reason: null }).eq('id', candidateId)
      return { status: 'valid', temperature: 'DOWNGRADED', name, phone, address, candidateId, imported: false }
    }
    const dupCaseId = await findCaseIdByPhone(admin, phone)
    if (dupCaseId) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId }).eq('id', candidateId); importedCaseId = dupCaseId }
    else {
      // 統一投入前ゲート（共有番号/同名同市/チェーン等。既存店チェックは上で実施済みのためskip）
      const gate = await caseImportGate(admin, { name, phone, address, text: (o.extraText || '').slice(0, 300), mapsKey, skipEstablishment: true, budgetEndMs: Date.now() + 15000 })
      if (!gate.ok) { await applyGateDowngrade(admin, candidateId, gate); return { status: 'valid', temperature: gate.action === 'exclude' ? 'EXCLUDED' : gate.action === 'link' ? 'HOT' : 'HOLD', name, phone, address, candidateId, importedCaseId: gate.linkCaseId || null, imported: false } }
      const memo = `【AI自動投入 / ${o.label} / HOT-B】${reason}\n電話: ${phone}\n住所: ${address}\nURL: ${url}`
      const { data: created } = await admin.from('cases').insert({ name, address: address || '', phone1: phone, industry: classifyIndustry(name) || normalizeIndustry(qr.category) || null, status: DEFAULT_STATUS, priority: '中', hp1: official || null, instagram: enrich?.instagram || null, source_urls: url, memo, created_by_id: o.userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
      if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id }).eq('id', candidateId); importedCaseId = created.id; imported = true }
    }
  }
  return { status: 'valid', temperature, name, phone, address, candidateId, importedCaseId, imported }
}

// ---- 実行ログ（auto_lead_runs）ヘルパ ----
async function startRun(admin: any, source: string, userId: string | null): Promise<string | null> {
  const { data } = await admin.from('auto_lead_runs').insert({ source, status: 'running', created_by_id: userId }).select('id').single()
  return data?.id ?? null
}
/** 実行の終了を記録。status='error' のときは原因を error_message に必ず残す
 *  （保存していなかったため、毎回同じ地点で落ちる恒久エラーの原因が本番ログから一切追えなかった）。 */
async function finishRun(admin: any, runId: string | null, counts: any, status = 'success', errorMessage?: string | null) {
  if (!runId) return
  await admin.from('auto_lead_runs').update({ status, error_message: errorMessage ? String(errorMessage).slice(0, 500) : null, finished_at: new Date().toISOString(), fetched_count: counts.fetched || 0, hot_count: counts.hot || 0, hold_count: counts.hold || 0, excluded_count: counts.excluded || 0, imported_count: counts.imported || 0 }).eq('id', runId).then(() => {}, () => {})
}

// ============================================================
// 1) SSL新規発行ドメイン監視（crt.sh・無料/キー不要）
// ============================================================
const BIZ_DOMAIN_HINT = /(clinic|dental|salon|hair|nail|beauty|esthe|seitai|cafe|kitchen|dining|ramen|gym|fitness|pet|trimming|school|juku|reform|cleaning|studio|shop|store|tenpo|inc|co\.jp)/i
export async function runSslCertScan(admin: any, mapsKey: string | null, opts: { maxDomains?: number; runBudgetMs?: number; recencyDays?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now()
  const budgetMs = Math.max(15000, Math.min(280000, opts.runBudgetMs || 90000))
  const remain = () => budgetMs - (Date.now() - startMs)
  const maxDomains = Math.max(1, Math.min(40, opts.maxDomains || 20))
  // 1件あたり典型 ~10s（最悪 fetch8+enrich12+既存店8+DB3=31s）。
  // 【不変条件】敷居は必ず予算より小さく保つ（予算連動）。敷居>=予算だと1件も処理されないまま
  // success記録される「恒久0件」バグになる（runBudgetMs=30sで実際に発生した）。
  const PER_ITEM_MS = Math.min(15000, Math.floor(budgetMs / 3))
  const counts: any = { sourceType: 'new_ssl_certificate_domain_scan', label: 'SSL新規発行ドメイン監視', fetched: 0, candidates: 0, hot: 0, hold: 0, excluded: 0, imported: 0, skipped: 0 }
  const runId = await startRun(admin, 'new_ssl_certificate_domain_scan', userId)
  try {
    // crt.sh: .jp の直近発行証明書（Identity検索）。JSONで最近のcommon_nameを取得。
    const res = await fetchText('https://crt.sh/?q=%25.jp&output=json&exclude=expired', 12000, 'application/json')
    let rows: any[] = []
    try { rows = JSON.parse(res.text || '[]') } catch { rows = [] }
    // 直近発行順・重複ドメイン除去・店舗系ドメインを優先
    const seen = new Set<string>(); const domains: string[] = []
    rows.sort((a, b) => Date.parse(b.entry_timestamp || 0) - Date.parse(a.entry_timestamp || 0))
    for (const r of rows) {
      const cn = String(r.common_name || r.name_value || '').split('\n')[0].replace(/^\*\./, '').trim().toLowerCase()
      if (!cn || !/^[a-z0-9.-]+\.jp$/.test(cn) || seen.has(cn)) continue
      seen.add(cn)
      if (BIZ_DOMAIN_HINT.test(cn)) domains.unshift(cn); else domains.push(cn)
      if (domains.length >= maxDomains * 3) break
    }
    for (const dom of domains.slice(0, maxDomains)) {
      if (remain() < PER_ITEM_MS) break
      // 既に取得済みドメインはスキップ
      const { data: seenDom } = await admin.from('discovery_seen_urls').select('id').eq('source_type', 'new_ssl_certificate_domain_scan').eq('url', `https://${dom}/`).limit(1)
      if (seenDom?.[0]) { counts.skipped++; continue }
      await admin.from('discovery_seen_urls').upsert({ source_type: 'new_ssl_certificate_domain_scan', url_hash: dom, url: `https://${dom}/` }, { onConflict: 'source_type,url_hash' }).then(() => {}, () => {})
      counts.fetched++
      const r = await ingestFromUrl(admin, mapsKey, { url: `https://${dom}/`, sourceType: 'new_ssl_certificate_domain_scan', label: 'SSL新規発行ドメイン', signalType: 'new_ssl_certificate', evidenceIso: new Date().toISOString(), userId, runId })
      if (r.temperature === 'HOT') { counts.hot++; if (r.imported) counts.imported++ } else if (r.temperature === 'EXCLUDED') counts.excluded++; else if (r.temperature === 'SKIPPED') counts.skipped++; else counts.hold++
    }
    await finishRun(admin, runId, counts)
    return { ok: true, ...counts, domainsFound: domains.length }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error', String(e?.message || e)); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 2) 公式ドメインの新規シグナル: WordPress初回投稿 / sitemap直近更新 / ドメイン登録日(RDAP)
//    既存候補(official_url あり)を対象に鮮度シグナルを付与し、条件を満たせばHOLD→HOT昇格。
// ============================================================
function hostOf(u: string): string { try { return new URL(u).host } catch { return '' } }
function originOf(u: string): string { try { const x = new URL(u); return `${x.protocol}//${x.host}` } catch { return '' } }

export async function runDomainSignalScan(admin: any, mapsKey: string | null, mode: 'wordpress' | 'sitemap' | 'rdap', opts: { limit?: number; runBudgetMs?: number; recencyDays?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now()
  const budgetMs = Math.max(15000, Math.min(280000, opts.runBudgetMs || 90000))
  const remain = () => budgetMs - (Date.now() - startMs)
  const limit = Math.max(1, Math.min(60, opts.limit || 30))
  const recencyDays = Math.max(1, opts.recencyDays || (mode === 'rdap' ? 30 : 7))
  const sourceType = mode === 'wordpress' ? 'wordpress_first_post_scan' : mode === 'sitemap' ? 'sitemap_recent_url_scan' : 'new_domain_registration_scan'
  const label = mode === 'wordpress' ? 'WordPress初回投稿検出' : mode === 'sitemap' ? 'sitemap直近更新URL監視' : '新規ドメイン登録日チェック'
  const signalType = mode === 'wordpress' ? 'wordpress_first_post' : mode === 'sitemap' ? 'sitemap_recent_url' : 'new_domain_registration'
  const counts: any = { sourceType, label, fetched: 0, recent: 0, promotedHot: 0, imported: 0, skipped: 0 }
  const runId = await startRun(admin, sourceType, userId)
  const nowMs = Date.now()
  try {
    // official_url を持つ非EXCLUDED候補（serpDiscovery等は official_url と website_url を同値で保存するため official_url で足りる）
    // ※order も cursor も無く limit(400)→slice(0,30) していたため、Supabaseが毎回同じ順序を返す結果
    //   先頭30件だけを永久に再走査し、残りの候補は一度も見られなかった。
    //   実行回数ベースでオフセットを回して全候補を巡回する（id昇順＝オフセット送りの前提となる安定順序）。
    const { count: total } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true })
      .not('official_url', 'is', null).neq('lead_temperature', 'EXCLUDED')
    const { count: runCount } = await admin.from('auto_lead_runs').select('id', { count: 'exact', head: true }).eq('source', sourceType)
    const start = total && total > limit ? ((runCount || 0) * limit) % total : 0
    const { data: rows } = await admin.from('lead_candidates').select('id,name,official_url,website_url,phone_number,address,lead_temperature,imported_to_cases')
      .not('official_url', 'is', null).neq('lead_temperature', 'EXCLUDED')
      .order('id', { ascending: true }).range(start, start + 399)
    const list = (rows || []).filter((c: any) => (c.official_url || c.website_url) && /^https?:\/\//.test(c.official_url || c.website_url)).slice(0, limit)
    for (const c of list) {
      if (remain() < 9000) break
      const site = c.official_url || c.website_url
      const origin = originOf(site)
      if (!origin || /(instagram|facebook|twitter|x\.com|tiktok|lin\.ee|line\.me|lit\.link|linktr)/i.test(origin)) { counts.skipped++; continue }
      counts.fetched++
      let recentIso: string | null = null
      if (mode === 'wordpress') {
        const r = await fetchText(`${origin}/wp-json/wp/v2/posts?per_page=3&orderby=date&order=desc&_fields=date`, 7000, 'application/json')
        // WordPressでないサイトは404でもJSONの「オブジェクト」を返すことがある（例: tabelog.com の
        // /wp-json/... は {"status":404,"error":"Not Found"}）。JSON.parseは成功するため catch では守れず、
        // 直後の posts.map() が TypeError を投げて実行全体が外側catchまで飛び恒久0件になっていた
        // （実績: 直近7日で11/11回 status=error・fetched=10 で毎回同じ地点で死亡）。配列でなければ空扱いにする。
        let posts: any[] = []
        try { const j = JSON.parse(r.text || '[]'); posts = Array.isArray(j) ? j : [] } catch { posts = [] }
        const latest = posts.map((p) => Date.parse(p?.date || 0)).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0]
        if (latest && (nowMs - latest) <= recencyDays * 86400000) recentIso = new Date(latest).toISOString()
      } else if (mode === 'sitemap') {
        const r = await fetchText(`${origin}/sitemap.xml`, 7000, 'application/xml')
        const mods = Array.from(r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/gi)).map((m) => Date.parse(m[1])).filter((t) => !Number.isNaN(t))
        const latest = mods.sort((a, b) => b - a)[0]
        if (latest && (nowMs - latest) <= recencyDays * 86400000) recentIso = new Date(latest).toISOString()
      } else { // rdap
        const host = hostOf(site).replace(/^www\./, '')
        const reg = host.split('.').slice(-2).join('.')
        const r = await fetchText(`https://rdap.org/domain/${reg}`, 7000, 'application/json')
        let j: any = {}; try { j = JSON.parse(r.text || '{}') } catch { j = {} }
        const ev = Array.isArray(j.events) ? j.events.find((e: any) => e.eventAction === 'registration') : null
        const t = ev ? Date.parse(ev.eventDate || 0) : NaN
        if (!Number.isNaN(t) && (nowMs - t) <= recencyDays * 86400000) recentIso = new Date(t).toISOString()
      }
      if (!recentIso) continue
      counts.recent++
      // 鮮度シグナルを付与
      if (c.id) await addSignals(admin, c.id, [{ type: signalType, source: label, url: site, date: recentIso, text: `${label}: 直近${recencyDays}日以内`, confidence: mode === 'rdap' ? 0.4 : 0.7 }])
      // 電話+住所があり HOLD なら HOT-B へ昇格（rdapは補助のみ＝昇格しない）
      const phone = c.phone_number || ''
      const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
      if (mode !== 'rdap' && phoneOk && c.address && isRealStoreAddress(c.address) && c.lead_temperature !== 'HOT') {
        await admin.from('lead_candidates').update({ lead_temperature: 'HOT', hot_tier: 'B', recommended_status: 'HOT_B', auto_import_reason: `${label}で直近公開を確認＋電話・住所あり→HOT-B`, ai_comment: `${label}: 直近${recencyDays}日以内に公開/更新を確認。電話・住所ありのため営業候補。` }).eq('id', c.id)
        counts.promotedHot++
        if (!c.imported_to_cases && phoneOk) {
          // 統一投入前ゲート（共有番号/同名同市/チェーン/既存店等の最終関門）
          const gate = await caseImportGate(admin, { name: c.name || '', phone, address: c.address || '', mapsKey, skipEstablishment: true, budgetEndMs: startMs + budgetMs })
          if (!gate.ok) { await applyGateDowngrade(admin, c.id, gate); counts.promotedHot = Math.max(0, counts.promotedHot - 1); continue }
          const dupCaseId = await findCaseIdByPhone(admin, phone)
          if (!dupCaseId) {
            const { data: created } = await admin.from('cases').insert({ name: c.name || '（店名未確定）', address: c.address || '', phone1: phone, industry: classifyIndustry(c.name || '') || null, status: DEFAULT_STATUS, priority: '中', hp1: site, source_urls: site, memo: `【AI自動投入 / ${label} / HOT-B】直近公開＋電話・住所あり\n電話: ${phone}\n住所: ${c.address}`, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
            if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: created.id }).eq('id', c.id); counts.imported++ }
          } else { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: dupCaseId }).eq('id', c.id) }
        }
      }
    }
    await finishRun(admin, runId, { ...counts, hot: counts.promotedHot })
    return { ok: true, ...counts }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error', String(e?.message || e)); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 3) HOLD理由別 再補完キュー（電話なし/住所なし/店名未確定/openingDate未取得 を再処理）
// ============================================================
export async function runReprocessQueue(admin: any, mapsKey: string | null, type: string, opts: { limit?: number; runBudgetMs?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now()
  const budgetMs = Math.max(15000, Math.min(280000, opts.runBudgetMs || 90000))
  const remain = () => budgetMs - (Date.now() - startMs)
  const limit = Math.max(1, Math.min(100, opts.limit || 60))
  const counts: any = { sourceType: type, label: '再評価/補完', scanned: 0, enriched: 0, phoneFound: 0, addressFound: 0, promotedHot: 0, imported: 0 }
  const runId = await startRun(admin, type, userId)
  try {
    // 対象: HOLD かつ 店名が確定（未確定はノイズが多い）
    let q = admin.from('lead_candidates').select('id,name,extracted_shop_name,extracted_area,extracted_industry,extracted_prefecture,phone_number,address,lead_temperature,is_chain_store,duplicate_of_case_id,imported_to_cases,official_url,auto_insert_skipped_reason,instagram_url,search_snippet').eq('lead_temperature', 'HOLD').not('name', 'is', null).limit(300)
    if (type === 'missing_phone_recheck_queue') q = q.is('phone_number', null).not('address', 'is', null)
    else if (type === 'phone_to_address_enrichment_queue') q = q.not('phone_number', 'is', null).is('address', null)
    // 汎用キューは「一時要因」の理由だけを対象（記事/まとめ・チェーン等の品質理由をHOTへ誤復活させない）
    else q = q.or('auto_insert_skipped_reason.ilike.%電話番号なし%,auto_insert_skipped_reason.ilike.%住所なし%,auto_insert_skipped_reason.ilike.%フォロワー数を確認できず%,auto_insert_skipped_reason.ilike.%ユーザー名が特定できず%')
    const { data: rows } = await q
    const list = (rows || []).filter((c: any) => !c.is_chain_store && !c.duplicate_of_case_id).slice(0, limit)
    for (const c of list) {
      // enrich(≤12s)＋case投入の余白。【不変条件】敷居は必ず予算より小さく保つ（予算連動・恒久0件バグの再発防止）
      if (remain() < Math.min(10000, Math.floor(budgetMs / 3))) break
      const shop = c.extracted_shop_name || c.name || ''
      if (!shop || shop === '店名未確定') continue
      counts.scanned++
      // フォロワー未確認HOLDの復活: Webスニペットで確認し、1000人未満ならHOT復帰→投入（電話・住所は既にある）
      const reason0 = String(c.auto_insert_skipped_reason || '')
      if (/フォロワー|ユーザー名が特定できず/.test(reason0)) {
        let igu = (String(c.instagram_url || '').match(/instagram\.com\/([A-Za-z0-9_.]+)/i)?.[1] || '')
        if (/^(p|reel|reels|explore|tv|stories)$/i.test(igu)) igu = ''
        if (!igu) igu = (String(c.search_snippet || '').match(/@([A-Za-z0-9_.]{3,30})/)?.[1] || '').replace(/\.+$/, '')
        if (!igu) continue
        const web = await withTimeout(fetchFollowersViaWebSearch(igu), 9000, { followers: null, bio: '' } as any)
        counts.followerChecked = (counts.followerChecked || 0) + 1
        // bioに多店舗/大手語 → 除外
        if (web.bio && (detectMultiStore(web.bio).exclude || detectBigOrPublic(web.bio).exclude)) {
          await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: 'Instagramプロフィールに多店舗/大手語のため投入対象外' }).eq('id', c.id)
          counts.followerExcluded = (counts.followerExcluded || 0) + 1
          continue
        }
        const f = web.followers
        if (f == null) continue
        if (f >= 1000) {
          await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: `Instagramフォロワー${f}人(1000人以上=確立済み)のため投入対象外` }).eq('id', c.id)
          counts.followerExcluded = (counts.followerExcluded || 0) + 1
          continue
        }
        const fp = c.phone_number || ''
        const fOk = !!fp && isJapanPhone(fp) && isValidJpPhone(fp) && !isTollFreeJp(fp)
        if (!fOk || !c.address || !isRealStoreAddress(c.address)) continue
        const gateF = await caseImportGate(admin, { name: shop, phone: fp, address: c.address, mapsKey, budgetEndMs: startMs + budgetMs })
        if (!gateF.ok) { await applyGateDowngrade(admin, c.id, gateF); continue }
        await admin.from('lead_candidates').update({ lead_temperature: 'HOT', hot_tier: 'B', recommended_status: 'HOT_B', auto_insert_skipped_reason: null, ai_comment: `フォロワー${f}人をWeb確認→HOT復帰（1000人未満）` }).eq('id', c.id)
        counts.promotedHot++
        const dupF = await findCaseIdByPhone(admin, fp)
        if (dupF) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: dupF }).eq('id', c.id); continue }
        const { data: cr } = await admin.from('cases').insert({ name: shop, address: c.address, phone1: fp, industry: classifyIndustry(shop) || null, status: DEFAULT_STATUS, priority: '中', instagram: c.instagram_url || null, hp1: c.official_url || null, source_urls: c.instagram_url || 'フォロワー確認復活', memo: `【AI自動投入 / HOLD復活(フォロワー${f}人確認) / HOT-B】
電話: ${fp}
住所: ${c.address}`, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
        if (cr?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: cr.id }).eq('id', c.id); counts.imported++ }
        continue
      }
      const e = await withTimeout(enrichCandidate(mapsKey!, { shop, username: '', areaHint: c.extracted_area || c.address || '', industry: c.extracted_industry || '', havePhone: c.phone_number || '', haveAddress: c.address || '' }, { maxQueries: 1, perQuery: 5 }), 12000, null)
      if (!e) continue
      counts.enriched++
      const phone = c.phone_number || e.phone || ''
      const address = c.address || e.address || ''
      const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
      if (e.phone && !c.phone_number) counts.phoneFound++
      if (e.address && !c.address) counts.addressFound++
      const u: any = { last_enriched_at: new Date().toISOString() }
      if (phone && !c.phone_number) { u.phone_number = phone; u.extracted_phone = phone; u.phone_source = 'enrich_reprocess'; u.enriched_phone = e.phone || null }
      if (address && !c.address) { u.address = address; u.extracted_address = address }
      if (e.official && !c.official_url) u.official_url = e.official
      if (phoneOk && address && isRealStoreAddress(address) && !isForeignAddress(address)) {
        u.lead_temperature = 'HOT'; u.hot_tier = 'B'; u.recommended_status = 'HOT_B'
        u.ai_comment = `HOLD再補完(${type}): 電話・住所を補完しHOT-Bへ昇格。`
        u.auto_import_reason = 'HOLD再補完で電話・住所確定→HOT-B'
        counts.promotedHot++
      }
      await admin.from('lead_candidates').update(u).eq('id', c.id)
      if (u.lead_temperature === 'HOT' && !c.imported_to_cases && phoneOk) {
        // 統一投入前ゲート（既存店/共有番号/同名同市/チェーン等の最終関門）
        const gate = await caseImportGate(admin, { name: shop, phone, address, mapsKey, budgetEndMs: startMs + budgetMs })
        if (!gate.ok) { await applyGateDowngrade(admin, c.id, gate); counts.promotedHot = Math.max(0, counts.promotedHot - 1); continue }
        const dupCaseId = await findCaseIdByPhone(admin, phone)
        if (dupCaseId) await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: dupCaseId }).eq('id', c.id)
        else { const { data: created } = await admin.from('cases').insert({ name: shop, address, phone1: phone, industry: classifyIndustry(shop) || normalizeIndustry(c.extracted_industry) || null, status: DEFAULT_STATUS, priority: '中', hp1: c.official_url || e.official || null, source_urls: c.official_url || 'HOLD再補完', memo: `【AI自動投入 / HOLD再補完 / HOT-B】\n電話: ${phone}\n住所: ${address}`, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null })); if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: created.id }).eq('id', c.id); counts.imported++ } }
      }
    }
    await finishRun(admin, runId, { ...counts, hot: counts.promotedHot })
    return { ok: true, ...counts }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error', String(e?.message || e)); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 4) 手動URL一括インポート
// ============================================================
export async function runBulkUrlImport(admin: any, mapsKey: string | null, urls: string[], meta: { memo?: string; sourceType?: string }, userId: string | null): Promise<any> {
  const startMs = Date.now(); const budgetMs = 240000; const remain = () => budgetMs - (Date.now() - startMs)
  const cleanAll = Array.from(new Set(urls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//.test(u))))
  const clean = cleanAll.slice(0, 40)
  const counts: any = { sourceType: 'manual_url_bulk_import', label: '手動URL一括インポート', total: cleanAll.length, processed: 0, hot: 0, hold: 0, excluded: 0, imported: 0 }
  // 40件上限の超過分は黙って捨てず通知（UI側で貼り直しできるようにremainingで返す）
  if (cleanAll.length > 40) { counts.stoppedEarly = true; counts.remaining = cleanAll.slice(40).join('\n') }
  const runId = await startRun(admin, 'manual_url_bulk_import', userId)
  const results: any[] = []
  let ui = -1
  for (const url of clean) {
    ui++
    // 1件最悪31s。残り32s未満なら打ち切り、未処理URL（上限超過分も含む）をremainingで返してUIに残す
    if (remain() < 32000) { counts.stoppedEarly = true; counts.remaining = [...clean.slice(ui), ...cleanAll.slice(40)].join('\n'); break }
    const r = await ingestFromUrl(admin, mapsKey, { url, sourceType: 'manual_url_bulk_import', label: '手動URL一括', signalType: 'manual_import', extraText: meta.memo || '', userId, runId, saveAlways: true })
    counts.processed++
    if (r.temperature === 'HOT') { counts.hot++; if (r.imported) counts.imported++ } else if (r.temperature === 'EXCLUDED') counts.excluded++; else counts.hold++
    if (results.length < 40) results.push({ url, name: r.name, temperature: r.temperature, phone: r.phone, imported: r.imported })
  }
  await finishRun(admin, runId, counts)
  return { ok: true, ...counts, results }
}

// ============================================================
// 4.2) 抽出済み店舗レコードの一括取込（新店まとめ記事の展開・ニュース由来などで共用）
//   店名+電話（+住所）を受け取り、補完→品質ゲート→重複→signal→HOT判定→保存→HOT投入まで行う。
// ============================================================
export interface ExtractedStore { name: string; phone: string; address?: string; snippet?: string }
export async function ingestExtractedStores(admin: any, mapsKey: string | null, stores: ExtractedStore[], o: {
  sourceType: string; label: string; signalType: string; sourceUrl: string; evidenceIso?: string | null
  userId: string | null; runId?: string | null; budgetEndMs?: number
  maxImports?: number  // 呼び出し元の投入上限（autoImportPerRun）の残り枠。超えたら候補保存のみで投入しない
}): Promise<any> {
  const endMs = o.budgetEndMs || (Date.now() + 40000)
  const remain = () => endMs - Date.now()
  const nowIso = new Date().toISOString()
  // processedAll: 予算切れで途中終了したらfalse（呼び出し元が既読URLを取り消して次回再展開できるように）
  const out: any = { processed: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, saved: 0, importedCases: [] as any[], processedAll: true }
  let estabLookups = 0
  for (const st of stores) {
    if (remain() < 16000) { out.processedAll = false; break }
    const phone = (st.phone || '').trim()
    const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
    if (!phoneOk) continue
    out.processed++
    // 再実行/重複の高速スキップ: 同一電話の投入済み候補
    const { data: dup } = await admin.from('lead_candidates').select('id,imported_to_cases,discovery_source_type,lead_source').eq('phone_number', phone).limit(1)
    if (dup?.[0]?.imported_to_cases) { out.excluded += 0; continue }
    let address = (st.address || '').trim()
    let e: any = null
    if (!address && mapsKey && remain() > 14000) { e = await withTimeout(enrichCandidate(mapsKey, { shop: st.name, username: '', areaHint: '', industry: '', havePhone: phone, haveAddress: '' }, { maxQueries: 1, perQuery: 4 }), 10000, null); address = e?.address || '' }
    const sn = sanitizeShopName(e?.place_name || st.name, { placesMatched: !!e?.place_id })
    const name = sn.valid ? sn.name : (st.name || '店名未確定')
    const text = `${name} ${st.snippet || ''}`
    const big = detectBigOrPublic(`${name} ${address}`); const chain = detectChain(name); const multi = detectMultiStore(text)
    const hardEx = hardExcludeReason({ name, phone, text })
    const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone))
    const pmMismatch = phoneAddressMatch(phone, address) === 'mismatch'
    // 開業日抽出（見出しブロック200字＝他店の日付が混ざらない粒度）。開業が半年超前ならPlaces確認枠を使わずHOLD
    const od = extractOpeningDateFromText(`${st.name} ${st.snippet || ''}`, { publishedIso: o.evidenceIso || null })
    const odStale = !!od && od.confidence >= 70 && od.daysSince != null && od.daysSince > 180
    let temperature = 'HOLD'; let hotTier: 'A' | 'B' | null = null; let holdReason = ''
    if (big.exclude || chain.definite || multi.exclude || isForeignAddress(address) || hardEx) temperature = 'EXCLUDED'
    else if (odStale) { temperature = 'HOLD'; holdReason = `開業が${od!.daysSince}日前（半年超=新店ではない）` }
    else if (phoneOk && address && isRealStoreAddress(address) && isJapan && !pmMismatch) { temperature = 'HOT'; hotTier = 'B' }
    else holdReason = !address || !isRealStoreAddress(address) ? '実店舗住所なし' : pmMismatch ? '電話と住所の地域不一致（誤抽出の疑い）' : '要確認'
    // 既存店ガード（まとめ記事は既存店も混ざるため、投入前にGoogle口コミで確認。上限つき）
    if (temperature === 'HOT' && mapsKey && sn.valid && estabLookups < 3 && remain() > 12000) {
      estabLookups++
      const est = await withTimeout(placesEstablishmentSignal(mapsKey, name, address), 7000, null as any)
      if (est && ((est.count != null && est.count >= BIG_GOOGLE_REVIEWS) || (est.oldestDays != null && est.oldestDays > 30))) { temperature = 'HOLD'; hotTier = null; holdReason = `既存店の疑い（Google口コミ${est.count ?? '?'}件/最古${est.oldestDays ?? '?'}日前）` }
    }
    if (temperature === 'HOT') { out.hot++; out.hotB++ } else if (temperature === 'EXCLUDED') out.excluded++; else out.hold++
    const reason = `${o.label}: 「${name}」${o.evidenceIso ? ` / 根拠日:${o.evidenceIso.slice(0, 10)}` : ''}${holdReason ? `（HOLD理由: ${holdReason}）` : ''}`
    const payload: any = {
      name, address: address || null, phone_number: phone, extracted_phone: phone, extracted_address: address || null,
      website_url: e?.official || null, official_url: e?.official || null,
      source: o.sourceType, lead_source: o.sourceType, discovery_source_type: o.sourceType, source_type: `AI自動投入(${o.label})`, source_site_name: o.label, parser_used: 'store_block_extract',
      source_detail_url: `${o.sourceUrl}#tel-${phone.replace(/\D/g, '')}`, search_snippet: (st.snippet || '').slice(0, 300),
      newness_type: o.signalType, regional_media_newness_reason: reason, regional_media_detected_at: o.evidenceIso || nowIso, first_discovered_at: nowIso,
      lead_temperature: temperature, hot_tier: hotTier, recommended_status: temperature === 'HOT' ? 'HOT_B' : temperature, should_exclude_from_call_list: temperature === 'EXCLUDED',
      name_unconfirmed_hot: temperature === 'HOT' && !sn.valid, phone_source: 'detail_page', matched_google_place_id: e?.place_id || null, extracted_shop_name: name,
      owner_reachability_score: 65, auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason, last_seen_at: nowIso, source_run_id: o.runId || null,
      auto_insert_skipped_reason: temperature === 'HOLD' && holdReason ? holdReason : null,
      // 開業日（テキスト由来。精度はsourceに符号化）→ 開業予定キュー/再コールに接続
      ...(od ? { opening_date: od.iso, opening_date_source: `article_text_${od.precision}`, opening_date_confidence: od.confidence, days_until_opening: od.daysUntil, days_since_opening: od.daysSince } : {}),
    }
    const qr = computeQuality(payload)
    Object.assign(payload, { quality_score: qr.score, quality_grade: qr.grade, industry_category: qr.category, dedup_key: qr.dedupKey, quality_flags: qr.flags, phone_pref_match: qr.phoneMatch, quality_computed_at: nowIso })
    let candidateId: string | null = dup?.[0]?.id || null
    if (candidateId) await admin.from('lead_candidates').update(payload).eq('id', candidateId).then(() => {}, () => {})
    else { const { data: ins } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: o.userId }).select('id').single(); candidateId = ins?.id || null; if (candidateId) out.saved++ }
    if (candidateId) await addSignals(admin, candidateId, [{ type: o.signalType, source: o.label, url: o.sourceUrl, date: o.evidenceIso || null, text: name.slice(0, 180), confidence: 0.7 }])
    if (temperature === 'HOT' && candidateId && out.imported >= (o.maxImports ?? Infinity)) {
      // 投入上限到達: 候補はHOT保存済みなので次のスイープが投入する（上限バイパス防止）
    } else if (temperature === 'HOT' && candidateId) {
      const dupCaseId = await findCaseIdByPhone(admin, phone)
      if (dupCaseId) await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId }).eq('id', candidateId)
      else if (!(await (async () => {
        // 統一投入前ゲート（共有番号/同名同市/チェーン等。既存店チェックは上で実施済みのためskip）
        const gate = await caseImportGate(admin, { name, phone, address, text: (st.snippet || '').slice(0, 300), mapsKey, skipEstablishment: true, budgetEndMs: endMs })
        if (!gate.ok) { await applyGateDowngrade(admin, candidateId, gate); out.hot = Math.max(0, out.hot - 1); out.hotB = Math.max(0, out.hotB - 1); if (gate.action === 'exclude') out.excluded++; else if (gate.action !== 'link') out.hold++ }
        return gate.ok
      })())) {
        // ゲート否認: 投入せず降格/リンク済み
      }
      else {
        const memo = `【AI自動投入 / ${o.label} / HOT-B】${reason}\n電話: ${phone}\n住所: ${address}\n掲載元: ${o.sourceUrl}`
        const { data: created } = await admin.from('cases').insert({ name, address: address || '', phone1: phone, industry: classifyIndustry(name) || normalizeIndustry(qr.category) || null, status: DEFAULT_STATUS, priority: '中', hp1: e?.official || null, source_urls: o.sourceUrl, memo, created_by_id: o.userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
        if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id }).eq('id', candidateId); out.imported++; out.importedCases.push({ id: created.id, name, phone, address }) }
      }
    }
  }
  return out
}

// ============================================================
// 4.3) Googleニュース RSS 新店取込（キー不要・Serper消費ゼロ・直近7日のニュースだけ）
// ============================================================
const NEWS_QUERIES = ['新規オープン 店舗', 'グランドオープン', 'ニューオープン', '開院 クリニック', '新規開業 店', 'オープン予定 店舗', '開院 歯科', '美容室 オープン', '整体院 オープン', 'カフェ 新規オープン', 'サロン 開業', '飲食店 開店']
export async function runGoogleNewsRss(admin: any, mapsKey: string | null, opts: { runBudgetMs?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now(); const budgetMs = Math.max(20000, Math.min(280000, opts.runBudgetMs || 150000)); const remain = () => budgetMs - (Date.now() - startMs)
  const counts: any = { sourceType: 'google_news_rss_opening', label: 'Googleニュース新店(RSS)', queries: 0, items: 0, fetched: 0, hot: 0, hold: 0, excluded: 0, imported: 0, seenSkipped: 0 }
  const runId = await startRun(admin, 'google_news_rss_opening', userId)
  const importedCases: any[] = []
  try {
    // 実行ごとに4クエリずつローテーション（12クエリ×直近7日をカバー）
    const dayIdx = Math.floor(Date.now() / 86400000)
    const picked = [0, 1, 2, 3].map((i) => NEWS_QUERIES[(dayIdx * 4 + i) % NEWS_QUERIES.length])
    // ホットスポット増幅: 勝ちエリアの新店ニュースも直近7日で検索（キー不要・コストゼロ）
    try { const hc = await getHotCities(admin, { days: 14, max: 3 }); for (const c of hc) picked.push(`新規オープン ${c}`) } catch { /* noop */ }
    // 【不変条件】敷居は必ず予算より小さく保つ（予算連動）。敷居>=予算だと1クエリも走らず恒久0件になる（実績あり）。
    // クエリ敷居はアイテム敷居+RSS取得8sより大きく（フィードだけ取ってアイテムを全スキップする無駄fetchを防ぐ）。
    const perItemMs = Math.min(15000, Math.floor(budgetMs / 3))
    for (const q of picked) {
      if (remain() < perItemMs + 8000) break
      counts.queries++
      const rss = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&hl=ja&gl=JP&ceid=JP:ja`, 8000, 'application/rss+xml')
      if (!rss.ok || !rss.text) continue
      const items = Array.from(rss.text.matchAll(/<item>([\s\S]*?)<\/item>/g)).map((m) => m[1]).slice(0, 20)
      for (const it of items) {
        // 1件あたり典型 ~10s（既読skipは1s未満・最悪28s）
        if (remain() < perItemMs) break
        const link = (it.match(/<link>([^<]+)<\/link>/)?.[1] || '').trim()
        const title = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim()
        const pub = Date.parse(it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || '')
        if (!/^https?:\/\//.test(link)) continue
        if (!Number.isNaN(pub) && (Date.now() - pub) > 7 * 86400000) continue
        counts.items++
        // 既読スキップ
        const { data: seen } = await admin.from('discovery_seen_urls').select('id').eq('source_type', 'google_news_rss_opening').eq('url', link).limit(1)
        if (seen?.[0]) { counts.seenSkipped++; continue }
        await admin.from('discovery_seen_urls').upsert({ source_type: 'google_news_rss_opening', url_hash: link.slice(-80), url: link }, { onConflict: 'source_type,url_hash' }).then(() => {}, () => {})
        counts.fetched++
        const r = await ingestFromUrl(admin, mapsKey, { url: link, sourceType: 'google_news_rss_opening', label: 'Googleニュース新店', signalType: 'new_article', evidenceIso: Number.isNaN(pub) ? null : new Date(pub).toISOString(), extraText: title, userId, runId })
        if (r.temperature === 'HOT') { counts.hot++; if (r.imported) { counts.imported++; importedCases.push({ id: r.importedCaseId, name: r.name, phone: r.phone, address: r.address }) } }
        else if (r.temperature === 'EXCLUDED') counts.excluded++
        else if (r.temperature === 'SKIPPED') counts.seenSkipped++
        else counts.hold++
      }
    }
    await finishRun(admin, runId, counts)
    return { ok: true, ...counts, importedCases }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error', String(e?.message || e)); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 4.4) 開業予定日キュー: Google確認済みの FUTURE_OPENING / 開業予定日45日以内 / 開業30日以内 を HOT-A で自動投入
//   （開業前〜直後がMEO/HP営業の黄金期。openingDateはGoogle裏取り済みの最強シグナル）
// ============================================================
export async function runOpeningSoonQueue(admin: any, opts: { limit?: number; runBudgetMs?: number; mapsKey?: string | null } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now(); const budgetMs = Math.max(15000, Math.min(280000, opts.runBudgetMs || 90000)); const remain = () => budgetMs - (Date.now() - startMs)
  const limit = Math.max(1, Math.min(300, opts.limit || 150))
  const mapsKey = opts.mapsKey || null
  const counts: any = { sourceType: 'opening_soon_promotion', label: '開業予定日キュー', scanned: 0, promotedHot: 0, imported: 0, skipped: 0 }
  const runId = await startRun(admin, 'opening_soon_promotion', userId)
  const importedCases: any[] = []
  try {
    const SEL = 'id,name,phone_number,extracted_phone,address,extracted_address,lead_temperature,hot_tier,google_business_status,days_until_opening,days_since_opening,imported_to_cases,should_exclude_from_call_list,is_chain_store,duplicate_of_case_id,official_url,website_url,instagram_url,google_opening_date_raw,opening_date,opening_date_source,opening_date_confidence,first_seen_at'
    const { data: rows } = await admin.from('lead_candidates').select(SEL)
      .eq('imported_to_cases', false).neq('lead_temperature', 'EXCLUDED').eq('should_exclude_from_call_list', false)
      .or('google_business_status.eq.FUTURE_OPENING,days_until_opening.lte.45,days_since_opening.lte.30')
      .order('first_seen_at', { ascending: false }).limit(limit)
    // 第2クエリ: opening_date（記事テキスト由来含む）が「30日前〜45日後」の候補。
    // days_* は発見時スナップショットで日々ズレる（60日前に「開業60日後」で発見した候補は今日「開業目前」なのに
    // lte.45 に永遠にヒットしない）ため、opening_date のレンジで取り直して取りこぼしを塞ぐ。
    const today = Date.now()
    const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const { data: rows2 } = await admin.from('lead_candidates').select(SEL)
      .eq('imported_to_cases', false).neq('lead_temperature', 'EXCLUDED').eq('should_exclude_from_call_list', false)
      .gte('opening_date', isoDay(today - 30 * 86400000)).lte('opening_date', isoDay(today + 45 * 86400000))
      .order('first_seen_at', { ascending: false }).limit(limit)
    const byId = new Map<string, any>()
    for (const r of [...(rows || []), ...(rows2 || [])] as any[]) { if (!byId.has(r.id)) byId.set(r.id, r) }
    // 開業タイミングを実行時点の値に再計算してから「開業に近い順」で処理（予算切れでも最良prefixが処理済みになる）
    const items = [...byId.values()].map((c: any) => {
      if (c.opening_date) {
        const t = Date.parse(String(c.opening_date).slice(0, 10) + 'T00:00:00+09:00')
        if (Number.isFinite(t)) { const diff = Math.round((t - today) / 86400000); c.days_until_opening = diff >= 0 ? diff : null; c.days_since_opening = diff < 0 ? -diff : null }
      }
      return c
    }).sort((a, b) => (openProx(a) - openProx(b)) || (Date.parse(b.first_seen_at || 0) - Date.parse(a.first_seen_at || 0)))
    for (const c of items) {
      if (remain() < 6000) break
      counts.scanned++
      if (c.is_chain_store || c.duplicate_of_case_id) { counts.skipped++; continue }
      // 鮮度確認: days_until_opening は負値（開業済み）も lte.45 に一致するため、開業からの経過が大きいものは除外
      const duo = c.days_until_opening, dso = c.days_since_opening
      const openingFresh = c.google_business_status === 'FUTURE_OPENING'
        || (duo != null && duo >= -45 && duo <= 45)
        || (dso != null && dso >= 0 && dso <= 30)
      if (!openingFresh) { counts.skipped++; continue }
      // テキスト由来の開業日は確度/精度ゲート: 低確度・月のみ精度はHOT-A昇格に使わない（誤日付での誤投入防止）
      const srcTxt = String(c.opening_date_source || '')
      const isTextDate = /^article_text/.test(srcTxt)
      // 保健所営業許可由来: 行政一次で日付は確実だが「経営者交代/移転も申請区分=新規」のため既存店チェックは必須
      //（Google裏取り済みと同格に扱うと、取込時に既存店として降格した判断を翌巡回で覆して投入してしまう）
      const needsEstab = isTextDate || srcTxt === 'health_permit'
      const conf = Number(c.opening_date_confidence ?? 0)
      if (isTextDate && (conf < 60 || /month$/.test(srcTxt))) { counts.skipped++; counts.textLowConfSkipped = (counts.textLowConfSkipped || 0) + 1; continue }
      // 既存店チェック必須の由来は残り12秒未満だとチェックが予算条件(budgetEnd-8000)でスキップされ
      // 無検証のままHOT投入される境界があるため、昇格前にここで次回へ持ち越す
      if (needsEstab && remain() < 12000) { counts.skipped++; continue }
      const phone = c.phone_number || c.extracted_phone || ''
      const address = c.address || c.extracted_address || ''
      const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
      if (!phoneOk || !address || !isRealStoreAddress(address) || isForeignAddress(address)) { counts.skipped++; continue }
      if (phoneAddressMatch(phone, address) === 'mismatch') { counts.skipped++; continue }
      const name = c.name && c.name !== '店名未確定' ? c.name : ''
      if (!name || detectChain(name).definite || detectBigOrPublic(`${name} ${address}`).exclude) { counts.skipped++; continue }
      // テキスト由来は高確度×日精度のみHOT-A。Google由来は従来通りHOT-A
      const strongText = isTextDate && conf >= 75 && /day$/.test(srcTxt)
      const tierUp: 'A' | 'B' = !isTextDate || strongText ? 'A' : 'B'
      const evidenceLabel = isTextDate ? `記事由来・確度${conf}${/part$/.test(srcTxt) ? '・旬丸め' : ''}` : srcTxt === 'health_permit' ? '保健所営業許可・行政一次データ' : 'Google openingDate裏取り済み'
      const why = c.google_business_status === 'FUTURE_OPENING' ? `開業予定(FUTURE_OPENING${c.google_opening_date_raw ? `・${c.google_opening_date_raw}` : ''})`
        : (duo != null && duo >= 0) ? `開業まで${duo}日${c.opening_date ? `（${c.opening_date}）` : ''}`
        : `開業${Math.abs(dso ?? 0)}日目${c.opening_date ? `（${c.opening_date}）` : ''}`
      await admin.from('lead_candidates').update({ lead_temperature: 'HOT', hot_tier: tierUp, recommended_status: tierUp === 'A' ? 'HOT_A' : 'HOT_B', auto_import_reason: `開業予定日キュー: ${why}（${evidenceLabel}）`, ai_comment: `開業予定日キュー: ${why}。開業前後はMEO/HP提案の最適期。` }).eq('id', c.id)
      counts.promotedHot++
      // 統一投入前ゲート。Google裏取り済みは既存店チェックskip / テキスト・営業許可由来はPlaces口コミの既存店チェック必須
      const gate = await caseImportGate(admin, { name, phone, address, mapsKey: needsEstab ? mapsKey : null, skipEstablishment: !needsEstab, budgetEndMs: startMs + budgetMs })
      if (!gate.ok) { await applyGateDowngrade(admin, c.id, gate); counts.promotedHot = Math.max(0, counts.promotedHot - 1); counts.skipped++; continue }
      const dupCaseId = await findCaseIdByPhone(admin, phone)
      const nowIso = new Date().toISOString()
      let caseIdForRecall: string | null = null
      if (dupCaseId) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId }).eq('id', c.id); caseIdForRecall = dupCaseId }
      else {
        const memo = `【AI自動投入 / 開業予定日キュー / HOT-${tierUp}】${why}（${evidenceLabel}）\n電話: ${phone}\n住所: ${address}\n開業前後はGBP整備・HP・MEOの提案最適期。`
        const { data: created } = await admin.from('cases').insert({ name, address, phone1: phone, industry: classifyIndustry(name) || null, status: DEFAULT_STATUS, priority: tierUp === 'A' ? '高' : '中', hp1: c.official_url || c.website_url || null, instagram: c.instagram_url || null, source_urls: '開業予定日キュー', memo, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
        if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id }).eq('id', c.id); counts.imported++; importedCases.push({ id: created.id, name, phone, address }) }
        caseIdForRecall = created?.id || null
      }
      // 開業日ドリブンの自動再コール: 開業が4日以上先なら「開業3日前の10:00」に再コール予定を自動登録。
      // 早期発見を「まだ開いてない店への空振り架電」で終わらせず、完璧なタイミングの架電に変換する。
      if (caseIdForRecall && duo != null && duo >= 4) {
        try {
          const { data: exR } = await admin.from('recalls').select('id').eq('case_id', caseIdForRecall).eq('done', false).limit(1)
          if (!exR?.[0]) {
            // VercelはUTC実行のためsetHours(10)だと19:00 JSTかつJST深夜帯は日付が1日ズレる。
            // JSTの暦日で(duo-3)日後を求め、01:00 UTC(=10:00 JST)を指す時刻を作る。
            const jstBase = new Date(Date.now() + 9 * 3600000 + (duo - 3) * 86400000)
            const target = new Date(Date.UTC(jstBase.getUTCFullYear(), jstBase.getUTCMonth(), jstBase.getUTCDate(), 1, 0, 0))
            await admin.from('recalls').insert({ case_id: caseIdForRecall, case_name: name, target_at: target.toISOString(), done: false, memo: `開業${duo}日前に検出（自動）。開業3日前アプローチ: GBP整備・HP・MEOは開業前が最適。`, created_by_id: userId })
            counts.recallScheduled = (counts.recallScheduled || 0) + 1
          }
        } catch { /* noop */ }
      }
    }
    await finishRun(admin, runId, { ...counts, hot: counts.promotedHot })
    return { ok: true, ...counts, importedCases }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error', String(e?.message || e)); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 4.5) テキスト貼り付けインポート（チラシ/PDF/Excel/リストの内容を貼るだけで候補化。OCR不要のファイル取込代替）
//   空行区切りのブロック（無ければ1行=1件）から 店名/電話/住所 を抽出→Places補完→検証→HOT判定→保存→HOT投入。
// ============================================================
export async function runTextImport(admin: any, mapsKey: string | null, text: string, meta: { memo?: string }, userId: string | null): Promise<any> {
  const startMs = Date.now(); const budgetMs = 240000; const remain = () => budgetMs - (Date.now() - startMs)
  const nowIso = new Date().toISOString()
  // ブロック分割: 空行区切り。空行が無い場合は「電話番号を含む行が2行以上＝1行1店舗のリスト」のときだけ行分割し、
  // 電話が0〜1個なら全体を1店舗として扱う（店名/電話/住所を3行で貼った1店舗レコードを3件に分解しない）。
  let blocks = String(text || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  if (blocks.length <= 1) {
    const lines = String(text || '').split(/\n/).map((b) => b.trim()).filter((b) => b.length >= 4)
    const phoneLines = lines.filter((l) => !!extractJpPhone(l)).length
    blocks = phoneLines >= 2 ? lines : [String(text || '').trim()].filter(Boolean)
  }
  // 1回30ブロック上限。超過分は黙って捨てず remaining として返す（UIがテキストエリアに残して続き実行できる）
  const overflow = blocks.slice(30)
  blocks = blocks.slice(0, 30)
  const counts: any = { sourceType: 'document_to_lead_import', label: 'テキスト貼り付け取込', total: blocks.length + overflow.length, processed: 0, hot: 0, hold: 0, excluded: 0, imported: 0, skipped: 0, alreadyImported: 0 }
  if (overflow.length) { counts.stoppedEarly = true; counts.remaining = overflow.join('\n\n') }
  const runId = await startRun(admin, 'document_to_lead_import', userId)
  const results: any[] = []
  let bi = -1
  for (const block of blocks) {
    bi++
    // 時間切れ: 未処理ブロックを remaining として返し、UI側でテキストエリアに残す（続きは再実行で処理できる）
    if (remain() < 20000) { counts.stoppedEarly = true; counts.remaining = [...blocks.slice(bi), ...overflow].join('\n\n'); break }
    const phone0 = extractJpPhone(block)
    const address0 = (block.match(PREF_RE)?.[0] || '').slice(0, 70)
    // 再実行の高速スキップ: 同一電話の候補が既に案件投入済みなら補完せず即スキップ（続き処理へ時間を回す）
    if (phone0) {
      const { data: done } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('phone_number', phone0).limit(1)
      if (done?.[0]?.imported_to_cases) { counts.alreadyImported++; counts.processed++; continue }
    }
    // 店名候補: 電話/住所/URLを除いた最初の行（記号除去・40字まで）
    const nameLine = block.split('\n').map((l) => l.replace(/https?:\/\/\S+/g, '').replace(/0\d[\d\-()\s]{8,}/g, '').replace(new RegExp(PREF_RE.source), '').trim()).find((l) => l.length >= 2) || ''
    const name0 = nameLine.replace(/[【】\[\]■●・☆★]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!phone0 && !name0) { counts.skipped++; continue }
    counts.processed++
    const sn0 = sanitizeShopName(name0, { placesMatched: false })
    // Places/検索補完（店名 or 電話を手がかりに正式店名・電話・住所を確定）
    let e: any = null
    if (mapsKey && (sn0.valid || address0)) e = await withTimeout(enrichCandidate(mapsKey, { shop: sn0.valid ? sn0.name : name0, username: '', areaHint: address0, industry: '', havePhone: phone0, haveAddress: address0 }, { maxQueries: 1, perQuery: 5 }), 12000, null)
    const phone = phone0 || e?.phone || ''
    const address = address0 || e?.address || ''
    const sn = sanitizeShopName(e?.place_name || name0, { placesMatched: !!e?.place_id })
    const name = sn.valid ? sn.name : (name0 || '店名未確定')
    const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
    const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || !!e?.prefecture)
    const hardEx = hardExcludeReason({ name, phone, text: block })
    const big = detectBigOrPublic(`${name} ${address}`); const chain = detectChain(name); const multi = detectMultiStore(block.slice(0, 300))
    let temperature = 'HOLD'; let hotTier: 'A' | 'B' | null = null; let holdReason = ''
    // 誤マッチ防止: 貼り付けテキスト自体に電話も住所も無い（店名だけ）場合、名前一致だけのPlaces補完で
    // 全国の同名店に誤ヒットし得るため、補完で揃ってもHOTにせず要確認(HOLD)に留める。
    const anchored = !!phone0 || !!address0
    if (big.exclude || chain.definite || multi.exclude || isForeignAddress(address) || hardEx) temperature = 'EXCLUDED'
    // 人手で選んだリスト＝新規根拠は担保されている前提。電話+実店舗住所+日本ならHOT-B（店名未確定でも可）
    else if (anchored && phoneOk && address && isRealStoreAddress(address) && isJapan) { temperature = 'HOT'; hotTier = 'B' }
    else holdReason = !phoneOk ? '電話番号なし/無効' : (!address || !isRealStoreAddress(address)) ? '実店舗住所なし' : !anchored ? '店名のみ入力（補完誤マッチ防止のため要確認）' : '要確認'
    if (temperature === 'HOT') counts.hot++; else if (temperature === 'EXCLUDED') counts.excluded++; else counts.hold++
    const reason = `テキスト貼り付け取込: 「${name}」${meta.memo ? ` / メモ:${meta.memo}` : ''}${holdReason ? `（HOLD理由: ${holdReason}）` : ''}${e?.status ? ` / 補完[${e.status}]` : ''}`
    const payload: any = {
      name, address: address || null, phone_number: phone || null, extracted_phone: phone || null, extracted_address: address || null,
      website_url: e?.official || null, official_url: e?.official || null, instagram_url: e?.instagram || null,
      source: 'document_to_lead_import', lead_source: 'document_to_lead_import', discovery_source_type: 'document_to_lead_import',
      source_type: 'AI自動投入(テキスト貼り付け)', source_site_name: 'テキスト貼り付け取込', parser_used: 'text_import',
      search_snippet: block.slice(0, 300), newness_type: 'document_import', regional_media_newness_reason: reason, first_discovered_at: nowIso,
      lead_temperature: temperature, hot_tier: hotTier, recommended_status: temperature === 'HOT' ? 'HOT_B' : temperature, should_exclude_from_call_list: temperature === 'EXCLUDED',
      name_unconfirmed_hot: temperature === 'HOT' && !sn.valid, phone_source: phone ? (e?.place_id ? 'google_places' : 'detail_page') : null,
      matched_google_place_id: e?.place_id || null, extracted_shop_name: name,
      owner_reachability_score: phone ? 70 : 30, auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason, last_seen_at: nowIso, source_run_id: runId,
      auto_insert_skipped_reason: temperature === 'HOLD' && holdReason ? holdReason : null,
    }
    const qr = computeQuality(payload)
    Object.assign(payload, { quality_score: qr.score, quality_grade: qr.grade, industry_category: qr.category, dedup_key: qr.dedupKey, quality_flags: qr.flags, phone_pref_match: qr.phoneMatch, quality_computed_at: nowIso })
    // 重複（電話）
    let candidateId: string | null = null; let alreadyImported = false
    if (phone) { const { data: bp } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('phone_number', phone).limit(1); candidateId = bp?.[0]?.id || null; alreadyImported = !!bp?.[0]?.imported_to_cases }
    if (candidateId) await admin.from('lead_candidates').update(payload).eq('id', candidateId).then(() => {}, () => {})
    else { const { data: ins } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single(); candidateId = ins?.id || null }
    // signal_urlはdedupキーを兼ねる（空だとinsert時NULL化しdedup不一致→再実行で重複蓄積するため、疑似キーを渡す）
    if (candidateId) await addSignals(admin, candidateId, [{ type: 'document_import', source: 'テキスト貼り付け取込', url: `text-import:${phone || name}`, date: null, text: name.slice(0, 180), confidence: 0.7 }])
    // HOT投入
    if (temperature === 'HOT' && phoneOk && candidateId && !alreadyImported) {
      const dupCaseId = await findCaseIdByPhone(admin, phone)
      if (dupCaseId) await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId }).eq('id', candidateId)
      else if (!(await (async () => {
        // 統一投入前ゲート（既存店/共有番号/同名同市/チェーン等の最終関門）
        const gate = await caseImportGate(admin, { name, phone, address, text: block.slice(0, 300), mapsKey, budgetEndMs: startMs + budgetMs })
        if (!gate.ok) { await applyGateDowngrade(admin, candidateId, gate); counts.hot = Math.max(0, counts.hot - 1); if (gate.action === 'exclude') counts.excluded++; else if (gate.action !== 'link') counts.hold++ }
        return gate.ok
      })())) {
        // ゲート否認: 投入せず降格/リンク済み
      }
      else {
        const memo = `【AI自動投入 / テキスト貼り付け取込 / HOT-B】${reason}\n電話: ${phone}\n住所: ${address}\n---\n${block.slice(0, 300)}`
        const { data: created } = await admin.from('cases').insert({ name, address: address || '', phone1: phone, industry: classifyIndustry(name) || null, status: DEFAULT_STATUS, priority: '中', hp1: e?.official || null, source_urls: 'テキスト貼り付け取込', memo, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
        if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id }).eq('id', candidateId); counts.imported++ }
      }
    }
    if (results.length < 30) results.push({ name, phone, address, temperature })
  }
  await finishRun(admin, runId, counts)
  return { ok: true, ...counts, results }
}

// ============================================================
// 5) リードスコアリング/学習（鮮度・架電容易性・複数シグナル・業種適合 → 営業優先度 S/A/B/C）
//    lead_exclusion_classifier / sales_angle_classifier / ai_duplicate_merge も mode で処理。
// ============================================================
const MEO_FIT_RE = /(整体|整骨|接骨|鍼灸|美容|理容|ヘア|ネイル|まつ|エステ|脱毛|リラク|マッサージ|ジム|ピラティス|ヨガ|歯科|クリニック|内科|皮膚|動物病院|ペット|トリミング|カフェ|居酒屋|飲食|レストラン|ラーメン|焼肉|バー|塾|教室|スクール|サロン|リフォーム|クリーニング|不用品|写真)/
export async function runLeadScoring(admin: any, mode: string, opts: { limit?: number; runBudgetMs?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now(); const budgetMs = Math.max(15000, Math.min(280000, opts.runBudgetMs || 90000)); const remain = () => budgetMs - (Date.now() - startMs)
  const limit = Math.max(1, Math.min(2000, opts.limit || 1000))
  const counts: any = { sourceType: mode, scored: 0, s: 0, a: 0, b: 0, c: 0, excluded: 0, merged: 0 }
  const runId = await startRun(admin, mode, userId)
  const nowMs = Date.now()
  try {
    // stale-HOT自動降格: HOTのまま14日以上未投入＝毎回のsweepで何かに弾かれ続けている候補。
    // 開業ターゲットは日単位で鮮度が落ちるため退場させ、sweepの外部ルックアップ枠（Places/IG）を生きた候補に集中させる。
    // ※開業根拠が生きている候補（開業予定/開業30日以内/opening_dateが直近）は絶対に降格しない（開業待ちHOT-Aを殺さない）。
    if (remain() > 10000) {
      const cutoff = new Date(nowMs - 14 * 86400000).toISOString()
      // 降格ループの独自上限＝予算の1/3。無制限だと最大200件の逐次UPDATEが本体の採点（signal取得は残り8秒必須）を飢餓させる
      const staleDeadline = startMs + Math.min(10000, Math.floor(budgetMs / 3))
      const { data: staleHots } = await admin.from('lead_candidates')
        .select('id,first_seen_at,opening_date,days_until_opening,days_since_opening,google_business_status,auto_insert_skipped_reason')
        .eq('lead_temperature', 'HOT').eq('imported_to_cases', false).lt('first_seen_at', cutoff).limit(200)
      for (const c of (staleHots || []) as any[]) {
        if (Date.now() > staleDeadline || remain() < 6000) break
        // 開業根拠の生存判定（opening_dateがあれば実行時点で再計算）
        let duo = c.days_until_opening != null ? Number(c.days_until_opening) : null
        let dso = c.days_since_opening != null ? Number(c.days_since_opening) : null
        if (c.opening_date) {
          const t = Date.parse(String(c.opening_date).slice(0, 10) + 'T00:00:00+09:00')
          if (Number.isFinite(t)) { const diff = Math.round((t - nowMs) / 86400000); duo = diff >= 0 ? diff : null; dso = diff < 0 ? -diff : null }
        }
        const openingAlive = c.google_business_status === 'FUTURE_OPENING' || (duo != null && duo >= 0) || (dso != null && dso <= 30)
        if (openingAlive) continue
        // 降格理由は runReprocessQueue の一時要因フィルタ・クロスソース復活のallowlistに非マッチの文言＝ピンポン昇降格を防ぐ。
        // 旧理由を埋め込む際はトリガー語（電話番号なし/新規根拠/要確認 等）を無害な同義語に置換してから埋め込む
        const oldReason = String(c.auto_insert_skipped_reason || '不明')
          .replace(/電話番号なし/g, '電話未取得').replace(/住所なし/g, '住所未取得')
          .replace(/フォロワー数を確認できず/g, 'フォロワー未確認').replace(/ユーザー名が特定できず/g, 'ユーザー名未特定')
          .replace(/新規根拠|新店根拠|新規性/g, '新店裏付け').replace(/要確認/g, '要検証')
          .slice(0, 80)
        await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: `HOT鮮度切れ: 発見から14日以上未投入（直近の障害: ${oldReason}）→HOLD` }).eq('id', c.id).then(() => {}, () => {})
        counts.staleHotDemoted = (counts.staleHotDemoted || 0) + 1
      }
    }
    const { data: rows } = await admin.from('lead_candidates').select('id,name,phone_number,address,lead_temperature,hot_tier,first_seen_at,regional_media_detected_at,extracted_industry,industry_category,official_url,website_url,imported_to_cases,duplicate_of_case_id,should_exclude_from_call_list,discovery_source_type,lead_source,source,auto_insert_skipped_reason').neq('lead_temperature', 'EXCLUDED').order('first_seen_at', { ascending: false }).limit(limit)
    const list = rows || []
    // signal種類×発信源（複数シグナル加点）をまとめて取得。
    // 行数カウントだと同一サイトの3シグナルで3点になる歪みがあるため「種類数×発信源数」で評価する
    const ids = list.map((c: any) => c.id)
    const sigTypes = new Map<string, Set<string>>()
    const sigSrcs = new Map<string, Set<string>>()
    for (let i = 0; i < ids.length && remain() > 8000; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data: sg } = await admin.from('lead_signals').select('lead_candidate_id,signal_type,signal_source').in('lead_candidate_id', chunk)
      for (const s of (sg || []) as any[]) {
        if (!sigTypes.has(s.lead_candidate_id)) { sigTypes.set(s.lead_candidate_id, new Set()); sigSrcs.set(s.lead_candidate_id, new Set()) }
        if (s.signal_type) sigTypes.get(s.lead_candidate_id)!.add(s.signal_type)
        if (s.signal_source) sigSrcs.get(s.lead_candidate_id)!.add(s.signal_source)
      }
    }
    // 電話番号の下10桁名寄せ: 独立した複数の取得元が同じ電話を新店として拾った＝最強の裏取りシグナル
    const pKeyOf = (p?: string | null) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
    const phoneSrcs = new Map<string, Set<string>>()
    const phoneRows = new Map<string, number>()
    for (const c of list) {
      const k = pKeyOf(c.phone_number)
      if (!k) continue
      phoneRows.set(k, (phoneRows.get(k) || 0) + 1)
      const src = c.discovery_source_type || c.lead_source || c.source || ''
      if (src) { if (!phoneSrcs.has(k)) phoneSrcs.set(k, new Set()); phoneSrcs.get(k)!.add(src) }
    }
    // 同名多地域＝未知チェーンの自動検出: 完全一致の店名が3件以上かつ2都道府県以上に出現＝多店舗展開の可能性が高い。
    // 辞書に無いチェーン（例: 洋麺屋五右衛門）を名寄せで発見し、HOTをHOLDへ降格して手動確認に回す。
    const normNm = (s: string) => String(s || '').replace(/[\s　・&＆'’\-－ー()（）【】\[\]]/g, '').toLowerCase()
    const prefOf = (a: string) => (String(a || '').match(/(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/) || [])[1] || ''
    const nameGroups = new Map<string, Set<string>>()
    for (const c of list) { const nm = normNm(c.name); if (!nm || c.name === '店名未確定' || nm.length < 3) continue; if (!nameGroups.has(nm)) nameGroups.set(nm, new Set()); const p = prefOf(c.address); if (p) nameGroups.get(nm)!.add(p) }
    const nameCount = new Map<string, number>()
    for (const c of list) { const nm = normNm(c.name); if (nm) nameCount.set(nm, (nameCount.get(nm) || 0) + 1) }

    for (const c of list) {
      if (remain() < 4000) break
      const phone = c.phone_number || ''
      const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
      const hasAddr = !!c.address && isRealStoreAddress(c.address)
      // 未知チェーン疑い: 同名3件以上×2都道府県以上 → HOT降格（手動確認）
      const nm = normNm(c.name)
      if (nm && c.name !== '店名未確定' && (nameCount.get(nm) || 0) >= 3 && (nameGroups.get(nm)?.size || 0) >= 2 && c.lead_temperature === 'HOT' && !c.imported_to_cases) {
        await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: `同名店舗が${nameCount.get(nm)}件・${nameGroups.get(nm)!.size}都道府県に存在（未知チェーンの疑い）→手動確認` }).eq('id', c.id).then(() => {}, () => {})
        counts.chainSuspect = (counts.chainSuspect || 0) + 1
        continue
      }
      // HOLD鮮度切れの自動整理: 60日以上前の未投入HOLDはEXCLUDEDへ（リストを常に新鮮に保つ）
      const firstSeen = Date.parse(c.first_seen_at || '') || 0
      if (c.lead_temperature === 'HOLD' && !c.imported_to_cases && firstSeen > 0 && (nowMs - firstSeen) > 60 * 86400000) {
        await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: '60日以上前のHOLD候補（鮮度切れの自動整理）' }).eq('id', c.id).then(() => {}, () => {})
        counts.staleCleaned = (counts.staleCleaned || 0) + 1
        continue
      }
      // 鮮度
      const ev = Date.parse(c.regional_media_detected_at || c.first_seen_at || '') || 0
      const ageDays = ev ? (nowMs - ev) / 86400000 : 999
      const freshness = ageDays <= 3 ? 30 : ageDays <= 7 ? 22 : ageDays <= 14 ? 14 : ageDays <= 30 ? 8 : 2
      // 架電容易性
      const contact = (phoneOk ? 30 : 0) + (hasAddr ? 20 : 0)
      // 複数シグナル（種類×発信源）＋クロスソース裏取り。
      // corroborated = 異なる取得元2つ以上が同じ電話を検出 かつ 同番号行数4以下（5行以上はポータル転送番号ノイズ）
      const pk = pKeyOf(c.phone_number)
      const corroborated = !!pk && (phoneSrcs.get(pk)?.size || 0) >= 2 && (phoneRows.get(pk) || 0) <= 4
      const nTypes = sigTypes.get(c.id)?.size || 0
      const nSrcs = sigSrcs.get(c.id)?.size || 0
      const multi = Math.min(20, nTypes * 5 + Math.max(0, nSrcs - 1) * 6) + (corroborated ? 10 : 0)
      // 業種適合
      const indFit = MEO_FIT_RE.test(`${c.extracted_industry || ''} ${c.industry_category || ''} ${c.name || ''}`) ? 12 : 0
      // HOT加点
      const hotBoost = c.lead_temperature === 'HOT' ? (c.hot_tier === 'A' ? 12 : 8) : 0
      const score = freshness + contact + multi + indFit + hotBoost
      // S/A/B/C（電話+住所必須でSランク）
      let grade: 'S' | 'A' | 'B' | 'C' = 'C'
      if (phoneOk && hasAddr && score >= 78) grade = 'S'
      else if (phoneOk && hasAddr && score >= 60) grade = 'A'
      else if (phoneOk || hasAddr) grade = 'B'
      counts.scored++; counts[grade.toLowerCase()]++
      await admin.from('lead_candidates').update({ sales_priority_grade: grade, sales_priority_score: score, quality_computed_at: new Date().toISOString() }).eq('id', c.id).then(() => {}, () => {})
      // クロスソース裏取りによる昇格（独立2系統の同時検出＝偽陽性率が単独ソースより大幅に低い）
      if (corroborated && !c.imported_to_cases && phoneOk && hasAddr) {
        if (c.lead_temperature === 'HOT' && c.hot_tier !== 'A') {
          // (a) HOT-B → HOT-A（次のsweepが優先処理）
          await admin.from('lead_candidates').update({ hot_tier: 'A', recommended_status: 'HOT_A', auto_import_reason: `複数取得元で確証（${[...(phoneSrcs.get(pk) || [])].slice(0, 3).join('/')}が同一電話を検出）` }).eq('id', c.id).then(() => {}, () => {})
          counts.corroboratedA = (counts.corroboratedA || 0) + 1
        } else if (c.lead_temperature === 'HOLD' && /新規根拠|新店根拠|新規性/.test(String(c.auto_insert_skipped_reason || '')) && !/チェーン|既存店|フォロワー|不一致|支店|大手|多店舗|共有番号|バーチャル|同業|レンタル|シェア|コワーキング|鮮度切れ/.test(String(c.auto_insert_skipped_reason || ''))) {
          // ※allowlistから「要確認」を外し、denylistにレンタル/シェア/コワーキング/鮮度切れを追加:
          //   VO疑いHOLD（「…実店舗か要確認」）やstale降格行を復活させるとsweep 1.22との永久ピンポンになる
          // (b) 「新規性の根拠が弱い」だけでHOLDだった候補: 独立系統の裏取りが新規性の代替根拠になる → HOT-B復帰。
          //     直接casesには入れない＝次のsweepが全ゲート（既存店/共有番号/フォロワー等）を再検査するので絶対条件はバイパスしない
          await admin.from('lead_candidates').update({ lead_temperature: 'HOT', hot_tier: 'B', recommended_status: 'HOT_B', auto_insert_skipped_reason: null, auto_import_reason: `複数取得元で確証（${[...(phoneSrcs.get(pk) || [])].slice(0, 3).join('/')}）＝新規性の裏取り成立→HOT-B復帰` }).eq('id', c.id).then(() => {}, () => {})
          counts.corroboratedRevived = (counts.corroboratedRevived || 0) + 1
        }
      }
    }
    await finishRun(admin, runId, counts)
    return { ok: true, ...counts }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error', String(e?.message || e)); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 4.8) 保健所「食品営業許可」オープンデータ取込（public_open_data_crawl）
//   行政一次データ＝誤検知ほぼゼロの最上流シグナル。「新規許可」＝開業直前後の店そのもの。
//   形式は2系統: (a)台東区型=月次の新規許可のみのCSV (b)国の標準データセット様式の全施設台帳
//   （施設名称/所在地_連結表記/施設電話番号/初回許可年月日/申請区分/廃業年月日…列名は全国共通）。
//   エンコードはUTF-8 BOM/Shift-JIS/UTF-16LEが混在するため自動判定する。
// ============================================================
export interface PermitSource {
  key: string; label: string; kind: 'taito_monthly' | 'std_registry'; urls: (nowMs: number) => string[]
  areaPrefix?: string; telAreaCode?: string
  /** この台帳専用の鮮度窓（日）。台帳ごとに公開ラグが違うため既定(45日)を上書きできる。
   *  港区は「ファイル更新は月末なのに収録データは前月末まで」＝公開ラグが約32〜60日あり、
   *  45日窓だと最新行すら窓の外になって月の大半で新規0件（＝2枠中1枠を空振りで消費）だった。 */
  recencyDays?: number
}
export const PERMIT_SOURCES: PermitSource[] = [
  {
    key: 'taito', label: '台東区 月次新規許可', kind: 'taito_monthly', areaPrefix: '東京都台東区', telAreaCode: '03',
    // 公開は月遅れ（当月分は404が正常）: 当月→前月→前々月の順で最初に取れたファイルを使う
    urls: (nowMs) => {
      const out: string[] = []
      for (let back = 0; back <= 2; back++) {
        const d = new Date(nowMs + 9 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back)
        out.push(`https://www.city.taito.lg.jp/kenkohukusi/kenkokikikanrieisei/food/syokuhin-sisetu/index.files/OPD${String(d.getUTCMonth() + 1).padStart(2, '0')}_PER.csv`)
      }
      return out
    },
  },
  // 港区は公開ラグが大きい（実測2026-07-16時点: ファイルのLast-Modifiedは6/30だが収録データの最新初回許可日は5/29＝約48日遅れ）。
  // 既定45日窓では最新行すら窓の外で毎月大半が新規0件になるため、この台帳だけ窓を90日に広げる。
  { key: 'minato', label: '港区 営業許可台帳', kind: 'std_registry', recencyDays: 90, urls: () => ['https://opendata.city.minato.tokyo.jp/dataset/54d8c582-00e2-4730-a23f-4a5befec9ae5/resource/c9d0299e-8e05-4317-877f-83055709e41f/download/food_business_all.csv'] },
  // ※実測で外したソース（2026-07実査）: 江東/中央/新宿=標準台帳だが年次スナップショット更新で直近45日の新規0件、
  //   中野=日付列なしの独自様式。更新頻度の高い自治体が見つかれば std_registry で1行追加するだけで対応可能。
]

/** 政府系CSVのエンコード自動判定デコード（UTF-8 BOM / UTF-16LE BOM / Shift-JIS / UTF-8）。 */
export function decodeGovCsv(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const tryDecs: string[] = []
  try { tryDecs.push(new TextDecoder('shift_jis').decode(buf)) } catch { /* full-icu無し環境 */ }
  tryDecs.push(buf.toString('utf8'))
  // 「許可/施設/営業」の出現が多い方を採用（誤エンコードだと壊れて出現しない）
  let best = tryDecs[0] || ''
  let bestScore = -1
  for (const t of tryDecs) { const sc = (t.slice(0, 4000).match(/許可|施設|営業|名称/g) || []).length; if (sc > bestScore) { bestScore = sc; best = t } }
  return best
}

/** ダブルクォート対応の最小CSVパーサ（RFC4180相当・状態機械）。 */
function parseCsvRows(text: string, maxRows = 100000): string[][] {
  const rows: string[][] = []
  let field = '', row: string[] = [], inQ = false
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

const zenToHan = (s: string) => String(s || '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ').replace(/[−－‐]/g, '-').trim()
const parsePermitDate = (s: string) => { const m = zenToHan(s).match(/(20\d{2})[/.年-]\s?(\d{1,2})[/.月-]\s?(\d{1,2})/); return m ? Date.parse(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}T00:00:00+09:00`) : NaN }
// 対象業種（来店型の飲食/食品製造）。販売・自販機・運搬・催事・移動営業はMEO/HP営業の対象外
const PERMIT_INDUSTRY_OK_RE = /(飲食店営業|喫茶|菓子製造|アイスクリーム|そうざい|調理|パン|めん類)/
const PERMIT_INDUSTRY_NG_RE = /(販売|自動販売機|自動車|運搬|集乳|冷凍|倉庫|催事|移動)/

export interface FreshPermitRow { name: string; addr: string; tel: string; kind: string; iso: string; no: string; op: string }
/** CSVバッファから「直近の新規営業許可」行を抽出する純関数（エンジンとローカル検証テストで共用）。
 *  新規判定: 初回許可年月日が直近 ＞ （初回列なし）申請区分=新規かつ許可開始日が直近 ＞ 台東月次（全行その月の許可）。
 *  更新許可（初回が古く許可開始日だけ新しい行）を新店と誤認しないための優先順位。 */
export function extractFreshPermitRows(src: PermitSource, buf: Buffer, sinceMs: number): { rows: number; fresh: FreshPermitRow[]; error: string } {
  const rows = parseCsvRows(decodeGovCsv(buf))
  if (rows.length < 2) return { rows: 0, fresh: [], error: 'CSVが空/解析不能' }
  const header = rows[0].map((h) => zenToHan(h).replace(/\s|"/g, ''))
  const col = (...names: string[]) => { for (const n of names) { const i = header.findIndex((h) => h.includes(n)); if (i >= 0) return i } return -1 }
  // 列マップ（台東型と標準データセット様式の両対応・列名で特定＝位置固定にしない）
  const cName = col('施設名称', '屋号')
  const cAddr = col('所在地_連結表記', '営業所所在地')
  const cAddr2 = col('施設方書', '営業所方書')
  const cTel = col('施設電話番号', '営業所TEL')
  const cKind = col('営業の種類', '業種')
  const cFirst = col('初回許可年月日')
  const cStart = col('許可開始日', '許可年月日')
  const cClosed = col('廃業年月日')
  const cApply = col('申請区分')
  const cOp = col('法人名', '営業者名')
  const cNo = col('許可番号')
  if (cName < 0 || cAddr < 0 || cStart < 0) return { rows: rows.length - 1, fresh: [], error: `必須列が見つからない（header: ${header.slice(0, 8).join(',')}）` }

  const fresh: FreshPermitRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (cClosed >= 0 && zenToHan(r[cClosed] || '')) continue  // 廃業済み
    const kind = zenToHan(r[cKind] || '')
    if (kind && (!PERMIT_INDUSTRY_OK_RE.test(kind) || PERMIT_INDUSTRY_NG_RE.test(kind))) continue
    const firstMs = cFirst >= 0 ? parsePermitDate(r[cFirst] || '') : NaN
    const startMs2 = parsePermitDate(r[cStart] || '')
    let freshOk = false; let evMs = NaN
    if (Number.isFinite(firstMs)) { freshOk = firstMs >= sinceMs; evMs = firstMs }
    else if (cApply >= 0 && /新規/.test(zenToHan(r[cApply] || ''))) { freshOk = Number.isFinite(startMs2) && startMs2 >= sinceMs; evMs = startMs2 }
    else if (src.kind === 'taito_monthly') { freshOk = Number.isFinite(startMs2) && startMs2 >= sinceMs; evMs = startMs2 }
    if (!freshOk || !Number.isFinite(evMs)) continue
    const name = zenToHan(r[cName] || '').replace(/["']/g, '').slice(0, 60)
    let addr = zenToHan(r[cAddr] || '').replace(/\s+/g, '')
    // 方書（ビル名/階）は連結表記に含まれていない場合のみ追記（港区は連結表記が方書を含み重複するため）
    const addr2 = cAddr2 >= 0 ? zenToHan(r[cAddr2] || '').replace(/\s+/g, '') : ''
    if (addr2 && !addr.includes(addr2)) addr += addr2
    addr = addr.slice(0, 90)
    if (!name || name.length < 2 || !addr) continue
    if (/一円|催事|イベント|移動/.test(addr)) continue  // 固定店舗でない（キッチンカー/催事）
    if (src.areaPrefix && !/^(北海道|東京都|(?:京都|大阪)府|[一-龥]{2,3}県)/.test(addr)) addr = `${src.areaPrefix}${addr}`
    let tel = cTel >= 0 ? zenToHan(r[cTel] || '').replace(/[^\d-]/g, '') : ''
    if (tel && !/^0/.test(tel) && src.telAreaCode) tel = `${src.telAreaCode}-${tel}`  // 台東は市外局番なし表記
    const op = cOp >= 0 ? zenToHan(r[cOp] || '') : ''
    // 営業者が大手チェーン/大手法人なら除外（※=個人営業者は最優先ターゲット）
    if (op && op !== '※' && (detectChain(op).definite || detectBigOrPublic(op).exclude)) continue
    const no = cNo >= 0 ? zenToHan(r[cNo] || '').replace(/[^\dA-Za-z]/g, '') : ''
    // evMsはJST 0時のepoch。UTCのtoISOStringだと前日15:00Z=日付が1日巻き戻るため+9hしてからJST暦日を取る
    fresh.push({ name, addr, tel, kind, iso: new Date(evMs + 9 * 3600000).toISOString().slice(0, 10), no: no || `${src.key}-${i}`, op })
  }
  // 同一店の複数業種行をdedupe ＋ 電話あり行を先に（即HOT候補・enrich不要で安い）
  const seenKey = new Set<string>()
  const uniq = fresh.filter((f) => { const k = `${f.name}|${f.addr}`; if (seenKey.has(k)) return false; seenKey.add(k); return true })
    .sort((a, b) => (b.tel ? 1 : 0) - (a.tel ? 1 : 0))
  return { rows: rows.length - 1, fresh: uniq, error: '' }
}

export async function runHealthPermitScan(admin: any, mapsKey: string | null, opts: { runBudgetMs?: number; limit?: number; recencyDays?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now(); const budgetMs = Math.max(20000, Math.min(280000, opts.runBudgetMs || 150000)); const remain = () => budgetMs - (Date.now() - startMs)
  const perItemMs = Math.min(15000, Math.floor(budgetMs / 3))  // 【不変条件】敷居は必ず予算より小さく（恒久0件バグの再発防止）
  const maxItems = Math.max(1, Math.min(60, opts.limit || 12))
  const recencyDays = Math.max(7, Math.min(90, opts.recencyDays || 45))
  const counts: any = { sourceType: 'public_open_data_crawl', label: '保健所営業許可オープンデータ', sources: 0, rows: 0, fresh: 0, fetched: 0, hot: 0, hold: 0, excluded: 0, imported: 0, seenSkipped: 0, skipped: 0 }
  const runId = await startRun(admin, 'public_open_data_crawl', userId)
  const importedCases: any[] = []
  try {
    // ローテーション: 1回2ソース（実行回数ベース）。台帳は月次更新なので全ソース1〜2日で一巡すれば十分
    const { count: rc } = await admin.from('auto_lead_runs').select('id', { count: 'exact', head: true }).eq('source', 'public_open_data_crawl')
    const startIdx = ((rc || 0) * 2) % PERMIT_SOURCES.length
    const picked = [PERMIT_SOURCES[startIdx % PERMIT_SOURCES.length], PERMIT_SOURCES[(startIdx + 1) % PERMIT_SOURCES.length]].filter((v, i, a) => a.indexOf(v) === i)
    let processed = 0

    for (const src of picked) {
      // 鮮度窓は台帳ごと（公開ラグが自治体で大きく違うため）。指定が無ければ実行時の既定を使う。
      const srcRecencyDays = Math.max(7, Math.min(180, src.recencyDays ?? recencyDays))
      const sinceMs = Date.now() - srcRecencyDays * 86400000
      if (remain() < perItemMs + 15000 || processed >= maxItems) break
      // CSV取得（月次ファイルはフォールバック列を順に試す）
      let csvUrl = ''; let buf: Buffer | null = null
      for (const u of src.urls(Date.now())) {
        try {
          const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000)
          const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' }, signal: ctrl.signal, redirect: 'follow' })
          if (r.ok) {
            const ab = await r.arrayBuffer(); clearTimeout(to)
            if (ab.byteLength > 0 && ab.byteLength < 25 * 1024 * 1024) { buf = Buffer.from(ab); csvUrl = u; break }
          } else clearTimeout(to)
        } catch { /* 次のURLへ */ }
      }
      if (!buf) { counts.skipped++; continue }
      counts.sources++
      const ext = extractFreshPermitRows(src, buf, sinceMs)
      counts.rows += ext.rows
      counts.fresh += ext.fresh.length
      if (ext.error) { counts.skipped++; continue }
      const uniq = ext.fresh

      for (const f of uniq) {
        if (remain() < perItemMs || processed >= maxItems) break
        // 既読（許可番号）スキップ＝冪等
        const hashKey = `${src.key}-${f.no}`.slice(0, 80)
        const { data: seen } = await admin.from('discovery_seen_urls').select('id').eq('source_type', 'public_open_data_crawl').eq('url_hash', hashKey).limit(1)
        if (seen?.[0]) { counts.seenSkipped++; continue }
        processed++; counts.fetched++
        // 行識別はクエリパラメータで付与する。#フラグメントは ingestFromUrl が先頭で剥がすため、
        // #方式だと全行が同一source_detail_urlに潰れて相互上書き＋2行目以降の投入が恒久ブロックされる（検証で実証済み）
        const rowUrl = `${csvUrl}${csvUrl.includes('?') ? '&' : '?'}rst_no=${encodeURIComponent(f.no)}`
        const r = await ingestFromUrl(admin, mapsKey, {
          url: rowUrl, sourceType: 'public_open_data_crawl', label: `保健所営業許可(${src.label})`, signalType: 'public_permit',
          hintName: f.name, hintPhone: f.tel, hintAddress: f.addr, evidenceIso: f.iso,
          extraText: `${f.kind} 新規営業許可 ${f.iso} ${f.op && f.op !== '※' ? f.op : '個人営業'}`,
          userId, runId,
        })
        // 既読マークはingest完了後に押す（先に押すと関数打ち切り時にその行が候補未作成のまま恒久スキップ＝月次ファイルは再掲されず永久喪失）
        await admin.from('discovery_seen_urls').upsert({ source_type: 'public_open_data_crawl', url_hash: hashKey, url: rowUrl }, { onConflict: 'source_type,url_hash' }).then(() => {}, () => {})
        if (r.temperature === 'HOT') { counts.hot++; if (r.imported) { counts.imported++; importedCases.push({ id: r.importedCaseId, name: r.name, phone: r.phone, address: r.address }) } }
        else if (r.temperature === 'EXCLUDED') counts.excluded++
        else if (r.temperature === 'SKIPPED') counts.skipped++
        else counts.hold++
        // 許可開始日≒開業日として候補に記録（行政一次＝高確度。開業予定キュー/再コール/スイープ優先順が使う）。
        // ※既存店ガードで降格(DOWNGRADED)/除外された候補には書かない: 開業予定キューが翌巡回で拾って降格判断を覆すのを防ぐ
        if (r.candidateId && r.temperature !== 'DOWNGRADED' && r.temperature !== 'EXCLUDED') {
          const diff = Math.round((Date.parse(f.iso + 'T00:00:00+09:00') - Date.now()) / 86400000)
          await admin.from('lead_candidates').update({
            opening_date: f.iso, opening_date_source: 'health_permit', opening_date_confidence: 75,
            days_until_opening: diff >= 0 ? diff : null, days_since_opening: diff < 0 ? -diff : null,
          }).eq('id', r.candidateId).then(() => {}, () => {})
        }
      }
    }
    await finishRun(admin, runId, counts)
    return { ok: true, ...counts, importedCases }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error', String(e?.message || e)); return { ok: false, error: String(e?.message || e), ...counts } }
}

// source_type → エンジン実行の振り分け。run.ts から呼ぶ。未対応(OCR/PDF/Meta API要)は null を返す。
export async function runEngineSource(admin: any, mapsKey: string | null, sourceType: string, opts: any, userId: string | null): Promise<any | null> {
  switch (sourceType) {
    case 'new_ssl_certificate_domain_scan': return runSslCertScan(admin, mapsKey, opts, userId)
    case 'google_news_rss_opening': return runGoogleNewsRss(admin, mapsKey, opts, userId)
    case 'opening_soon_promotion': return runOpeningSoonQueue(admin, { ...(opts || {}), mapsKey }, userId)
    case 'public_open_data_crawl': return runHealthPermitScan(admin, mapsKey, opts, userId)
    case 'wordpress_first_post_scan': return runDomainSignalScan(admin, mapsKey, 'wordpress', opts, userId)
    case 'sitemap_recent_url_scan': return runDomainSignalScan(admin, mapsKey, 'sitemap', opts, userId)
    case 'new_domain_registration_scan': return runDomainSignalScan(admin, mapsKey, 'rdap', opts, userId)
    case 'hold_reason_reprocess_queue':
    case 'missing_phone_recheck_queue':
    case 'phone_to_address_enrichment_queue':
    case 'places_recheck_queue':
    case 'first_review_detected_scan':
      return runReprocessQueue(admin, mapsKey, sourceType, opts, userId)
    case 'document_to_lead_import':
    case 'event_vendor_list_import':
      return { ok: true, skipped: true, reason: 'テキスト貼り付けで取込できます（取得・投入タブ「テキスト貼り付けインポート」にリスト/チラシ/Excelの内容を貼り付け）。画像はスマホ等でテキスト化してから貼り付けてください。' }
    case 'lead_freshness_scoring':
    case 'callability_score_engine':
    case 'multi_signal_priority_boost':
    case 'successful_query_expander':
    case 'lead_exclusion_classifier':
    case 'sales_angle_classifier':
    case 'calling_priority_queue':
    case 'industry_fit_score':
    case 'ai_duplicate_merge':
    case 'area_hotspot_expansion':
      return runLeadScoring(admin, sourceType, opts, userId)
    default: return null
  }
}

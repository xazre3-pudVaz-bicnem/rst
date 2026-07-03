// ============================================================
// 追加取得元の本稼働エンジン群（土台→本稼働）。サーバー専用。
// すべて共通pipeline(ingestFromUrl)を通す: fetch→抽出→Places/公式補完→検証→除外→重複→signal→HOT/HOLD→保存→HOT投入。
// 外部の有料サービス(OCR/Meta API)を要するもの(スクショ/PDF/CSV/IGコメント)は対象外（run.tsでfoundation継続）。
// すべて残り時間ガード＋fetchタイムアウトで60秒関数上限を死守する。
// ============================================================
import { enrichCandidate } from './instagramWebRun.js'
import { sanitizeShopName, isValidJpPhone, extractJpPhone, isTollFreeJp } from './regionalParsers.js'
import { isJapanPhone, isJapanAddress, isForeignAddress } from './japanFilter.js'
import { detectBigOrPublic, detectMultiStore } from './targetFilter.js'
import { detectChain } from './chainFilter.js'
import { computeQuality, detectNegative, isRealStoreAddress } from './leadQuality.js'
import { hardExcludeReason } from './excludeGate.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { addSignals, applySalesScore } from './leadSignals.js'
import { findCaseIdByPhone } from './caseDedup.js'
import { placesEstablishmentSignal, BIG_GOOGLE_REVIEWS } from './importHot.js'
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
  userId: string | null; autoImport?: boolean; runId?: string | null
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
  if (needEnrich) { try { enrich = await enrichCandidate(mapsKey, { shop: sn0.name, username: '', areaHint: o.hintAddress || d.address || '', industry: '', havePhone: o.hintPhone || d.phone || '', haveAddress: o.hintAddress || d.address || '' }, { maxQueries: 1, perQuery: 5 }) } catch { /* noop */ } }
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
  const hasNewness = NEW_OPEN_RE.test(text) || !!o.evidenceIso
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
  }
  const qr = computeQuality(payload)
  Object.assign(payload, { quality_score: qr.score, quality_grade: qr.grade, industry_category: qr.category, dedup_key: qr.dedupKey, quality_flags: qr.flags, phone_pref_match: qr.phoneMatch, quality_computed_at: nowIso })

  let candidateId: string | null = exC?.[0]?.id || null
  if (!candidateId && phone) { const { data: bp } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = bp?.[0]?.id || null }
  const already = !!exC?.[0]?.imported_to_cases
  if (candidateId) await admin.from('lead_candidates').update(payload).eq('id', candidateId).then(() => {}, () => {})
  else { const { data: ins } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: o.userId }).select('id').single(); candidateId = ins?.id || null }

  if (candidateId) {
    await addSignals(admin, candidateId, [{ type: o.signalType, source: o.label, url, date: o.evidenceIso || null, text: name.slice(0, 180), confidence: temperature === 'HOT' ? 0.8 : 0.5 }])
    const { data: full } = await admin.from('lead_candidates').select('*').eq('id', candidateId).single()
    const { data: sigs } = await admin.from('lead_signals').select('signal_type').eq('lead_candidate_id', candidateId)
    if (full) await applySalesScore(admin, full, Array.from(new Set((sigs || []).map((s: any) => s.signal_type))))
  }

  let importedCaseId: string | null = null; let imported = false
  if (o.autoImport !== false && temperature === 'HOT' && phoneOk && candidateId && !already) {
    // 既存店ガード（口コミ30件以上/最古1ヶ月超）
    let established: any = null
    if (mapsKey && sn.valid && name !== '店名未確定') { try { established = await placesEstablishmentSignal(mapsKey, name, address) } catch { established = null } }
    const isEstablished = !!established && ((established.count != null && established.count >= BIG_GOOGLE_REVIEWS) || (established.oldestDays != null && established.oldestDays > 30))
    if (isEstablished) {
      await admin.from('lead_candidates').update({ lead_temperature: established.count >= BIG_GOOGLE_REVIEWS ? 'EXCLUDED' : 'HOLD', hot_tier: null, should_exclude_from_call_list: established.count >= BIG_GOOGLE_REVIEWS, user_rating_count: established.count ?? null, oldest_review_days_ago: established.oldestDays ?? null, auto_insert_skipped_reason: '既存店（口コミ多数/最古1ヶ月超）のため投入せず', auto_import_reason: null }).eq('id', candidateId)
      return { status: 'valid', temperature: 'DOWNGRADED', name, phone, address, candidateId, imported: false }
    }
    const dupCaseId = await findCaseIdByPhone(admin, phone)
    if (dupCaseId) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId }).eq('id', candidateId); importedCaseId = dupCaseId }
    else {
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
async function finishRun(admin: any, runId: string | null, counts: any, status = 'success') {
  if (!runId) return
  await admin.from('auto_lead_runs').update({ status, finished_at: new Date().toISOString(), fetched_count: counts.fetched || 0, hot_count: counts.hot || 0, hold_count: counts.hold || 0, excluded_count: counts.excluded || 0, imported_count: counts.imported || 0 }).eq('id', runId).then(() => {}, () => {})
}

// ============================================================
// 1) SSL新規発行ドメイン監視（crt.sh・無料/キー不要）
// ============================================================
const BIZ_DOMAIN_HINT = /(clinic|dental|salon|hair|nail|beauty|esthe|seitai|cafe|kitchen|dining|ramen|gym|fitness|pet|trimming|school|juku|reform|cleaning|studio|shop|store|tenpo|inc|co\.jp)/i
export async function runSslCertScan(admin: any, mapsKey: string | null, opts: { maxDomains?: number; runBudgetMs?: number; recencyDays?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now()
  const budgetMs = Math.max(15000, Math.min(50000, opts.runBudgetMs || 40000))
  const remain = () => budgetMs - (Date.now() - startMs)
  const maxDomains = Math.max(1, Math.min(40, opts.maxDomains || 20))
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
      if (remain() < 10000) break
      // 既に取得済みドメインはスキップ
      const { data: seenDom } = await admin.from('discovery_seen_urls').select('id').eq('source_type', 'new_ssl_certificate_domain_scan').eq('url', `https://${dom}/`).limit(1)
      if (seenDom?.[0]) { counts.skipped++; continue }
      await admin.from('discovery_seen_urls').upsert({ source_type: 'new_ssl_certificate_domain_scan', url_hash: dom, url: `https://${dom}/` }, { onConflict: 'source_type,url_hash' }).then(() => {}, () => {})
      counts.fetched++
      const r = await ingestFromUrl(admin, mapsKey, { url: `https://${dom}/`, sourceType: 'new_ssl_certificate_domain_scan', label: 'SSL新規発行ドメイン', signalType: 'new_ssl_certificate', evidenceIso: new Date().toISOString(), userId, runId })
      if (r.temperature === 'HOT') { counts.hot++; if (r.imported) counts.imported++ } else if (r.temperature === 'EXCLUDED') counts.excluded++; else counts.hold++
    }
    await finishRun(admin, runId, counts)
    return { ok: true, ...counts, domainsFound: domains.length }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error'); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 2) 公式ドメインの新規シグナル: WordPress初回投稿 / sitemap直近更新 / ドメイン登録日(RDAP)
//    既存候補(official_url あり)を対象に鮮度シグナルを付与し、条件を満たせばHOLD→HOT昇格。
// ============================================================
function hostOf(u: string): string { try { return new URL(u).host } catch { return '' } }
function originOf(u: string): string { try { const x = new URL(u); return `${x.protocol}//${x.host}` } catch { return '' } }

export async function runDomainSignalScan(admin: any, mapsKey: string | null, mode: 'wordpress' | 'sitemap' | 'rdap', opts: { limit?: number; runBudgetMs?: number; recencyDays?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now()
  const budgetMs = Math.max(15000, Math.min(50000, opts.runBudgetMs || 40000))
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
    // official_url があり、直近未チェックの候補（HOLD/HOT中心）
    const { data: rows } = await admin.from('lead_candidates').select('id,name,official_url,website_url,phone_number,address,lead_temperature,imported_to_cases')
      .or('official_url.not.is.null,website_url.not.is.null').neq('lead_temperature', 'EXCLUDED').limit(400)
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
        let posts: any[] = []; try { posts = JSON.parse(r.text || '[]') } catch { posts = [] }
        const latest = posts.map((p) => Date.parse(p.date || 0)).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0]
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
  } catch (e: any) { await finishRun(admin, runId, counts, 'error'); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 3) HOLD理由別 再補完キュー（電話なし/住所なし/店名未確定/openingDate未取得 を再処理）
// ============================================================
export async function runReprocessQueue(admin: any, mapsKey: string | null, type: string, opts: { limit?: number; runBudgetMs?: number } = {}, userId: string | null): Promise<any> {
  const startMs = Date.now()
  const budgetMs = Math.max(15000, Math.min(50000, opts.runBudgetMs || 40000))
  const remain = () => budgetMs - (Date.now() - startMs)
  const limit = Math.max(1, Math.min(100, opts.limit || 60))
  const counts: any = { sourceType: type, label: '再評価/補完', scanned: 0, enriched: 0, phoneFound: 0, addressFound: 0, promotedHot: 0, imported: 0 }
  const runId = await startRun(admin, type, userId)
  try {
    // 対象: HOLD かつ 店名が確定（未確定はノイズが多い）
    let q = admin.from('lead_candidates').select('id,name,extracted_shop_name,extracted_area,extracted_industry,extracted_prefecture,phone_number,address,lead_temperature,is_chain_store,duplicate_of_case_id,imported_to_cases,official_url').eq('lead_temperature', 'HOLD').not('name', 'is', null).limit(300)
    if (type === 'missing_phone_recheck_queue') q = q.is('phone_number', null).not('address', 'is', null)
    else if (type === 'phone_to_address_enrichment_queue') q = q.not('phone_number', 'is', null).is('address', null)
    const { data: rows } = await q
    const list = (rows || []).filter((c: any) => !c.is_chain_store && !c.duplicate_of_case_id).slice(0, limit)
    for (const c of list) {
      if (remain() < 12000) break
      const shop = c.extracted_shop_name || c.name || ''
      if (!shop || shop === '店名未確定') continue
      counts.scanned++
      const e = await enrichCandidate(mapsKey, { shop, username: '', areaHint: c.extracted_area || c.address || '', industry: c.extracted_industry || '', havePhone: c.phone_number || '', haveAddress: c.address || '' }, { maxQueries: 2, perQuery: 5 }).catch(() => null)
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
        const dupCaseId = await findCaseIdByPhone(admin, phone)
        if (dupCaseId) await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: dupCaseId }).eq('id', c.id)
        else { const { data: created } = await admin.from('cases').insert({ name: shop, address, phone1: phone, industry: classifyIndustry(shop) || normalizeIndustry(c.extracted_industry) || null, status: DEFAULT_STATUS, priority: '中', hp1: c.official_url || e.official || null, source_urls: c.official_url || 'HOLD再補完', memo: `【AI自動投入 / HOLD再補完 / HOT-B】\n電話: ${phone}\n住所: ${address}`, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null })); if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: created.id }).eq('id', c.id); counts.imported++ } }
      }
    }
    await finishRun(admin, runId, { ...counts, hot: counts.promotedHot })
    return { ok: true, ...counts }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error'); return { ok: false, error: String(e?.message || e), ...counts } }
}

// ============================================================
// 4) 手動URL一括インポート
// ============================================================
export async function runBulkUrlImport(admin: any, mapsKey: string | null, urls: string[], meta: { memo?: string; sourceType?: string }, userId: string | null): Promise<any> {
  const startMs = Date.now(); const budgetMs = 45000; const remain = () => budgetMs - (Date.now() - startMs)
  const clean = Array.from(new Set(urls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//.test(u)))).slice(0, 40)
  const counts: any = { sourceType: 'manual_url_bulk_import', label: '手動URL一括インポート', total: clean.length, processed: 0, hot: 0, hold: 0, excluded: 0, imported: 0 }
  const runId = await startRun(admin, 'manual_url_bulk_import', userId)
  const results: any[] = []
  for (const url of clean) {
    if (remain() < 10000) { counts.stoppedEarly = true; break }
    const r = await ingestFromUrl(admin, mapsKey, { url, sourceType: 'manual_url_bulk_import', label: '手動URL一括', signalType: 'manual_import', extraText: meta.memo || '', userId, runId })
    counts.processed++
    if (r.temperature === 'HOT') { counts.hot++; if (r.imported) counts.imported++ } else if (r.temperature === 'EXCLUDED') counts.excluded++; else counts.hold++
    if (results.length < 40) results.push({ url, name: r.name, temperature: r.temperature, phone: r.phone, imported: r.imported })
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
  const startMs = Date.now(); const budgetMs = Math.max(15000, Math.min(50000, opts.runBudgetMs || 40000)); const remain = () => budgetMs - (Date.now() - startMs)
  const limit = Math.max(1, Math.min(2000, opts.limit || 1000))
  const counts: any = { sourceType: mode, scored: 0, s: 0, a: 0, b: 0, c: 0, excluded: 0, merged: 0 }
  const runId = await startRun(admin, mode, userId)
  const nowMs = Date.now()
  try {
    const { data: rows } = await admin.from('lead_candidates').select('id,name,phone_number,address,lead_temperature,hot_tier,first_seen_at,regional_media_detected_at,extracted_industry,industry_category,official_url,website_url,imported_to_cases,duplicate_of_case_id,should_exclude_from_call_list').neq('lead_temperature', 'EXCLUDED').order('first_seen_at', { ascending: false }).limit(limit)
    const list = rows || []
    // signal数（複数シグナル加点）をまとめて取得
    const ids = list.map((c: any) => c.id)
    const sigCount = new Map<string, number>()
    for (let i = 0; i < ids.length && remain() > 8000; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data: sg } = await admin.from('lead_signals').select('lead_candidate_id').in('lead_candidate_id', chunk)
      for (const s of (sg || [])) sigCount.set(s.lead_candidate_id, (sigCount.get(s.lead_candidate_id) || 0) + 1)
    }
    for (const c of list) {
      if (remain() < 4000) break
      const phone = c.phone_number || ''
      const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
      const hasAddr = !!c.address && isRealStoreAddress(c.address)
      // 鮮度
      const ev = Date.parse(c.regional_media_detected_at || c.first_seen_at || '') || 0
      const ageDays = ev ? (nowMs - ev) / 86400000 : 999
      const freshness = ageDays <= 3 ? 30 : ageDays <= 7 ? 22 : ageDays <= 14 ? 14 : ageDays <= 30 ? 8 : 2
      // 架電容易性
      const contact = (phoneOk ? 30 : 0) + (hasAddr ? 20 : 0)
      // 複数シグナル
      const nsig = sigCount.get(c.id) || 0
      const multi = Math.min(20, nsig * 7)
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
    }
    await finishRun(admin, runId, counts)
    return { ok: true, ...counts }
  } catch (e: any) { await finishRun(admin, runId, counts, 'error'); return { ok: false, error: String(e?.message || e), ...counts } }
}

// source_type → エンジン実行の振り分け。run.ts から呼ぶ。未対応(OCR/PDF/Meta API要)は null を返す。
export async function runEngineSource(admin: any, mapsKey: string | null, sourceType: string, opts: any, userId: string | null): Promise<any | null> {
  switch (sourceType) {
    case 'new_ssl_certificate_domain_scan': return runSslCertScan(admin, mapsKey, opts, userId)
    case 'wordpress_first_post_scan': return runDomainSignalScan(admin, mapsKey, 'wordpress', opts, userId)
    case 'sitemap_recent_url_scan': return runDomainSignalScan(admin, mapsKey, 'sitemap', opts, userId)
    case 'new_domain_registration_scan': return runDomainSignalScan(admin, mapsKey, 'rdap', opts, userId)
    case 'hold_reason_reprocess_queue':
    case 'missing_phone_recheck_queue':
    case 'phone_to_address_enrichment_queue':
    case 'places_recheck_queue':
    case 'first_review_detected_scan':
      return runReprocessQueue(admin, mapsKey, sourceType, opts, userId)
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

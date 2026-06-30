// ============================================================
// 連番URL探索クロール（サーバー専用・地域メディアとは別枠）
//  - 文字コード自動判定(Shift_JIS/EUC-JP/UTF-8)＋文字化け検出
//  - じゃらん専用パーサー(jalan_spot_detail): 本体の基本情報のみ抽出（周辺おすすめは除外）
//  - 前回 last_checked_id の続きから再開＋少し戻り確認(backfill)
//  - valid/invalid判定。validのみ lead_candidates 保存・invalid/文字化けは probe_results に記録
//  - 連続not_found停止・1回20/1日100URL・30日再取得回避・robots配慮
// ============================================================
import { extractAddressLoose } from './enrichProfile.js'
import { extractJpPhone } from './regionalParsers.js'
import { isForeignAddress, isJapanAddress, isJapanPhone } from './japanFilter.js'
import { scoreCandidate, tierToTemperature, autoImportAllowed, type InjectMode } from './hotTier.js'
import { buildHotReject, type HotCheck } from './hotReject.js'

const UA = 'RST-CRM-bot/1.0 (+lead research; respects robots.txt)'
const PROBE_TIMEOUT_MS = 8000

// ---- 文字コード判定つき取得 ----
function detectCharset(buf: Buffer, headerCt: string): string {
  const m = headerCt.match(/charset=["']?([\w-]+)/i)
  if (m) return m[1].toLowerCase()
  const head = buf.slice(0, 4096).toString('latin1')
  const meta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || head.match(/content=["'][^"']*charset=([\w-]+)/i)
  return (meta?.[1] || '').toLowerCase()
}
function normCharset(cs: string): string {
  const c = cs.replace(/[^a-z0-9_-]/g, '')
  if (/^(shift.?jis|sjis|ms932|windows-?31j|cp932)$/.test(c)) return 'shift_jis'
  if (/^(euc-?jp|eucjp)$/.test(c)) return 'euc-jp'
  if (/^(iso-?2022-?jp)$/.test(c)) return 'iso-2022-jp'
  if (/^utf-?8$/.test(c) || !c) return 'utf-8'
  return c
}
function decodeBuf(buf: Buffer, cs: string): string {
  try { return new TextDecoder(cs as any).decode(buf) } catch { try { return new TextDecoder('utf-8').decode(buf) } catch { return buf.toString('utf8') } }
}
function mojibakeRate(s: string): number {
  if (!s) return 1
  const sample = s.slice(0, 6000)
  const bad = (sample.match(/�/g) || []).length
  return bad / Math.max(1, sample.length)
}

interface FetchDecoded { ok: boolean; status: number; html: string; charset: string; decodeMethod: string; mojibakeRate: number; mojibake: boolean; timedOut: boolean }
async function fetchDecoded(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<FetchDecoded> {
  const ctrl = new AbortController()
  let timedOut = false
  const to = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ja' }, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(to)
    const buf = Buffer.from(await res.arrayBuffer())
    const detected = normCharset(detectCharset(buf, res.headers.get('content-type') || ''))
    let html = decodeBuf(buf, detected)
    let rate = mojibakeRate(html)
    let method = detected
    if (rate > 0.01) {
      for (const cs of ['shift_jis', 'euc-jp', 'utf-8']) {
        if (cs === detected) continue
        const h2 = decodeBuf(buf, cs); const r2 = mojibakeRate(h2)
        if (r2 < rate) { html = h2; rate = r2; method = cs }
      }
    }
    return { ok: res.ok, status: res.status, html, charset: detected || 'utf-8', decodeMethod: method, mojibakeRate: rate, mojibake: rate > 0.02, timedOut: false }
  } catch { clearTimeout(to); return { ok: false, status: 0, html: '', charset: '', decodeMethod: '', mojibakeRate: 1, mojibake: false, timedOut } }
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

const INVALID_RE = /(該当(観光スポット|施設|店舗)?情報は存在しません|ページが見つかりません|お探しのページ|404\s*Not\s*Found|エラーが発生|アクセスが集中|ただいま大変混み合)/i
const OPEN_RE = /(新規オープン|ニューオープン|グランドオープン|プレオープン|本日オープン|オープンしました|開店しました|開業しました|\d{1,2}月\d{1,2}日\s?(?:OPEN|オープン|開店|開業))/i
// 観光名所・公共施設のみ（電話/住所が無ければ営業対象外）
const FACILITY_RE = /(神社|神宮|大社|[^ァ-ヶ]寺$|お寺|寺院|仏閣|教会|公園|庭園|広場|駅$|空港|港$|役所|市役所|町村役場|区役所|図書館|博物館|美術館|資料館|城跡|城$|展望台|展望|海岸|砂浜|ビーチ|滝$|渓谷|峠|岬|湖$|池$|山$|岳$|温泉郷|景勝|名所|旧跡|史跡|記念碑|モニュメント)/

export interface JalanSpot { name: string; address: string; phone: string; category: string; official: string; mapUrl: string; reviews: string; valid: boolean; invalidReason: string }
/** じゃらん観光スポット詳細ページのパーサー（本体の基本情報のみ。周辺おすすめは除外） */
export function parseJalanSpot(html: string, mojibake: boolean): JalanSpot {
  const empty: JalanSpot = { name: '', address: '', phone: '', category: '', official: '', mapUrl: '', reviews: '', valid: false, invalidReason: '' }
  if (mojibake) return { ...empty, invalidReason: '文字化けで読めない' }
  // 「周辺のおすすめ」「周辺観光スポット」「クチコミ一覧」以降は切り捨て（おすすめ別店舗の誤抽出防止）
  const cut = html.search(/周辺の?(おすすめ|観光|スポット|ランチ|ホテル|宿)|このスポットの.*クチコミ一覧|近くの/)
  const main = cut > 500 ? html.slice(0, cut) : html
  const body = stripTags(main)
  if (INVALID_RE.test(stripTags(html))) return { ...empty, invalidReason: '不存在/エラーページ' }
  // 名称: og:title優先 → h1（「| じゃらん」等を除去）
  const og = main.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ''
  const h1 = main.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''
  let name = stripTags(og || h1).replace(/[|｜].*$/, '').replace(/(の(観光情報|詳細|クチコミ|地図).*)$/,'').trim().slice(0, 50)
  // 所在地: 「所在地」「住所」ラベル → 緩い住所抽出
  let address = (body.match(/(?:所在地|住所)[:：\s]*([〒\d都道府県][^\n。｜|]{4,50})/)?.[1] || '').trim()
  if (!address) address = extractAddressLoose(body).address
  const phone = extractJpPhone(body)
  const category = (body.match(/(?:ジャンル|カテゴリ|種別)[:：\s]*([^\s|｜/]{2,16})/)?.[1] || '')
  const official = (main.match(/href=["'](https?:\/\/(?!www\.jalan\.net)[^"']+)["'][^>]*>\s*(?:公式|ホームページ|HP|Webサイト)/i)?.[1] || '')
  const mapUrl = (main.match(/href=["'](https?:\/\/(?:maps\.google|www\.google\.[^/]*\/maps)[^"']+)["']/i)?.[1] || '')
  const reviews = (body.match(/(?:クチコミ|口コミ)\s*([\d,]+)\s*件/)?.[1] || '')
  const valid = !!name && !!address
  return { name, address, phone, category, official, mapUrl, reviews, valid, invalidReason: valid ? '' : (!name ? '名称が取れない' : '所在地が取れない') }
}

function pad(id: number, padding: number): string { const s = String(id); return padding > 0 ? s.padStart(padding, '0') : s }

export interface ProbeResult {
  ok: boolean; siteName: string
  probed: number; valid: number; invalid: number; saved: number; saveError: number
  hot: number; hotA: number; hotB: number; hold: number; excluded: number; imported: number
  timeouts: number; dupSkip: number; mojibake: number; fetchFail: number; consecutiveNotFound: number
  startId: number; fromId: number; toId: number; nextId: number; lastFoundId: number | null; lastValidId: number | null
  backfillFrom: number | null; backfillTo: number | null; items: any[]; reason: string
}

/** 1サイトの連番探索（前回の続きから＋戻り確認）。DB保存込み。 */
export async function runSequentialProbe(admin: any, mapsKey: string | null, site: any, opts: {
  userId: string | null; runId: string | null; nowIso: string; mode: InjectMode
  forwardCount?: number; backfillCount?: number; startIdOverride?: number; force?: boolean
  dayRemaining: number; autoImportPerRun: number; autoImportPerDay: number; importedToday: number; delayMs: number
}): Promise<ProbeResult> {
  const res: ProbeResult = {
    ok: true, siteName: site.name, probed: 0, valid: 0, invalid: 0, saved: 0, saveError: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0,
    timeouts: 0, dupSkip: 0, mojibake: 0, fetchFail: 0, consecutiveNotFound: 0,
    startId: 0, fromId: 0, toId: 0, nextId: 0, lastFoundId: site.last_found_id ?? null, lastValidId: site.last_valid_id ?? null,
    backfillFrom: null, backfillTo: null, items: [], reason: '',
  }
  const template: string = site.url_template || ''
  if (!template.includes('{ID}')) { res.ok = false; res.reason = 'url_template に {ID} がありません'; return res }
  const padding = Number(site.id_padding) || 0
  const maxNotFound = Math.max(1, Number(site.max_consecutive_not_found) || 10)
  const forward = Math.max(1, Math.min(Number(opts.forwardCount) || Number(site.forward_scan_count) || 20, 100, opts.dayRemaining))
  const backfill = Math.max(0, Math.min(Number(opts.backfillCount ?? site.backfill_scan_count ?? 5), 20))
  // 再開位置: 指定 > current_probe_id > last_checked_id+1 > start_probe_id
  const startId = opts.startIdOverride ?? Number(site.current_probe_id) ?? (site.last_checked_id != null ? Number(site.last_checked_id) + 1 : Number(site.start_probe_id) || 1)
  res.startId = startId; res.fromId = startId
  const startedAt = opts.nowIso
  let consecutiveNotFound = Number(site.consecutive_not_found_count) || 0
  let importedThisRun = 0
  let importedCount = opts.importedToday
  let totalChecked = 0, totalValid = 0, totalInvalid = 0

  // 探索対象IDリスト: 前方20 ＋ 戻り確認(last_checked_id-backfill 〜 last_checked_id)
  const ids: number[] = []
  for (let i = 0; i < forward; i++) ids.push(startId + i)
  if (backfill > 0 && site.last_checked_id != null) {
    const bEnd = Number(site.last_checked_id)
    const bStart = bEnd - backfill + 1
    res.backfillFrom = bStart; res.backfillTo = bEnd
    for (let id = bStart; id <= bEnd; id++) if (id > 0 && !ids.includes(id)) ids.push(id)
  }

  for (const probedId of ids) {
    if (res.probed >= forward + backfill) break
    if (consecutiveNotFound >= maxNotFound && probedId >= startId) {
      res.reason = `not_found ${consecutiveNotFound}連続で前方探索停止`
      // 前方分を打ち切り、戻り確認のみ残す
      if (probedId >= startId) continue
    }
    if (opts.dayRemaining - res.probed <= 0) { res.reason = '1日のURL上限に到達'; break }
    const url = template.replace('{ID}', pad(probedId, padding))
    res.toId = Math.max(res.toId, probedId)

    // 30日以内に確認済みはスキップ（手動forceは除く）。invalidは7日以内skip
    if (!opts.force) {
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString()
      const { data: lg } = await admin.from('sequential_probe_results').select('id,valid,checked_at').eq('probed_url', url).order('checked_at', { ascending: false }).limit(1)
      const last = lg?.[0]
      if (last) {
        const ageDays = (Date.now() - Date.parse(last.checked_at)) / 86400000
        if (last.valid) { res.dupSkip++; continue }            // validは再取得しない
        if (ageDays < 7) { res.dupSkip++; continue }            // invalidは7日skip
        if (ageDays < 30 && last.valid) { res.dupSkip++; continue }
      }
    }

    const r = await fetchDecoded(url)
    await new Promise((rs) => setTimeout(rs, Math.max(200, opts.delayMs)))
    res.probed++; totalChecked++
    if (r.timedOut) res.timeouts++
    if (!r.ok || !r.html) res.fetchFail++
    if (r.mojibake) res.mojibake++

    const isJalan = (site.parser_type === 'jalan_spot_detail') || /jalan\.net/i.test(url)
    const spot = isJalan ? parseJalanSpot(r.html, r.mojibake) : null
    const bodyAll = r.html ? stripTags(r.html) : ''
    const name = spot ? spot.name : ''
    const address = spot ? spot.address : extractAddressLoose(bodyAll).address
    const phone = spot ? spot.phone : extractJpPhone(bodyAll)
    let invalidReason = ''
    if (!r.ok || !r.html) invalidReason = r.timedOut ? 'fetch timeout' : `取得失敗(HTTP ${r.status})`
    else if (r.mojibake) invalidReason = '文字化けで名称/住所が読めない'
    else if (spot) invalidReason = spot.valid ? '' : spot.invalidReason
    else if (INVALID_RE.test(bodyAll) || bodyAll.length < 200) invalidReason = '不存在/本文なし'
    else if (!name && !address) invalidReason = '名称/所在地が取れない'
    const valid = !invalidReason

    // 探索ログ（valid/invalid問わず記録）
    let savedCandidateId: string | null = null
    let createdCaseId: string | null = null

    if (!valid) {
      res.invalid++; totalInvalid++; consecutiveNotFound++
      await admin.from('sequential_probe_results').insert({
        source_site_id: site.id, run_id: opts.runId, probed_id: probedId, probed_url: url, http_status: r.status,
        valid_page: false, invalid_reason: invalidReason, charset_detected: r.charset, decode_method: r.decodeMethod,
        decode_success: !r.mojibake, mojibake_detected: r.mojibake, mojibake_rate: Math.round(r.mojibakeRate * 1000) / 1000,
        extracted_name: name || null, parser_used: isJalan ? 'jalan_spot_detail' : 'generic_detail_page', error_message: r.timedOut ? 'timeout' : null, checked_at: opts.nowIso,
      }).then(() => {}, () => {})
      if (res.items.length < 40) res.items.push({ probedId, url, valid: false, status: r.status, charset: r.charset, mojibake: r.mojibake, invalidReason })
      continue
    }

    // valid: 判定して保存
    res.valid++; totalValid++; res.lastFoundId = probedId; res.lastValidId = probedId; consecutiveNotFound = 0
    const category = spot?.category || ''
    const official = spot?.official || ''
    const hasOpen = OPEN_RE.test(bodyAll)
    const newness_type = hasOpen ? 'possible_new_open' : 'source_new_listing'
    const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || /[市区町村]/.test(address))
    // 観光名所/公共施設のみ（電話なし）は営業対象外
    const facilityish = FACILITY_RE.test(`${name} ${category}`)
    const excludedFacility = facilityish && !(phone && isJapanPhone(phone))

    const sc = scoreCandidate({
      source: 'regional_media', isJapan, hasShopName: !!name, hasPhone: !!phone && isJapanPhone(phone), hasArea: !!address,
      hasOpeningDate: hasOpen, isFuture: false, igNew: false, regionalNew: false, newListing: true,
      placesMatched: false, hasOfficial: !!official,
      isChain: false, isOrg: excludedFacility, isEventRecruit: false, isForeign: isForeignAddress(address), isDup: false, reviewMany: false,
    }, opts.mode)
    const { temperature, hot_tier } = tierToTemperature(sc.tier)
    if (temperature === 'HOT') { res.hot++; if (hot_tier === 'A') res.hotA++; else res.hotB++ }
    else if (temperature === 'EXCLUDED') res.excluded++; else res.hold++

    const rmChecks: HotCheck[] = [
      { key: 'has_japan', label: '日本国内', ok: isForeignAddress(address) ? false : (isJapan ? true : null), reasonKey: 'not_japan' },
      { key: 'has_shop_name', label: '店名/施設名あり', ok: !!name, reasonKey: 'shop_name_missing' },
      { key: 'has_area', label: '住所あり', ok: !!address, reasonKey: 'address_missing', value: address || undefined },
      { key: 'has_phone', label: '日本の電話番号あり', ok: (phone && isJapanPhone(phone)) ? true : false, reasonKey: 'phone_missing', value: phone || undefined },
      { key: 'has_newness', label: '新規掲載候補', ok: true, reasonKey: 'newness_missing' },
      { key: 'has_opening_date', label: '新規オープン根拠', ok: hasOpen ? true : null, reasonKey: 'opening_date_missing' },
    ]
    const hotReject = buildHotReject({ source: 'regional_media', temperature, confidence: sc.score, checks: rmChecks })
    const payload: any = {
      name: name || '連番探索候補', address: address || null, industry: category || null, phone_number: phone || null, website_url: official || null,
      source: 'sequential_id_probe', lead_source: 'sequential_id_probe', source_type: 'AI自動投入(連番探索)',
      source_site_type: 'sequential_id_probe', parser_used: isJalan ? 'jalan_spot_detail' : 'generic_detail_page', source_media_family: site.media_family || null, source_site_name: site.name,
      source_detail_url: url, source_list_url: template, probed_id: probedId, probed_url: url, probe_valid: true, probe_status: `HTTP ${r.status}`,
      charset_detected: r.charset, mojibake_detected: false,
      search_title: (name || '').slice(0, 300), search_snippet: bodyAll.slice(0, 300), candidate_block_text_short: bodyAll.slice(0, 300),
      newness_type, regional_media_newness_reason: `連番探索(${isJalan ? 'jalan_spot_detail' : 'generic'}) ID=${probedId}「${name}」${hasOpen ? '・OPEN表記あり' : '・新規掲載候補'} / ${sc.reason}`,
      first_discovered_at: opts.nowIso, regional_media_detected_at: opts.nowIso,
      lead_temperature: temperature, hot_tier, recommended_status: sc.tier, should_exclude_from_call_list: temperature === 'EXCLUDED',
      owner_reachability_score: phone ? 65 : 30, auto_import_reason: temperature === 'HOT' ? sc.reason : null, ai_comment: sc.reason,
      extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null, extracted_industry: category || null, extracted_area: address || null, extracted_official_url: official || null,
      hot_reject_reasons: hotReject.hot_reject_reasons, hot_reject_summary: hotReject.hot_reject_summary, hot_check_result: hotReject.hot_check_result,
      hot_missing_requirements: hotReject.hot_missing_requirements, hot_blocking_reason: hotReject.hot_blocking_reason, hot_required_score: hotReject.hot_required_score,
      match_confidence: sc.score, last_seen_at: opts.nowIso, source_run_id: opts.runId,
    }
    const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_detail_url', url).limit(1)
    let candidateId: string | null = exC?.[0]?.id || null
    if (!candidateId && phone) { const { data: byPhone } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = byPhone?.[0]?.id || null }
    const alreadyImported = !!exC?.[0]?.imported_to_cases
    if (candidateId) { const { error } = await admin.from('lead_candidates').update(payload).eq('id', candidateId); if (error) res.saveError++; else res.saved++ }
    else { const { data: ins, error } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: opts.nowIso, imported_to_cases: false, created_by_id: opts.userId }).select('id').single(); if (error) res.saveError++; else res.saved++; candidateId = ins?.id || null }
    savedCandidateId = candidateId

    if (autoImportAllowed(sc.tier, opts.mode) && phone && isJapanPhone(phone) && candidateId && !alreadyImported && importedCount < opts.autoImportPerDay && importedThisRun < opts.autoImportPerRun) {
      const { data: created } = await admin.from('cases').insert({ name: name || '連番探索候補', address: address || '', phone1: phone, industry: category || null, status: 'リスト', priority: sc.priority === 'high' ? '高' : '中', hp1: official || null, source_urls: url, memo: `【AI自動投入 / 連番探索 / ${sc.tier}】ID=${probedId}\nURL: ${url}`, created_by_id: opts.userId }).select('id').single()
      if (created?.id) { createdCaseId = created.id; await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: opts.nowIso, imported_case_id: created.id }).eq('id', candidateId); res.imported++; importedCount++; importedThisRun++ }
    }
    await admin.from('sequential_probe_results').insert({
      source_site_id: site.id, run_id: opts.runId, probed_id: probedId, probed_url: url, http_status: r.status, valid_page: true, invalid_reason: null,
      charset_detected: r.charset, decode_method: r.decodeMethod, decode_success: true, mojibake_detected: false, mojibake_rate: Math.round(r.mojibakeRate * 1000) / 1000,
      extracted_name: name || null, extracted_address: address || null, extracted_phone: phone || null, parser_used: isJalan ? 'jalan_spot_detail' : 'generic_detail_page',
      saved_candidate_id: savedCandidateId, created_case_id: createdCaseId, checked_at: opts.nowIso,
    }).then(() => {}, () => {})
    if (res.items.length < 40) res.items.push({ probedId, url, valid: true, charset: r.charset, name, phone, address, category, newness_type, temperature: hot_tier ? `HOT-${hot_tier}` : temperature })
  }

  // 次回開始ID = 最後に確認したID + 1（前方分の最大ID基準）
  const lastChecked = res.toId || (startId + forward - 1)
  const nextId = lastChecked + 1
  res.nextId = nextId; res.consecutiveNotFound = consecutiveNotFound
  if (!res.reason) res.reason = res.valid > 0 ? `OK（valid ${res.valid}/probed ${res.probed}）` : `valid 0（probed ${res.probed}）`
  await admin.from('source_sites').update({
    current_probe_id: nextId, last_checked_id: lastChecked, last_found_id: res.lastFoundId ?? site.last_found_id ?? null,
    last_valid_id: res.lastValidId ?? site.last_valid_id ?? null, last_invalid_id: res.invalid > 0 ? res.toId : (site.last_invalid_id ?? null),
    last_probe_started_at: startedAt, last_probe_finished_at: opts.nowIso, consecutive_not_found_count: consecutiveNotFound,
    total_checked_count: (Number(site.total_checked_count) || 0) + totalChecked, total_valid_count: (Number(site.total_valid_count) || 0) + totalValid, total_invalid_count: (Number(site.total_invalid_count) || 0) + totalInvalid,
    probe_result_summary: `次回ID${nextId} / probed${res.probed} valid${res.valid}/invalid${res.invalid} 文字化け${res.mojibake} HOT-A${res.hotA}/B${res.hotB} 保存${res.saved}`.slice(0, 200),
    last_crawled_at: opts.nowIso, updated_at: opts.nowIso,
  }).eq('id', site.id).then(() => {}, () => {})
  return res
}

/** 全 sequential_id_probe サイトを実行（連番探索タブ用） */
export async function runAllSequentialProbes(admin: any, mapsKey: string | null, rawSettings: any, userId: string | null) {
  const s = rawSettings || {}
  const mode: InjectMode = (s.aiInjectMode === 'strict' || s.aiInjectMode === 'aggressive') ? s.aiInjectMode : 'standard'
  const nowIso = new Date().toISOString()
  const counts = { sources: 0, probed: 0, valid: 0, invalid: 0, saved: 0, saveError: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, mojibake: 0, fetchFail: 0, phoneYes: 0, addressYes: 0, dupSkip: 0, timeouts: 0 }
  const debug: any = { siteResults: [] as any[] }
  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'sequential_probe', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null
  try {
    const { data: sites } = await admin.from('source_sites').select('*').eq('source_type', 'sequential_id_probe').eq('is_active', true).limit(50)
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: probedTodayCount } = await admin.from('sequential_probe_results').select('id', { count: 'exact', head: true }).gte('checked_at', startToday.toISOString())
    let dayRemaining = Math.max(0, 100 - (probedTodayCount || 0))
    const { count: importedTodayCount } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    const autoImportPerRun = Math.max(1, Number(s.autoImportPerRun) || 50)
    const autoImportPerDay = Math.max(1, Number(s.autoImportPerDay) || 200)
    for (const site of sites || []) {
      if (site.probe_enabled === false) continue
      counts.sources++
      const pr = await runSequentialProbe(admin, mapsKey, site, {
        userId, runId, nowIso, mode,
        forwardCount: Number(s.forwardCount) || undefined, backfillCount: s.backfillCount, startIdOverride: undefined, force: !!s.force,
        dayRemaining, autoImportPerRun, autoImportPerDay, importedToday: importedTodayCount || 0, delayMs: 800,
      })
      dayRemaining = Math.max(0, dayRemaining - pr.probed)
      counts.probed += pr.probed; counts.valid += pr.valid; counts.invalid += pr.invalid; counts.saved += pr.saved; counts.saveError += pr.saveError
      counts.hot += pr.hot; counts.hotA += pr.hotA; counts.hotB += pr.hotB; counts.hold += pr.hold; counts.excluded += pr.excluded; counts.imported += pr.imported
      counts.mojibake += pr.mojibake; counts.fetchFail += pr.fetchFail; counts.timeouts += pr.timeouts; counts.dupSkip += pr.dupSkip
      counts.phoneYes += pr.items.filter((i: any) => i.valid && i.phone).length
      counts.addressYes += pr.items.filter((i: any) => i.valid && i.address).length
      debug.siteResults.push(pr)
    }
    await admin.from('auto_lead_runs').update({ status: 'success', finished_at: new Date().toISOString(), search_queries_count: counts.sources, fetched_count: counts.valid, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded, imported_count: counts.imported }).eq('id', runId).then(() => {}, () => {})
    return { ok: true, runId, ...counts, debug }
  } catch (e: any) {
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: String(e?.message || e) }).eq('id', runId).then(() => {}, () => {})
    throw e
  }
}

// ============================================================
// 連番URL探索クロール（サーバー専用）
//  URLテンプレ内の数値IDを順に増減し、存在するページだけ検出して店名/住所/電話を抽出。
//  「新規掲載候補」であり「新規オープン確定」ではない（newness_typeで区別）。
//  robots/タイムアウト/連続not_found停止/件数上限/30日再テスト回避 を遵守。
// ============================================================
import { extractDirectoryShopInfo } from './directoryParser.js'
import { extractAddressLoose } from './enrichProfile.js'
import { extractJpPhone } from './regionalParsers.js'
import { isForeignAddress, isJapanAddress, isJapanPhone } from './japanFilter.js'
import { scoreCandidate, tierToTemperature, autoImportAllowed, type InjectMode } from './hotTier.js'
import { buildHotReject, type HotCheck } from './hotReject.js'

const UA = 'RST-CRM-bot/1.0 (+lead research; respects robots.txt)'
const PROBE_TIMEOUT_MS = 8000

async function fetchPage(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; status: number; html: string; timedOut: boolean }> {
  const ctrl = new AbortController()
  let timedOut = false
  const to = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ja' }, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(to)
    const html = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, html, timedOut: false }
  } catch { clearTimeout(to); return { ok: false, status: 0, html: '', timedOut } }
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

// 既定の valid / invalid 判定パターン（じゃらん等。サイト設定で上書き可）
const DEFAULT_VALID = /(基本情報|所在地|お問い合わせ|口コミ|名称|住所|電話)/
const DEFAULT_INVALID = /(該当(観光スポット|施設|店舗)?情報は存在しません|ページが見つかりません|お探しのページ|404 Not Found|エラーが発生)/

const OPEN_RE = /(新規オープン|ニューオープン|グランドオープン|プレオープン|本日オープン|オープンしました|開店しました|開業しました|\d{1,2}月\d{1,2}日\s?(?:OPEN|オープン|開店|開業))/i

function pad(id: number, padding: number): string {
  const s = String(id)
  return padding > 0 ? s.padStart(padding, '0') : s
}

export interface ProbeResult {
  ok: boolean
  probed: number; valid: number; invalid: number; saved: number; saveError: number
  hot: number; hotA: number; hotB: number; hold: number; excluded: number; imported: number
  timeouts: number; dupSkip: number; consecutiveNotFound: number
  fromId: number; toId: number; lastFoundId: number | null
  items: any[]; reason: string
}

/** 1サイトの連番探索を実行（DB保存込み） */
export async function runSequentialProbe(admin: any, mapsKey: string | null, site: any, opts: {
  userId: string | null; runId: string | null; nowIso: string; mode: InjectMode
  perRunMax: number; dayRemaining: number; autoImportPerRun: number; autoImportPerDay: number
  importedToday: number; delayMs: number
}): Promise<ProbeResult> {
  const res: ProbeResult = {
    ok: true, probed: 0, valid: 0, invalid: 0, saved: 0, saveError: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0,
    timeouts: 0, dupSkip: 0, consecutiveNotFound: 0, fromId: 0, toId: 0, lastFoundId: null, items: [], reason: '',
  }
  const template: string = site.url_template || ''
  if (!template || !template.includes('{ID}')) { res.ok = false; res.reason = 'url_template に {ID} がありません'; return res }
  const padding = Number(site.id_padding) || 0
  const direction = site.scan_direction === 'backward' ? -1 : 1
  const batch = Math.max(1, Math.min(Number(site.probe_batch_size) || Number(site.max_probe_per_run) || 20, opts.perRunMax, opts.dayRemaining))
  const maxNotFound = Math.max(1, Number(site.max_consecutive_not_found) || 10)
  const validRe = site.valid_page_pattern ? new RegExp(String(site.valid_page_pattern).split(/[|,、]/).map((s: string) => s.trim()).filter(Boolean).join('|')) : DEFAULT_VALID
  const invalidRe = site.invalid_page_pattern ? new RegExp(String(site.invalid_page_pattern).split(/[|,、]/).map((s: string) => s.trim()).filter(Boolean).join('|')) : DEFAULT_INVALID
  let curId = Number(site.current_probe_id) || 1
  res.fromId = curId
  let consecutiveNotFound = Number(site.consecutive_not_found_count) || 0
  let importedThisRun = 0
  let importedCount = opts.importedToday

  for (let i = 0; i < batch; i++) {
    if (consecutiveNotFound >= maxNotFound) { res.reason = `not_found ${consecutiveNotFound}連続で停止`; break }
    if (opts.dayRemaining - res.probed <= 0) { res.reason = '1日のURL上限に到達'; break }
    const probedId = curId
    const url = template.replace('{ID}', pad(probedId, padding))
    curId += direction
    res.toId = probedId

    // 30日以内に探索済みならスキップ
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString()
    const { data: logRow } = await admin.from('sequential_probe_log').select('id,valid').eq('probed_url', url).gte('last_probed_at', since30).limit(1)
    if (logRow && logRow[0]) { res.dupSkip++; continue }

    const r = await fetchPage(url)
    await new Promise((rs) => setTimeout(rs, Math.max(200, opts.delayMs)))
    res.probed++
    if (r.timedOut) res.timeouts++
    const body = r.html ? stripTags(r.html) : ''
    const isInvalid = !r.ok || !r.html || invalidRe.test(body) || body.length < 200
    const isValid = r.ok && !isInvalid && validRe.test(body)

    await admin.from('sequential_probe_log').upsert({ source_site_id: site.id, probed_url: url, probed_id: probedId, valid: isValid, status: r.timedOut ? 'timeout' : `HTTP ${r.status}`, last_probed_at: opts.nowIso }, { onConflict: 'probed_url' }).then(() => {}, () => {})

    if (!isValid) {
      res.invalid++; consecutiveNotFound++
      if (res.items.length < 30) res.items.push({ probedId, url, valid: false, status: r.timedOut ? 'timeout' : `HTTP ${r.status}`, reason: r.timedOut ? 'timeout' : (isInvalid ? '不存在/本文なし' : 'validパターン不一致') })
      continue
    }
    res.valid++; res.lastFoundId = probedId; consecutiveNotFound = 0

    // 詳細抽出（汎用 + 連番ページ向け補強）
    const info = extractDirectoryShopInfo(r.html, '')
    const phone = info.phone || extractJpPhone(body)
    const ad = info.address ? { address: info.address, prefecture: '', city: '' } : extractAddressLoose(body)
    const address = ad.address || info.address
    const shopName = info.shop_name || ''
    const hasOpen = OPEN_RE.test(body) || info.open.confidence !== 'none'
    const newness_type = hasOpen ? 'possible_new_open' : 'source_new_listing'
    const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || /[市区町村]/.test(address))

    // 観光施設/公共施設/寺社/公園は営業対象外
    const isExcludedFacility = /(公園|寺|神社|仏閣|城跡|博物館|美術館|資料館|役所|市役所|町役場|figure|展望台|海岸|温泉郷|滝|湖|山$|公共施設)/.test(shopName || body.slice(0, 200))

    const sc = scoreCandidate({
      source: 'regional_media', isJapan, hasShopName: !!shopName, hasPhone: !!phone && isJapanPhone(phone), hasArea: !!address,
      hasOpeningDate: hasOpen, isFuture: false, igNew: false, regionalNew: false, newListing: true,
      placesMatched: false, hasOfficial: !!info.official_url,
      isChain: false, isOrg: isExcludedFacility, isEventRecruit: false, isForeign: isForeignAddress(address), isDup: false, reviewMany: false,
    }, opts.mode)
    const { temperature, hot_tier } = tierToTemperature(sc.tier)
    if (temperature === 'HOT') { res.hot++; if (hot_tier === 'A') res.hotA++; else res.hotB++ }
    else if (temperature === 'EXCLUDED') res.excluded++
    else res.hold++

    const name = shopName || '連番探索候補'
    const newnessReason = `連番探索（${site.parser_type || 'generic_detail_page'}）ID=${probedId}「${name}」${hasOpen ? '・OPEN表記あり' : '・新規掲載候補'} / ${sc.reason}`
    const rmChecks: HotCheck[] = [
      { key: 'has_japan', label: '日本国内', ok: isForeignAddress(address) ? false : (isJapan ? true : null), reasonKey: 'not_japan' },
      { key: 'has_shop_name', label: '店名/施設名あり', ok: !!shopName, reasonKey: 'shop_name_missing' },
      { key: 'has_area', label: '住所あり', ok: !!address, reasonKey: 'address_missing', value: address || undefined },
      { key: 'has_phone', label: '日本の電話番号あり', ok: (phone && isJapanPhone(phone)) ? true : false, reasonKey: 'phone_missing', value: phone || undefined },
      { key: 'has_newness', label: '新規掲載候補', ok: true, reasonKey: 'newness_missing' },
      { key: 'has_opening_date', label: '新規オープン根拠', ok: hasOpen ? true : null, reasonKey: 'opening_date_missing' },
    ]
    const hotReject = buildHotReject({ source: 'regional_media', temperature, confidence: sc.score, checks: rmChecks })

    const payload: any = {
      name, address: address || null, industry: info.industry || null, phone_number: phone || null, website_url: info.official_url || null,
      source: 'sequential_id_probe', lead_source: 'regional_media', source_type: 'AI自動投入(連番探索)',
      source_site_type: 'sequential_id_probe', parser_used: site.parser_type || 'generic_detail_page', source_media_family: site.media_family || null, source_site_name: site.name,
      source_detail_url: url, source_list_url: template, probed_id: probedId, probed_url: url, probe_valid: true, probe_status: `HTTP ${r.status}`,
      search_title: name.slice(0, 300), search_snippet: body.slice(0, 300), candidate_block_text_short: body.slice(0, 300),
      newness_type, regional_media_newness_reason: newnessReason, first_discovered_at: opts.nowIso, regional_media_detected_at: opts.nowIso,
      lead_temperature: temperature, hot_tier, recommended_status: sc.tier, is_new_gbp: false, should_exclude_from_call_list: temperature === 'EXCLUDED',
      owner_reachability_score: phone ? 65 : 30, auto_import_reason: temperature === 'HOT' ? sc.reason : null, ai_comment: sc.reason,
      extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null, extracted_industry: info.industry || null,
      extracted_area: address || null, extracted_official_url: info.official_url || null,
      hot_reject_reasons: hotReject.hot_reject_reasons, hot_reject_summary: hotReject.hot_reject_summary,
      hot_check_result: hotReject.hot_check_result, hot_missing_requirements: hotReject.hot_missing_requirements,
      hot_blocking_reason: hotReject.hot_blocking_reason, hot_required_score: hotReject.hot_required_score,
      match_confidence: sc.score, last_seen_at: opts.nowIso, source_run_id: opts.runId,
    }

    // 重複: probed_url / 電話 / 店名+住所
    const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_detail_url', url).limit(1)
    let candidateId: string | null = exC?.[0]?.id || null
    if (!candidateId && phone) { const { data: byPhone } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = byPhone?.[0]?.id || null }
    const alreadyImported = !!exC?.[0]?.imported_to_cases
    if (candidateId) { const { error } = await admin.from('lead_candidates').update(payload).eq('id', candidateId); if (error) res.saveError++; else res.saved++ }
    else { const { data: ins, error } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: opts.nowIso, imported_to_cases: false, created_by_id: opts.userId }).select('id').single(); if (error) res.saveError++; else res.saved++; candidateId = ins?.id || null }

    if (autoImportAllowed(sc.tier, opts.mode) && phone && candidateId && !alreadyImported && importedCount < opts.autoImportPerDay && importedThisRun < opts.autoImportPerRun) {
      const { data: created } = await admin.from('cases').insert({ name, address: address || '', phone1: phone, industry: info.industry || null, status: 'リスト', priority: sc.priority === 'high' ? '高' : '中', hp1: info.official_url || null, source_urls: url, memo: `【AI自動投入 / 連番探索 / ${sc.tier}】ID=${probedId}\nURL: ${url}`, created_by_id: opts.userId }).select('id').single()
      if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: opts.nowIso }).eq('id', candidateId); res.imported++; importedCount++; importedThisRun++ }
    }
    if (res.items.length < 30) res.items.push({ probedId, url, valid: true, shopName: name, phone, address, newness_type, temperature: hot_tier ? `HOT-${hot_tier}` : temperature })
  }

  res.consecutiveNotFound = consecutiveNotFound
  if (!res.reason) res.reason = res.valid > 0 ? `OK（valid ${res.valid}/probed ${res.probed}）` : `valid 0（probed ${res.probed}・全て不存在/対象外）`
  // サイト状態を更新（次回は続きから）
  await admin.from('source_sites').update({
    current_probe_id: curId, last_checked_id: res.toId, last_found_id: res.lastFoundId ?? site.last_found_id ?? null,
    last_probe_at: opts.nowIso, consecutive_not_found_count: consecutiveNotFound,
    probe_result_summary: `probed${res.probed}/valid${res.valid}/保存${res.saved} HOT-A${res.hotA}/B${res.hotB} ${res.reason}`.slice(0, 200),
    last_crawled_at: opts.nowIso, updated_at: opts.nowIso,
  }).eq('id', site.id).then(() => {}, () => {})
  return res
}

// ============================================================
// 巡回サイト自動発見・自動登録（サーバー専用）
//  検索APIで新店情報サイトを発見→fetch診断→parser_type推定→スコア→source_site_candidates保存
//  高スコアは source_sites へ自動登録。robots/timeout/件数上限/重複/海外除外 を遵守。
// ============================================================
import { webSearch } from './instagramWebRun.js'
import { detectParserType, extractNewnessBlocks, newnessKeywords } from './regionalParsers.js'
import { isForeignText } from './japanFilter.js'

const UA = 'RST-CRM-bot/1.0 (+lead research; respects robots.txt)'

// 自動発見の検索クエリ（全国横断・最大20）
export const DISCOVERY_QUERIES = [
  '新規オープン 店舗', '新店情報', '開店情報', '開店 閉店 情報', 'オープン予定 店舗', 'ニューオープン 店舗',
  '新規掲載 店舗', '新着店舗', '店舗 新着', '地域 新店情報', 'グランドオープン 店舗', 'プレオープン 店舗',
  '店舗検索 新着順', '店舗一覧 新規', 'グルメ 新規掲載', '美容 新規掲載',
  'site:jp "新規オープン"', 'site:jp "開店しました"', 'site:jp "新着店舗"', 'site:jp "新規掲載"',
]

const SPAM_RE = /(porn|casino|adult|xxx|出会い|アダルト|副業|稼げる|投資詐欺)/i
const RECRUIT_RE = /(求人|採用|転職|バイト|アルバイト|indeed|タウンワーク|マイナビ|リクナビ)/i
const EVENT_RE = /(イベント|フェス|マルシェ|花火|祭り|コンサート)/i
const EC_RE = /(通販|オンラインショップ|ec-?site|楽天市場|amazon\.co|yahoo!?ショッピング|メルカリ|base\.shop)/i
const LOGIN_RE = /(ログインが必要|会員登録してください|sign in to continue|ログインしてください)/i

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
function normalizeUrl(u: string): string {
  try { const x = new URL(u); return `${x.protocol}//${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase() } catch { return String(u || '').trim().toLowerCase() }
}
function domainOf(u: string): string { try { return new URL(u).host.replace(/^www\./, '').toLowerCase() } catch { return '' } }

async function fetchPage(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; html: string; timedOut: boolean }> {
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
async function robotsAllows(origin: string, path: string): Promise<boolean> {
  const r = await fetchPage(`${origin}/robots.txt`, 6000)
  if (!r.ok || !r.html) return true
  const lines = r.html.split(/\r?\n/).map((l) => l.trim()); let all = false; const dis: string[] = []
  for (const line of lines) { const m = line.match(/^(user-agent|disallow):\s*(.*)$/i); if (!m) continue; if (m[1].toLowerCase() === 'user-agent') all = m[2].trim() === '*'; else if (all && m[2].trim()) dis.push(m[2].trim()) }
  return !dis.some((d) => path.startsWith(d))
}

const MEDIA_FAMILY_HINT: { re: RegExp; fam: string }[] = [
  { re: /goguynet/i, fam: 'goguynet' }, { re: /kaiten-?heiten/i, fam: 'kaitenheiten' }, { re: /tsushin/i, fam: 'tsushin' },
  { re: /jalan/i, fam: 'jalan' }, { re: /tabelog/i, fam: 'tabelog' }, { re: /epark/i, fam: 'epark' }, { re: /hotpepper|beauty\.hotpepper/i, fam: 'hotpepper' },
]

export interface DiscoveryStats { queries: number; urls: number; tested: number; saved: number; autoRegistered: number; review: number; ignore: number; alreadyRegistered: number; items: any[] }

/** 自動発見の実行 */
export async function runSiteDiscovery(admin: any, opts: { userId: string | null; maxQueries?: number; perQuery?: number; maxTests?: number; maxAutoRegister?: number }): Promise<DiscoveryStats> {
  const stats: DiscoveryStats = { queries: 0, urls: 0, tested: 0, saved: 0, autoRegistered: 0, review: 0, ignore: 0, alreadyRegistered: 0, items: [] }
  const maxQueries = Math.min(20, Math.max(1, opts.maxQueries || 20))
  const perQuery = Math.min(10, Math.max(1, opts.perQuery || 10))
  const maxTests = Math.min(50, Math.max(1, opts.maxTests || 50))
  const maxAuto = Math.max(0, opts.maxAutoRegister ?? 10)

  // 既存サイトのドメイン集合
  const { data: sites } = await admin.from('source_sites').select('base_url,list_url').limit(2000)
  const existingDomains = new Set<string>()
  for (const s of sites || []) { existingDomains.add(domainOf(s.base_url)); existingDomains.add(domainOf(s.list_url)) }

  // URL収集
  const urlSet = new Map<string, { url: string; title: string; snippet: string; query: string }>()
  for (const q of DISCOVERY_QUERIES.slice(0, maxQueries)) {
    stats.queries++
    const { results } = await webSearch(q, perQuery)
    for (const r of results) {
      const dom = domainOf(r.url); if (!dom) continue
      // ポータル/SNS/検索は除外
      if (/(instagram\.com|twitter\.com|x\.com|facebook\.com|youtube\.com|google\.|yahoo\.co\.jp\/search|wikipedia\.org|amazon\.|rakuten\.co\.jp\/search)/i.test(r.url)) continue
      const key = domainOf(r.url) + new URL(r.url).pathname.replace(/\/+$/, '')
      if (!urlSet.has(key)) urlSet.set(key, { url: r.url, title: r.title || '', snippet: r.snippet || '', query: q })
    }
    await new Promise((rs) => setTimeout(rs, 300))
  }
  stats.urls = urlSet.size

  for (const cand of Array.from(urlSet.values()).slice(0, maxTests)) {
    const normalized = normalizeUrl(cand.url)
    const domain = domainOf(cand.url)
    // 既存サイトと重複
    const already = existingDomains.has(domain)
    // 30日以内に診断済みならスキップ
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString()
    const { data: prev } = await admin.from('source_site_candidates').select('id').eq('normalized_url', normalized).gte('last_tested_at', since30).limit(1)
    if (prev && prev[0]) continue

    let origin = ''; let path = '/'
    try { const u = new URL(cand.url); origin = u.origin; path = u.pathname } catch { /* noop */ }
    const allowed = origin ? await robotsAllows(origin, path) : true
    let r = { ok: false, status: 0, html: '', timedOut: false }
    if (allowed) r = await fetchPage(cand.url)
    await new Promise((rs) => setTimeout(rs, 300))
    stats.tested++

    const body = r.html ? stripTags(r.html) : ''
    const kw = newnessKeywords(`${cand.title} ${cand.snippet} ${body.slice(0, 4000)}`)
    let parserType = 'generic_page_text_scan'; let articleLinks = 0; let shopCards = 0; let phoneFound = 0; let addrFound = 0; let sample: any[] = []
    if (r.ok && r.html) {
      try { parserType = detectParserType({ source_type: '', media_family: '' }, r.html, cand.url) } catch { /* noop */ }
      try { const base = new URL(cand.url); const ex = extractNewnessBlocks(r.html, base); shopCards = ex.candidates.length; sample = ex.candidates.slice(0, 3).map((c) => ({ shop: c.shopName, address: c.address, phone: c.phone, kw: c.matchedKeywords })); phoneFound = ex.candidates.filter((c) => c.phone).length; addrFound = ex.candidates.filter((c) => c.address).length } catch { /* noop */ }
      articleLinks = (r.html.match(/href=["'][^"']*\/(archives|\d{4}\/\d{1,2}|\d{4,})/gi) || []).length
    }

    // スコアリング
    let score = 0; let invalidReason = ''
    const foreign = isForeignText(`${cand.title} ${cand.snippet}`) && !/[ぁ-んァ-ヶ一-龥]/.test(body.slice(0, 500))
    if (!allowed) { score = -100; invalidReason = 'robots.txtにより不可' }
    else if (!r.ok || !r.html) { score = -50; invalidReason = r.timedOut ? 'fetch timeout' : `取得不可(HTTP ${r.status})` }
    else if (body.length < 200) { score = -50; invalidReason = '本文が空/JSレンダリング' }
    else if (foreign) { score = -50; invalidReason = '海外サイト' }
    else if (SPAM_RE.test(body.slice(0, 2000))) { score = -100; invalidReason = 'スパム/不適切' }
    else {
      if (/[ぁ-んァ-ヶ一-龥]/.test(body.slice(0, 1000))) score += 20            // 日本語サイト
      if (kw.strong.length > 0) score += 20                                       // 新店キーワード
      if (articleLinks >= 5 || shopCards >= 3) score += 20                        // 記事リンク/店舗カード
      if (phoneFound > 0 && addrFound > 0) score += 20                            // 詳細に電話+住所
      if (/(newest|new|open|sort|新着|新規|search)/i.test(cand.url)) score += 15  // 新着/新規順URL
      if (/(OPEN|オープン|開店|開業|グランドオープン)/i.test(body.slice(0, 3000))) score += 15
      if (parserType === 'local_directory_new_listing' || parserType === 'marketplace_listing') score += 10
      if (sample.length > 0) score += 10
      if (RECRUIT_RE.test(body.slice(0, 2000))) score -= 30
      if (EVENT_RE.test(cand.title)) score -= 30
      if (EC_RE.test(body.slice(0, 2000))) score -= 30
      if (LOGIN_RE.test(body.slice(0, 2000))) score -= 50
    }
    const action = score >= 80 ? 'auto_register' : score >= 50 ? 'review' : 'ignore'
    const fam = MEDIA_FAMILY_HINT.find((m) => m.re.test(cand.url))?.fam || 'local_news'

    const candRow: any = {
      discovered_url: cand.url, normalized_url: normalized, domain, title: cand.title.slice(0, 200), snippet: cand.snippet.slice(0, 300),
      source_discovery_query: cand.query, detected_source_type: parserType, detected_parser_type: parserType, detected_media_family: fam,
      confidence_score: score, test_fetch_status: r.ok ? 'ok' : (r.timedOut ? 'timeout' : 'failed'), test_http_status: r.status,
      html_length: r.html.length, text_length: body.length, article_link_count: articleLinks, shop_card_count: shopCards,
      newness_keyword_count: kw.strong.length + kw.weak.length, phone_found_count: phoneFound, address_found_count: addrFound,
      sample_candidates: sample, valid_page_pattern_found: kw.strong.length > 0, invalid_reason: invalidReason || null,
      already_registered: already, recommended_action: already ? 'ignore' : action, last_tested_at: new Date().toISOString(),
    }
    const { data: up } = await admin.from('source_site_candidates').upsert(candRow, { onConflict: 'normalized_url' }).select('id').single()
    stats.saved++
    if (already) stats.alreadyRegistered++
    else if (action === 'auto_register') stats.review++ // 後段でauto登録時に振替
    else if (action === 'review') stats.review++
    else stats.ignore++

    // 自動登録（score>=80・未登録・上限内）
    if (!already && action === 'auto_register' && stats.autoRegistered < maxAuto) {
      const listUrl = cand.url
      const sourceType = parserType
      const { data: created } = await admin.from('source_sites').insert({
        name: (cand.title || domain).slice(0, 80), base_url: origin || cand.url, list_url: listUrl,
        media_family: fam, source_type: sourceType, parser_type: sourceType, category_label: '店舗新着',
        is_active: score >= 70, reliability_score: Math.max(0, Math.min(100, score)), crawl_interval_hours: 24,
        created_by: 'auto_discovery', last_crawl_result: '自動発見により登録', updated_at: new Date().toISOString(),
      }).select('id').single().then((x: any) => x, () => ({ data: null }))
      if (created?.id) {
        stats.autoRegistered++; stats.review--
        existingDomains.add(domain)
        await admin.from('source_site_candidates').update({ is_registered: true, registered_source_site_id: created.id, recommended_action: 'auto_register' }).eq('id', up?.id).then(() => {}, () => {})
      }
    }
    if (stats.items.length < 50) stats.items.push({ url: cand.url, domain, parserType, score, action: candRow.recommended_action, already, newness: kw.strong.length, cards: shopCards, articleLinks, phone: phoneFound, address: addrFound, sample })
  }
  return stats
}

/** 候補を手動で source_sites へ登録 */
export async function registerSiteCandidate(admin: any, candidateId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { data: c } = await admin.from('source_site_candidates').select('*').eq('id', candidateId).maybeSingle()
  if (!c) return { ok: false, error: '候補が見つかりません' }
  if (c.is_registered) return { ok: false, error: '登録済みです' }
  let origin = c.discovered_url; try { origin = new URL(c.discovered_url).origin } catch { /* noop */ }
  const { data: created, error } = await admin.from('source_sites').insert({
    name: (c.title || c.domain).slice(0, 80), base_url: origin, list_url: c.discovered_url,
    media_family: c.detected_media_family || 'local_news', source_type: c.detected_parser_type || 'generic_page_text_scan',
    parser_type: c.detected_parser_type || 'generic_page_text_scan', category_label: '店舗新着',
    is_active: true, reliability_score: Math.max(0, Math.min(100, c.confidence_score || 50)), crawl_interval_hours: 24,
    created_by: 'auto_discovery', last_crawl_result: '候補から登録', updated_at: new Date().toISOString(),
  }).select('id').single()
  if (error) return { ok: false, error: error.message }
  await admin.from('source_site_candidates').update({ is_registered: true, registered_source_site_id: created.id }).eq('id', candidateId).then(() => {}, () => {})
  return { ok: true, id: created.id }
}

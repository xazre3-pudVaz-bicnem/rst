// ============================================================
// 地域情報サイト巡回ロジック（サーバー専用）
// robots.txt尊重・レート制限・同一URL再取得回避。記事本文は保存しない。
// 新店系記事 → 抽出 → 任意でPlaces照合 → HOT/HOLD/EXCLUDED → HOTのみcases投入。
// ============================================================
import { classifyLead } from './leadScoring.js'
import { DEFAULT_STATUS } from './constants.js'
import { searchLight, placeDetails, phoneOf, reviewDates, parseOpeningDate } from './googlePlacesRun.js'
import { extractFromArticle, isOpenTitle, urlHash } from './regionalExtract.js'
import { isForeignAddress, isForeignText, isJapanAddress, isJapanPhone } from './japanFilter.js'
import { buildHotReject, type HotCheck } from './hotReject.js'
import { extractDirectoryListingLinks, extractDirectoryShopInfo, classifyDirectoryCandidate, extractOpeningDateFromText } from './directoryParser.js'
import { detectParserType, extractNewnessBlocks, parseHorbyCards, parseHorbyDetail, parseGoguynetShopInfo, extractMainContent, sanitizeShopName, extractShopFromTitle, isValidJpPhone, isTollFreeJp } from './regionalParsers.js'
import { autoImportAllowed, scoreCandidate, tierToTemperature, type InjectMode, type HotTier } from './hotTier.js'
import { detectChain } from './chainFilter.js'
import { detectBigOrPublic, detectBigOrPublicStrong, detectMultiStore, looksLikeBranchStore } from './targetFilter.js'
import { looksLikeArticle as looksLikeArticleText, isRealStoreAddress } from './leadQuality.js'
// Instagram Web検索と共通の外部情報補完ロジックを再利用
import { enrichCandidate } from './instagramWebRun.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { findCaseIdByPhone } from './caseDedup.js'
import { caseImportGate, applyGateDowngrade } from './importGate.js'

// サイトのタイプを正規化（記事型 / 店舗ディレクトリ型 / ハイブリッド）
export function siteTypeOf(site: any): 'local_directory_new_listing' | 'openclose_article' | 'hybrid' {
  const t = String(site?.source_type || '')
  if (t === 'local_directory_new_listing') return 'local_directory_new_listing'
  if (t === 'hybrid') return 'hybrid'
  // 旧データ互換: media_family / category で店舗ディレクトリ判定
  if (['saikohkunavi', 'local_directory'].includes(String(site?.media_family || '')) || /店舗新着|店舗情報/.test(String(site?.category_label || ''))) return 'local_directory_new_listing'
  return 'openclose_article'
}

export function getDefaultRegionalSettings() {
  return {
    regionalEnabled: true,
    maxSitesPerDay: 3,
    maxArticlesPerSite: 5,
    // 504回避: 実行全体の時間予算と詳細取得の上限（続きは次回実行に回す）
    runBudgetMs: 50000,            // Vercel maxDuration 60s に対する安全マージン
    maxDetailFetchesPerRun: 20,    // 1回の巡回で詳細ページは最大20件
    periodDays: 30,
    saveDays: 3,        // lead_candidates へ保存する公開日の上限（既定3日以内）
    requirePhone: true,
    dailyCap: 30,
    fetchDelayMs: 800,
    // 外部情報補完（IWと共通）
    regionalEnrichEnabled: true,
    regionalEnrichMaxQueries: 3,
    regionalEnrichPerQuery: 5,
    regionalEnrichDailyCap: 100,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// 多くのローカルメディアが未知のbot UAを既定WAFで403にするため、実在ブラウザUAで一覧記事を取得する（robots.txtは別途遵守・記事本文は保存しない）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// fetchタイムアウト: 一覧ページは長め、詳細ページは短め（504回避）
const LIST_TIMEOUT_MS = 12000
const DETAIL_TIMEOUT_MS = 7000

async function fetchHtml(url: string, timeoutMs = LIST_TIMEOUT_MS): Promise<{ ok: boolean; status: number; html: string; length: number; error: string | null; timedOut: boolean }> {
  const ctrl = new AbortController()
  let timedOut = false
  const to = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.8' }, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(to)
    const ct = res.headers.get('content-type') || ''
    if (!res.ok) return { ok: false, status: res.status, html: '', length: 0, error: `HTTP ${res.status}`, timedOut: false }
    if (ct && !/text|html|xml|json/i.test(ct)) return { ok: false, status: res.status, html: '', length: 0, error: `非HTML(${ct})`, timedOut: false }
    const html = await res.text()
    return { ok: true, status: res.status, html, length: html.length, error: null, timedOut: false }
  } catch (e: any) {
    clearTimeout(to)
    return { ok: false, status: 0, html: '', length: 0, error: timedOut ? `timeout(${timeoutMs}ms・外部サイト応答遅延)` : String(e?.message || e).slice(0, 120), timedOut }
  }
}

async function fetchText(url: string, timeoutMs = LIST_TIMEOUT_MS): Promise<string | null> {
  const r = await fetchHtml(url, timeoutMs)
  return r.ok ? r.html : null
}

// ===== JSレンダリング取得（外部レンダリングAPI経由。Vercel上でPlaywrightは使えないため）=====
// 環境変数:
//   RENDER_PROVIDER … 'scrapingbee' | 'scraperapi' | 'render_api_url'（未指定なら設定済みのものを自動選択）
//   SCRAPINGBEE_API_KEY … ScrapingBee（render_js=true・JS描画後HTML）
//   SCRAPERAPI_KEY      … ScraperAPI（render=true）
//   RENDER_API_URL      … {url} を含む汎用テンプレ（例: https://my-renderer/render?url={url}&wait=8000）
export function renderConfigured(): boolean {
  return !!(process.env.SCRAPINGBEE_API_KEY || process.env.SCRAPERAPI_KEY || process.env.RENDER_API_URL)
}
function pickRenderProvider(): string {
  const p = String(process.env.RENDER_PROVIDER || '').toLowerCase()
  if (p === 'scrapingbee' && process.env.SCRAPINGBEE_API_KEY) return 'scrapingbee'
  if (p === 'scraperapi' && process.env.SCRAPERAPI_KEY) return 'scraperapi'
  if (p === 'render_api_url' && process.env.RENDER_API_URL) return 'render_api_url'
  // 自動選択（ScrapingBee優先）
  if (process.env.SCRAPINGBEE_API_KEY) return 'scrapingbee'
  if (process.env.SCRAPERAPI_KEY) return 'scraperapi'
  if (process.env.RENDER_API_URL) return 'render_api_url'
  return 'none'
}
/** renderPage(url): JS描画後HTMLを取得（共通関数）。未設定ならエラーで落とさず configured:false を返す。 */
export async function renderPage(url: string, opts: { waitMs?: number; timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; html: string; length: number; error: string | null; configured: boolean; provider: string }> {
  const provider = pickRenderProvider()
  if (provider === 'none') return { ok: false, status: 0, html: '', length: 0, error: 'SCRAPINGBEE_API_KEY 未設定のためJSレンダリング取得不可（RENDER_PROVIDER=scrapingbee）', configured: false, provider: 'none' }
  const waitMs = Math.max(0, Math.min(20000, opts.waitMs ?? 8000))
  const timeoutMs = opts.timeoutMs ?? 30000
  let target = ''
  if (provider === 'scrapingbee') target = `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_API_KEY}&render_js=true&wait=${waitMs}&url=${encodeURIComponent(url)}`
  else if (provider === 'scraperapi') target = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&render=true&url=${encodeURIComponent(url)}`
  else target = process.env.RENDER_API_URL!.includes('{url}') ? process.env.RENDER_API_URL!.replace('{url}', encodeURIComponent(url)) : `${process.env.RENDER_API_URL}${process.env.RENDER_API_URL!.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`
  const ctrl = new AbortController(); let timedOut = false
  const to = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  try {
    const res = await fetch(target, { headers: { Accept: 'text/html' }, signal: ctrl.signal })
    clearTimeout(to)
    const html = await res.text()
    if (!res.ok) return { ok: false, status: res.status, html: '', length: 0, error: `レンダリングAPI HTTP ${res.status}（${String(html).slice(0, 80)}）`, configured: true, provider }
    return { ok: true, status: res.status, html, length: html.length, error: null, configured: true, provider }
  } catch (e: any) { clearTimeout(to); return { ok: false, status: 0, html: '', length: 0, error: timedOut ? 'レンダリングAPIタイムアウト' : String(e?.message || e).slice(0, 120), configured: true, provider } }
}
// 後方互換のエイリアス
const renderFetch = renderPage

/** カードに href が無くJSクリックでしか詳細へ行けないサイト用（HORBY等）。一覧の n番目カードをクリック→詳細ページへ遷移→描画後HTML＋解決URLを取得。
 *  公開の詳細ページへ実クリック遷移するのみ（要ログインAPIや認証突破はしない）。ScrapingBee js_scenario が必要。
 *  cardSelector/linkSelector は source_sites の card_selector / detail_click_selector で設定駆動。 */
async function renderClickDetail(listUrl: string, cardIndex: number, cardSelector: string, linkSelector: string, opts: { waitListMs?: number; waitDetailMs?: number; timeoutMs?: number } = {}): Promise<{ ok: boolean; html: string; resolvedUrl: string; error: string | null }> {
  if (!process.env.SCRAPINGBEE_API_KEY) return { ok: false, html: '', resolvedUrl: '', error: 'scrapingbee未設定（クリック遷移にはScrapingBeeが必要）' }
  const sel = `${cardSelector}:nth-child(${cardIndex}) ${linkSelector}`.trim()
  const scenario = JSON.stringify({ instructions: [{ wait: opts.waitListMs ?? 7000 }, { click: sel }, { wait: opts.waitDetailMs ?? 9000 }] })
  const target = `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_API_KEY}&render_js=true&js_scenario=${encodeURIComponent(scenario)}&url=${encodeURIComponent(listUrl)}`
  const ctrl = new AbortController(); let timedOut = false
  const to = setTimeout(() => { timedOut = true; ctrl.abort() }, opts.timeoutMs ?? 30000)
  try {
    const res = await fetch(target, { headers: { Accept: 'text/html' }, signal: ctrl.signal })
    clearTimeout(to)
    const html = await res.text()
    const resolvedUrl = res.headers.get('spb-resolved-url') || res.headers.get('Spb-Resolved-Url') || ''
    if (!res.ok) return { ok: false, html: '', resolvedUrl: '', error: `HTTP ${res.status}` }
    return { ok: true, html, resolvedUrl, error: null }
  } catch (e: any) { clearTimeout(to); return { ok: false, html: '', resolvedUrl: '', error: timedOut ? 'timeout' : String(e?.message || e).slice(0, 100) } }
}

// ログイン制限で非公開の情報を示す表記（電話/メール等が会員限定の場合）
const LOGIN_GATED_RE = /(ログイン後に表示|会員のみ|会員限定|登録後に表示|予約後に表示|非公開|ログインが必要|login\s*required|members?\s*only)/i

/** 詳細ページ取得（全サイト共通）。mode: static=通常fetch / browser=最初からレンダリング / auto=本文が薄い/失敗時のみレンダリングfallback。 */
async function fetchDetailPage(url: string, mode: string, timeoutMs = DETAIL_TIMEOUT_MS): Promise<{ ok: boolean; html: string; rendered: boolean; status: number; error: string | null }> {
  if (mode === 'browser') {
    const r = await renderPage(url, { waitMs: 6000, timeoutMs: Math.min(28000, timeoutMs + 18000) })
    return { ok: r.ok, html: r.html, rendered: true, status: r.status, error: r.error }
  }
  const stat = await fetchHtml(url, timeoutMs)
  if (mode === 'static') return { ok: stat.ok, html: stat.html, rendered: false, status: stat.status, error: stat.error }
  // auto: 本文が薄い/取得失敗 かつ レンダリング設定あり → fallback
  const bodyLen = stat.ok && stat.html ? stripTags(stat.html).length : 0
  if (stat.ok && bodyLen >= 600) return { ok: true, html: stat.html, rendered: false, status: stat.status, error: null }
  if (renderConfigured()) {
    const r = await renderPage(url, { waitMs: 6000, timeoutMs: 28000 })
    if (r.ok && r.html) return { ok: true, html: r.html, rendered: true, status: r.status, error: null }
    return { ok: stat.ok, html: stat.html, rendered: false, status: stat.status, error: r.error || stat.error }
  }
  return { ok: stat.ok, html: stat.html, rendered: false, status: stat.status, error: stat.error }
}

/** robots.txt の User-agent:* で path が Disallow されていないか（簡易） */
async function robotsAllows(origin: string, path: string): Promise<boolean> {
  const txt = await fetchText(`${origin}/robots.txt`, 6000)
  if (!txt) return true // 取得不可なら許可とみなす（その代わりレート制限を守る）
  const lines = txt.split(/\r?\n/).map((l) => l.trim())
  let appliesToAll = false
  const disallows: string[] = []
  for (const line of lines) {
    const m = line.match(/^(user-agent|disallow):\s*(.*)$/i)
    if (!m) continue
    if (m[1].toLowerCase() === 'user-agent') appliesToAll = m[2].trim() === '*'
    else if (m[1].toLowerCase() === 'disallow' && appliesToAll && m[2].trim()) disallows.push(m[2].trim())
  }
  return !disallows.some((d) => path.startsWith(d))
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

interface LinkOpts { mediaFamily?: string; categoryLabel?: string; listUrl?: string }

/** 開店/閉店・新店系のソースか（記事URLっぽければアンカー文言不問で拾う） */
function isOpenCloseContext(o: LinkOpts): boolean {
  const fam = o.mediaFamily || ''
  if (['goguynet', 'kaitenheiten', 'tsushin', 'local_news'].includes(fam)) return true
  if (['開店閉店', '新店情報'].includes(o.categoryLabel || '')) return true
  if (/open|close|kaiten|heiten|shinten|newopen|cat_/i.test(o.listUrl || '')) return true
  return false
}

// ナビ/インデックス系パス。記事URLと構造が同じ（例: 開店閉店.comの /area-open/ は実記事 /shinjuku-kokoro/ と
// 同じ「単一の英字スラッグ」）ため、looksLikeArticle のスラッグ判定だけでは弾けず明示的に除外する。
// これを許すと一覧の先頭にナビが並び、(a)記事予算を食い潰し (b)差分巡回カーソルがナビURL（不変）に固定され
// 2回目以降の巡回が即breakして恒久0件になる。
const EXCLUDE_PATH = /\/(category|tag|author|page|search|feed|amp|wp-admin|wp-content|wp-json|wp-login|about|contact|privacy|policy|sitemap|ranking|login|mypage|profile|terms|company|recruit|area-open|area-close|area-list|shop-list|store-list|[a-z-]*gyousyubetsu|[a-z-]*gyoshubetsu)\b/i

/** パスが個別記事URLっぽいか（号外NETの数字ID・WPの日本語/英字slug 等） */
function looksLikeArticle(pathname: string): boolean {
  if (pathname === '/' || pathname.length < 2) return false
  if (EXCLUDE_PATH.test(pathname)) return false
  if (/\/archives\/\d+/i.test(pathname)) return true        // WP /archives/123
  if (/\/\d{4}\/\d{1,2}\//.test(pathname)) return true       // /2026/06/...
  if (/\/\d{4,}(\/|\.html?)?$/.test(pathname)) return true   // 号外NET 数字ID /123456
  if (/-[a-z0-9-]{4,}/i.test(pathname)) return true          // 英字スラッグ
  if (/%[0-9a-f]{2}/i.test(pathname)) return true            // %エンコード日本語スラッグ(WP)
  try { if (/[ぁ-んァ-ヶ一-龥]/.test(decodeURIComponent(pathname))) return true } catch { /* noop */ }
  return false
}

/** リストページから記事リンクを抽出（メディア別）。total/candidate も返す */
function extractArticleLinks(html: string, base: URL, opts: LinkOpts = {}): { links: { url: string; title: string }[]; totalLinks: number; candidateLinks: number; keywordHits: number } {
  const out: { url: string; title: string }[] = []
  const seen = new Set<string>()
  const openCtx = isOpenCloseContext(opts)
  let totalLinks = 0
  let keywordHits = 0
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    totalLinks++
    const href = m[1]
    const title = stripTags(m[2]).slice(0, 140)
    let abs: URL
    try { abs = new URL(href, base) } catch { continue }
    // 同一ホスト or 同一サイトの別サブドメイン（goguynetの地域別など）
    const sameHost = abs.host === base.host
    const rootOf = (h: string) => h.split('.').slice(-2).join('.')
    const sameRoot = rootOf(abs.host) === rootOf(base.host)
    if (!sameHost && !sameRoot) continue
    // 地域サブドメイン（katsushika.goguynet.jp 等）から見た apex（goguynet.jp）はポータルの
    // 都道府県ナビの塊で記事ではない。sameRootで通すと /aomori-iwate-miyagi/ 等が一覧先頭を占拠し、
    // 記事予算の消費と差分巡回カーソルの汚染（＝恒久0件）を招くため除外する。
    if (!sameHost && sameRoot && abs.host === rootOf(abs.host) && base.host !== rootOf(base.host)) continue
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue
    const articleLike = looksLikeArticle(abs.pathname)
    const titleOpen = title.length >= 4 && isOpenTitle(title)
    if (titleOpen) keywordHits++
    // 開店閉店系ソースは「記事URLっぽい」だけで採用（アンカー文言不問）。それ以外は文言一致必須。
    const accept = openCtx ? (articleLike || titleOpen) : (titleOpen && (articleLike || title.length >= 8))
    if (!accept) continue
    const key = abs.origin + abs.pathname
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: abs.toString(), title })
  }
  return { links: out, totalLinks, candidateLinks: out.length, keywordHits }
}

function articleMeta(html: string): { published_at: string | null; excerpt: string; title: string } {
  let published_at: string | null = null
  const pub = html.match(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+(?:itemprop|name)=["'](?:datePublished|pubdate)["'][^>]*content=["']([^"']+)["']/i)
  if (pub && !Number.isNaN(Date.parse(pub[1]))) published_at = new Date(pub[1]).toISOString()
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
  const tt = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = stripTags((og ? og[1] : tt ? tt[1] : '')).slice(0, 160)
  const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i)
  const excerpt = (desc ? desc[1] : stripTags(html).slice(0, 300)).slice(0, 300)
  return { published_at, excerpt, title }
}

function matchConfidence(shop: string, placeName: string): number {
  if (!shop || !placeName) return 0
  const norm = (s: string) => s.replace(/[\s　・,.。、（）()【】\[\]『』「」]/g, '')
  const a = norm(shop), b = norm(placeName)
  if (!a || !b) return 0
  if (a === b) return 100
  if (b.includes(a) || a.includes(b)) return 80
  return 0
}

export async function runRegionalMedia(admin: any, mapsKey: string | null, rawSettings: any, userId: string | null) {
  const s = { ...getDefaultRegionalSettings(), ...(rawSettings || {}) }
  const recentDays = Math.max(1, Number(s.saveDays) || 3)
  const recentMs = recentDays * 86400000
  // 実行モード: test=3件 / all=有効全件（バッチ分割で完走）/ priority=信頼度順 / selected=指定のみ
  const runMode: string = ['test', 'all', 'priority', 'selected'].includes(s.runMode) ? s.runMode : 'all'
  const batchSites = Math.max(1, Number(s.batchSites) || 8)  // 1バッチのサイト数（Vercelタイムアウト対策）
  const selectedSiteIds: string[] = Array.isArray(s.selectedSiteIds) ? s.selectedSiteIds.filter(Boolean) : []
  const excludeSiteIds: string[] = Array.isArray(s.excludeSiteIds) ? s.excludeSiteIds.filter(Boolean) : []
  const maxSites = runMode === 'test' ? 3 : runMode === 'selected' ? Math.max(1, selectedSiteIds.length || 50) : batchSites
  const maxArticles = Math.max(1, Number(s.maxArticlesPerSite) || 5)
  const dailyCap = Math.max(1, Number(s.dailyCap) || 30)
  const delay = Math.max(200, Number(s.fetchDelayMs) || 800)
  const enrichEnabled = s.regionalEnrichEnabled !== false
  const enrichMaxQueries = Math.max(0, Number(s.regionalEnrichMaxQueries) || 3)
  const enrichPerQuery = Math.max(1, Math.min(10, Number(s.regionalEnrichPerQuery) || 5))
  const enrichDailyCap = Math.max(0, Number(s.regionalEnrichDailyCap) || 100)

  const mode: InjectMode = (s.aiInjectMode === 'strict' || s.aiInjectMode === 'aggressive') ? s.aiInjectMode : 'standard'
  const autoImportPerRun = Math.max(1, Number(s.autoImportPerRun) || 50)
  const autoImportPerDay = Math.max(1, Number(s.autoImportPerDay) || 200)
  let importedThisRun = 0
  const counts = { sites: 0, articles: 0, newArticles: 0, candidates: 0, placeMatched: 0, phoneYes: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, saved: 0, saveError: 0, error: 0, enrichTried: 0, enrichSucceeded: 0, enrichPhone: 0, enrichAddress: 0, enrichQueries: 0, openingDateCount: 0, futureOpeningCount: 0, timeouts: 0, detailFetches: 0, deferredSites: 0, deferredDetails: 0, dupImportSkip: 0, alreadyImported: 0, manualPending: 0, importFailed: 0, seenSkipped: 0, oldSkipped: 0, reachedPrev: 0 }
  // ===== 差分巡回（増分巡回）=====
  // 既定: 前回巡回済み（source_articles / lead_candidates に既出）のURLは詳細を読み直さない。
  // recrawlAll=過去分も再巡回 / recrawlIncomplete=電話or住所が欠けている既出のみ再補完（情報不足の再取得）。
  const differential = s.differential !== false
  const recrawlAll = s.recrawlAll === true
  const recrawlIncomplete = s.recrawlIncomplete === true
  // 既読URLをスキップすべきか（true=スキップ）
  const skipSeen = (exA: any, cand: any): boolean => {
    if (recrawlAll) return false
    const seen = !!exA || !!cand
    if (!seen) return false
    if (recrawlIncomplete && cand && !(cand.phone_number && cand.address)) return false // 情報不足は再補完
    return differential
  }
  const debug: any = { siteResults: [] as any[], sample: null, saveErrors: [] as string[] }
  let errorMessage = ''
  const enrichQueriesToLog = new Set<string>()
  // 504回避: 実行全体の時間予算・詳細取得上限（続きは次回実行に回す）
  const runStart = Date.now()
  const runBudgetMs = Math.max(20000, Number(s.runBudgetMs) || 50000)
  const maxDetailFetches = Math.max(1, Number(s.maxDetailFetchesPerRun) || 20)
  const overBudget = () => (Date.now() - runStart) > runBudgetMs
  const detailBudgetLeft = () => counts.detailFetches < maxDetailFetches
  debug.runBudgetMs = runBudgetMs; debug.maxDetailFetches = maxDetailFetches

  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'regional_media', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  try {
    // 有効サイト総数（進捗表示用・連番探索は別タブなので除外）
    const { count: totalActiveSites } = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true).neq('source_type', 'sequential_id_probe')
    let sq = admin.from('source_sites').select('*').eq('is_active', true).neq('source_type', 'sequential_id_probe')
    if (runMode === 'selected' && selectedSiteIds.length) sq = sq.in('id', selectedSiteIds)
    if (excludeSiteIds.length) sq = sq.not('id', 'in', `(${excludeSiteIds.join(',')})`)  // 全サイト巡回: 既に処理済みを除外して次バッチへ
    // 優先順位: 信頼度が高い → 最終巡回が古い（最終的に全件を巡回。順番付けのみ）
    if (runMode === 'priority' || runMode === 'all') sq = sq.order('reliability_score', { ascending: false }).order('last_crawled_at', { ascending: true, nullsFirst: true })
    else sq = sq.order('last_crawled_at', { ascending: true, nullsFirst: true })
    const { data: sites } = await sq.limit(maxSites)
    const list = sites || []
    const failedSites: { id: string; name: string; reason: string }[] = []
    const nowIso = new Date().toISOString()
    const now = Date.now()

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount = importedToday || 0

    // HOT候補の自動投入を一元処理し、結果（新規投入/既存投入済/手動待ち/失敗）を集計＋候補に記録。
    // 戻り値: 候補の投入状態（UI表示用）。casesに実際に作成された場合のみ「今回投入済」。
    async function autoImportHot(o: { candidateId: string | null; tier: HotTier; temperature: string; phone: string; alreadyImported: boolean; caseData: any }): Promise<string> {
      if (o.temperature !== 'HOT') return o.temperature // HOLD/EXCLUDED はそのまま
      let attempted = false, success = false, skip = '', errMsg = '', caseId: string | null = null
      if (o.alreadyImported) { skip = '既に投入済'; counts.alreadyImported++ }
      else if (!autoImportAllowed(o.tier, mode)) { skip = `手動投入待ち（${o.tier}は現モード対象外）`; counts.manualPending++ }
      else if (!o.phone || !isJapanPhone(o.phone)) { skip = '手動投入待ち（電話番号なし）'; counts.manualPending++ }
      else if (importedCount >= autoImportPerDay) { skip = '手動投入待ち（1日上限）'; counts.manualPending++ }
      else if (importedThisRun >= autoImportPerRun) { skip = '手動投入待ち（1回上限）'; counts.manualPending++ }
      else {
        // 統一投入前ゲート（チェーン/支店/大手/既存店/共有番号/地域不一致/同名同市 の最終関門・全ソース共通）
        const gate = await caseImportGate(admin, { name: o.caseData?.name || '', phone: o.phone, address: o.caseData?.address || '', text: `${o.caseData?.memo || ''}`, mapsKey, budgetEndMs: Date.now() + 15000 })
        if (!gate.ok && gate.action === 'link' && gate.linkCaseId) { skip = gate.reason; caseId = gate.linkCaseId; counts.alreadyImported++ }
        else if (!gate.ok) { skip = gate.reason; counts.manualPending++; await applyGateDowngrade(admin, o.candidateId, gate) }
        else {
          // 別経路からの同一店舗（電話重複）は二重作成しない
          const dupCaseId = await findCaseIdByPhone(admin, o.phone)
          if (dupCaseId) { skip = '既存案件と電話重複のためリンク'; caseId = dupCaseId; counts.alreadyImported++ }
          else {
            attempted = true
            const { data: created, error } = await admin.from('cases').insert(o.caseData).select('id').single()
            if (error || !created?.id) { errMsg = error?.message || 'case作成失敗'; counts.importFailed++ }
            else { success = true; caseId = created.id; counts.imported++; importedThisRun++; importedCount++ }
          }
        }
      }
      if (o.candidateId) {
        await admin.from('lead_candidates').update({
          auto_insert_attempted: attempted, auto_insert_success: success, auto_insert_skipped_reason: skip || null, auto_insert_error: errMsg || null,
          // caseIdがnullの回（既に投入済/手動待ち等）で既存のimported_case_idをnull上書きしない（再巡回のたびにリンクが剥がれていた）
          ...(caseId ? { imported_case_id: caseId } : {}),
          // 既存案件へのリンク（gateの同名同市/電話重複）も投入済み扱いにする。放置するとHOT×未投入のまま毎回のsweep/ゲートを永遠に再通過する
          ...(caseId ? { imported_to_cases: true, imported_at: nowIso } : {}),
        }).eq('id', o.candidateId).then(() => {}, () => {})
      }
      return success ? '今回投入済' : o.alreadyImported ? '既に投入済' : skip || (errMsg ? '投入失敗' : '手動投入待ち')
    }

    // 外部補完: 1日上限と7日以内の補完クエリ
    const { count: enrichedTodayCount } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true })
      .eq('lead_source', 'regional_media').not('last_enriched_at', 'is', null).gte('last_enriched_at', startToday.toISOString())
    let enrichBudget = Math.max(0, enrichDailyCap - (enrichedTodayCount || 0))
    const since7e = new Date(Date.now() - 7 * 86400000).toISOString()
    const { data: enrichRecentRows } = await admin.from('ig_enrich_log').select('query').gte('last_run_at', since7e).limit(8000)
    const enrichRecent = new Set<string>((enrichRecentRows || []).map((r: any) => String(r.query)))
    debug.enrichBudget = enrichBudget

    for (const site of list) {
      // 504回避: 時間予算を超えたら残りサイトは次回実行に回す（全体は失敗扱いにしない）
      if (overBudget()) { counts.deferredSites++; debug.siteResults.push({ site: site.name, deferred: true, reason: `実行時間上限(${Math.round(runBudgetMs / 1000)}s)のため次回に継続` }); continue }
      counts.sites++
      // 差分巡回カーソル: 前回巡回時の最新アイテムURL。一覧（新着順）でここに到達したら以降（古い記事）は読まない。
      const prevLatest: string | null = recrawlAll ? null : (site.latest_item_url || null)
      let siteNewest: string | null = null   // 今回一覧の先頭（最新）アイテムURL → 次回の prevLatest
      let siteSeenSkipped = 0, siteOldSkipped = 0, siteNewArticles = 0
      const crawlUrl = site.list_url || site.base_url
      let base: URL
      try { base = new URL(crawlUrl) } catch { debug.siteResults.push({ site: site.name, error: 'invalid base_url' }); await admin.from('source_sites').update({ last_crawl_result: 'URL不正', last_crawled_at: nowIso, updated_at: nowIso }).eq('id', site.id).then(() => {}, () => {}); continue }

      const allowed = await robotsAllows(base.origin, base.pathname)
      if (!allowed) {
        debug.siteResults.push({ site: site.name, error: 'robots.txt により不許可' })
        await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso, last_crawl_result: 'robots.txtにより不許可' }).eq('id', site.id)
        continue
      }

      // 連番URL探索は別タブ（runAllSequentialProbes）で実行。地域メディア巡回では処理・集計しない。
      if (site.source_type === 'sequential_id_probe') continue

      const idx = await fetchHtml(crawlUrl)
      await sleep(delay)
      const linkOpts: LinkOpts = { mediaFamily: site.media_family, categoryLabel: site.category_label, listUrl: crawlUrl }
      // parser_type 判定（site設定 → URL/HTML構造から推定）
      const parserType = idx.ok ? detectParserType(site, idx.html, crawlUrl) : siteTypeOf(site)
      const stype = parserType
      const diag: any = { site: site.name, url: crawlUrl, siteType: stype, parserType, parser_used: '', fetchOk: idx.ok, status: idx.status, htmlLength: idx.length, totalLinks: 0, candidateLinks: 0, keywordHits: 0, recent: 0, saved: 0, hot: 0, hold: 0, excluded: 0, timeouts: 0, error: idx.error, reason: '' }
      if (!idx.ok) {
        counts.error++; if (idx.timedOut) { counts.timeouts++; diag.timeouts++ }
        diag.reason = idx.timedOut ? `リスト取得がタイムアウト（外部サイト応答遅延）` : `リスト取得失敗（${idx.error}）`
        debug.siteResults.push(diag)
        failedSites.push({ id: site.id, name: site.name, reason: idx.timedOut ? 'timeout' : `fetch失敗(${idx.error || idx.status})` })
        await admin.from('source_sites').update({ last_crawled_at: nowIso, last_crawl_result: (idx.timedOut ? 'timeout ' : '取得失敗 ') + (idx.error || '') }).eq('id', site.id)
        continue
      }

      // ===== 店舗ディレクトリ型（彩北なび等）: 一覧→店舗詳細リンク→詳細ページ取得→判定 =====
      if (stype === 'local_directory_new_listing') {
        diag.parser_used = 'directory_parser'
        const dr = extractDirectoryListingLinks(idx.html, base, site.media_family)
        diag.totalLinks = dr.totalLinks; diag.detailLinks = dr.detailLinks; diag.openTagged = dr.openTagged
        diag.detailFetched = 0; diag.phoneYes = 0; diag.addressYes = 0; diag.openYes = 0
        if (dr.links.length === 0) diag.reason = `店舗詳細リンク0（全リンク${dr.totalLinks}）。list_url/detailPattern を確認`
        let used = 0
        for (const item of dr.links.slice(0, recrawlAll ? maxArticles * 4 : 60)) {
          if (used >= maxArticles) break
          // 差分巡回: 前回処理した最新カードに到達したら、以降（既読の古いカード）は読み進めない
          if (prevLatest && item.url === prevLatest) { counts.reachedPrev++; diag.reachedPrev = true; diag.reason = diag.reason || '前回最新カードに到達したため停止（差分巡回）'; break }
          // 504回避: 時間/件数の上限に達したら次回に継続
          if (overBudget() || !detailBudgetLeft()) { counts.deferredDetails++; diag.reason = `詳細取得を${used}件で打ち切り（時間/件数上限・次回継続）`; break }
          const dhash = urlHash(item.url)
          const { data: exA } = await admin.from('source_articles').select('id').eq('article_url_hash', dhash).limit(1)
          // 既存lead候補（source_detail_url）も確認（HOLD→電話/住所が取れたら補完更新）
          const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases,phone_number,address').eq('source_detail_url', item.url).limit(1)
          const existingCand = exC?.[0] || null
          if (skipSeen(exA?.[0], existingCand)) { counts.seenSkipped++; siteSeenSkipped++; diag.seenSkipped = (diag.seenSkipped || 0) + 1; continue } // 差分: 既読URLは読み直さない
          siteNewArticles++
          counts.articles++; counts.newArticles++; used++

          const dRes = await fetchHtml(item.url, DETAIL_TIMEOUT_MS)
          counts.detailFetches++
          await sleep(delay)
          // 詳細取得が一時失敗(timeout/403)したitemはカーソルに採用しない（次回リトライさせるため）。取得成功して初めて停止カーソルにする。
          if (!dRes.ok) { if (dRes.timedOut) { counts.timeouts++; diag.timeouts++ } diag.reason = diag.reason || (dRes.timedOut ? '詳細ページがタイムアウト' : '詳細ページ取得失敗'); continue }
          if (siteNewest === null) siteNewest = item.url  // 取得成功した最初の新規＝次回の停止カーソル
          const dHtml = dRes.html
          diag.detailFetched++
          const info = extractDirectoryShopInfo(dHtml, item.title, site.media_family)
          // 一覧タイトルのOPEN表記を優先（詳細でOPEN取れない場合の補完）
          const open = info.open.confidence !== 'none' ? info.open : item.open
          if (info.phone) diag.phoneYes++
          if (info.address) diag.addressYes++
          if (open.confidence !== 'none') diag.openYes++

          // 外部補完: 詳細ページで電話 or 住所が取れない時だけ（APIコスト削減）
          let enrich: any = null
          const needEnrich = enrichEnabled && enrichBudget > 0 && !!info.shop_name && (!info.phone || !info.address) && !classifyDirectoryCandidate({ ...info, open, isJapan: true }).isChain
          if (needEnrich) {
            enrich = await enrichCandidate(mapsKey, { shop: info.shop_name, username: '', areaHint: info.address || '', industry: info.industry || '', havePhone: info.phone || '', haveAddress: info.address || '' }, {
              maxQueries: enrichMaxQueries, perQuery: enrichPerQuery, skipQuery: enrichRecent,
              onQuery: (qq: string) => { counts.enrichQueries++; diag.enrichQueries = (diag.enrichQueries || 0) + 1; enrichQueriesToLog.add(qq) },
            })
            enrichBudget--; counts.enrichTried++
            if (enrich.status === 'enriched') counts.enrichSucceeded++
            if (enrich.phone) counts.enrichPhone++
            if (enrich.address) counts.enrichAddress++
          }
          const phone = info.phone || enrich?.phone || ''
          const address = info.address || enrich?.address || ''
          const official = info.official_url || enrich?.official || null
          const instagram = info.instagram_url || enrich?.instagram || null
          const prefecture = enrich?.prefecture || null
          const city = enrich?.city || null
          const matchedPlaceId = enrich?.place_id || null
          if (matchedPlaceId) counts.placeMatched++
          if (phone) counts.phoneYes++

          const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || !!prefecture || /[市区町村]/.test(address))
          const dSn = sanitizeShopName(info.shop_name, { placesMatched: !!matchedPlaceId })
          const dName = (matchedPlaceId && enrich?.place_name) ? enrich.place_name : (dSn.valid ? dSn.name : '')
          const dc = classifyDirectoryCandidate({ shop_name: dName, phone, address, open, isJapan }, mode)
          let temperature = dc.temperature
          let dHotTier = dc.hot_tier
          // 多店舗展開/フランチャイズは確立済み大型 → EXCLUDED
          const multiD = detectMultiStore(`${dName} ${info.shop_name || ''} ${(info.excerpt || '').slice(0, 200)}`)
          if (multiD.exclude || looksLikeBranchStore(dName)) { temperature = 'EXCLUDED'; dHotTier = null }
          // 新方針: HOTは電話＋住所必須。店名未確定でも電話＋住所＋新店根拠ありなら HOT-B
          const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
          const cardNew = open.confidence !== 'none' || true  // 店舗ディレクトリ新着＝新規掲載根拠
          let nameUnconfirmedHot = false
          if (temperature === 'HOT') {
            if (!phoneOk) { temperature = 'HOLD'; dHotTier = null }
            else if (!address) { temperature = 'HOLD'; dHotTier = null }
            else if (!dName) { dHotTier = 'B'; nameUnconfirmedHot = true }
          } else if (temperature === 'HOLD' && !dName && phoneOk && !!address && cardNew && !dc.isForeign) {
            temperature = 'HOT'; dHotTier = 'B'; nameUnconfirmedHot = true
          }
          if (temperature === 'HOT') { counts.hot++; diag.hot++; if (dHotTier === 'A') counts.hotA++; else counts.hotB++ }
          else if (temperature === 'EXCLUDED') { counts.excluded++; diag.excluded++ }
          else { counts.hold++; diag.hold++ }
          counts.candidates++

          const name = dName || '店名未確定'
          const newnessReason = `${site.name}（店舗新着）「${name}」${open.text ? ` ${open.text}` : ''}${enrich ? ` / 補完[${enrich.status}]` : ''} / ${dc.reason}`

          // HOT未達理由
          const rmConf = (phone && isJapanPhone(phone) ? 35 : 0) + (address ? 30 : 0) + (open.confidence === 'high' ? 25 : open.confidence === 'mid' ? 15 : 0) + (matchedPlaceId ? 10 : 0)
          const rmChecks: HotCheck[] = [
            { key: 'has_japan', label: '日本国内', ok: dc.isForeign ? false : (isJapan ? true : null), reasonKey: 'not_japan' },
            { key: 'has_shop_name', label: '店名あり', ok: !!info.shop_name, reasonKey: 'shop_name_missing' },
            { key: 'has_industry', label: '業種推定', ok: info.industry ? true : null, reasonKey: 'industry_unknown' },
            { key: 'has_area', label: '住所あり', ok: !!address, reasonKey: 'address_missing', value: address || undefined },
            { key: 'has_phone', label: '日本の電話番号あり', ok: (phone && isJapanPhone(phone)) ? true : false, reasonKey: 'phone_missing', value: phone || undefined },
            { key: 'has_newness', label: 'OPEN表記あり', ok: (open.confidence === 'high' || open.confidence === 'mid') ? true : null, reasonKey: 'newness_missing', value: open.text || undefined },
            { key: 'has_opening_date', label: 'OPEN日付あり', ok: open.iso ? true : false, reasonKey: 'opening_date_missing' },
            { key: 'has_official', label: '公式/Places裏取り', ok: (official || matchedPlaceId) ? true : null, reasonKey: 'official_unverified' },
          ]
          const hotReject = buildHotReject({ source: 'regional_media', temperature, confidence: rmConf, checks: rmChecks })

          const payload: any = {
            name, address: address || null, industry: info.industry || null,
            phone_number: phone || null, website_url: official,
            lead_source: 'regional_media', source: 'regional_media', source_type: 'AI自動投入(店舗ディレクトリ)',
            source_site_type: 'local_directory_new_listing', source_media_family: site.media_family || null, source_site_name: site.name,
            source_listing_url: crawlUrl, source_detail_url: item.url, source_article_url: item.url,
            search_title: item.title?.slice(0, 300) || name, search_snippet: info.excerpt?.slice(0, 500) || null,
            lead_temperature: temperature, hot_tier: dHotTier, recommended_status: nameUnconfirmedHot ? 'HOT_B' : dc.tier, is_new_gbp: !!matchedPlaceId, should_exclude_from_call_list: temperature === 'EXCLUDED',
            name_unconfirmed_hot: nameUnconfirmedHot, phone_source: phone ? (info.phone ? 'detail_page' : enrich?.phone ? 'enrich' : 'list') : null,
            owner_reachability_score: phone ? 70 : 35, auto_import_reason: temperature === 'HOT' ? dc.reason : null, ai_comment: nameUnconfirmedHot ? `店名未確定だが電話・住所・新店根拠ありのため営業可能候補(HOT-B)。営業前に店名確認推奨。${dc.reason}` : dc.reason,
            regional_media_newness_reason: newnessReason, regional_media_detected_at: nowIso,
            newness_type: 'new_listing_open',
            extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null,
            extracted_area: address || [prefecture, city].filter(Boolean).join('') || null, extracted_prefecture: prefecture, extracted_city: city,
            extracted_industry: info.industry || null,
            extracted_open_date: open.iso || open.text || null, extracted_open_date_text: open.text || null,
            extracted_open_month: open.month, extracted_open_day: open.day, extracted_open_date_confidence: open.confidence,
            instagram_url: instagram, official_url: official, map_url: info.map_url || null,
            business_hours: info.hours || null,
            hot_reject_reasons: hotReject.hot_reject_reasons, hot_reject_summary: hotReject.hot_reject_summary,
            hot_check_result: hotReject.hot_check_result, hot_missing_requirements: hotReject.hot_missing_requirements,
            hot_blocking_reason: hotReject.hot_blocking_reason, hot_required_score: hotReject.hot_required_score,
            // 補完結果
            enrichment_status: enrich?.status || 'not_started', enrichment_sources: enrich?.sources || null,
            enriched_phone: enrich?.phone || null, enriched_address: enrich?.address || null, last_enriched_at: enrich ? nowIso : null,
            match_confidence: rmConf, google_place_id: matchedPlaceId, matched_google_place_id: matchedPlaceId,
            last_seen_at: nowIso, source_run_id: runId,
          }

          // source_articles に記録（再取得回避・本文は保存しない）
          await admin.from('source_articles').insert({
            source_site_id: site.id, article_url: item.url, article_url_hash: dhash, title: name,
            published_at: open.iso ? new Date(open.iso).toISOString() : null, detected_type: 'open', raw_excerpt: (info.excerpt || '').slice(0, 300),
            processed_status: temperature === 'EXCLUDED' ? 'skipped' : 'processed', extracted_shop_name: name, extracted_address: address || null,
            extracted_open_date: open.text || null, extracted_industry: info.industry || null,
          }).then(() => {}, () => {})

          // 重複: source_detail_url（既存があれば補完更新）/ 電話 / 店名+住所
          let candidateId: string | null = existingCand?.id || null
          if (!candidateId && phone) {
            const { data: byPhone } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1)
            candidateId = byPhone?.[0]?.id || null
          }
          const alreadyImported = !!existingCand?.imported_to_cases
          if (candidateId) {
            const { error } = await admin.from('lead_candidates').update(payload).eq('id', candidateId)
            if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else { counts.saved++; diag.saved++ }
          } else {
            const { data: ins, error } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
            if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else { counts.saved++; diag.saved++ }
            candidateId = ins?.id || null
          }

          const importStatus = await autoImportHot({ candidateId, tier: (nameUnconfirmedHot ? 'HOT_B' : dc.tier) as any, temperature, phone, alreadyImported, caseData: {
            name, address: address || '', phone1: phone, industry: info.industry || null,
            status: DEFAULT_STATUS, priority: dc.priority === 'high' ? '高' : '中', hp1: official, instagram, business_hours: info.hours || null, source_urls: item.url,
            memo: [`【AI自動投入 / 店舗ディレクトリ / ${nameUnconfirmedHot ? 'HOT_B(店名未確定)' : dc.tier}】`, `店舗: ${name}`, `記事タイトル: ${item.title || ''}`, `URL: ${item.url}`, `電話: ${phone || '—'}`, `住所: ${address || '—'}`, `理由: ${dc.reason}`, ...(nameUnconfirmedHot ? ['※営業前に店名確認推奨'] : [])].join('\n'), created_by_id: userId,
          } })
          void importStatus

          if (!debug.sample || debug.sample.siteType !== 'local_directory_new_listing') {
            debug.sample = { siteType: 'local_directory_new_listing', site: site.name, detailUrl: item.url, shop_name: name, phone, address, open_date: open.text, industry: info.industry, temperature, reason: dc.reason }
          }
        }
        diag.newArticles = used
        if (!diag.reason) diag.reason = diag.saved > 0 ? 'OK' : (diag.detailLinks > 0 ? '詳細は取得したが保存条件を満たさず' : '店舗詳細リンクなし')
        await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso, last_success_at: nowIso, latest_item_url: siteNewest || site.latest_item_url, last_seen_shop_url: siteNewest || site.last_seen_shop_url, last_new_count: siteNewArticles, last_seen_skipped: siteSeenSkipped, last_old_skipped: siteOldSkipped, last_crawl_result: `[店舗新着]詳細${diag.detailLinks}/取得${diag.detailFetched} 新規${siteNewArticles}/既読skip${siteSeenSkipped} 電話${diag.phoneYes}/住所${diag.addressYes} HOT${diag.hot}/HOLD${diag.hold} ${diag.reason}`.slice(0, 200) }).eq('id', site.id)
        debug.siteResults.push(diag)
        continue
      }

      // ===== マーケットプレイス/検索結果・カード型（HORBY等）＋ 汎用本文スキャン =====
      if (stype === 'marketplace_listing' || stype === 'generic_page_text_scan' || stype === 'horby_new_salon') {
        const isHorby = stype === 'horby_new_salon' || /u-word\.com|h-word\.com/i.test(crawlUrl)
        diag.parser_used = isHorby ? 'horby_new_salon' : stype === 'marketplace_listing' ? 'marketplace_card_parser' : 'generic_card_parser'
        const extract = (h: string) => isHorby ? parseHorbyCards(h, base) : extractNewnessBlocks(h, base)
        let ex = extract(idx.html)
        let candidates = ex.candidates; let stats = ex.stats
        diag.staticCards = candidates.length
        // JSレンダリング取得（browser=最初から / auto=静的で候補0かつJS疑い時）
        const renderingMode = String(site.rendering_mode || 'auto')
        const wantRender = !overBudget() && (renderingMode === 'browser' || (renderingMode === 'auto' && candidates.length === 0 && (stats.jsLikely || isHorby)))
        diag.renderingMode = renderingMode; diag.renderConfigured = renderConfigured(); diag.rendered = false; diag.renderedCards = 0
        let renderResultNote = ''
        if (wantRender) {
          const rr = await renderFetch(crawlUrl, { waitMs: isHorby ? 9000 : 6000 })
          diag.rendered = true; diag.renderProvider = rr.provider
          if (rr.ok && rr.html) {
            const re = extract(rr.html)
            if (re.candidates.length >= candidates.length) { candidates = re.candidates; stats = re.stats }
            diag.renderedCards = re.candidates.length
            renderResultNote = `rendered(${rr.provider}) HTML${rr.length}字 カード${re.candidates.length}件`
          } else { diag.renderError = rr.error; if (!rr.configured) diag.renderNotConfigured = true; renderResultNote = `rendering失敗: ${rr.error}` }
        } else if (isHorby && renderingMode === 'static') { renderResultNote = 'rendering_mode=static のためJS取得せず（HORBYは要レンダリング）' }
        // クリック遷移（カードにhrefもidも無いJSサイト用・設定駆動）。click_required=true のソースのみ。公開詳細ページへ実クリック遷移（認証突破しない）
        const clickRequired = site.click_required === true || (isHorby && site.click_required !== false)
        const detailParserType = String(site.detail_parser_type || (isHorby ? 'horby_detail' : ''))
        if (clickRequired && candidates.length > 0 && !!process.env.SCRAPINGBEE_API_KEY) {
          const cardSelector = String(site.card_selector || '.new_salon_list .new_salon_item')
          const linkSelector = String(site.detail_click_selector || 'a')
          const clickMax = Math.max(0, Math.min(candidates.length, Number(site.max_detail_pages_per_run) || Number(s.horbyMaxDetails) || 2))  // 60s制限内（1件≈18s）
          diag.clickTried = 0; diag.clickAddrOk = 0; diag.loginGated = 0
          for (let i = 0; i < clickMax; i++) {
            if (overBudget()) { diag.reason = `クリック詳細を${i}件で打ち切り（時間上限・次回継続）`; break }
            diag.clickTried++
            const d = await renderClickDetail(crawlUrl, i + 1, cardSelector, linkSelector)
            if (d.ok) {
              const dd = detailParserType === 'horby_detail' ? parseHorbyDetail(d.html) : null
              if (dd) {
                if (dd.name) candidates[i].shopName = dd.name
                if (dd.phone) candidates[i].phone = dd.phone  // ゲストでは「ログイン後に表示」のため通常空 → 電話なし＝HOLD
                else if (LOGIN_GATED_RE.test(d.html)) { diag.loginGated++; candidates[i].phoneGated = true }
                if (dd.address) { candidates[i].address = dd.address; if (dd.prefecture) candidates[i].prefecture = dd.prefecture; diag.clickAddrOk++ }
                if (dd.official) candidates[i].official = dd.official
              }
              if (d.resolvedUrl) candidates[i].detailUrl = d.resolvedUrl  // 実詳細URL（一意）
              candidates[i].preEnriched = true
            }
          }
          diag.phoneYes = candidates.filter((c) => c.phone).length
        }
        // レンダリング結果をソースに記録
        await admin.from('source_sites').update({ rendering_provider: diag.renderProvider || pickRenderProvider(), last_rendering_result: (renderResultNote + (clickRequired ? ` クリック詳細(住所)${diag.clickAddrOk || 0}/${diag.clickTried || 0}件${diag.loginGated ? `・電話ログイン制限${diag.loginGated}件→HOLD` : ''}` : '')).slice(0, 200) || null, last_rendering_error: diag.renderError || null }).eq('id', site.id).then(() => {}, () => {})
        diag.totalLinks = stats.totalLinks; diag.bodyTextLen = stats.bodyTextLen; diag.blockCount = stats.blockCount
        diag.keywordBlocks = stats.keywordBlocks; diag.detailLinks = stats.detailLinks; diag.newBadge = stats.newBadge
        diag.cardCandidates = candidates.length; diag.jsLikely = stats.jsLikely
        diag.detailFetched = 0; diag.phoneYes = 0; diag.addressYes = 0; diag.openYes = 0
        if (candidates.length === 0) {
          diag.reason = diag.renderNotConfigured
            ? `静的HTMLに店舗情報なし。JSレンダリングが必要ですが browser fallback が未設定です（RENDER_API_URL / SCRAPINGBEE_API_KEY / SCRAPERAPI_KEY を設定するか rendering_mode=static 以外に）`
            : diag.rendered
              ? `静的fetch候補0 → JSレンダリングfallback実行したが店舗カード0（${diag.renderError || 'レンダリング後も抽出できず'}）`
              : stats.jsLikely
                ? `HTMLは取得できたが本文が少なくJSレンダリングの可能性（本文${stats.bodyTextLen}字）。rendering_mode=auto/browser ＋ レンダリングAPI設定で取得可能`
                : stats.keywordBlocks > 0
                  ? `新店キーワード一致ブロック${stats.keywordBlocks}件あるが店名/詳細リンクが取れず候補化できず`
                  : `記事リンク0・店舗カード候補0（ブロック${stats.blockCount}/新店語一致${stats.keywordBlocks}）。本文に新店キーワードなし`
          // 要改善サイトとして記録（HTTP200・候補0・JSヒント/レンダリング要）
          diag.needsImprovement = true
          diag.improvementHint = diag.renderNotConfigured ? 'レンダリングAPIを設定（RENDER_API_URL等）' : stats.jsLikely ? 'rendering_mode=browser＋レンダリングAPI設定' : 'parser_type/list_url の見直し'
        }
        // 詳細取得設定（全サイト共通）
        const detailEnabled = site.detail_fetch_enabled !== false
        const detailMode = String(site.detail_rendering_mode || (isHorby ? 'browser' : 'auto'))
        const maxDetailPages = Math.max(1, Math.min(50, Number(site.max_detail_pages_per_run) || Number(s.maxDetailPagesPerRun) || 20))
        let detailFetchedThisSite = 0
        let used = 0
        for (const cand of candidates.slice(0, recrawlAll ? maxArticles * 4 : 60)) {
          if (used >= maxArticles) break
          if (overBudget() || !detailBudgetLeft()) { counts.deferredDetails++; diag.reason = `カード${used}件で打ち切り（時間/件数上限・次回継続）`; break }
          const detailUrl = cand.detailUrl || crawlUrl
          const cardKey = (cand.detailUrl && cand.detailUrl !== crawlUrl) ? cand.detailUrl : `${crawlUrl}#${cand.shopName || ''}`
          // 差分巡回: 前回処理した最新カードに到達したら以降（既読カード）は読まない
          if (prevLatest && cardKey === prevLatest) { counts.reachedPrev++; diag.reachedPrev = true; diag.reason = diag.reason || '前回最新カードに到達したため停止（差分巡回）'; break }
          const dhash = urlHash(detailUrl + '|' + cand.shopName)
          const { data: exA } = await admin.from('source_articles').select('id').eq('article_url_hash', dhash).limit(1)
          const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases,phone_number,address').eq('source_detail_url', detailUrl).limit(1)
          const existingCand = exC?.[0] || null
          if (skipSeen(exA?.[0], existingCand)) { counts.seenSkipped++; siteSeenSkipped++; diag.seenSkipped = (diag.seenSkipped || 0) + 1; continue } // 差分: 既読カードはスキップ
          if (siteNewest === null) siteNewest = cardKey  // 今回処理する最初の新規カード＝次回の停止カーソル
          siteNewArticles++
          counts.articles++; counts.newArticles++; used++

          // 詳細ページ取得（カードに詳細リンクがあれば）。detail_rendering_mode(static/auto/browser)・detail_parser_type を尊重
          let info: any = { shop_name: cand.shopName, phone: cand.phone, address: cand.address, industry: cand.industry, official_url: cand.official || '', instagram_url: '', map_url: '', open: cand.open, hours: '', holiday: '', excerpt: cand.blockText }
          let detailStatus = cand.preEnriched ? 'pre_enriched' : 'no_detail_link'
          let phoneGated = !!cand.phoneGated
          let detailRendered = false
          // コスト制御: 詳細取得無効/合成URL/上限超過/既に電話+住所ありの重複 はスキップ
          const skipDetail = !detailEnabled || cand.preEnriched || cand.detailUrl.includes('#') || detailFetchedThisSite >= maxDetailPages || (existingCand && existingCand.phone_number && existingCand.address)
          if (!skipDetail && cand.detailUrl && !cand.detailUrl.includes('#')) {
            const dRes = await fetchDetailPage(cand.detailUrl, detailMode); counts.detailFetches++; detailFetchedThisSite++
            await sleep(delay)
            if (dRes.ok && dRes.html) {
              diag.detailFetched++; detailStatus = dRes.rendered ? 'rendered' : 'fetched'; detailRendered = dRes.rendered
              const di = String(site.detail_parser_type) === 'horby_detail'
                ? (() => { const h = parseHorbyDetail(dRes.html); return { shop_name: h.name, phone: h.phone, address: h.address, industry: cand.industry, official_url: h.official, instagram_url: '', map_url: h.mapUrl, open: cand.open } as any })()
                : extractDirectoryShopInfo(dRes.html, cand.shopName, site.media_family)
              info = { ...info, shop_name: di.shop_name || cand.shopName, phone: di.phone || cand.phone, address: di.address || cand.address, industry: di.industry || cand.industry, official_url: di.official_url || info.official_url, instagram_url: di.instagram_url || '', map_url: di.map_url || '', open: (di.open && di.open.confidence !== 'none' ? di.open : cand.open) }
              if (!info.phone && LOGIN_GATED_RE.test(dRes.html)) { phoneGated = true; diag.loginGated = (diag.loginGated || 0) + 1 }
            } else { detailStatus = dRes.error ? 'failed' : 'failed'; if (/timeout/i.test(dRes.error || '')) { counts.timeouts++; diag.timeouts++ } }
          }
          // 外部補完（電話 or 住所が無い時のみ）
          let enrich: any = null
          if (enrichEnabled && enrichBudget > 0 && info.shop_name && (!info.phone || !info.address) && !overBudget()) {
            enrich = await enrichCandidate(mapsKey, { shop: info.shop_name, username: '', areaHint: info.address || cand.city || '', industry: info.industry || '', havePhone: info.phone || '', haveAddress: info.address || '' }, {
              maxQueries: enrichMaxQueries, perQuery: enrichPerQuery, skipQuery: enrichRecent,
              onQuery: (qq: string) => { counts.enrichQueries++; enrichQueriesToLog.add(qq) },
            })
            enrichBudget--; counts.enrichTried++
            if (enrich.status === 'enriched') counts.enrichSucceeded++
            if (enrich.phone) counts.enrichPhone++
            if (enrich.address) counts.enrichAddress++
          }
          const phone = info.phone || enrich?.phone || ''
          const address = info.address || enrich?.address || ''
          const official = info.official_url || enrich?.official || null
          const instagram = info.instagram_url || enrich?.instagram || null
          const prefecture = cand.prefecture || enrich?.prefecture || null
          const city = cand.city || enrich?.city || null
          const matchedPlaceId = enrich?.place_id || null
          const open = info.open
          if (phone) { diag.phoneYes++; counts.phoneYes++ }
          if (address) diag.addressYes++
          if (open.confidence !== 'none') diag.openYes++
          if (matchedPlaceId) counts.placeMatched++

          const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || !!prefecture || /[市区町村]/.test(address))
          const mSn = sanitizeShopName(info.shop_name, { placesMatched: !!matchedPlaceId })
          // 号外NET系: 記事タイトル/本文の『店名』を店名として補完（『ケーズデンキ女池インター本店』等）
          const titleName = extractShopFromTitle(cand.blockText || cand.shopName || '')
          const dName = (matchedPlaceId && enrich?.place_name) ? enrich.place_name : (mSn.valid ? mSn.name : titleName || '')
          const dc = classifyDirectoryCandidate({ shop_name: dName, phone, address, open, isJapan }, mode)
          let temperature = dc.temperature
          let dHotTier = dc.hot_tier
          // 多店舗/大手チェーン/量販/ショッピングモール/駅ビル・記事/まとめ・カテゴリ住所 は営業対象外（EXCLUDED）
          const gateText = `${dName} ${titleName} ${info.shop_name || ''} ${cand.blockText || ''}`
          const multiM = detectMultiStore(gateText)
          const chM = detectChain(dName || titleName || '', cand.blockText || '')
          const bigStrongM = detectBigOrPublicStrong(gateText)
          // 記事見出し判定は「候補の店名」のみで行う（blockTextを含めると、見出しが常に【市名】…形式の
          // 号外NET等で、正式店名＋電話＋住所が揃った正当なHOT-Aまで全て記事扱いでEXCLUDEDになっていた）
          const isArticleM = looksLikeArticleText(dName || titleName || '')
          if (multiM.exclude || chM.definite || bigStrongM.exclude || isArticleM || looksLikeBranchStore(dName) || !isRealStoreAddress(address)) {
            temperature = 'EXCLUDED'; dHotTier = null
          }
          // ===== 新方針: HOTは電話＋住所必須。店名未確定でも電話＋住所＋新店根拠ありなら HOT-B =====
          const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
          const cardNew = cand.matchedKeywords.length > 0 || open.confidence !== 'none'
          let nameUnconfirmedHot = false
          if (temperature === 'HOT') {
            if (!phoneOk) { temperature = 'HOLD'; dHotTier = null }
            else if (!address) { temperature = 'HOLD'; dHotTier = null }
            else if (!dName) { dHotTier = 'B'; nameUnconfirmedHot = true }
          } else if (temperature === 'HOLD' && !dName && phoneOk && !!address && cardNew && !dc.isForeign) {
            temperature = 'HOT'; dHotTier = 'B'; nameUnconfirmedHot = true
          }
          if (temperature === 'HOT') { counts.hot++; diag.hot++; if (dHotTier === 'A') counts.hotA++; else counts.hotB++ }
          else if (temperature === 'EXCLUDED') { counts.excluded++; diag.excluded++ }
          else { counts.hold++; diag.hold++ }
          counts.candidates++

          const name = dName || '店名未確定'
          const phoneSource = info.phone ? 'detail_page' : enrich?.phone ? 'enrich' : (phoneGated ? 'login_required' : null)
          const phoneNote = phoneGated && !phone ? '・電話番号がログイン制限のため取得不可' : ''
          const newnessReason = `${site.name}（${diag.parser_used}${detailRendered ? '/rendered' : ''}）「${name}」${open.text ? ` ${open.text}` : ''} 一致語[${cand.matchedKeywords.join('・')}]${enrich ? ` / 補完[${enrich.status}]` : ''}${phoneNote} / ${dc.reason}`
          const rmConf = (phone && isJapanPhone(phone) ? 35 : 0) + (address ? 30 : 0) + (open.confidence === 'high' ? 25 : open.confidence === 'mid' ? 15 : 0) + (matchedPlaceId ? 10 : 0)
          const rmChecks: HotCheck[] = [
            { key: 'has_japan', label: '日本国内', ok: dc.isForeign ? false : (isJapan ? true : null), reasonKey: 'not_japan' },
            { key: 'has_shop_name', label: '店名あり', ok: !!info.shop_name, reasonKey: 'shop_name_missing' },
            { key: 'has_industry', label: '業種推定', ok: info.industry ? true : null, reasonKey: 'industry_unknown' },
            { key: 'has_area', label: '住所あり', ok: !!address, reasonKey: 'address_missing', value: address || undefined },
            { key: 'has_phone', label: '日本の電話番号あり', ok: (phone && isJapanPhone(phone)) ? true : false, reasonKey: 'phone_missing', value: phone || undefined },
            { key: 'has_newness', label: '新店根拠(カード)あり', ok: cand.matchedKeywords.length > 0 ? true : null, reasonKey: 'newness_missing', value: cand.matchedKeywords.join('・') || undefined },
            { key: 'has_opening_date', label: 'OPEN日付あり', ok: open.iso ? true : false, reasonKey: 'opening_date_missing' },
            { key: 'has_official', label: '公式/Places裏取り', ok: (official || matchedPlaceId) ? true : null, reasonKey: 'official_unverified' },
          ]
          const hotReject = buildHotReject({ source: 'regional_media', temperature, confidence: rmConf, checks: rmChecks })

          const payload: any = {
            name, address: address || null, industry: info.industry || null,
            phone_number: phone || null, website_url: official,
            lead_source: 'regional_media', source: 'regional_media', source_type: 'AI自動投入(地域メディア)',
            source_site_type: stype, parser_used: diag.parser_used, source_media_family: site.media_family || null, source_site_name: site.name,
            phone_source: phoneSource, detail_rendering_mode: detailMode,
            source_list_url: crawlUrl, source_listing_url: crawlUrl, source_detail_url: detailUrl, source_article_url: detailUrl,
            search_title: name.slice(0, 300), search_snippet: cand.blockText, candidate_block_text_short: cand.blockText, detail_fetch_status: detailStatus,
            matched_keywords: cand.matchedKeywords, newness_type: stype === 'marketplace_listing' ? 'marketplace_new_listing' : 'generic_new_block',
            lead_temperature: temperature, hot_tier: dHotTier, recommended_status: nameUnconfirmedHot ? 'HOT_B' : dc.tier, is_new_gbp: !!matchedPlaceId, should_exclude_from_call_list: temperature === 'EXCLUDED',
            name_unconfirmed_hot: nameUnconfirmedHot,
            owner_reachability_score: phone ? 70 : 35, auto_import_reason: temperature === 'HOT' ? dc.reason : null, ai_comment: nameUnconfirmedHot ? `店名未確定だが電話・住所・新店根拠ありのため営業可能候補(HOT-B)。営業前に店名確認推奨。${dc.reason}` : dc.reason,
            regional_media_newness_reason: newnessReason, regional_media_detected_at: nowIso,
            extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null,
            extracted_area: address || [prefecture, city].filter(Boolean).join('') || null, extracted_prefecture: prefecture, extracted_city: city,
            extracted_industry: info.industry || null,
            extracted_open_date: open.iso || open.text || null, extracted_open_date_text: open.text || null,
            extracted_open_month: open.month, extracted_open_day: open.day, extracted_open_date_confidence: open.confidence,
            instagram_url: instagram, official_url: official, map_url: info.map_url || null,
            business_hours: info.hours || null,
            hot_reject_reasons: hotReject.hot_reject_reasons, hot_reject_summary: hotReject.hot_reject_summary,
            hot_check_result: hotReject.hot_check_result, hot_missing_requirements: hotReject.hot_missing_requirements,
            hot_blocking_reason: hotReject.hot_blocking_reason, hot_required_score: hotReject.hot_required_score,
            enrichment_status: enrich?.status || 'not_started', enrichment_sources: enrich?.sources || null,
            enriched_phone: enrich?.phone || null, enriched_address: enrich?.address || null, last_enriched_at: enrich ? nowIso : null,
            match_confidence: rmConf, google_place_id: matchedPlaceId, matched_google_place_id: matchedPlaceId,
            last_seen_at: nowIso, source_run_id: runId,
          }

          await admin.from('source_articles').insert({
            source_site_id: site.id, article_url: detailUrl, article_url_hash: dhash, title: name,
            published_at: open.iso ? new Date(open.iso).toISOString() : null, detected_type: 'open', raw_excerpt: cand.blockText,
            processed_status: temperature === 'EXCLUDED' ? 'skipped' : 'processed', extracted_shop_name: name, extracted_address: address || null,
            extracted_open_date: open.text || null, extracted_industry: info.industry || null,
          }).then(() => {}, () => {})

          let candidateId: string | null = existingCand?.id || null
          if (!candidateId && phone) { const { data: byPhone } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = byPhone?.[0]?.id || null }
          const alreadyImported = !!existingCand?.imported_to_cases
          if (candidateId) {
            const { error } = await admin.from('lead_candidates').update(payload).eq('id', candidateId)
            if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else { counts.saved++; diag.saved++ }
          } else {
            const { data: ins, error } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
            if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else { counts.saved++; diag.saved++ }
            candidateId = ins?.id || null
          }
          await autoImportHot({ candidateId, tier: (nameUnconfirmedHot ? 'HOT_B' : dc.tier) as any, temperature, phone, alreadyImported, caseData: {
            name, address: address || '', phone1: phone, industry: info.industry || null, status: DEFAULT_STATUS, priority: dc.priority === 'high' ? '高' : '中', hp1: official, instagram, business_hours: info.hours || null, source_urls: detailUrl,
            memo: [`【AI自動投入 / ${diag.parser_used} / ${nameUnconfirmedHot ? 'HOT_B(店名未確定)' : dc.tier}】`, `店舗: ${name}`, `記事タイトル: ${cand.shopName || ''}`, `URL: ${detailUrl}`, `電話: ${phone || '—'}`, `住所: ${address || '—'}`, `理由: ${dc.reason}`, ...(nameUnconfirmedHot ? ['※営業前に店名確認推奨'] : [])].join('\n'), created_by_id: userId,
          } })
          if (!debug.sample || debug.sample.siteType !== stype) debug.sample = { siteType: stype, parser_used: diag.parser_used, site: site.name, detailUrl, shop_name: name, phone, address, open_date: open.text, industry: info.industry, matched: cand.matchedKeywords, temperature, reason: dc.reason }
        }
        diag.newArticles = used
        if (!diag.reason) diag.reason = diag.saved > 0 ? 'OK' : (diag.cardCandidates > 0 ? 'カード候補はあるが保存条件を満たさず' : '新店カード候補なし')
        await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso, last_success_at: nowIso, latest_item_url: siteNewest || site.latest_item_url, last_seen_shop_url: siteNewest || site.last_seen_shop_url, last_new_count: siteNewArticles, last_seen_skipped: siteSeenSkipped, last_old_skipped: siteOldSkipped, last_crawl_result: `[${diag.parser_used}]カード${diag.cardCandidates}/詳細${diag.detailFetched} 新規${siteNewArticles}/既読skip${siteSeenSkipped} 電話${diag.phoneYes}/住所${diag.addressYes} HOT${diag.hot}/HOLD${diag.hold} ${diag.reason}`.slice(0, 200), last_detail_fetch_result: `一覧${diag.cardCandidates}・詳細取得${diag.detailFetched}・電話${diag.phoneYes}・住所${diag.addressYes}${diag.loginGated ? `・ログイン制限${diag.loginGated}` : ''}・HOT${diag.hot}/HOLD${diag.hold}`.slice(0, 200), last_detail_fetch_error: diag.renderError || null }).eq('id', site.id)
        debug.siteResults.push(diag)
        continue
      }

      diag.parser_used = 'article_link_parser'
      const extracted = extractArticleLinks(idx.html, base, linkOpts)
      diag.totalLinks = extracted.totalLinks; diag.candidateLinks = extracted.candidateLinks; diag.keywordHits = extracted.keywordHits
      // 差分巡回: 前回最新記事に到達したら以降は読まないので、一覧は広めに見て新着のみ拾う
      const links = extracted.links.slice(0, recrawlAll ? maxArticles * 4 : 30)
      if (links.length === 0) diag.reason = `記事候補リンク0（全リンク${extracted.totalLinks}・新店語一致${extracted.keywordHits}）。list_url/パーサーを確認`

      let used = 0
      for (const link of links) {
        if (used >= maxArticles) break
        // 差分巡回: 前回処理した最新記事URLに到達したら、それ以降（古い記事）は読み進めない
        if (prevLatest && link.url === prevLatest) { counts.reachedPrev++; diag.reachedPrev = true; diag.reason = diag.reason || `前回最新記事に到達したため停止（差分巡回）`; break }
        // 504回避: 時間/件数の上限に達したら次回に継続
        if (overBudget() || !detailBudgetLeft()) { counts.deferredDetails++; diag.reason = `記事取得を${used}件で打ち切り（時間/件数上限・次回継続）`; break }
        counts.articles++
        const hash = urlHash(link.url)
        const { data: exA } = await admin.from('source_articles').select('id').eq('article_url_hash', hash).limit(1)
        if (skipSeen(exA?.[0], null)) { counts.seenSkipped++; siteSeenSkipped++; diag.seenSkipped = (diag.seenSkipped || 0) + 1; continue } // 差分: 既読記事は再取得しない
        counts.newArticles++; used++

        const aRes = await fetchHtml(link.url, DETAIL_TIMEOUT_MS)
        counts.detailFetches++
        if (aRes.timedOut) { counts.timeouts++; diag.timeouts++ }
        const html = aRes.ok ? aRes.html : null
        // 取得に成功した最初の新規記事だけを次回の停止カーソルにする（ディレクトリ経路と同じ設計）。
        // 取得失敗したURLをカーソルにすると、その記事は本文を読めていないのに「読んだ」印になり、
        // 次回以降そこで即breakして永久に再取得されない（＝恒久0件）。
        if (siteNewest === null && aRes.ok) siteNewest = link.url
        await sleep(delay)
        // 本文抽出は記事エリア優先: サイドバー/広告/関連記事の電話・住所を誤認しない。
        // extractMainContentが過剰除去したとき（<300字）は全文へフォールバック。
        // 4000→6000字: 実測で記事末尾の店舗情報（住所4600字目等）が4000字切りで物理的に欠落していた
        const mainText = html ? stripTags(extractMainContent(html)) : ''
        const body = mainText.length >= 300 ? mainText : (html ? stripTags(html) : '')
        const meta = html ? articleMeta(html) : { published_at: null, excerpt: '', title: '' }
        const bestTitle = meta.title && meta.title.length >= link.title.length ? meta.title : (link.title || meta.title)
        let ex = extractFromArticle(bestTitle, body.slice(0, 6000))
        // 記事エリア限定で電話も住所も取れなかった場合は全文で再抽出（店舗情報が<article>外にあるサイトの黙殺防止）
        if (!ex.phone && !ex.address && html && mainText.length >= 300) {
          const exFull = extractFromArticle(bestTitle, stripTags(html).slice(0, 6000))
          if (exFull.phone || exFull.address) ex = exFull
        }
        // 号外NET系のCMS定型「店舗情報」ブロック（店名/住所/電話/営業時間/リンク）を構造化直取り。
        // 見出し断片から店名を推測するより桁違いに正確。ブロックが無いサイトは found:false で従来フロー
        const gg = html ? parseGoguynetShopInfo(html) : null
        const ggSn = gg?.name ? sanitizeShopName(gg.name, { placesMatched: true }) : null
        // 店名の最優先はCMS定型ブロック（shop-info-name）由来のみ。マップ埋め込み由来は精度が落ちるため
        // Places正式名/記事抽出より弱い最終フォールバックとして扱う
        const ggName = ggSn?.valid && gg?.nameFromBlock ? ggSn.name : ''
        const ggNameWeak = ggSn?.valid && !gg?.nameFromBlock ? ggSn.name : ''
        // テキスト由来の開業日（タイトル/抜粋/抽出開店日から。Google補完値があればそちら優先で下のpayloadにて解決）
        const odText = extractOpeningDateFromText(`${bestTitle} ${meta.excerpt || ''} ${ex.open_date || ''} ${body.slice(0, 3000)}`, { publishedIso: meta.published_at })

        const publishedMs = meta.published_at ? Date.parse(meta.published_at) : NaN
        const pubKnown = !Number.isNaN(publishedMs)
        const tooOld = pubKnown && (now - publishedMs) > recentMs
        if (pubKnown && !tooOld) diag.recent++

        // source_articles 保存（本文は保存しない・抜粋のみ。再取得回避のため古い/除外も記録）
        const artStatus = ex.is_excluded ? 'skipped' : (tooOld ? 'skipped' : 'processed')
        await admin.from('source_articles').insert({
          source_site_id: site.id, article_url: link.url, article_url_hash: hash, title: bestTitle,
          published_at: meta.published_at, detected_type: ex.detected_type, raw_excerpt: meta.excerpt.slice(0, 300),
          processed_status: artStatus, extracted_shop_name: ex.shop_name || null, extracted_area: ex.area || null,
          extracted_address: ex.address || null, extracted_open_date: ex.open_date || null, extracted_industry: ex.industry || null,
          exclusion_reason: ex.is_excluded ? ex.exclude_reason : (tooOld ? `公開${Math.round((now - publishedMs) / 86400000)}日前（保存対象外）` : null),
        }).then(() => {}, () => {})

        // 除外記事は lead_candidate を作らずカウントのみ
        if (ex.is_excluded) { counts.excluded++; diag.excluded++; continue }
        // 保存条件: 公開日が判明していて3日(=saveDays)より古いものは lead_candidates に保存しない
        if (tooOld) { diag.tooOld = (diag.tooOld || 0) + 1; continue }

        // 外部情報補完（記事だけで電話なし/エリア不明を確定しない）。構造化ブロック(gg)で埋まっていれば補完不要
        let enrich: any = null
        const needEnrich = enrichEnabled && enrichBudget > 0 && !!(ggName || ex.shop_name) && (!(ex.phone || gg?.phone) || !(ex.address || gg?.address)) && !ex.is_chain && !ex.is_mall
        if (needEnrich) {
          enrich = await enrichCandidate(mapsKey, { shop: ggName || ex.shop_name, username: '', areaHint: gg?.address || ex.area || '', industry: ex.industry || '', havePhone: ex.phone || gg?.phone || '', haveAddress: ex.address || gg?.address || '' }, {
            maxQueries: enrichMaxQueries, perQuery: enrichPerQuery, skipQuery: enrichRecent,
            onQuery: (qq: string) => { counts.enrichQueries++; diag.enrichQueries = (diag.enrichQueries || 0) + 1; enrichQueriesToLog.add(qq) },
          })
          enrichBudget--; counts.enrichTried++
          if (enrich.status === 'enriched') counts.enrichSucceeded++
          if (enrich.phone) counts.enrichPhone++
          if (enrich.address) counts.enrichAddress++
          if (enrich.has_opening) counts.openingDateCount++
          if (enrich.business_status === 'FUTURE_OPENING') counts.futureOpeningCount++
        }
        const matchedPlaceId: string | null = enrich?.place_id || null
        const placeMatched = !!matchedPlaceId
        if (placeMatched) counts.placeMatched++

        // マージ（記事 → 構造化ブロック(gg) → 補完）。記事の都道府県とPlaces住所の都道府県が食い違う場合はHOLD寄りに
        const phone = ex.phone || gg?.phone || enrich?.phone || ''
        const address = ex.address || gg?.address || enrich?.address || null
        const prefecture = enrich?.prefecture || null
        const city = enrich?.city || null
        const areaMerged = ex.area || [prefecture, city].filter(Boolean).join('') || null
        const officialVal = enrich?.official || gg?.officialUrl || null
        const reservationVal = enrich?.reservation || null
        const lineVal = enrich?.line || null
        const instagramVal = enrich?.instagram || gg?.instagramUrl || null
        if (phone) counts.phoneYes++

        // 判定: HOTは店名＋電話＋（住所/市区町村 または Google開業日）必須（甘くしない）
        let temperature: string = 'HOLD'
        let reason = ''
        const recentOk = Number.isNaN(publishedMs) ? true : !tooOld
        const haveArea = !!(areaMerged || address)
        const strongOpening = !!enrich?.has_opening  // Google openingDate / FUTURE_OPENING
        const openNote = strongOpening ? `Google開業日(${enrich.opening_raw}${enrich.business_status === 'FUTURE_OPENING' ? '・開業予定' : ''})` : ''
        // 店名: 構造化ブロック(gg=CMS公式値) > Google Places正式名 > 記事抽出(整形) > タイトル「」内
        const sn = sanitizeShopName(ex.shop_name || '', { placesMatched: !!placeMatched })
        const fromTitle = sn.valid ? '' : extractShopFromTitle(bestTitle || '')
        const shopName = ggName || ((placeMatched && enrich?.place_name) ? enrich.place_name : (sn.valid ? sn.name : (fromTitle || ggNameWeak || '')))
        const nameValid = !!shopName
        const nameReason = nameValid ? '' : (sn.reason || '店名抽出失敗')
        // 日本国外は除外（海外住所/海外電話）
        const isForeign = isForeignAddress(address) || isForeignText(`${ex.shop_name || ''} ${bestTitle || ''}`) || (!!phone && !isJapanPhone(phone))
        const japanOk = !isForeign && (!!prefecture || isJapanAddress(address) || !!ex.area || isJapanPhone(phone))
        // 新店根拠（店名の有無に依存させない・新方針）
        const articleNew = recentOk || strongOpening || !!ex.open_date
        const chA = detectChain(shopName || ex.shop_name || '', bestTitle || '')
        const bigA0 = detectBigOrPublic(`${shopName || ex.shop_name || ''} ${address}`)
        const multiA = detectMultiStore(`${shopName || ex.shop_name || ''} ${bestTitle || ''} ${(meta.excerpt || '').slice(0, 200)}`)
        const bigA = { exclude: bigA0.exclude || multiA.exclude, reason: bigA0.exclude ? bigA0.reason : multiA.reason }
        const sc = scoreCandidate({
          source: 'regional_media', isJapan: japanOk, hasShopName: nameValid, hasPhone: !!phone && isJapanPhone(phone),
          hasArea: haveArea, hasOpeningDate: strongOpening || !!ex.open_date, isFuture: enrich?.business_status === 'FUTURE_OPENING',
          igNew: false, regionalNew: articleNew, newListing: false, placesMatched: !!placeMatched, hasOfficial: !!(officialVal || reservationVal || lineVal),
          isChain: !!ex.is_chain || chA.definite || bigA.exclude, chainSuspect: chA.suspect && !chA.definite, isOrg: bigA.exclude, isEventRecruit: !!ex.is_excluded, isForeign, isDup: false, reviewMany: false,
        }, mode)
        const tt = tierToTemperature(sc.tier)
        let hotTier = tt.hot_tier
        temperature = tt.temperature
        reason = sc.reason
        // 大手/公共/大型施設/道の駅/産直/JA等は営業対象外（個人事業主・小規模店ではない）→ EXCLUDED
        if (bigA.exclude) { temperature = 'EXCLUDED'; hotTier = null; reason = `${bigA.reason}${reason}` }
        // 実店舗ではない記事/ニュース/まとめ/映画告知、または住所がカテゴリナビ(「最新まとめ」等)→ 新店ではないのでEXCLUDED
        const gateName = shopName || ex.shop_name || ''
        const gateAddr = address || areaMerged || ''
        const isArticleText = looksLikeArticleText(`${gateName} ${bestTitle || ''}`)
        const bigStrongA = detectBigOrPublicStrong(`${gateName} ${bestTitle || ''}`)  // タイトル内のイオンモール/大手チェーン
        const isBranchA = looksLikeBranchStore(gateName)
        if (isArticleText || bigStrongA.exclude || isBranchA || !isRealStoreAddress(gateAddr)) {
          temperature = 'EXCLUDED'; hotTier = null
          reason = `実店舗ではない/営業対象外（${isBranchA ? '支店/チェーン店（○○店）' : bigStrongA.exclude ? bigStrongA.hit : isArticleText ? '記事/ニュース/告知の見出し' : '住所がカテゴリ/まとめ等で店舗住所ではない'}）のため除外。${reason}`
        }
        // ===== 新方針のHOT判定 =====
        const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
        const hasAreaOk = !!haveArea
        let nameUnconfirmedHot = false
        if (temperature === 'HOT') {
          // HOTは電話＋住所が必須（店名未確定でも可）
          if (!phoneOk) { temperature = 'HOLD'; hotTier = null; reason = `電話番号なし（または不正な形式）のためHOLD。${reason}` }
          else if (!hasAreaOk) { temperature = 'HOLD'; hotTier = null; reason = `住所なしのためHOLD。${reason}` }
          else if (!nameValid) { hotTier = 'B'; nameUnconfirmedHot = true; reason = `店名未確定だが電話・住所・新店根拠ありのため営業可能候補(HOT-B)。営業前に店名確認推奨。${reason}` }  // HOT-Aには上げない
        } else if (temperature === 'HOLD' && !nameValid && phoneOk && hasAreaOk && articleNew && !chA.definite && !isForeign) {
          // 店名未確定でHOLDだが 電話＋住所＋新店根拠 あり → HOT-Bへ昇格（営業前に店名確認）
          temperature = 'HOT'; hotTier = 'B'; nameUnconfirmedHot = true; reason = `店名未確定だが電話・住所・新店根拠ありのため営業可能候補(HOT-B)。営業前に店名確認推奨。${reason}`
        }

        if (temperature === 'HOT') { counts.hot++; diag.hot++; if (hotTier === 'A') counts.hotA++; else counts.hotB++ }
        else if (temperature === 'EXCLUDED') { counts.excluded++; diag.excluded = (diag.excluded || 0) + 1 }
        else { counts.hold++; diag.hold++ }
        counts.candidates++

        const name = shopName || '店名未確定'
        const enrichNote = enrich ? ` / 補完[${enrich.status}:${enrich.reason}]` : ''
        const newnessReason = `${site.name}「${bestTitle}」（${meta.published_at ? new Date(meta.published_at).toLocaleDateString('ja-JP') : '日付不明'}）${ex.open_date ? ` 開店日: ${ex.open_date}` : ''}${enrichNote} / ${reason}`

        // HOT未達理由（地域メディア向けチェックリスト）
        const rmConf = (phone ? 35 : 0) + (haveArea ? 25 : 0) + (strongOpening ? 20 : 0) + (placeMatched ? 15 : 0) + (officialVal ? 5 : 0)
        const rmChecks: HotCheck[] = [
          { key: 'has_japan', label: '日本国内', ok: isForeign ? false : (japanOk ? true : null), reasonKey: 'not_japan' },
          { key: 'has_shop_name', label: '店名あり', ok: !!ex.shop_name, reasonKey: 'shop_name_missing' },
          { key: 'has_industry', label: '業種推定', ok: ex.industry ? true : null, reasonKey: 'industry_unknown' },
          { key: 'has_area', label: '住所/市区町村あり', ok: haveArea ? true : false, reasonKey: 'address_missing', value: (address || areaMerged) || undefined },
          { key: 'has_phone', label: '日本の電話番号あり', ok: (phone && isJapanPhone(phone)) ? true : false, reasonKey: 'phone_missing', value: phone || undefined },
          { key: 'has_newness', label: '新店記事根拠あり', ok: (recentOk || strongOpening) ? true : null, reasonKey: 'newness_missing' },
          { key: 'has_opening_date', label: 'openingDate/開業予定あり', ok: strongOpening ? true : false, reasonKey: 'opening_date_missing' },
          { key: 'has_official', label: '公式/Places裏取りあり', ok: (officialVal || placeMatched) ? true : null, reasonKey: 'official_unverified' },
          { key: 'places_matched', label: 'Google Places一致', ok: placeMatched ? true : null, reasonKey: 'places_no_match' },
        ]
        const hotReject = buildHotReject({ source: 'regional_media', temperature, confidence: rmConf, hotRequiredScore: s.rmHotRequiredScore, checks: rmChecks })

        const payload: any = {
          name, address, industry: ex.industry || null,
          phone_number: phone || null, website_url: officialVal,
          lead_source: 'regional_media', source_type: 'AI自動投入(地域メディア)',
          hot_reject_reasons: hotReject.hot_reject_reasons, hot_reject_summary: hotReject.hot_reject_summary,
          hot_check_result: hotReject.hot_check_result, hot_missing_requirements: hotReject.hot_missing_requirements,
          hot_blocking_reason: hotReject.hot_blocking_reason, hot_required_score: hotReject.hot_required_score,
          lead_temperature: temperature, hot_tier: hotTier, recommended_status: nameUnconfirmedHot ? 'HOT_B' : sc.tier, is_new_gbp: placeMatched,
          should_exclude_from_call_list: temperature === 'EXCLUDED',
          name_unconfirmed_hot: nameUnconfirmedHot, phone_source: phone ? (enrich?.phone && !ex.phone ? 'enrich' : 'article') : null,
          owner_reachability_score: phone ? 70 : 30, parser_used: 'article_link_parser', source_list_url: crawlUrl,
          auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason,
          // 記事由来（元情報）
          source_article_url: link.url, source_article_title: bestTitle, source_site_name: site.name,
          source_article_excerpt: (meta.excerpt || '').slice(0, 300), source_media_family: site.media_family || null,
          extracted_shop_name_from_article: ex.shop_name || null, extracted_area_from_article: ex.area || null, extracted_open_date_from_article: ex.open_date || null,
          regional_media_detected_at: nowIso, extracted_open_date: ex.open_date || null,
          // 最終値（補完反映）
          extracted_shop_name: name, extracted_area: areaMerged, extracted_prefecture: prefecture, extracted_city: city,
          extracted_address: address, extracted_industry: ex.industry || null, extracted_phone: phone || ex.phone || null,
          line_url: lineVal, reservation_url: reservationVal, official_url: officialVal, instagram_url: instagramVal,
          regional_media_newness_reason: newnessReason,
          // 補完結果
          enrichment_status: enrich?.status || 'not_started', enrichment_sources: enrich?.sources || null,
          enriched_phone: enrich?.phone || null, enriched_address: enrich?.address || null,
          enriched_prefecture: enrich?.prefecture || null, enriched_city: enrich?.city || null,
          enriched_official_url: enrich?.official || null, enriched_instagram_url: enrich?.instagram || null,
          enriched_reservation_url: enrich?.reservation || null, enriched_line_url: enrich?.line || null,
          enriched_google_place_id: enrich?.place_id || null, enrichment_reason: enrich?.reason || null,
          enrichment_confidence: enrich?.confidence ?? null, last_enriched_at: enrich ? nowIso : null,
          // Google openingDate / businessStatus（補完経由）。開業日フィールド群は「Google一式 or テキスト一式」の
          // 二者択一でマージする（フィールド単位の??混合は禁止: enrichはGoogle開業日なしでもopening_confidence:0を
          // 返すため0がテキスト確度を潰す／duoとdsoが別系統から混ざり「両方非null」の規約違反行ができる／
          // テキスト日付がsource='external_enrichment'として裏取り済みに化ける、の3事故が実際に起きた）
          google_business_status: enrich?.business_status || null, google_opening_date_raw: enrich?.opening_raw || null,
          google_opening_date_year: enrich?.opening_year ?? null, google_opening_date_month: enrich?.opening_month ?? null, google_opening_date_day: enrich?.opening_day ?? null,
          has_google_opening_date: enrich?.has_opening || false,
          ...(enrich?.has_opening ? {
            opening_date_confidence: enrich.opening_confidence ?? null,
            days_until_opening: enrich.days_until_opening ?? null, days_since_opening: enrich.days_since_opening ?? null,
            opening_date_source: 'external_enrichment',
            ...(enrich.opening_year && enrich.opening_month ? { opening_date: `${enrich.opening_year}-${String(enrich.opening_month).padStart(2, '0')}-${String(enrich.opening_day || 1).padStart(2, '0')}` } : {}),
          } : odText ? {
            opening_date: odText.iso, opening_date_source: `article_text_${odText.precision}`, opening_date_confidence: odText.confidence,
            days_until_opening: odText.daysUntil, days_since_opening: odText.daysSince,
          } : {}),
          business_hours: gg?.hours || null,
          google_places_checked_at: enrich?.place_id ? nowIso : null, opening_date_checked_at: enrich?.has_opening ? nowIso : null,
          google_place_id: matchedPlaceId, matched_google_place_id: matchedPlaceId, match_confidence: enrich?.confidence ?? null,
          last_seen_at: nowIso, source_run_id: runId,
        }

        // 重複: source_article_url / 電話一致(cases)
        const { data: dupCand } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_article_url', link.url).limit(1)
        let candidateId: string | null = dupCand?.[0]?.id || null
        const alreadyImported = !!dupCand?.[0]?.imported_to_cases
        if (candidateId) {
          const { error } = await admin.from('lead_candidates').update(payload).eq('id', candidateId)
          if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else { counts.saved++; diag.saved++ }
        } else {
          const { data: ins, error } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
          if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else { counts.saved++; diag.saved++ }
          candidateId = ins?.id || null
        }

        // HOT自動投入（電話必須）。店名未確定HOT-Bも投入可（営業前に店名確認）
        await autoImportHot({ candidateId, tier: (nameUnconfirmedHot ? 'HOT_B' : sc.tier) as any, temperature, phone, alreadyImported, caseData: {
          name, address: payload.address || '', phone1: phone, industry: normalizeIndustry(ex.industry) || classifyIndustry(name) || null,
          status: DEFAULT_STATUS, priority: sc.priority === 'high' ? '高' : '中', hp1: payload.website_url, source_urls: link.url,
          memo: [`【AI自動投入 / 地域メディア / ${nameUnconfirmedHot ? 'HOT_B(店名未確定)' : sc.tier}】`, `店舗: ${name}`, `記事タイトル: ${bestTitle}`, `URL: ${link.url}`, `電話: ${phone || '—'}`, `住所: ${payload.address || '—'}`, `理由: ${reason}`, ...(nameUnconfirmedHot ? ['※営業前に店名確認推奨'] : [])].join('\n'), created_by_id: userId,
        } })

        if (!debug.sample) debug.sample = { site: site.name, title: bestTitle, url: link.url, published_at: meta.published_at, extracted: ex, enrich, temperature, reason, matchedPlaceId }
      }

      if (!diag.reason) {
        if (diag.candidateLinks > 0 && diag.recent === 0) diag.reason = `記事候補${diag.candidateLinks}件あるが3日以内の新着が0（日付条件で保存対象外）`
        else if (diag.saved === 0 && diag.candidateLinks > 0) diag.reason = '記事は取得できたが保存条件を満たさず（電話/店名/エリア/日付）'
        else diag.reason = 'OK'
      }
      diag.newArticles = used
      await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso, last_success_at: nowIso, latest_item_url: siteNewest || site.latest_item_url, last_seen_article_url: siteNewest || site.last_seen_article_url, last_new_count: siteNewArticles, last_seen_skipped: siteSeenSkipped, last_old_skipped: siteOldSkipped, last_crawl_result: `記事リンク${diag.candidateLinks}/新規${used}/既読skip${siteSeenSkipped} HOT${diag.hot}/HOLD${diag.hold}/除外${diag.excluded} ${diag.reason}`.slice(0, 200) }).eq('id', site.id)
      debug.siteResults.push(diag)
    }

    // 補完検索クエリの履歴を記録（7日スキップ用・IWと共通テーブル）
    for (const eq of enrichQueriesToLog) {
      await admin.from('ig_enrich_log').upsert({ query: eq, last_run_at: nowIso, runs: 1 }, { onConflict: 'query' }).then(() => {}, () => {})
    }
    // 概算コスト（補完検索のSerper回数）
    debug.estSerperCost = Math.round(counts.enrichQueries * 0.5 * 10) / 10
    // HOT件数と案件投入の整合性: HOT = 新規投入 + 既存投入済 + 手動投入待ち + 投入失敗
    debug.importReconcile = {
      hot: counts.hot, newImport: counts.imported, alreadyImported: counts.alreadyImported,
      manualPending: counts.manualPending, importFailed: counts.importFailed,
      sum: counts.imported + counts.alreadyImported + counts.manualPending + counts.importFailed,
      ok: counts.hot === (counts.imported + counts.alreadyImported + counts.manualPending + counts.importFailed),
    }

    await admin.from('auto_lead_runs').update({
      status: 'success', finished_at: new Date().toISOString(), search_queries_count: counts.sites,
      fetched_count: counts.newArticles, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded,
      imported_count: counts.imported, error_count: counts.error, error_message: errorMessage || null,
    }).eq('id', runId)

    return {
      ok: true, runId, ...counts, errorCount: counts.error, error: errorMessage || null,
      runMode, totalActiveSites: totalActiveSites || 0, processedSiteCount: list.length,
      processedSiteIds: list.map((x: any) => x.id), failedSites, batchSites,
      debug,
    }
  } catch (e: any) {
    const msg = String(e?.message || e)
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: msg }).eq('id', runId)
    throw new Error(msg)
  }
}

/**
 * 巡回テスト（DBへ書き込まない・cases投入しない）。
 * 1サイトのリストページから記事を取得し、URL/タイトル/公開日/3日以内判定/新店判定を返す。
 */
export async function testCrawlSite(site: any, maxArticles = 10, recentDays = 3) {
  const crawlUrl = site.list_url || site.base_url
  const out: any = {
    site: site.name, url: crawlUrl, ok: false, error: null as string | null, articles: [] as any[],
    diag: { fetchOk: false, status: 0, htmlLength: 0, totalLinks: 0, candidateLinks: 0, keywordHits: 0, reason: '' },
    counts: { articles: 0, recent: 0, open: 0, excluded: 0, hotLike: 0, holdLike: 0 },
  }
  let base: URL
  try { base = new URL(crawlUrl) } catch { out.error = 'URL不正'; out.diag.reason = 'list_url/base_url が不正'; return out }
  try {
    const allowed = await robotsAllows(base.origin, base.pathname)
    if (!allowed) { out.error = 'robots.txtにより不許可'; out.diag.reason = 'robots.txtにより不許可'; return out }
    const idx = await fetchHtml(crawlUrl)
    out.diag.fetchOk = idx.ok; out.diag.status = idx.status; out.diag.htmlLength = idx.length
    if (!idx.ok) { out.error = `リストページ取得失敗（${idx.error}）`; out.diag.reason = out.error; return out }
    out.ok = true
    const now = Date.now()
    const extracted = extractArticleLinks(idx.html, base, { mediaFamily: site.media_family, categoryLabel: site.category_label, listUrl: crawlUrl })
    out.diag.totalLinks = extracted.totalLinks; out.diag.candidateLinks = extracted.candidateLinks; out.diag.keywordHits = extracted.keywordHits
    if (extracted.links.length === 0) { out.diag.reason = `記事候補リンク0（全リンク${extracted.totalLinks}）。list_url/パーサー要確認`; return out }
    const links = extracted.links.slice(0, maxArticles)
    for (const link of links) {
      out.counts.articles++
      const ah = await fetchText(link.url)
      await sleep(300)
      const body = ah ? stripTags(ah) : ''
      const meta = ah ? articleMeta(ah) : { published_at: null, excerpt: '', title: '' }
      const bestTitle = meta.title && meta.title.length >= link.title.length ? meta.title : (link.title || meta.title)
      const ex = extractFromArticle(bestTitle, body.slice(0, 4000))
      const pubMs = meta.published_at ? Date.parse(meta.published_at) : NaN
      const within = !Number.isNaN(pubMs) && (now - pubMs) <= recentDays * 86400000
      const isOpen = ex.detected_type === 'open' || ex.detected_type === 'reopen'
      if (within) out.counts.recent++
      if (isOpen && !ex.is_excluded) out.counts.open++
      let est = 'HOLD'
      if (ex.is_excluded) { out.counts.excluded++; est = 'EXCLUDED' }
      else if (isOpen && ex.shop_name && ex.area && ex.phone) { out.counts.hotLike++; est = 'HOT候補' }
      else { out.counts.holdLike++ }
      // テストでは3日以内でなくても「抽出できた記事」として表示する
      out.articles.push({
        url: link.url, title: bestTitle, published_at: meta.published_at, within_recent: within,
        detected_type: ex.detected_type, is_new: isOpen && !ex.is_excluded, shop_name: ex.shop_name,
        area: ex.area, phone: ex.phone, estimate: est, exclusion_reason: ex.is_excluded ? ex.exclude_reason : null,
      })
    }
    out.diag.reason = out.counts.recent === 0 ? `記事は取得できたが3日以内が0（保存は3日以内のみ／テストは全件表示）` : 'OK'
  } catch (e: any) { out.error = String(e?.message || e); out.diag.reason = out.error }
  return out
}

/** 全有効サイトをテスト巡回（DB書き込みなし） */
export async function testCrawlAll(admin: any, maxArticles = 5, recentDays = 3) {
  const { data: sites } = await admin.from('source_sites').select('*').eq('is_active', true)
  const list = sites || []
  const agg = { activeSites: list.length, success: 0, fail: 0, articles: 0, recent: 0, candidates: 0, hot: 0, hold: 0, excluded: 0 }
  const results: any[] = []
  for (const site of list) {
    const r = await testCrawlSite(site, maxArticles, recentDays)
    if (r.ok) agg.success++; else agg.fail++
    agg.articles += r.counts.articles; agg.recent += r.counts.recent
    agg.candidates += r.counts.open; agg.hot += r.counts.hotLike; agg.hold += r.counts.holdLike; agg.excluded += r.counts.excluded
    results.push({ site: r.site, ok: r.ok, error: r.error, status: r.diag?.status, htmlLength: r.diag?.htmlLength, totalLinks: r.diag?.totalLinks, candidateLinks: r.diag?.candidateLinks, reason: r.diag?.reason, ...r.counts })
  }
  return { ...agg, results }
}

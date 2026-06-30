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
import { extractDirectoryListingLinks, extractDirectoryShopInfo, classifyDirectoryCandidate } from './directoryParser.js'
import { detectParserType, extractNewnessBlocks } from './regionalParsers.js'
import { autoImportAllowed, scoreCandidate, tierToTemperature, type InjectMode, type HotTier } from './hotTier.js'
// Instagram Web検索と共通の外部情報補完ロジックを再利用
import { enrichCandidate } from './instagramWebRun.js'

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
const UA = 'RST-CRM-bot/1.0 (+lead research; respects robots.txt)'

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

const EXCLUDE_PATH = /\/(category|tag|author|page|search|feed|amp|wp-admin|wp-content|wp-json|wp-login|about|contact|privacy|policy|sitemap|ranking|login|mypage|profile|terms|company|recruit)\b/i

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
    const sameRoot = abs.host.split('.').slice(-2).join('.') === base.host.split('.').slice(-2).join('.')
    if (!sameHost && !sameRoot) continue
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
  const maxSites = Math.max(1, Number(s.maxSitesPerDay) || 3)
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
  const counts = { sites: 0, articles: 0, newArticles: 0, candidates: 0, placeMatched: 0, phoneYes: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, saved: 0, saveError: 0, error: 0, enrichTried: 0, enrichSucceeded: 0, enrichPhone: 0, enrichAddress: 0, enrichQueries: 0, openingDateCount: 0, futureOpeningCount: 0, timeouts: 0, detailFetches: 0, deferredSites: 0, deferredDetails: 0, dupImportSkip: 0, alreadyImported: 0, manualPending: 0, importFailed: 0 }
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
    const { data: sites } = await admin.from('source_sites').select('*').eq('is_active', true).neq('source_type', 'sequential_id_probe')
      .order('last_crawled_at', { ascending: true, nullsFirst: true }).limit(maxSites)
    const list = sites || []
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
        attempted = true
        const { data: created, error } = await admin.from('cases').insert(o.caseData).select('id').single()
        if (error || !created?.id) { errMsg = error?.message || 'case作成失敗'; counts.importFailed++ }
        else { success = true; caseId = created.id; counts.imported++; importedThisRun++; importedCount++ }
      }
      if (o.candidateId) {
        await admin.from('lead_candidates').update({
          auto_insert_attempted: attempted, auto_insert_success: success, auto_insert_skipped_reason: skip || null, auto_insert_error: errMsg || null,
          imported_case_id: caseId, ...(success ? { imported_to_cases: true, imported_at: nowIso } : {}),
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
      const crawlUrl = site.list_url || site.base_url
      let base: URL
      try { base = new URL(crawlUrl) } catch { debug.siteResults.push({ site: site.name, error: 'invalid base_url' }); await admin.from('source_sites').update({ last_crawl_result: 'URL不正' }).eq('id', site.id).then(() => {}, () => {}); continue }

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
        for (const item of dr.links.slice(0, maxArticles * 2)) {
          if (used >= maxArticles) break
          // 504回避: 時間/件数の上限に達したら次回に継続
          if (overBudget() || !detailBudgetLeft()) { counts.deferredDetails++; diag.reason = `詳細取得を${used}件で打ち切り（時間/件数上限・次回継続）`; break }
          const dhash = urlHash(item.url)
          const { data: exA } = await admin.from('source_articles').select('id').eq('article_url_hash', dhash).limit(1)
          // 既存lead候補（source_detail_url）も確認（HOLD→電話/住所が取れたら補完更新）
          const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases,phone_number,address').eq('source_detail_url', item.url).limit(1)
          const existingCand = exC?.[0] || null
          if (exA?.[0] && existingCand && existingCand.phone_number && existingCand.address) continue // 既に十分取得済み
          counts.articles++; counts.newArticles++; used++

          const dRes = await fetchHtml(item.url, DETAIL_TIMEOUT_MS)
          counts.detailFetches++
          await sleep(delay)
          if (!dRes.ok) { if (dRes.timedOut) { counts.timeouts++; diag.timeouts++ } diag.reason = diag.reason || (dRes.timedOut ? '詳細ページがタイムアウト' : '詳細ページ取得失敗'); continue }
          const dHtml = dRes.html
          diag.detailFetched++
          const info = extractDirectoryShopInfo(dHtml, item.title)
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
          const dc = classifyDirectoryCandidate({ shop_name: info.shop_name, phone, address, open, isJapan }, mode)
          const temperature = dc.temperature
          if (temperature === 'HOT') { counts.hot++; diag.hot++; if (dc.hot_tier === 'A') counts.hotA++; else counts.hotB++ }
          else if (temperature === 'EXCLUDED') { counts.excluded++; diag.excluded++ }
          else { counts.hold++; diag.hold++ }
          counts.candidates++

          const name = info.shop_name || '店舗ディレクトリ候補'
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
            lead_temperature: temperature, hot_tier: dc.hot_tier, recommended_status: dc.tier, is_new_gbp: !!matchedPlaceId, should_exclude_from_call_list: temperature === 'EXCLUDED',
            owner_reachability_score: phone ? 70 : 35, auto_import_reason: temperature === 'HOT' ? dc.reason : null, ai_comment: dc.reason,
            regional_media_newness_reason: newnessReason, regional_media_detected_at: nowIso,
            newness_type: 'new_listing_open',
            extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null,
            extracted_area: address || [prefecture, city].filter(Boolean).join('') || null, extracted_prefecture: prefecture, extracted_city: city,
            extracted_industry: info.industry || null,
            extracted_open_date: open.iso || open.text || null, extracted_open_date_text: open.text || null,
            extracted_open_month: open.month, extracted_open_day: open.day, extracted_open_date_confidence: open.confidence,
            instagram_url: instagram, official_url: official, map_url: info.map_url || null,
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

          const importStatus = await autoImportHot({ candidateId, tier: dc.tier, temperature, phone, alreadyImported, caseData: {
            name, address: address || '', phone1: phone, industry: info.industry || null,
            status: DEFAULT_STATUS, priority: dc.priority === 'high' ? '高' : '中', hp1: official, instagram, source_urls: item.url,
            memo: [`【AI自動投入 / 店舗ディレクトリ / ${dc.tier}】`, `店舗: ${name}`, `URL: ${item.url}`, `理由: ${dc.reason}`].join('\n'), created_by_id: userId,
          } })
          void importStatus

          if (!debug.sample || debug.sample.siteType !== 'local_directory_new_listing') {
            debug.sample = { siteType: 'local_directory_new_listing', site: site.name, detailUrl: item.url, shop_name: name, phone, address, open_date: open.text, industry: info.industry, temperature, reason: dc.reason }
          }
        }
        diag.newArticles = used
        if (!diag.reason) diag.reason = diag.saved > 0 ? 'OK' : (diag.detailLinks > 0 ? '詳細は取得したが保存条件を満たさず' : '店舗詳細リンクなし')
        await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso, last_crawl_result: `[店舗新着]詳細${diag.detailLinks}/取得${diag.detailFetched} 電話${diag.phoneYes}/住所${diag.addressYes} HOT${diag.hot}/HOLD${diag.hold} ${diag.reason}`.slice(0, 200) }).eq('id', site.id)
        debug.siteResults.push(diag)
        continue
      }

      // ===== マーケットプレイス/検索結果・カード型（HORBY等）＋ 汎用本文スキャン =====
      if (stype === 'marketplace_listing' || stype === 'generic_page_text_scan') {
        diag.parser_used = stype === 'marketplace_listing' ? 'marketplace_card_parser' : 'generic_card_parser'
        const { candidates, stats } = extractNewnessBlocks(idx.html, base)
        diag.totalLinks = stats.totalLinks; diag.bodyTextLen = stats.bodyTextLen; diag.blockCount = stats.blockCount
        diag.keywordBlocks = stats.keywordBlocks; diag.detailLinks = stats.detailLinks; diag.newBadge = stats.newBadge
        diag.cardCandidates = candidates.length; diag.jsLikely = stats.jsLikely
        diag.detailFetched = 0; diag.phoneYes = 0; diag.addressYes = 0; diag.openYes = 0
        if (candidates.length === 0) {
          diag.reason = stats.jsLikely
            ? `HTMLは取得できたが本文が少なくJSレンダリングの可能性（本文${stats.bodyTextLen}字）。静的HTMLに店舗情報なし`
            : stats.keywordBlocks > 0
              ? `新店キーワード一致ブロック${stats.keywordBlocks}件あるが店名/詳細リンクが取れず候補化できず`
              : `記事リンク0・店舗カード候補0（ブロック${stats.blockCount}/新店語一致${stats.keywordBlocks}）。本文に新店キーワードなし`
        }
        let used = 0
        for (const cand of candidates.slice(0, maxArticles * 2)) {
          if (used >= maxArticles) break
          if (overBudget() || !detailBudgetLeft()) { counts.deferredDetails++; diag.reason = `カード${used}件で打ち切り（時間/件数上限・次回継続）`; break }
          const detailUrl = cand.detailUrl || crawlUrl
          const dhash = urlHash(detailUrl + '|' + cand.shopName)
          const { data: exA } = await admin.from('source_articles').select('id').eq('article_url_hash', dhash).limit(1)
          const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases,phone_number,address').eq('source_detail_url', detailUrl).limit(1)
          const existingCand = exC?.[0] || null
          if (exA?.[0] && existingCand && existingCand.phone_number && existingCand.address) continue
          counts.articles++; counts.newArticles++; used++

          // 詳細ページ取得（カードに詳細リンクがあれば）
          let info: any = { shop_name: cand.shopName, phone: cand.phone, address: cand.address, industry: cand.industry, official_url: '', instagram_url: '', map_url: '', open: cand.open, hours: '', holiday: '', excerpt: cand.blockText }
          let detailStatus = 'no_detail_link'
          if (cand.detailUrl) {
            const dRes = await fetchHtml(cand.detailUrl, DETAIL_TIMEOUT_MS); counts.detailFetches++
            await sleep(delay)
            if (dRes.ok) { diag.detailFetched++; detailStatus = 'fetched'; const di = extractDirectoryShopInfo(dRes.html, cand.shopName); info = { ...info, shop_name: di.shop_name || cand.shopName, phone: di.phone || cand.phone, address: di.address || cand.address, industry: di.industry || cand.industry, official_url: di.official_url, instagram_url: di.instagram_url, map_url: di.map_url, open: (di.open.confidence !== 'none' ? di.open : cand.open) } }
            else { detailStatus = dRes.timedOut ? 'timeout' : 'failed'; if (dRes.timedOut) { counts.timeouts++; diag.timeouts++ } }
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
          const dc = classifyDirectoryCandidate({ shop_name: info.shop_name, phone, address, open, isJapan }, mode)
          const temperature = dc.temperature
          if (temperature === 'HOT') { counts.hot++; diag.hot++; if (dc.hot_tier === 'A') counts.hotA++; else counts.hotB++ }
          else if (temperature === 'EXCLUDED') { counts.excluded++; diag.excluded++ }
          else { counts.hold++; diag.hold++ }
          counts.candidates++

          const name = info.shop_name || '新店候補'
          const newnessReason = `${site.name}（${diag.parser_used}）「${name}」${open.text ? ` ${open.text}` : ''} 一致語[${cand.matchedKeywords.join('・')}]${enrich ? ` / 補完[${enrich.status}]` : ''} / ${dc.reason}`
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
            source_list_url: crawlUrl, source_listing_url: crawlUrl, source_detail_url: detailUrl, source_article_url: detailUrl,
            search_title: name.slice(0, 300), search_snippet: cand.blockText, candidate_block_text_short: cand.blockText, detail_fetch_status: detailStatus,
            matched_keywords: cand.matchedKeywords, newness_type: stype === 'marketplace_listing' ? 'marketplace_new_listing' : 'generic_new_block',
            lead_temperature: temperature, hot_tier: dc.hot_tier, recommended_status: dc.tier, is_new_gbp: !!matchedPlaceId, should_exclude_from_call_list: temperature === 'EXCLUDED',
            owner_reachability_score: phone ? 70 : 35, auto_import_reason: temperature === 'HOT' ? dc.reason : null, ai_comment: dc.reason,
            regional_media_newness_reason: newnessReason, regional_media_detected_at: nowIso,
            extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null,
            extracted_area: address || [prefecture, city].filter(Boolean).join('') || null, extracted_prefecture: prefecture, extracted_city: city,
            extracted_industry: info.industry || null,
            extracted_open_date: open.iso || open.text || null, extracted_open_date_text: open.text || null,
            extracted_open_month: open.month, extracted_open_day: open.day, extracted_open_date_confidence: open.confidence,
            instagram_url: instagram, official_url: official, map_url: info.map_url || null,
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
          await autoImportHot({ candidateId, tier: dc.tier, temperature, phone, alreadyImported, caseData: {
            name, address: address || '', phone1: phone, industry: info.industry || null, status: DEFAULT_STATUS, priority: dc.priority === 'high' ? '高' : '中', hp1: official, instagram, source_urls: detailUrl,
            memo: [`【AI自動投入 / ${diag.parser_used} / ${dc.tier}】`, `店舗: ${name}`, `URL: ${detailUrl}`, `理由: ${dc.reason}`].join('\n'), created_by_id: userId,
          } })
          if (!debug.sample || debug.sample.siteType !== stype) debug.sample = { siteType: stype, parser_used: diag.parser_used, site: site.name, detailUrl, shop_name: name, phone, address, open_date: open.text, industry: info.industry, matched: cand.matchedKeywords, temperature, reason: dc.reason }
        }
        diag.newArticles = used
        if (!diag.reason) diag.reason = diag.saved > 0 ? 'OK' : (diag.cardCandidates > 0 ? 'カード候補はあるが保存条件を満たさず' : '新店カード候補なし')
        await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso, last_crawl_result: `[${diag.parser_used}]カード${diag.cardCandidates}/詳細${diag.detailFetched} 電話${diag.phoneYes}/住所${diag.addressYes} HOT${diag.hot}/HOLD${diag.hold} ${diag.reason}`.slice(0, 200) }).eq('id', site.id)
        debug.siteResults.push(diag)
        continue
      }

      diag.parser_used = 'article_link_parser'
      const extracted = extractArticleLinks(idx.html, base, linkOpts)
      diag.totalLinks = extracted.totalLinks; diag.candidateLinks = extracted.candidateLinks; diag.keywordHits = extracted.keywordHits
      const links = extracted.links.slice(0, maxArticles * 2)
      if (links.length === 0) diag.reason = `記事候補リンク0（全リンク${extracted.totalLinks}・新店語一致${extracted.keywordHits}）。list_url/パーサーを確認`

      let used = 0
      for (const link of links) {
        if (used >= maxArticles) break
        // 504回避: 時間/件数の上限に達したら次回に継続
        if (overBudget() || !detailBudgetLeft()) { counts.deferredDetails++; diag.reason = `記事取得を${used}件で打ち切り（時間/件数上限・次回継続）`; break }
        counts.articles++
        const hash = urlHash(link.url)
        const { data: exA } = await admin.from('source_articles').select('id').eq('article_url_hash', hash).limit(1)
        if (exA && exA[0]) continue // 同一URLは再取得しない
        counts.newArticles++; used++

        const aRes = await fetchHtml(link.url, DETAIL_TIMEOUT_MS)
        counts.detailFetches++
        if (aRes.timedOut) { counts.timeouts++; diag.timeouts++ }
        const html = aRes.ok ? aRes.html : null
        await sleep(delay)
        const body = html ? stripTags(html) : ''
        const meta = html ? articleMeta(html) : { published_at: null, excerpt: '', title: '' }
        const bestTitle = meta.title && meta.title.length >= link.title.length ? meta.title : (link.title || meta.title)
        const ex = extractFromArticle(bestTitle, body.slice(0, 4000))

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

        // 外部情報補完（記事だけで電話なし/エリア不明を確定しない）。電話or住所が無ければ実行
        let enrich: any = null
        const needEnrich = enrichEnabled && enrichBudget > 0 && !!ex.shop_name && (!ex.phone || !ex.address) && !ex.is_chain && !ex.is_mall
        if (needEnrich) {
          enrich = await enrichCandidate(mapsKey, { shop: ex.shop_name, username: '', areaHint: ex.area || '', industry: ex.industry || '', havePhone: ex.phone || '', haveAddress: ex.address || '' }, {
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

        // マージ（記事 → 補完）。記事の都道府県とPlaces住所の都道府県が食い違う場合はHOLD寄りに
        const phone = ex.phone || enrich?.phone || ''
        const address = ex.address || enrich?.address || null
        const prefecture = enrich?.prefecture || null
        const city = enrich?.city || null
        const areaMerged = ex.area || [prefecture, city].filter(Boolean).join('') || null
        const officialVal = enrich?.official || null
        const reservationVal = enrich?.reservation || null
        const lineVal = enrich?.line || null
        const instagramVal = enrich?.instagram || null
        if (phone) counts.phoneYes++

        // 判定: HOTは店名＋電話＋（住所/市区町村 または Google開業日）必須（甘くしない）
        let temperature: string = 'HOLD'
        let reason = ''
        const recentOk = Number.isNaN(publishedMs) ? true : !tooOld
        const haveArea = !!(areaMerged || address)
        const strongOpening = !!enrich?.has_opening  // Google openingDate / FUTURE_OPENING
        const openNote = strongOpening ? `Google開業日(${enrich.opening_raw}${enrich.business_status === 'FUTURE_OPENING' ? '・開業予定' : ''})` : ''
        // 日本国外は除外（海外住所/海外電話）
        const isForeign = isForeignAddress(address) || isForeignText(`${ex.shop_name || ''} ${bestTitle || ''}`) || (!!phone && !isJapanPhone(phone))
        const japanOk = !isForeign && (!!prefecture || isJapanAddress(address) || !!ex.area || isJapanPhone(phone))
        // 営業向きHOT判定（HOT_A/HOT_B/HOLD/EXCLUDED）: 新店記事＝新店根拠。openingDateは加点（必須にしない）
        const articleNew = !!ex.shop_name && (recentOk || strongOpening || !!ex.open_date)
        const sc = scoreCandidate({
          source: 'regional_media', isJapan: japanOk, hasShopName: !!ex.shop_name, hasPhone: !!phone && isJapanPhone(phone),
          hasArea: haveArea, hasOpeningDate: strongOpening || !!ex.open_date, isFuture: enrich?.business_status === 'FUTURE_OPENING',
          igNew: false, regionalNew: articleNew, newListing: false, placesMatched: !!placeMatched, hasOfficial: !!(officialVal || reservationVal || lineVal),
          isChain: !!ex.is_chain, isOrg: false, isEventRecruit: !!ex.is_excluded, isForeign, isDup: false, reviewMany: false,
        }, mode)
        const tt = tierToTemperature(sc.tier)
        temperature = tt.temperature
        const hotTier = tt.hot_tier
        reason = sc.reason

        if (temperature === 'HOT') { counts.hot++; diag.hot++; if (hotTier === 'A') counts.hotA++; else counts.hotB++ }
        else if (temperature === 'EXCLUDED') { counts.excluded++; diag.excluded = (diag.excluded || 0) + 1 }
        else { counts.hold++; diag.hold++ }
        counts.candidates++

        const name = ex.shop_name || `${ex.area || ''}${ex.industry || ''}`.trim() || '地域メディア候補'
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
          lead_temperature: temperature, hot_tier: hotTier, recommended_status: sc.tier, is_new_gbp: placeMatched,
          should_exclude_from_call_list: temperature === 'EXCLUDED',
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
          // Google openingDate / businessStatus（補完経由）
          google_business_status: enrich?.business_status || null, google_opening_date_raw: enrich?.opening_raw || null,
          google_opening_date_year: enrich?.opening_year ?? null, google_opening_date_month: enrich?.opening_month ?? null, google_opening_date_day: enrich?.opening_day ?? null,
          has_google_opening_date: enrich?.has_opening || false, opening_date_confidence: enrich?.opening_confidence ?? null,
          days_until_opening: enrich?.days_until_opening ?? null, days_since_opening: enrich?.days_since_opening ?? null,
          opening_date_source: enrich?.has_opening ? 'external_enrichment' : null,
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

        // HOT自動投入（電話必須）
        await autoImportHot({ candidateId, tier: sc.tier, temperature, phone, alreadyImported, caseData: {
          name, address: payload.address || '', phone1: phone, industry: ex.industry || null,
          status: DEFAULT_STATUS, priority: sc.priority === 'high' ? '高' : '中', hp1: payload.website_url, source_urls: link.url,
          memo: [`【AI自動投入 / 地域メディア / ${sc.tier}】`, `記事: ${link.title}`, `URL: ${link.url}`, `理由: ${reason}`].join('\n'), created_by_id: userId,
        } })

        if (!debug.sample) debug.sample = { site: site.name, title: bestTitle, url: link.url, published_at: meta.published_at, extracted: ex, enrich, temperature, reason, matchedPlaceId }
      }

      if (!diag.reason) {
        if (diag.candidateLinks > 0 && diag.recent === 0) diag.reason = `記事候補${diag.candidateLinks}件あるが3日以内の新着が0（日付条件で保存対象外）`
        else if (diag.saved === 0 && diag.candidateLinks > 0) diag.reason = '記事は取得できたが保存条件を満たさず（電話/店名/エリア/日付）'
        else diag.reason = 'OK'
      }
      diag.newArticles = used
      await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso, last_crawl_result: `リンク${diag.candidateLinks}/新着${used} HOT${diag.hot}/HOLD${diag.hold}/除外${diag.excluded} ${diag.reason}`.slice(0, 200) }).eq('id', site.id)
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

    return { ok: true, runId, ...counts, debug }
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

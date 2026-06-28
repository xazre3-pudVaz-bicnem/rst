// ============================================================
// 地域情報サイト巡回ロジック（サーバー専用）
// robots.txt尊重・レート制限・同一URL再取得回避。記事本文は保存しない。
// 新店系記事 → 抽出 → 任意でPlaces照合 → HOT/HOLD/EXCLUDED → HOTのみcases投入。
// ============================================================
import { classifyLead } from './leadScoring.js'
import { DEFAULT_STATUS } from './constants.js'
import { searchLight, placeDetails, phoneOf, reviewDates, parseOpeningDate } from './googlePlacesRun.js'
import { extractFromArticle, isOpenTitle, urlHash } from './regionalExtract.js'

export function getDefaultRegionalSettings() {
  return {
    regionalEnabled: true,
    maxSitesPerDay: 3,
    maxArticlesPerSite: 5,
    periodDays: 30,
    saveDays: 3,        // lead_candidates へ保存する公開日の上限（既定3日以内）
    requirePhone: true,
    dailyCap: 30,
    fetchDelayMs: 800,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UA = 'RST-CRM-bot/1.0 (+lead research; respects robots.txt)'

async function fetchHtml(url: string, timeoutMs = 12000): Promise<{ ok: boolean; status: number; html: string; length: number; error: string | null }> {
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.8' }, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(to)
    const ct = res.headers.get('content-type') || ''
    if (!res.ok) return { ok: false, status: res.status, html: '', length: 0, error: `HTTP ${res.status}` }
    if (ct && !/text|html|xml|json/i.test(ct)) return { ok: false, status: res.status, html: '', length: 0, error: `非HTML(${ct})` }
    const html = await res.text()
    return { ok: true, status: res.status, html, length: html.length, error: null }
  } catch (e: any) { return { ok: false, status: 0, html: '', length: 0, error: String(e?.message || e).slice(0, 120) } }
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string | null> {
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

  const counts = { sites: 0, articles: 0, newArticles: 0, candidates: 0, placeMatched: 0, phoneYes: 0, hot: 0, hold: 0, excluded: 0, imported: 0, saved: 0, saveError: 0, error: 0 }
  const debug: any = { siteResults: [] as any[], sample: null, saveErrors: [] as string[] }
  let errorMessage = ''

  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'regional_media', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  try {
    const { data: sites } = await admin.from('source_sites').select('*').eq('is_active', true)
      .order('last_crawled_at', { ascending: true, nullsFirst: true }).limit(maxSites)
    const list = sites || []
    const nowIso = new Date().toISOString()
    const now = Date.now()

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount = importedToday || 0

    for (const site of list) {
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

      const idx = await fetchHtml(crawlUrl)
      await sleep(delay)
      const linkOpts: LinkOpts = { mediaFamily: site.media_family, categoryLabel: site.category_label, listUrl: crawlUrl }
      const diag: any = { site: site.name, url: crawlUrl, fetchOk: idx.ok, status: idx.status, htmlLength: idx.length, totalLinks: 0, candidateLinks: 0, keywordHits: 0, recent: 0, saved: 0, hot: 0, hold: 0, excluded: 0, error: idx.error, reason: '' }
      if (!idx.ok) {
        counts.error++; diag.reason = `リスト取得失敗（${idx.error}）`
        debug.siteResults.push(diag)
        await admin.from('source_sites').update({ last_crawled_at: nowIso, last_crawl_result: `取得失敗 ${idx.error}` }).eq('id', site.id)
        continue
      }
      const extracted = extractArticleLinks(idx.html, base, linkOpts)
      diag.totalLinks = extracted.totalLinks; diag.candidateLinks = extracted.candidateLinks; diag.keywordHits = extracted.keywordHits
      const links = extracted.links.slice(0, maxArticles * 2)
      if (links.length === 0) diag.reason = `記事候補リンク0（全リンク${extracted.totalLinks}・新店語一致${extracted.keywordHits}）。list_url/パーサーを確認`

      let used = 0
      for (const link of links) {
        if (used >= maxArticles) break
        counts.articles++
        const hash = urlHash(link.url)
        const { data: exA } = await admin.from('source_articles').select('id').eq('article_url_hash', hash).limit(1)
        if (exA && exA[0]) continue // 同一URLは再取得しない
        counts.newArticles++; used++

        const html = await fetchText(link.url)
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

        // 任意: Google Places照合（必須にしない）
        let placeMatched = false, placeHot = false, confidence = 0
        let matchedPlaceId: string | null = null, placeFields: any = {}
        if (mapsKey && ex.shop_name && ex.area) {
          const r = await searchLight(mapsKey, `${ex.shop_name} ${ex.area}`, 3)
          const top = r.places?.[0]
          if (top) {
            confidence = matchConfidence(ex.shop_name, top.displayName?.text || '')
            if (confidence >= 80) {
              placeMatched = true; matchedPlaceId = top.id || null; counts.placeMatched++
              const detail = matchedPlaceId ? await placeDetails(mapsKey, matchedPlaceId) : null
              const p = detail || top; placeFields = p
              const { oldest, latest } = reviewDates(p)
              const classified: any = classifyLead({
                name: ex.shop_name, address: ex.address || top.formattedAddress || '', industry: ex.industry || undefined,
                phone_number: phoneOf(p), website_url: p.websiteUri || '', place_id: matchedPlaceId || undefined,
                is_new_gbp: true, review_count: typeof p.userRatingCount === 'number' ? p.userRatingCount : undefined,
                business_status: p.businessStatus || undefined, opening_date: parseOpeningDate(p.openingDate) || undefined,
                from_new_open_query: true, oldest_review_publish_time: oldest || undefined, latest_review_publish_time: latest || undefined,
              }, [], { hotMaxReviews: 5, warmMaxReviews: 15, exclude100: true, unknownHold: true })
              placeHot = classified.lead_temperature === 'HOT'
            }
          }
        }

        const phone = placeMatched ? (phoneOf(placeFields) || ex.phone) : ex.phone
        if (phone) counts.phoneYes++

        // 判定（量より質）
        let temperature: string = 'HOLD'
        let reason = ''
        const recentOk = Number.isNaN(publishedMs) ? true : !tooOld
        if (!ex.shop_name || !ex.area) { temperature = 'HOLD'; reason = '店名またはエリアの抽出精度が低いためHOLD。' }
        else if (!recentOk) { temperature = 'HOLD'; reason = `記事公開が${Math.round((now - publishedMs) / 86400000)}日前で対象期間外のためHOLD。` }
        else if (placeMatched && placeHot && phone) { temperature = 'HOT'; reason = `地域メディア新店記事＋Google Placesで同一店舗確認、電話・口コミ日付が厳格条件を満たすためHOT。` }
        else if (phone) { temperature = 'HOLD'; reason = placeMatched ? '電話は取れたがGBPの口コミ条件未達のためHOLD（要確認）。' : 'Google Places未照合のためHOLD（電話は取得済み・要確認）。' }
        else { temperature = 'HOLD'; reason = '電話番号が取得できないためHOLD（自動投入しない）。' }

        if (temperature === 'HOT') { counts.hot++; diag.hot++ } else { counts.hold++; diag.hold++ }
        counts.candidates++

        const name = ex.shop_name || `${ex.area}${ex.industry}`.trim() || '地域メディア候補'
        const newnessReason = `${site.name}「${bestTitle}」（${meta.published_at ? new Date(meta.published_at).toLocaleDateString('ja-JP') : '日付不明'}）${ex.open_date ? ` 開店日: ${ex.open_date}` : ''} / ${reason}`

        const payload: any = {
          name, address: ex.address || (placeMatched ? placeFields.formattedAddress : '') || null, industry: ex.industry || null,
          phone_number: phone || null, website_url: placeFields.websiteUri || null,
          lead_source: 'regional_media', source_type: 'AI自動投入(地域メディア)',
          lead_temperature: temperature, is_new_gbp: placeMatched,
          should_exclude_from_call_list: temperature === 'EXCLUDED',
          owner_reachability_score: phone ? 70 : 30,
          auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason,
          source_article_url: link.url, source_article_title: bestTitle, source_site_name: site.name,
          regional_media_detected_at: nowIso, extracted_open_date: ex.open_date || null,
          extracted_shop_name: ex.shop_name || null, extracted_area: ex.area || null, extracted_address: ex.address || null,
          extracted_industry: ex.industry || null, regional_media_newness_reason: newnessReason,
          google_place_id: matchedPlaceId, matched_google_place_id: matchedPlaceId, match_confidence: confidence || null,
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
        if (temperature === 'HOT' && phone && candidateId && !alreadyImported && importedCount < dailyCap) {
          const memo = [`【AI自動投入 / 地域メディア】`, `記事: ${link.title}`, `URL: ${link.url}`, `理由: ${reason}`].join('\n')
          const { data: created } = await admin.from('cases').insert({
            name, address: payload.address || '', phone1: phone, industry: ex.industry || null,
            status: DEFAULT_STATUS, hp1: payload.website_url, source_urls: link.url, memo, created_by_id: userId,
          }).select('id').single()
          if (created?.id) {
            await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId)
            counts.imported++; importedCount++
          }
        }

        if (!debug.sample) debug.sample = { site: site.name, title: bestTitle, url: link.url, published_at: meta.published_at, extracted: ex, temperature, reason, confidence, matchedPlaceId }
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

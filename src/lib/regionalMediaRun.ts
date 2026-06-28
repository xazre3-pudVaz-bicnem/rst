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
    requirePhone: true,
    dailyCap: 30,
    fetchDelayMs: 800,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UA = 'RST-CRM-bot/1.0 (+lead research; respects robots.txt)'

async function fetchText(url: string, timeoutMs = 12000): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, signal: ctrl.signal })
    clearTimeout(to)
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (!/text|html|xml/i.test(ct)) return null
    return await res.text()
  } catch { return null }
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

/** カテゴリページHTMLから記事リンク（同一ドメイン・新店系タイトル）を抽出 */
function extractArticleLinks(html: string, base: URL): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]
    const title = stripTags(m[2]).slice(0, 120)
    if (!title || title.length < 6) continue
    let abs: URL
    try { abs = new URL(href, base) } catch { continue }
    if (abs.host !== base.host) continue
    if (/\/(category|tag|author|page|wp-|feed)\b/i.test(abs.pathname)) continue
    if (abs.pathname === '/' || abs.pathname.length < 6) continue
    if (!isOpenTitle(title)) continue
    const key = abs.origin + abs.pathname
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: abs.toString(), title })
  }
  return out
}

function articleMeta(html: string): { published_at: string | null; excerpt: string } {
  let published_at: string | null = null
  const pub = html.match(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i)
  if (pub && !Number.isNaN(Date.parse(pub[1]))) published_at = new Date(pub[1]).toISOString()
  const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i)
  const excerpt = (desc ? desc[1] : stripTags(html).slice(0, 300)).slice(0, 300)
  return { published_at, excerpt }
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
  const periodMs = Math.max(1, Number(s.periodDays) || 30) * 86400000
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
      const before = { hot: counts.hot, hold: counts.hold, excluded: counts.excluded }
      let base: URL
      try { base = new URL(site.base_url) } catch { debug.siteResults.push({ site: site.name, error: 'invalid base_url' }); continue }

      const allowed = await robotsAllows(base.origin, base.pathname)
      if (!allowed) {
        debug.siteResults.push({ site: site.name, error: 'robots.txt により不許可' })
        await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso }).eq('id', site.id)
        continue
      }

      const indexHtml = await fetchText(site.base_url)
      await sleep(delay)
      if (!indexHtml) { counts.error++; debug.siteResults.push({ site: site.name, error: 'カテゴリページ取得失敗' }); await admin.from('source_sites').update({ last_crawled_at: nowIso }).eq('id', site.id); continue }

      const links = extractArticleLinks(indexHtml, base).slice(0, maxArticles * 2)
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
        const meta = html ? articleMeta(html) : { published_at: null, excerpt: '' }
        const ex = extractFromArticle(link.title, body.slice(0, 4000))

        const publishedMs = meta.published_at ? Date.parse(meta.published_at) : NaN
        const tooOld = !Number.isNaN(publishedMs) && (now - publishedMs) > periodMs

        // source_articles 保存（本文は保存しない・抜粋のみ）
        const artStatus = ex.is_excluded ? 'skipped' : 'processed'
        await admin.from('source_articles').insert({
          source_site_id: site.id, article_url: link.url, article_url_hash: hash, title: link.title,
          published_at: meta.published_at, detected_type: ex.detected_type, raw_excerpt: meta.excerpt.slice(0, 300),
          processed_status: artStatus, extracted_shop_name: ex.shop_name || null, extracted_area: ex.area || null,
          extracted_address: ex.address || null, extracted_open_date: ex.open_date || null, extracted_industry: ex.industry || null,
          exclusion_reason: ex.is_excluded ? ex.exclude_reason : null,
        }).then(() => {}, () => {})

        // 除外記事は lead_candidate を作らずカウントのみ
        if (ex.is_excluded) { counts.excluded++; continue }

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

        if (temperature === 'HOT') counts.hot++; else counts.hold++
        counts.candidates++

        const name = ex.shop_name || `${ex.area}${ex.industry}`.trim() || '地域メディア候補'
        const newnessReason = `${site.name}「${link.title}」（${meta.published_at ? new Date(meta.published_at).toLocaleDateString('ja-JP') : '日付不明'}）${ex.open_date ? ` 開店日: ${ex.open_date}` : ''} / ${reason}`

        const payload: any = {
          name, address: ex.address || (placeMatched ? placeFields.formattedAddress : '') || null, industry: ex.industry || null,
          phone_number: phone || null, website_url: placeFields.websiteUri || null,
          lead_source: 'regional_media', source_type: 'AI自動投入(地域メディア)',
          lead_temperature: temperature, is_new_gbp: placeMatched,
          should_exclude_from_call_list: temperature === 'EXCLUDED',
          owner_reachability_score: phone ? 70 : 30,
          auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason,
          source_article_url: link.url, source_article_title: link.title, source_site_name: site.name,
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
          if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else counts.saved++
        } else {
          const { data: ins, error } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
          if (error) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(error.message) } else counts.saved++
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

        if (!debug.sample) debug.sample = { site: site.name, title: link.title, url: link.url, published_at: meta.published_at, extracted: ex, temperature, reason, confidence, matchedPlaceId }
      }

      await admin.from('source_sites').update({ last_crawled_at: nowIso, updated_at: nowIso }).eq('id', site.id)
      debug.siteResults.push({ site: site.name, links: links.length, used, hot: counts.hot - before.hot, hold: counts.hold - before.hold, excluded: counts.excluded - before.excluded })
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

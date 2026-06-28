// ============================================================
// Instagram Web検索 新店候補取得（サーバー専用）
// Meta API不使用。公開Web検索(Serper/Bing) + Anthropic判定のみ。
// Instagramログイン/非公式スクレイピング禁止。保存は URL/タイトル/スニペット/抽出/理由のみ。
// ============================================================
import { resolveAreas, type AreaPresetKey } from './areaPresets.js'
import { searchLight, placeDetails, phoneOf } from './googlePlacesRun.js'
import { DEFAULT_STATUS } from './constants.js'

export function getDefaultIwSettings() {
  return {
    iwEnabled: true,
    iwAutoImport: false,        // HOT自動投入（初期OFF）
    iwRequirePhone: false,      // 電話番号必須（初期OFF）
    iwPlacesRequired: false,    // Google Places照合必須（初期OFF）
    iwAnthropic: true,          // Anthropic判定（初期ON）
    iwMaxQueriesPerDay: 30,
    iwPerQuery: 10,
    areaPreset: 'ittokensanken',
    industries: ['美容室', '整体', '整骨院', '歯科', 'クリニック', 'カフェ', 'エステ', 'ネイルサロン', 'パーソナルジム', '居酒屋', 'サロン'] as string[],
  }
}

const PATTERNS = ['新規オープン', 'ニューオープン', '開業しました', '開店しました', '本日オープン', 'プレオープン', 'グランドオープン', '移転オープン', '#新規オープン', '#開業', '#newopen']
const INDUSTRY_PATTERNS: { pat: string; ind: string }[] = [
  { pat: '新規オープン', ind: '美容室' }, { pat: '新規開院', ind: '歯科' }, { pat: '開業しました', ind: '整体' },
  { pat: 'ニューオープン', ind: 'カフェ' }, { pat: '独立開業', ind: 'サロン' }, { pat: 'オープンしました', ind: 'エステ' },
  { pat: '開店しました', ind: '居酒屋' }, { pat: '新規オープン', ind: 'クリニック' }, { pat: 'オープン', ind: 'ネイルサロン' },
  { pat: '新規オープン', ind: 'パーソナルジム' },
]

export interface IwQuery { query: string; area: string; pattern: string; industry: string }

export function buildIwQueries(areas: string[], extraIndustries: string[]): IwQuery[] {
  const generic: IwQuery[] = []
  const byIndustry: IwQuery[] = []
  for (const area of areas) {
    for (const p of PATTERNS) generic.push({ query: `site:instagram.com "${p}" "${area}"`, area, pattern: p, industry: '' })
    for (const ip of INDUSTRY_PATTERNS) byIndustry.push({ query: `site:instagram.com "${ip.pat}" "${ip.ind}" "${area}"`, area, pattern: ip.pat, industry: ip.ind })
    for (const ind of extraIndustries) byIndustry.push({ query: `site:instagram.com "新規オープン" "${ind}" "${area}"`, area, pattern: '新規オープン', industry: ind })
  }
  // 新店確度の高い業種別を先に
  return [...byIndustry, ...generic]
}

// ---- Web検索（Serper優先・無ければBing） ----
export function searchProvider(): 'serper' | 'bing' | null {
  if (process.env.SERPER_API_KEY) return 'serper'
  if (process.env.BING_SEARCH_API_KEY) return 'bing'
  return null
}

interface WebResult { title: string; url: string; snippet: string }

async function webSearch(query: string, num: number): Promise<{ results: WebResult[]; error: string | null }> {
  const prov = searchProvider()
  try {
    if (prov === 'serper') {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY as string, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'jp', hl: 'ja', num: Math.min(20, num) }),
      })
      const j: any = await res.json().catch(() => ({}))
      if (!res.ok) return { results: [], error: String(j?.message || `HTTP ${res.status}`).slice(0, 200) }
      const organic = Array.isArray(j.organic) ? j.organic : []
      return { results: organic.map((o: any) => ({ title: o.title || '', url: o.link || '', snippet: o.snippet || '' })), error: null }
    }
    if (prov === 'bing') {
      const u = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${Math.min(20, num)}&mkt=ja-JP`
      const res = await fetch(u, { headers: { 'Ocp-Apim-Subscription-Key': process.env.BING_SEARCH_API_KEY as string } })
      const j: any = await res.json().catch(() => ({}))
      if (!res.ok) return { results: [], error: String(j?.error?.message || `HTTP ${res.status}`).slice(0, 200) }
      const vals = j?.webPages?.value || []
      return { results: vals.map((o: any) => ({ title: o.name || '', url: o.url || '', snippet: o.snippet || '' })), error: null }
    }
    return { results: [], error: '検索APIキー未設定（SERPER_API_KEY / BING_SEARCH_API_KEY）' }
  } catch (e: any) { return { results: [], error: String(e?.message || e).slice(0, 200) } }
}

// ---- Anthropic 判定 ----
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

function buildJudgePrompt(r: WebResult, areaHint: string): string {
  return `あなたは新規オープン店舗の営業リスト判定アシスタントです。以下のWeb検索結果(Instagram)が「新規オープン/新規開業/新規開院/移転オープン」の新店候補かを判定し、JSONのみを返してください。

ルール:
- 新店・新規開業・新規開院・移転オープンの根拠があるものだけ候補化(is_new_business_candidate=true)
- 最新投稿でなくても新店根拠が強ければHOLD
- 電話番号があればHOT、無くてもLINE/予約URL/公式HPがあればHOLD、Instagram URLだけで裏取りが弱ければHOLD
- 求人/イベント/マルシェ/催事/ポップアップのみ/周年/キャンペーン/新メニュー/既存店投稿/美容師個人の作品/チェーン/大型商業施設の大手テナント/通販ECのみ/インフルエンサー紹介 は EXCLUDED
- 一都三県の地域情報があるか確認。エリアヒント: "${areaHint}"

返すJSON(キーは厳守):
{"is_instagram_candidate":bool,"is_new_business_candidate":bool,"newness_type":"new_open|pre_open|grand_open|relocation_open|new_clinic|independent_open|unknown","shop_name":str,"industry":str,"area":str,"address_candidate":str,"phone_candidate":str,"line_url_candidate":str,"reservation_url_candidate":str,"official_url_candidate":str,"instagram_url":str,"evidence_text":str,"confidence_score":0-100,"exclusion_reason":str,"recommended_status":"HOT|HOLD|EXCLUDED"}

検索結果:
title: ${r.title}
snippet: ${r.snippet}
url: ${r.url}

JSONのみ:`
}

export async function anthropicJudge(r: WebResult, areaHint: string): Promise<any | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, messages: [{ role: 'user', content: buildJudgePrompt(r, areaHint) }] }),
    })
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return null
    const text = (j?.content?.[0]?.text || '').trim()
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    return JSON.parse(m[0])
  } catch { return null }
}

// ---- ヒューリスティック判定（Anthropic未使用/失敗時のフォールバック） ----
const OPEN_RE = /(新規オープン|ニューオープン|グランドオープン|プレオープン|本日オープン|オープンしました|開業しました|開店しました|新規開院|独立開業|移転オープン|new\s?open)/i
const EXCLUDE_RE = /(求人|採用|スタッフ募集|イベント|マルシェ|催事|ポップアップ|popup|周年|キャンペーン|新メニュー|通販|オンラインショップ|EC限定|閉店|作品|スタイリスト募集|インフルエンサー|アンバサダー)/i
const CHAIN_RE = /(マクドナルド|スターバックス|スタバ|ユニクロ|GU|セブンイレブン|ファミリーマート|ローソン|ライザップ|チョコザップ|chocoZAP|イオンモール|ららぽーと|ルミネ|アトレ|パルコ|百貨店)/i

export function heuristicJudge(r: WebResult, areaHint: string): any {
  const text = `${r.title} ${r.snippet}`
  const hasOpen = OPEN_RE.test(text)
  const excl = EXCLUDE_RE.test(text) || CHAIN_RE.test(text)
  const phone = (text.match(/0\d{1,3}[-(]?\d{2,4}[-)]?\d{3,4}/) || [])[0] || ''
  const igUrl = /instagram\.com/i.test(r.url) ? r.url : ''
  let status: 'HOT' | 'HOLD' | 'EXCLUDED' = 'HOLD'
  if (excl) status = 'EXCLUDED'
  else if (hasOpen && phone) status = 'HOT'
  else if (hasOpen) status = 'HOLD'
  else status = 'HOLD'
  return {
    is_instagram_candidate: !!igUrl, is_new_business_candidate: hasOpen && !excl,
    newness_type: hasOpen ? 'new_open' : 'unknown', shop_name: '', industry: '', area: areaHint,
    address_candidate: '', phone_candidate: phone, line_url_candidate: '', reservation_url_candidate: '',
    official_url_candidate: '', instagram_url: igUrl, evidence_text: r.snippet.slice(0, 160),
    confidence_score: hasOpen ? 55 : 30, exclusion_reason: excl ? '除外語/チェーン/施設を含む' : '',
    recommended_status: status, _heuristic: true,
  }
}

// ---- ローテーション ----
function pickQueries(all: IwQuery[], recent: Set<string>, cap: number): IwQuery[] {
  const picked = all.filter((q) => !recent.has(q.query)).slice(0, cap)
  return picked.length ? picked : all.slice(0, cap)
}

export async function runInstagramWeb(admin: any, mapsKey: string | null, rawSettings: any, userId: string | null) {
  const s = { ...getDefaultIwSettings(), ...(rawSettings || {}) }
  const cap = Math.max(1, Number(s.iwMaxQueriesPerDay) || 30)
  const perQuery = Math.max(1, Math.min(20, Number(s.iwPerQuery) || 10))
  const useAnthropic = s.iwAnthropic !== false && !!process.env.ANTHROPIC_API_KEY
  const areas = resolveAreas((s.areaPreset || 'ittokensanken') as AreaPresetKey, Array.isArray(s.areas) ? s.areas : [])
  const industries = Array.isArray(s.industries) && s.industries.length ? s.industries : getDefaultIwSettings().industries
  const all = buildIwQueries(areas, industries)

  const counts = { queries: 0, results: 0, igCandidates: 0, judged: 0, placeMatched: 0, phoneYes: 0, hot: 0, hold: 0, excluded: 0, imported: 0, saved: 0, saveError: 0, error: 0, dup: 0 }
  const debug: any = { provider: searchProvider(), useAnthropic, queries: [] as string[], queryResults: [] as any[], sample: null, saveErrors: [] as string[] }
  let errorMessage = ''
  const startMs = Date.now()
  const TIME_BUDGET = 50_000

  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'instagram_web', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  try {
    if (!searchProvider()) throw new Error('検索APIキー未設定（SERPER_API_KEY もしくは BING_SEARCH_API_KEY）')

    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const { data: logRows } = await admin.from('ig_web_query_log').select('query').gte('last_run_at', since).limit(5000)
    const recent = new Set<string>((logRows || []).map((r: any) => String(r.query)))
    const picked = pickQueries(all, recent, cap)
    debug.queries = picked.map((q) => q.query)
    debug.totalQueries = all.length; debug.recentSkipped = recent.size

    const nowIso = new Date().toISOString()
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount = importedToday || 0
    const dailyCap = Math.max(1, Number(s.dailyCap) || 30)

    for (const gq of picked) {
      if (Date.now() - startMs > TIME_BUDGET) { debug.stoppedEarly = true; break }
      counts.queries++
      const before = { hot: counts.hot, hold: counts.hold, excluded: counts.excluded }
      const { results, error } = await webSearch(gq.query, perQuery)
      if (error) { counts.error++; errorMessage = error }

      let qResults = 0
      for (const r of results) {
        if (!/instagram\.com/i.test(r.url)) continue
        counts.results++; qResults++
        // 同一URLスキップ
        const { data: exU } = await admin.from('lead_candidates').select('id').eq('instagram_url', r.url).limit(1)
        if (exU && exU[0]) { counts.dup++; continue }

        const j = (useAnthropic ? await anthropicJudge(r, gq.area) : null) || heuristicJudge(r, gq.area)
        counts.judged++
        if (j.is_instagram_candidate) counts.igCandidates++
        if (!j.is_instagram_candidate && !j.is_new_business_candidate) continue

        const phone = j.phone_candidate || ''
        if (phone) counts.phoneYes++

        // 任意: Google Places照合（未照合でも除外しない）
        let placeMatched = false, matchedPlaceId: string | null = null, placeFields: any = {}
        if (mapsKey && j.shop_name && (j.area || gq.area)) {
          const sr = await searchLight(mapsKey, `${j.shop_name} ${j.area || gq.area}`, 2)
          const top = sr.places?.[0]
          if (top && (top.displayName?.text || '').includes(String(j.shop_name).slice(0, 4))) {
            placeMatched = true; matchedPlaceId = top.id || null; counts.placeMatched++
            const d = matchedPlaceId ? await placeDetails(mapsKey, matchedPlaceId) : null
            placeFields = d || top
          }
        }

        // 最終ステータス（設定の必須条件を反映）
        let temperature: string = j.recommended_status || 'HOLD'
        if (temperature === 'HOT') {
          if (s.iwRequirePhone && !phone) temperature = 'HOLD'
          if (s.iwPlacesRequired && !placeMatched) temperature = 'HOLD'
        }
        if (temperature === 'HOT') counts.hot++
        else if (temperature === 'EXCLUDED') counts.excluded++
        else counts.hold++

        const finalPhone = phone || (placeMatched ? phoneOf(placeFields) : '')
        const name = j.shop_name || `${j.area || gq.area}${j.industry || ''}`.trim() || 'Instagram候補'
        const reason = j.exclusion_reason
          ? `除外: ${j.exclusion_reason}`
          : `新店根拠(${j.newness_type || 'unknown'}) 確度${j.confidence_score ?? '-'} / ${j.evidence_text || r.snippet?.slice(0, 120) || ''}${j._heuristic ? '（ルール判定）' : '（AI判定）'}`

        const payload: any = {
          name, address: j.address_candidate || null, industry: j.industry || null,
          phone_number: finalPhone || null, website_url: j.official_url_candidate || null,
          source: 'instagram_web_search', lead_source: 'instagram_web', source_type: 'AI自動投入(Instagram Web)',
          lead_temperature: temperature, is_new_instagram: true, is_new_gbp: placeMatched,
          should_exclude_from_call_list: temperature === 'EXCLUDED',
          owner_reachability_score: finalPhone ? 65 : 30,
          auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason,
          instagram_url: r.url, search_query: gq.query, search_title: (r.title || '').slice(0, 300), search_snippet: (r.snippet || '').slice(0, 500),
          extracted_shop_name: j.shop_name || null, extracted_area: j.area || gq.area || null, extracted_industry: j.industry || null,
          extracted_address: j.address_candidate || null, extracted_phone: phone || null, extracted_url: j.official_url_candidate || null,
          line_url: j.line_url_candidate || null, reservation_url: j.reservation_url_candidate || null, official_url: j.official_url_candidate || null,
          instagram_newness_reason: reason, anthropic_judgement: j, match_confidence: j.confidence_score ?? null, newness_type: j.newness_type || null,
          google_place_id: matchedPlaceId, matched_google_place_id: matchedPlaceId,
          last_seen_at: nowIso, source_run_id: runId,
        }

        const { data: ins, error: insErr } = await admin.from('lead_candidates')
          .insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
        if (insErr) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(insErr.message) } else counts.saved++
        const candidateId = ins?.id || null

        // HOT自動投入（初期OFF）
        if (s.iwAutoImport && temperature === 'HOT' && finalPhone && candidateId && importedCount < dailyCap) {
          const memo = [`【AI自動投入 / Instagram Web】`, `URL: ${r.url}`, `理由: ${reason}`, `クエリ: ${gq.query}`].join('\n')
          const { data: created } = await admin.from('cases').insert({
            name, address: j.address_candidate || '', phone1: finalPhone, industry: j.industry || null,
            status: DEFAULT_STATUS, hp1: j.official_url_candidate || null, instagram: r.url, source_urls: r.url, memo, created_by_id: userId,
          }).select('id').single()
          if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId); counts.imported++; importedCount++ }
        }

        if (!debug.sample) debug.sample = { query: gq.query, url: r.url, title: r.title, snippet: r.snippet, judgement: j, temperature }
      }

      await admin.from('ig_web_query_log').upsert({ query: gq.query, last_run_at: nowIso, runs: 1, results: qResults, hot_count: counts.hot - before.hot }, { onConflict: 'query' }).then(() => {}, () => {})
      debug.queryResults.push({ query: gq.query, results: qResults, hot: counts.hot - before.hot, hold: counts.hold - before.hold, excluded: counts.excluded - before.excluded, error })
    }

    await admin.from('auto_lead_runs').update({
      status: 'success', finished_at: new Date().toISOString(), search_queries_count: counts.queries,
      fetched_count: counts.results, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded,
      imported_count: counts.imported, error_count: counts.error, error_message: errorMessage || null,
    }).eq('id', runId)

    return { ok: true, runId, ...counts, debug }
  } catch (e: any) {
    const msg = String(e?.message || e)
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: msg }).eq('id', runId)
    throw new Error(msg)
  }
}

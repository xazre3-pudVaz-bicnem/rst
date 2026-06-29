// ============================================================
// Instagram Web検索 新店候補取得（サーバー専用・全国検索）
// Meta API不使用。公開Web検索(Serper/Bing) + Anthropic判定のみ。
// 重要: 検索クエリに地域名・業種名を入れない（全国の新店系ハッシュタグ/語のみ）。
// 地域/業種は title/snippet/url から後段で抽出。コスト制御付き定期バッチ設計。
// ============================================================
import { searchLight, placeDetails, phoneOf } from './googlePlacesRun.js'
import { DEFAULT_STATUS } from './constants.js'

export function getDefaultIwSettings() {
  return {
    iwEnabled: true,
    iwAutoImport: false,        // HOT自動投入（初期OFF・HOLD中心）
    iwRequirePhone: false,      // 電話番号必須（初期OFF）
    iwPlacesRequired: false,    // Google Places照合必須（初期OFF）
    iwAnthropic: true,          // Anthropic判定（初期ON）
    iwMaxRunsPerDay: 4,         // 1日最大実行回数
    iwPerRun: 20,               // 1回最大クエリ数
    iwMaxQueriesPerDay: 80,     // 1日最大クエリ数
    iwPerQuery: 10,             // 1クエリ取得件数
    iwAnthropicDailyCap: 100,   // 1日最大AI判定件数
  }
}

// 全国検索クエリ（地域名・業種名を含めない。新店系ハッシュタグ/語のみ）
export const NATIONAL_QUERIES = [
  'site:instagram.com "#新規オープン"',
  'site:instagram.com "#ニューオープン"',
  'site:instagram.com "#開業"',
  'site:instagram.com "#開店"',
  'site:instagram.com "#開院"',
  'site:instagram.com "#独立開業"',
  'site:instagram.com "#グランドオープン"',
  'site:instagram.com "#プレオープン"',
  'site:instagram.com "#移転オープン"',
  'site:instagram.com "#newopen"',
  'site:instagram.com "#new_open"',
  'site:instagram.com "新規オープンしました"',
  'site:instagram.com "オープンしました"',
  'site:instagram.com "開業しました"',
  'site:instagram.com "開店しました"',
  'site:instagram.com "開院しました"',
  'site:instagram.com "本日オープン"',
  'site:instagram.com "グランドオープンしました"',
  'site:instagram.com "プレオープンしました"',
]

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

// ---- ルールベース粗選別（Anthropic判定の前に必ず実行） ----
const OPEN_WORDS_RE = /(新規オープン|ニューオープン|オープンしました|開業しました|開店しました|開院しました|本日オープン|グランドオープン|プレオープン|移転オープン|独立開業|new[\s_]?open)/i
const PRE_EXCLUDE_RE = /(求人|採用|スタッフ募集|アルバイト募集|バイト募集|イベント|マルシェ|催事|ポップアップ|pop-?up|周年|キャンペーン|新メニュー|閉店|閉業|通販|オンラインショップ|EC限定|インフルエンサー|アンバサダー|まとめ記事|ランキング)/i

/** ルール粗選別: AIに回すべきかを判定（excluded_pre / open / no_open_word） */
function ruleFilter(r: WebResult): { pass: boolean; result: 'open' | 'excluded_pre' | 'no_open_word'; reason: string } {
  const text = `${r.title} ${r.snippet}`
  if (PRE_EXCLUDE_RE.test(text)) {
    const w = (text.match(PRE_EXCLUDE_RE) || [])[0] || ''
    return { pass: false, result: 'excluded_pre', reason: `除外語「${w}」` }
  }
  if (OPEN_WORDS_RE.test(text)) return { pass: true, result: 'open', reason: '新店系ワードあり' }
  return { pass: false, result: 'no_open_word', reason: '新店系ワードなし' }
}

// ---- 地域抽出（全国対応・クエリには地域が無いので本文から推定） ----
const PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
const FOREIGN_RE = /(ソウル|韓国|台湾|台北|香港|上海|北京|bangkok|タイ|ベトナム|hawaii|ハワイ|los angeles|new york|paris|london|singapore|シンガポール|オーストラリア|アメリカ|フランス|イタリア)/i

function extractRegion(text: string): { prefecture: string; city: string; area: string; foreign: boolean } {
  const prefecture = PREFECTURES.find((p) => text.includes(p)) || ''
  const cityM = text.match(/([一-龥ぁ-んァ-ヶ]{1,6}[市区町村])/)
  const city = cityM ? cityM[1] : ''
  const foreign = !prefecture && FOREIGN_RE.test(text)
  const area = [prefecture, city].filter(Boolean).join('')
  return { prefecture, city, area, foreign }
}

const INDUSTRY_RE: { name: string; re: RegExp }[] = [
  { name: '美容室', re: /美容室|ヘアサロン|美容院|hair/i }, { name: 'ネイルサロン', re: /ネイル|nail/i }, { name: 'まつ毛サロン', re: /まつ毛|まつげ|マツエク|eyelash/i },
  { name: 'エステ', re: /エステ|脱毛|フェイシャル/ }, { name: '整体', re: /整体|カイロ/ }, { name: '整骨院・接骨院', re: /整骨院|接骨院/ }, { name: '鍼灸院', re: /鍼灸|はり灸/ },
  { name: 'リラクゼーション', re: /リラクゼーション|もみほぐし/ }, { name: 'クリニック', re: /クリニック|医院|診療所/ }, { name: '歯科', re: /歯科|デンタル/ },
  { name: 'カフェ', re: /カフェ|cafe|coffee|珈琲/i }, { name: 'ラーメン', re: /ラーメン|らーめん/ }, { name: '居酒屋', re: /居酒屋|酒場|バル/ },
  { name: '飲食店', re: /レストラン|食堂|ダイニング|焼肉|寿司|そば|うどん|定食|パン|ベーカリー|スイーツ/ }, { name: 'ジム・フィットネス', re: /ジム|フィットネス|パーソナル|ピラティス|ヨガ/ },
  { name: '士業', re: /行政書士|税理士|社労士|司法書士|弁護士|事務所/ }, { name: '不動産', re: /不動産/ }, { name: 'リフォーム', re: /リフォーム|リノベ/ },
]
function extractIndustry(text: string): string { return INDUSTRY_RE.find((m) => m.re.test(text))?.name || '' }

// ---- Anthropic 判定 ----
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

function buildJudgePrompt(r: WebResult): string {
  return `あなたは新規オープン店舗の営業リスト判定アシスタントです。以下のInstagram公開検索結果が「新規オープン/開業/開店/開院/独立開業/移転オープン」の新店候補かを判定し、JSONのみ返してください。検索クエリには地域名・業種名を含めていません。地域や業種は本文から推定し、無ければ null にしてください（推測で東京都千代田区などを入れない）。

ルール:
- 新店根拠が明確で店名/業種/日本国内の地域が推定でき、電話/公式/予約/LINEで連絡先が辿れる → HOT
- 新店根拠はあるが電話なし/地域弱い/店名弱い/Instagramのみ/地域不明だが国内っぽい → HOLD
- 求人/イベント/催事/ポップアップ/周年/キャンペーン/新メニュー/既存店通常投稿/インフルエンサー紹介/大手チェーン/EC通販のみ/海外店舗/閉店のみ → EXCLUDED
- 海外と判断できる場合のみ EXCLUDED（地域不明は EXCLUDED にせず HOLD）

返すJSON(キー厳守):
{"is_instagram_candidate":bool,"is_new_business_candidate":bool,"newness_type":"new_open|pre_open|grand_open|relocation_open|new_clinic|independent_open|unknown","shop_name":str|null,"industry":str|null,"prefecture":str|null,"city":str|null,"address_candidate":str|null,"phone_candidate":str|null,"line_url_candidate":str|null,"reservation_url_candidate":str|null,"official_url_candidate":str|null,"instagram_url":str|null,"evidence_text":str,"confidence_score":0-100,"is_foreign":bool,"exclusion_reason":str|null,"recommended_status":"HOT|HOLD|EXCLUDED"}

検索結果:
title: ${r.title}
snippet: ${r.snippet}
url: ${r.url}

JSONのみ:`
}

export async function anthropicJudge(r: WebResult): Promise<any | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, messages: [{ role: 'user', content: buildJudgePrompt(r) }] }),
    })
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return null
    const text = (j?.content?.[0]?.text || '').trim()
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    return JSON.parse(m[0])
  } catch { return null }
}

// ---- ヒューリスティック判定（Anthropic未使用/上限超過/失敗時のフォールバック・無料） ----
const CHAIN_RE = /(マクドナルド|スターバックス|スタバ|ユニクロ|GU|セブンイレブン|ファミリーマート|ローソン|ライザップ|チョコザップ|chocoZAP|イオンモール|ららぽーと|ルミネ|アトレ|パルコ|百貨店|ニトリ|ダイソー|ドンキ)/i

export function heuristicJudge(r: WebResult): any {
  const text = `${r.title} ${r.snippet}`
  const hasOpen = OPEN_WORDS_RE.test(text)
  const region = extractRegion(text)
  const industry = extractIndustry(text)
  const phone = (text.match(/0\d{1,3}[-(]?\d{2,4}[-)]?\d{3,4}/) || [])[0] || ''
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s　]+/g)).map((m) => m[0])
  const line = urls.find((u) => /lin\.ee|line\.me/i.test(u)) || ''
  const reservation = urls.find((u) => /(reserve|yoyaku|booking|hotpepper|airrsv|coubic|stores\.jp|epark)/i.test(u)) || ''
  const official = urls.find((u) => !/instagram\.com/i.test(u) && u !== line && u !== reservation) || ''
  const igUrl = /instagram\.com/i.test(r.url) ? r.url : ''
  const chain = CHAIN_RE.test(text)
  // 店名候補: タイトル先頭の語、または『』内
  const q = r.title.match(/[『「"]([^』」"]{2,30})[』」"]/)
  const shop = q ? q[1] : (r.title.split(/[|｜\-–—・]/)[0] || '').trim().slice(0, 30)

  let status: 'HOT' | 'HOLD' | 'EXCLUDED' = 'HOLD'
  if (region.foreign) status = 'EXCLUDED'
  else if (chain) status = 'EXCLUDED'
  else if (hasOpen && phone && shop && industry && region.prefecture) status = 'HOT'
  else status = 'HOLD'

  return {
    is_instagram_candidate: !!igUrl, is_new_business_candidate: hasOpen && !chain && !region.foreign,
    newness_type: hasOpen ? 'new_open' : 'unknown', shop_name: shop || null, industry: industry || null,
    prefecture: region.prefecture || null, city: region.city || null,
    address_candidate: null, phone_candidate: phone || null, line_url_candidate: line || null,
    reservation_url_candidate: reservation || null, official_url_candidate: official || null, instagram_url: igUrl || null,
    evidence_text: r.snippet.slice(0, 160), confidence_score: hasOpen ? (region.prefecture ? 55 : 40) : 25,
    is_foreign: region.foreign, exclusion_reason: region.foreign ? '海外店舗' : (chain ? 'チェーン店' : null),
    recommended_status: status, _heuristic: true,
  }
}

// ---- 概算コスト（料金は変動するため目安） ----
const SERPER_JPY_PER_QUERY = 0.5
const ANTHROPIC_JPY_PER_JUDGE = 0.3

export async function runInstagramWeb(admin: any, mapsKey: string | null, rawSettings: any, userId: string | null) {
  const s = { ...getDefaultIwSettings(), ...(rawSettings || {}) }
  const perQuery = Math.max(1, Math.min(20, Number(s.iwPerQuery) || 10))
  const perRun = Math.max(1, Number(s.iwPerRun) || 20)
  const maxQueriesPerDay = Math.max(1, Number(s.iwMaxQueriesPerDay) || 80)
  const maxRunsPerDay = Math.max(1, Number(s.iwMaxRunsPerDay) || 4)
  const anthropicDailyCap = Math.max(0, Number(s.iwAnthropicDailyCap) || 100)
  const useAnthropic = s.iwAnthropic !== false && !!process.env.ANTHROPIC_API_KEY
  const dailyCap = Math.max(1, Number(s.dailyCap) || 30)

  const counts = {
    queries: 0, results: 0, igUrls: 0, rulePassed: 0, preExcluded: 0, noOpenWord: 0,
    judged: 0, heuristicUsed: 0, placeMatched: 0, phoneYes: 0,
    hot: 0, hold: 0, excluded: 0, imported: 0, saved: 0, saveError: 0, error: 0, dup: 0,
    areaKnown: 0, areaUnknown: 0, industryKnown: 0, industryUnknown: 0,
  }
  const debug: any = { mode: 'nationwide', provider: searchProvider(), useAnthropic, queries: [] as string[], queryResults: [] as any[], sample: null, saveErrors: [] as string[] }
  let errorMessage = ''
  const startMs = Date.now()
  const TIME_BUDGET = 50_000
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0)

  if (!searchProvider()) {
    return { ok: false, ...counts, error: '検索APIキー未設定（SERPER_API_KEY もしくは BING_SEARCH_API_KEY）', debug }
  }

  // 1日の実行回数制限（run行を作る前に判定）
  const { count: runsToday } = await admin.from('auto_lead_runs').select('id', { count: 'exact', head: true })
    .eq('source', 'instagram_web').gte('created_date', startToday.toISOString())
  if ((runsToday || 0) >= maxRunsPerDay) {
    return { ok: true, skipped: true, reason: `本日の実行回数上限(${maxRunsPerDay})に到達`, runsToday, ...counts, debug }
  }

  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'instagram_web', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  try {
    // 1日のクエリ上限（今日実行済みクエリ数）
    const { count: queriesToday } = await admin.from('ig_web_query_log').select('id', { count: 'exact', head: true }).gte('last_run_at', startToday.toISOString())
    const remainingQueries = Math.max(0, maxQueriesPerDay - (queriesToday || 0))
    const runQueryLimit = Math.min(perRun, remainingQueries)

    // AI判定の1日上限（今日保存済みのiw候補数で概算）
    const { count: judgedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true })
      .eq('source', 'instagram_web_search').gte('first_seen_at', startToday.toISOString())
    let anthropicBudget = Math.max(0, anthropicDailyCap - (judgedToday || 0))

    // 7日以内に実行したクエリはスキップ → 未実行/古い順に runQueryLimit 件
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString()
    const { data: recentRows } = await admin.from('ig_web_query_log').select('query').gte('last_run_at', since7).limit(5000)
    const recent = new Set<string>((recentRows || []).map((r: any) => String(r.query)))
    let picked = NATIONAL_QUERIES.filter((q) => !recent.has(q)).slice(0, runQueryLimit)
    if (picked.length === 0 && runQueryLimit > 0) picked = NATIONAL_QUERIES.slice(0, runQueryLimit)
    debug.queries = picked
    debug.runsToday = (runsToday || 0) + 1
    debug.queriesToday = queriesToday || 0
    debug.remainingQueries = remainingQueries
    debug.anthropicBudget = anthropicBudget

    const nowIso = new Date().toISOString()
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount = importedToday || 0

    for (const query of picked) {
      if (Date.now() - startMs > TIME_BUDGET) { debug.stoppedEarly = true; break }
      counts.queries++
      const before = { hot: counts.hot, hold: counts.hold, excluded: counts.excluded }
      const q: any = { query, results: 0, igUrls: 0, rulePassed: 0, judged: 0, heuristic: 0, hot: 0, hold: 0, excluded: 0, areaKnown: 0, areaUnknown: 0, industryKnown: 0, industryUnknown: 0, error: null }
      const { results, error } = await webSearch(query, perQuery)
      if (error) { counts.error++; errorMessage = error; q.error = error }

      for (const r of results) {
        q.results++; counts.results++
        if (!/instagram\.com/i.test(r.url)) continue
        q.igUrls++; counts.igUrls++

        // 同一URLスキップ（重複防止＝再判定しない＝コスト削減）
        const { data: exU } = await admin.from('lead_candidates').select('id').eq('instagram_url', r.url).limit(1)
        if (exU && exU[0]) { counts.dup++; continue }

        // ルールベース粗選別（AI判定の前に必ず）
        const rf = ruleFilter(r)
        if (rf.result === 'excluded_pre') { counts.preExcluded++; counts.excluded++; q.excluded++; continue }
        if (!rf.pass) { counts.noOpenWord++; continue }
        counts.rulePassed++; q.rulePassed++

        // AI判定（上限内のみ）。超過/OFF/失敗はヒューリスティック（無料）
        let j: any
        if (useAnthropic && anthropicBudget > 0) {
          j = await anthropicJudge(r)
          if (j) { counts.judged++; q.judged++; anthropicBudget-- }
          else { j = heuristicJudge(r); counts.heuristicUsed++; q.heuristic++ }
        } else {
          j = heuristicJudge(r); counts.heuristicUsed++; q.heuristic++
        }

        // 地域は抽出できたものだけ。クエリ地域のフォールバックはしない（千代田区固定の修正）
        const region = extractRegion(`${r.title} ${r.snippet}`)
        const prefecture = j.prefecture || region.prefecture || null
        const city = j.city || region.city || null
        const area = [prefecture, city].filter(Boolean).join('') || null
        const industry = j.industry || extractIndustry(`${r.title} ${r.snippet}`) || null
        const phone = j.phone_candidate || ''
        if (phone) counts.phoneYes++
        if (area) { counts.areaKnown++; q.areaKnown++ } else { counts.areaUnknown++; q.areaUnknown++ }
        if (industry) { counts.industryKnown++; q.industryKnown++ } else { counts.industryUnknown++; q.industryUnknown++ }

        // 任意: Google Places照合
        let placeMatched = false, matchedPlaceId: string | null = null, placeFields: any = {}
        if (mapsKey && j.shop_name && area && !j.is_foreign) {
          const sr = await searchLight(mapsKey, `${j.shop_name} ${area}`, 2)
          const top = sr.places?.[0]
          if (top && (top.displayName?.text || '').includes(String(j.shop_name).slice(0, 4))) {
            placeMatched = true; matchedPlaceId = top.id || null; counts.placeMatched++
            const d = matchedPlaceId ? await placeDetails(mapsKey, matchedPlaceId) : null
            placeFields = d || top
          }
        }

        let temperature: string = j.recommended_status || 'HOLD'
        if (j.is_foreign) temperature = 'EXCLUDED'
        if (temperature === 'HOT') {
          if (s.iwRequirePhone && !phone) temperature = 'HOLD'
          if (s.iwPlacesRequired && !placeMatched) temperature = 'HOLD'
        }
        if (temperature === 'HOT') { counts.hot++; q.hot++ }
        else if (temperature === 'EXCLUDED') { counts.excluded++; q.excluded++ }
        else { counts.hold++; q.hold++ }

        const finalPhone = phone || (placeMatched ? phoneOf(placeFields) : '')
        const name = j.shop_name || (area ? `${area}の新店候補` : 'Instagram新店候補')
        const reason = j.exclusion_reason
          ? `除外: ${j.exclusion_reason}`
          : `新店根拠(${j.newness_type || 'unknown'}) 確度${j.confidence_score ?? '-'} / 地域:${area || '不明'} / ${j.evidence_text || r.snippet?.slice(0, 100) || ''}${j._heuristic ? '（ルール判定）' : '（AI判定）'}`

        const payload: any = {
          name, address: j.address_candidate || null, industry,
          phone_number: finalPhone || null, website_url: j.official_url_candidate || null,
          source: 'instagram_web_search', lead_source: 'instagram_web', source_type: 'AI自動投入(Instagram Web)',
          lead_temperature: temperature, recommended_status: j.recommended_status || temperature,
          is_new_instagram: true, is_new_gbp: placeMatched,
          should_exclude_from_call_list: temperature === 'EXCLUDED',
          owner_reachability_score: finalPhone ? 65 : 30,
          auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason,
          instagram_url: r.url, search_query: query, search_title: (r.title || '').slice(0, 300), search_snippet: (r.snippet || '').slice(0, 500),
          extracted_shop_name: j.shop_name || null, extracted_area: area, extracted_prefecture: prefecture, extracted_city: city,
          extracted_industry: industry, extracted_phone: phone || null, extracted_url: j.official_url_candidate || null,
          line_url: j.line_url_candidate || null, reservation_url: j.reservation_url_candidate || null, official_url: j.official_url_candidate || null,
          instagram_newness_reason: reason, anthropic_judgement: j, match_confidence: j.confidence_score ?? null, newness_type: j.newness_type || null,
          rule_filter_result: rf.result, skipped_reason: null, api_run_id: runId,
          google_place_id: matchedPlaceId, matched_google_place_id: matchedPlaceId,
          last_seen_at: nowIso, source_run_id: runId,
        }

        const { data: ins, error: insErr } = await admin.from('lead_candidates')
          .insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
        if (insErr) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(insErr.message) } else counts.saved++
        const candidateId = ins?.id || null

        if (s.iwAutoImport && temperature === 'HOT' && finalPhone && candidateId && importedCount < dailyCap) {
          const memo = [`【AI自動投入 / Instagram Web(全国)】`, `URL: ${r.url}`, `理由: ${reason}`, `クエリ: ${query}`].join('\n')
          const { data: created } = await admin.from('cases').insert({
            name, address: j.address_candidate || '', phone1: finalPhone, industry,
            status: DEFAULT_STATUS, hp1: j.official_url_candidate || null, instagram: r.url, source_urls: r.url, memo, created_by_id: userId,
          }).select('id').single()
          if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId); counts.imported++; importedCount++ }
        }

        if (!debug.sample) debug.sample = { query, url: r.url, title: r.title, snippet: r.snippet, rule: rf.result, judgement: j, area, temperature }
      }

      await admin.from('ig_web_query_log').upsert({ query, last_run_at: nowIso, runs: 1, results: q.results, hot_count: counts.hot - before.hot }, { onConflict: 'query' }).then(() => {}, () => {})
      debug.queryResults.push(q)
    }

    // 概算コスト
    debug.estSerperCost = Math.round(counts.queries * SERPER_JPY_PER_QUERY * 10) / 10
    debug.estAnthropicCost = Math.round(counts.judged * ANTHROPIC_JPY_PER_JUDGE * 10) / 10
    debug.estTotalCost = Math.round((debug.estSerperCost + debug.estAnthropicCost) * 10) / 10

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

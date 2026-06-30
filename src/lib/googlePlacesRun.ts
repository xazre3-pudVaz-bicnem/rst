// ============================================================
// Google Places (New) 実行ロジック（サーバー専用）
// HOT条件は緩めない。改善は「探し方」: エリアプリセット展開 / 新規オープン系
// クエリ優先 / クエリローテーション(1日上限) / 二段階取得(軽い検索→詳細)。
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { classifyLead } from './leadScoring.js'
import { DEFAULT_STATUS } from './constants.js'
import { resolveAreas, prefectureOfArea, type AreaPresetKey } from './areaPresets.js'
import { buildLeadQueries } from './leadQueries.js'

const SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
const DETAILS_ENDPOINT = 'https://places.googleapis.com/v1/places/'

// 第1段階（軽い検索：電話/レビューは取らない＝低コスト）
const LIGHT_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress',
  'places.userRatingCount', 'places.types', 'places.primaryType', 'places.businessStatus',
].join(',')

// 第2段階（詳細取得：電話・レビュー日・開店日など）
const DETAIL_FIELDS_EXT = [
  'id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'internationalPhoneNumber',
  'websiteUri', 'googleMapsUri', 'rating', 'userRatingCount', 'businessStatus', 'types', 'primaryType',
  'openingDate', 'reviews',
].join(',')
const DETAIL_FIELDS_BASE = [
  'id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'internationalPhoneNumber',
  'websiteUri', 'googleMapsUri', 'rating', 'userRatingCount', 'businessStatus', 'types', 'primaryType',
].join(',')

let detailExtSupported = true

export function getAdminClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（Vercel環境変数）')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

// 全国・新店系ワードでの検索クエリ（地域名・業種名を含めない）
export const NATIONAL_PLACES_QUERIES = [
  '新規オープン', 'ニューオープン', 'オープン予定', '開業予定', '開店予定', '開院予定',
  'プレオープン', 'グランドオープン', '移転オープン', '本日オープン', '近日オープン',
  '新店舗', '新店', '開業しました', '開店しました', '開院しました', 'オープンしました', '新規開業', '独立開業',
]

export function getDefaultSettings() {
  return {
    autoImport: true,
    placesEnabled: true,
    // 全国・新店系ワード検索（エリア/業種で絞らない）
    placesNationwide: true,
    placesMaxQueriesPerDay: 30,
    placesPerQuery: 20,
    placesMaxDetailsPerDay: 100,
    areaPreset: 'ittokensanken',
    maxPerQuery: 10,
    maxQueriesPerDay: 50,
    dailyCap: 30,
    rotation: true,
    areas: [],
    industries: [
      '整体', '整骨院', '接骨院', '鍼灸院', '美容室', '理容室', 'ネイルサロン', 'まつ毛サロン',
      'エステ', 'リラクゼーション', 'パーソナルジム', 'ピラティス', '歯科', '動物病院', 'ペットサロン',
      '飲食店', 'カフェ', '居酒屋', 'テイクアウト', 'ハウスクリーニング', '不用品回収', 'リフォーム',
      '外壁塗装', '水道修理', '電気工事', '行政書士', '税理士', '写真館', 'レンタルスペース',
    ],
  }
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[\n、,・]+/).map((x) => x.trim()).filter(Boolean)
  return []
}

export function parseOpeningDate(v: any): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  if (typeof v === 'object' && v.year) {
    const m = String(v.month ?? 1).padStart(2, '0')
    const d = String(v.day ?? 1).padStart(2, '0')
    return `${v.year}-${m}-${d}`
  }
  return null
}

export interface GoogleOpening {
  year: number | null; month: number | null; day: number | null; raw: string | null
  date: string | null; daysUntil: number | null; daysSince: number | null
  confidence: number; within90: boolean; has: boolean
}
/** Places の openingDate(オブジェクト/文字列) と businessStatus から開業日情報を算出。月のみ(dayなし)も対応。 */
export function parseGoogleOpening(openingDate: any, businessStatus?: string): GoogleOpening {
  const future = businessStatus === 'FUTURE_OPENING'
  let year: number | null = null, month: number | null = null, day: number | null = null
  if (openingDate && typeof openingDate === 'object') {
    year = openingDate.year ?? null; month = openingDate.month ?? null; day = openingDate.day ?? null
  } else if (typeof openingDate === 'string') {
    const m = openingDate.match(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/)
    if (m) { year = Number(m[1]); month = Number(m[2]); day = m[3] ? Number(m[3]) : null }
  }
  const has = !!(year || future)
  const raw = year ? `${year}年${month ? month + '月' : ''}${day ? day + '日' : ''}` : (future ? '開業予定' : null)
  // 日付化（dayなしは月初）
  let dateStr: string | null = null, daysUntil: number | null = null, daysSince: number | null = null
  if (year && month) {
    const dt = new Date(year, month - 1, day || 1)
    dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day || 1).padStart(2, '0')}`
    const diff = Math.round((dt.getTime() - Date.now()) / 86400000)
    if (diff >= 0) daysUntil = diff; else daysSince = -diff
  }
  // 確度: 開業日あり60＋day有20/無-10＋FUTURE_OPENING+15。最大100
  let confidence = 0
  if (year) confidence = 60 + (day ? 20 : -10)
  if (future) confidence += 15
  confidence = Math.max(0, Math.min(100, confidence))
  // 現在±90日（未来=開業予定含む）
  const within90 = dateStr ? Math.abs(Date.parse(dateStr) - Date.now()) <= 90 * 86400000 : future
  return { year, month, day, raw, date: dateStr, daysUntil, daysSince, confidence, within90, has }
}

export function reviewDates(p: any): { latest: string | null; oldest: string | null } {
  const reviews = Array.isArray(p.reviews) ? p.reviews : []
  let latest: string | null = null
  let oldest: string | null = null
  for (const r of reviews) {
    const pt = r?.publishTime
    if (!pt) continue
    const t = Date.parse(pt)
    if (Number.isNaN(t)) continue
    if (latest === null || t > Date.parse(latest)) latest = pt
    if (oldest === null || t < Date.parse(oldest)) oldest = pt
  }
  return { latest, oldest }
}

export function phoneOf(p: any): string {
  return p.nationalPhoneNumber || p.internationalPhoneNumber || ''
}

/** 第1段階: 軽い検索。例外を投げず {status, places, error} を返す */
export async function searchLight(apiKey: string, query: string, maxResultCount: number): Promise<{ status: number; places: any[]; error: string | null }> {
  try {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': LIGHT_FIELDS },
      body: JSON.stringify({ textQuery: query, languageCode: 'ja', regionCode: 'JP', maxResultCount: Math.max(1, Math.min(20, maxResultCount)) }),
    })
    const text = await res.text().catch(() => '')
    let json: any = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = {} }
    if (!res.ok) return { status: res.status, places: [], error: String(json?.error?.message || text || `HTTP ${res.status}`).slice(0, 400) }
    return { status: res.status, places: Array.isArray(json.places) ? json.places : [], error: null }
  } catch (e: any) {
    return { status: 0, places: [], error: String(e?.message || e) }
  }
}

/** 第2段階: 詳細取得（電話・レビュー日・開店日）。openingDate/reviewsが400なら自動でBASEに落とす */
export async function placeDetails(apiKey: string, placeId: string): Promise<any | null> {
  async function attempt(ext: boolean) {
    const res = await fetch(DETAILS_ENDPOINT + encodeURIComponent(placeId), {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': ext ? DETAIL_FIELDS_EXT : DETAIL_FIELDS_BASE },
    })
    const text = await res.text().catch(() => '')
    let json: any = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = {} }
    return { ok: res.ok, status: res.status, json }
  }
  try {
    let r = await attempt(detailExtSupported)
    if (detailExtSupported && r.status === 400) { detailExtSupported = false; r = await attempt(false) }
    return r.ok ? r.json : null
  } catch {
    return null
  }
}

export async function fetchCases(admin: any): Promise<any[]> {
  const all: any[] = []
  for (let page = 0; page < 10; page++) {
    const from = page * 1000
    const { data, error } = await admin.from('cases').select('id,name,address,phone1,phone2,phone3,hp1,hp2,instagram').range(from, from + 999)
    if (error) break
    const rows = data || []
    all.push(...rows)
    if (rows.length < 1000) break
  }
  return all
}

// チェーン/施設内/支店の簡易判定（第1段階の足切り用。詳細はclassifyLeadで最終判定）
const CHAIN_HINT = /(マクドナルド|スターバックス|スタバ|ケンタッキー|モスバーガー|ガスト|サイゼリヤ|吉野家|すき家|松屋|ドトール|タリーズ|コメダ|丸亀製麺|ユニクロ|GU|セブン-?イレブン|ファミリーマート|ローソン|QBハウス|TBC|ミュゼ|RIZAP|ライザップ|チョコザップ|chocoZAP|カーブス|ゴールドジム|明光義塾|公文|KUMON|ほっともっと|大戸屋|やよい軒|アパマン|エイブル|ミニミニ|りらくる|ほぐしの達人|大東建託)/
const MALL_HINT = /(イオンモール|イオン |ららぽーと|アリオ|ルミネ|アトレ|マルイ|丸井|パルコ|PARCO|高島屋|三越|伊勢丹|そごう|西武|大丸|松坂屋|百貨店|駅ビル|エキュート|アウトレット|ショッピングモール|ショッピングセンター)/
const BRANCH_HINT = /(支店|営業所|支社|出張所)/

// 全国モード: formattedAddress から都道府県・市区町村を抽出
const JP_PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
function regionFromAddress(addr: string): { prefecture: string; city: string; area: string } {
  const a = (addr || '').replace(/^日本、?\s*/, '')
  const prefecture = JP_PREFS.find((p) => a.includes(p)) || ''
  const after = prefecture ? a.slice(a.indexOf(prefecture) + prefecture.length) : a
  const cm = after.match(/^([^\d\s]{1,8}?[市区町村])/) || a.match(/([一-龥ぁ-んァ-ヶ]{1,8}[市区町村])/)
  const city = cm ? cm[1] : ''
  return { prefecture, city, area: [prefecture, city].filter(Boolean).join('') }
}
// primaryType / types / 店名 から業種推定
const PTYPE_MAP: { re: RegExp; name: string }[] = [
  { re: /hair|beauty_salon|hairdresser/i, name: '美容室' }, { re: /nail/i, name: 'ネイルサロン' }, { re: /barber/i, name: '理容室' },
  { re: /spa|massage|wellness/i, name: 'リラクゼーション' }, { re: /chiropractor|physiotherap|osteopath/i, name: '整体' },
  { re: /dentist|dental/i, name: '歯科' }, { re: /doctor|clinic|hospital|health/i, name: 'クリニック' }, { re: /veterinary/i, name: '動物病院' },
  { re: /gym|fitness|yoga|pilates/i, name: 'ジム・フィットネス' }, { re: /cafe|coffee/i, name: 'カフェ' }, { re: /bakery/i, name: 'パン屋' },
  { re: /bar|izakaya|pub/i, name: '居酒屋' }, { re: /ramen|noodle/i, name: 'ラーメン' }, { re: /restaurant|food|meal|dining/i, name: '飲食店' },
  { re: /real_estate/i, name: '不動産' }, { re: /lawyer|accounting|legal/i, name: '士業' }, { re: /pet/i, name: 'ペットサロン' },
  { re: /store|shop|retail/i, name: '小売' },
]
function industryFromPlace(primaryType: string, types: string[], name: string): string {
  const hay = `${primaryType} ${(types || []).join(' ')}`
  const m = PTYPE_MAP.find((x) => x.re.test(hay)) || PTYPE_MAP.find((x) => x.re.test(name))
  return m ? m.name : ''
}

export async function runGooglePlaces(admin: any, apiKey: string, rawSettings: any, userId: string | null) {
  const def = getDefaultSettings()
  const testFixed = !!rawSettings?.testFixed

  const preset = (rawSettings?.areaPreset || def.areaPreset) as AreaPresetKey
  const customAreas = asArray(rawSettings?.areas)
  const industries = asArray(rawSettings?.industries).length ? asArray(rawSettings?.industries) : def.industries
  const maxPerQuery = Math.max(1, Math.min(20, Number(rawSettings?.maxPerQuery) || def.maxPerQuery))
  const maxQueriesPerDay = Math.max(1, Number(rawSettings?.maxQueriesPerDay) || def.maxQueriesPerDay)
  const rotation = rawSettings?.rotation ?? def.rotation
  const autoImport = rawSettings?.autoImport ?? def.autoImport
  const dailyCap = Math.max(1, Number(rawSettings?.dailyCap) || def.dailyCap)
  const opts = {
    hotMaxReviews: Number(rawSettings?.hotMaxReviews) > 0 ? Number(rawSettings.hotMaxReviews) : 5,
    warmMaxReviews: Number(rawSettings?.warmMaxReviews) > 0 ? Number(rawSettings.warmMaxReviews) : 15,
    exclude100: rawSettings?.exclude100 ?? true,
    unknownHold: rawSettings?.unknownHold ?? true,
  }

  // 全国・新店系ワード検索（既定ON）。falseで旧エリア×業種ローテーション
  const nationwide = rawSettings?.placesNationwide ?? def.placesNationwide
  const searchMode = nationwide ? 'nationwide_new_open_query' : 'area_industry'

  // 対象エリア（旧モード用）
  let areas = preset === 'custom' ? customAreas : resolveAreas(preset, customAreas)
  let perQuery = nationwide ? Math.max(1, Math.min(20, Number(rawSettings?.placesPerQuery) || def.placesPerQuery)) : maxPerQuery
  let dayCap = nationwide ? Math.max(1, Number(rawSettings?.placesMaxQueriesPerDay) || def.placesMaxQueriesPerDay) : maxQueriesPerDay
  let useRotation = rotation
  const maxDetailsPerDay = Math.max(1, Number(rawSettings?.placesMaxDetailsPerDay) || def.placesMaxDetailsPerDay)

  // テスト固定: 少量・ローテーションなし
  if (testFixed) {
    areas = ['東京都葛飾区', '亀有']
    perQuery = nationwide ? 10 : 5
    dayCap = 6
    useRotation = false
  }

  // 全国モード: 地域名・業種名を含めない新店系ワードのみ。旧モード: エリア×業種
  const allQueries = nationwide
    ? NATIONAL_PLACES_QUERIES.map((w) => ({ query: w, isNewOpen: true, area: '', industry: '' }))
    : buildLeadQueries(areas, testFixed ? ['整体'] : industries)

  // ローテーション: 7日以内に実行済みのクエリはスキップ、未実行/古いものから dayCap 件
  let recentSet = new Set<string>()
  if (useRotation) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const { data } = await admin.from('lead_query_log').select('query').gte('last_run_at', since).limit(5000)
    recentSet = new Set((data || []).map((r: any) => r.query))
  }
  let picked = allQueries.filter((q) => !recentSet.has(q.query)).slice(0, dayCap)
  if (picked.length === 0) picked = allQueries.slice(0, dayCap) // 全部最近実行済みなら先頭から

  const counts = {
    fetched: 0, hot: 0, hold: 0, excluded: 0, imported: 0, duplicate: 0, error: 0,
    noPhone: 0, chainExcluded: 0, saved: 0, saveError: 0,
    review0_5: 0, review6_15: 0, review16_99: 0, review100: 0, reviewUnknown: 0,
    phoneYes: 0, detailCalls: 0, oldestRecent: 0, openingDateCount: 0, futureOpeningCount: 0,
    dupSkip: 0, detailCapped: 0,
    newOpenRan: picked.filter((q) => q.isNewOpen).length,
    normalRan: picked.filter((q) => !q.isNewOpen).length,
  }
  const debug: any = {
    preset, areas, industries,
    totalQueries: allQueries.length,
    ranQueries: picked.length,
    recentSkipped: recentSet.size,
    remaining: Math.max(0, allQueries.length - recentSet.size - picked.length),
    perQuery, maxQueriesPerDay: dayCap,
    queries: picked.map((q) => q.query),
    queryResults: [] as any[],
    sample: null,
    saveErrors: [] as string[],
  }
  let errorMessage = ''
  const recordSaveError = (msg: string) => { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(String(msg).slice(0, 300)) }

  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'google_places', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  try {
    const cases = await fetchCases(admin)
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount: number = importedToday || 0
    // 本日のPlace Details件数（コスト上限の基準）
    const { count: detailsTodayCount } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('google_places_checked_at', startToday.toISOString())
    const detailsToday = detailsTodayCount || 0
    debug.detailsToday = detailsToday
    debug.searchMode = searchMode
    const nowIso = new Date().toISOString()

    for (const gq of picked) {
      const query = gq.query
      const before = { hot: counts.hot, hold: counts.hold, excluded: counts.excluded }
      const r = await searchLight(apiKey, query, perQuery)
      if (r.error) { counts.error++; errorMessage = r.error }

      for (const lp of r.places) {
        counts.fetched++
        const placeId: string = lp.id || ''
        const name: string = lp.displayName?.text || ''
        const address: string = lp.formattedAddress || ''
        const hay = `${name} ${address}`
        const reviewCount: number | null = typeof lp.userRatingCount === 'number' ? lp.userRatingCount : null

        // 口コミ件数の内訳
        if (reviewCount === null) counts.reviewUnknown++
        else if (reviewCount <= opts.hotMaxReviews) counts.review0_5++
        else if (reviewCount <= opts.warmMaxReviews) counts.review6_15++
        else if (reviewCount < 100) counts.review16_99++
        else counts.review100++

        // 足切り: チェーン/施設内/支店、口コミ6件以上は深掘りしない（API節約）
        const chainish = CHAIN_HINT.test(name) || MALL_HINT.test(hay) || BRANCH_HINT.test(name)
        if (chainish) { counts.chainExcluded++; continue }
        // 6件以上は対象外。ただし FUTURE_OPENING（開業予定）は口コミより優先して必ず詳細取得
        if (reviewCount !== null && reviewCount > opts.hotMaxReviews && lp.businessStatus !== 'FUTURE_OPENING') continue

        // 既存(place_id)を先に確認 → 30日以内にチェック済みなら詳細を再取得しない（コスト削減）
        let existing: any = null
        if (placeId) {
          const { data } = await admin.from('lead_candidates').select('*').eq('google_place_id', placeId).limit(1)
          existing = data && data[0] ? data[0] : null
        }
        if (existing?.google_places_checked_at && (Date.now() - Date.parse(existing.google_places_checked_at)) < 30 * 86400000) { counts.dupSkip++; continue }
        // Place Details の1日上限（コスト制御）
        if (detailsToday + counts.detailCalls >= maxDetailsPerDay) { counts.detailCapped++; continue }

        // 第2段階: 詳細取得（電話・レビュー日・開店日・businessStatus）
        const detail = await placeDetails(apiKey, placeId)
        counts.detailCalls++
        const p = detail || lp
        const phone = phoneOf(p)
        if (phone) counts.phoneYes++
        const openingDate = parseOpeningDate(p.openingDate)
        const og = parseGoogleOpening(p.openingDate, p.businessStatus)
        if (og.has) counts.openingDateCount = (counts.openingDateCount || 0) + 1
        if (p.businessStatus === 'FUTURE_OPENING') counts.futureOpeningCount = (counts.futureOpeningCount || 0) + 1
        const { latest: latestPub, oldest: oldestPub } = reviewDates(p)
        const fromNewOpen = gq.isNewOpen
        const firstSeenDays = existing?.first_seen_at ? Math.max(0, Math.floor((Date.now() - Date.parse(existing.first_seen_at)) / 86400000)) : 0
        // 全国モード: 住所から都道府県/市区町村、primaryType/types/店名から業種を抽出
        const region = regionFromAddress(p.formattedAddress || address)
        const industryGuess = industryFromPlace(p.primaryType || '', Array.isArray(p.types) ? p.types : [], name) || gq.industry || null

        const classified: any = classifyLead({
          name, address,
          industry: industryGuess || undefined,
          phone_number: phone,
          website_url: p.websiteUri || '',
          place_id: placeId,
          is_new_gbp: !existing,
          review_count: (typeof p.userRatingCount === 'number' ? p.userRatingCount : reviewCount) ?? undefined,
          business_status: p.businessStatus || undefined,
          opening_date: openingDate || undefined,
          first_seen_days: firstSeenDays,
          from_new_open_query: fromNewOpen,
          latest_review_publish_time: latestPub || undefined,
          oldest_review_publish_time: oldestPub || undefined,
        }, cases, opts)

        if (classified.oldest_review_is_recent) counts.oldestRecent++
        if (classified.lead_temperature === 'HOT') counts.hot++
        else if (classified.lead_temperature === 'EXCLUDED') counts.excluded++
        else counts.hold++
        if (classified.duplicate_of_case_id) counts.duplicate++
        if (!classified.phone_normalized) counts.noPhone++

        const payload: any = {
          ...classified,
          source_type: 'AI自動投入',
          detected_signals: classified.is_new_gbp ? ['GBP'] : (classified.detected_signals || []),
          google_place_id: placeId || null,
          google_maps_uri: p.googleMapsUri || null,
          rating: typeof p.rating === 'number' ? p.rating : null,
          user_rating_count: classified.user_rating_count ?? reviewCount,
          business_status: p.businessStatus || null,
          place_types: Array.isArray(p.types) ? p.types : null,
          primary_type: p.primaryType || null,
          website_url: p.websiteUri || null,
          search_query: query,
          source_run_id: runId,
          raw_payload: p,
          last_seen_at: nowIso,
          // Google openingDate / businessStatus（口コミより強い新店シグナル）
          google_business_status: p.businessStatus || null,
          google_opening_date_year: og.year, google_opening_date_month: og.month, google_opening_date_day: og.day,
          google_opening_date_raw: og.raw, has_google_opening_date: og.has,
          opening_date_source: og.has ? 'google_places_openingDate' : null, opening_date_confidence: og.has ? og.confidence : null,
          days_until_opening: og.daysUntil, days_since_opening: og.daysSince,
          google_places_checked_at: nowIso, opening_date_checked_at: og.has ? nowIso : null,
          // 全国モード: 検索条件ではなく抽出結果として保存
          places_search_query: query, places_search_mode: searchMode,
          extracted_prefecture: region.prefecture || null, extracted_city: region.city || null,
          extracted_area: region.area || null, extracted_industry: industryGuess,
          google_primary_type: p.primaryType || null, google_types: Array.isArray(p.types) ? p.types : null,
          google_website_uri: p.websiteUri || null, google_rating: typeof p.rating === 'number' ? p.rating : null,
          google_user_rating_count: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
        }

        if (!debug.sample) {
          debug.sample = {
            place: { name, address, nationalPhoneNumber: p.nationalPhoneNumber || '', websiteUri: p.websiteUri || '', primaryType: p.primaryType || '', userRatingCount: reviewCount, openingDate: openingDate || null },
            query, isNewOpen: fromNewOpen,
            classified: {
              lead_temperature: classified.lead_temperature,
              owner_reachability_score: classified.owner_reachability_score,
              is_new_opening_candidate: classified.is_new_opening_candidate,
              newness_reason: classified.newness_reason || '',
              review_newness_reason: classified.review_newness_reason || '',
              opening_date: classified.opening_date || null,
              days_since_first_seen: classified.days_since_first_seen,
              from_new_open_query: fromNewOpen,
              user_rating_count: classified.user_rating_count,
              latest_review_publish_time: classified.latest_review_publish_time || null,
              oldest_review_publish_time: classified.oldest_review_publish_time || null,
              oldest_review_days_ago: classified.oldest_review_days_ago,
              review_dates_checked: classified.review_dates_checked,
              phone_normalized: classified.phone_normalized || '',
              exclusion_reason: classified.exclusion_reason || '',
            },
          }
        }

        // 保存
        let candidateId: string | null = existing?.id || null
        const alreadyImported = !!existing?.imported_to_cases
        if (existing) {
          const { error: upErr } = await admin.from('lead_candidates').update(payload).eq('id', existing.id)
          if (upErr) recordSaveError('lead update: ' + upErr.message); else counts.saved++
        } else {
          const { data: ins, error: insErr } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
          if (insErr) recordSaveError('lead insert: ' + insErr.message); else counts.saved++
          candidateId = ins?.id || null
        }

        // HOT自動投入
        if (autoImport && classified.lead_temperature === 'HOT' && !classified.duplicate_of_case_id && !alreadyImported && importedCount < dailyCap && candidateId) {
          const memo = [
            `【AI自動投入 / GBP】`,
            `投入理由: ${classified.auto_import_reason || ''}`,
            `AIコメント: ${classified.ai_comment || ''}`,
            `口コミ: ${payload.user_rating_count ?? '不明'} / 最古口コミ: ${classified.oldest_review_days_ago ?? '不明'}日前`,
            `到達スコア: ${classified.owner_reachability_score}`,
          ].join('\n')
          const { data: created, error: caseErr } = await admin.from('cases').insert({
            name: classified.name, address: classified.address || '', phone1: classified.phone_number || '',
            industry: classified.industry || null, status: DEFAULT_STATUS, hp1: payload.website_url,
            instagram: classified.instagram_url || null, source_urls: 'AI自動投入', memo, created_by_id: userId,
          }).select('id').single()
          if (caseErr) recordSaveError('case insert: ' + caseErr.message)
          if (created?.id) {
            await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId)
            counts.imported++; importedCount++
            await admin.from('audit_logs').insert({ action: 'create', entity: 'case', entity_id: created.id, entity_name: classified.name, detail: 'AI自動投入（Google Places）', actor_id: userId }).then(() => {}, () => {})
          }
        }
      }

      // クエリ実行履歴を記録（ローテーション用）
      await admin.from('lead_query_log').upsert({
        query, source: 'google_places', last_run_at: nowIso,
        places_count: r.places.length, hot_count: counts.hot - before.hot, runs: 1,
        prefecture: prefectureOfArea(gq.area), area: gq.area,
      }, { onConflict: 'query' }).then(() => {}, () => {})

      debug.queryResults.push({
        query, isNewOpen: gq.isNewOpen, status: r.status, placesLength: r.places.length, error: r.error,
        hot: counts.hot - before.hot, hold: counts.hold - before.hold, excluded: counts.excluded - before.excluded,
      })
    }

    debug.estApiCalls = picked.length + counts.detailCalls
    await admin.from('auto_lead_runs').update({
      status: 'success', finished_at: new Date().toISOString(),
      search_queries_count: picked.length, fetched_count: counts.fetched,
      hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded,
      imported_count: counts.imported, duplicate_count: counts.duplicate,
      error_count: counts.error, error_message: errorMessage || null,
    }).eq('id', runId)

    return { ok: true, runId, queries: picked.length, ...counts, debug }
  } catch (e: any) {
    const msg = String(e?.message || e)
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: msg, error_count: counts.error + 1 }).eq('id', runId)
    throw new Error(msg)
  }
}

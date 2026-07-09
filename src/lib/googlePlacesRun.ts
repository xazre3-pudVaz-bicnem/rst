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
import { isForeignAddress, isOrgNonStore, isJapanAddress, isJapanPhone, isForeignPhone } from './japanFilter.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { findCaseIdByPhone } from './caseDedup.js'

const SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
const DETAILS_ENDPOINT = 'https://places.googleapis.com/v1/places/'
// 判定ロジックの版（openingDate最優先版）。版が上がると既存候補は30日内でも再評価される。
export const GP_LOGIC_VERSION = 3

// 第1段階（軽い検索：country判定のため addressComponents も取得。openingDate/businessStatus を検索段階でも取得し新店を優先）
const LIGHT_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.internationalPhoneNumber', 'places.nationalPhoneNumber',
  'places.userRatingCount', 'places.rating', 'places.types', 'places.primaryType', 'places.primaryTypeDisplayName',
  'places.businessStatus', 'places.openingDate', 'places.googleMapsUri', 'places.websiteUri',
  'nextPageToken',
].join(',')

// 第2段階（詳細取得：電話・レビュー日・開店日・addressComponents など）
const DETAIL_FIELDS_EXT = [
  'id', 'displayName', 'formattedAddress', 'addressComponents', 'nationalPhoneNumber', 'internationalPhoneNumber',
  'websiteUri', 'googleMapsUri', 'rating', 'userRatingCount', 'businessStatus', 'types', 'primaryType', 'primaryTypeDisplayName',
  'openingDate', 'currentOpeningHours', 'regularOpeningHours', 'reviews',
].join(',')
const DETAIL_FIELDS_BASE = [
  'id', 'displayName', 'formattedAddress', 'addressComponents', 'nationalPhoneNumber', 'internationalPhoneNumber',
  'websiteUri', 'googleMapsUri', 'rating', 'userRatingCount', 'businessStatus', 'types', 'primaryType', 'primaryTypeDisplayName', 'openingDate',
].join(',')

// 日本全体をカバーする矩形（locationRestriction）。海外を最初から検索結果に入れない。
const JAPAN_RECTANGLE = {
  low: { latitude: 20.0, longitude: 122.0 },
  high: { latitude: 46.0, longitude: 154.0 },
}

// 全国を地域ブロックに分割（locationRestrictionをブロック単位にして、東京偏重を避け地方の開業前GBPまで網羅）。
// 各クエリにブロックを割り当て、実行ごとにローテーションで全国をカバーする。
export const REGION_RECTANGLES: { key: string; name: string; rect: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } } }[] = [
  { key: 'hokkaido', name: '北海道', rect: { low: { latitude: 41.3, longitude: 139.3 }, high: { latitude: 45.6, longitude: 146.0 } } },
  { key: 'tohoku_n', name: '北東北', rect: { low: { latitude: 39.4, longitude: 139.4 }, high: { latitude: 41.6, longitude: 142.1 } } },
  { key: 'tohoku_s', name: '南東北', rect: { low: { latitude: 37.0, longitude: 139.2 }, high: { latitude: 39.5, longitude: 141.7 } } },
  { key: 'kita_kanto', name: '北関東', rect: { low: { latitude: 35.9, longitude: 138.4 }, high: { latitude: 37.1, longitude: 140.9 } } },
  { key: 'tokyo', name: '東京・神奈川', rect: { low: { latitude: 35.1, longitude: 138.9 }, high: { latitude: 35.95, longitude: 140.3 } } },
  { key: 'chiba_saitama', name: '千葉・埼玉', rect: { low: { latitude: 35.0, longitude: 138.8 }, high: { latitude: 36.3, longitude: 140.9 } } },
  { key: 'koshinetsu', name: '甲信越', rect: { low: { latitude: 35.2, longitude: 137.3 }, high: { latitude: 38.6, longitude: 139.9 } } },
  { key: 'tokai', name: '東海', rect: { low: { latitude: 34.5, longitude: 136.4 }, high: { latitude: 35.9, longitude: 138.9 } } },
  { key: 'hokuriku', name: '北陸', rect: { low: { latitude: 35.4, longitude: 135.9 }, high: { latitude: 37.6, longitude: 137.7 } } },
  { key: 'kansai', name: '関西', rect: { low: { latitude: 33.4, longitude: 134.3 }, high: { latitude: 35.7, longitude: 136.5 } } },
  { key: 'chugoku', name: '中国', rect: { low: { latitude: 33.8, longitude: 130.9 }, high: { latitude: 35.6, longitude: 134.4 } } },
  { key: 'shikoku', name: '四国', rect: { low: { latitude: 32.7, longitude: 132.0 }, high: { latitude: 34.4, longitude: 134.8 } } },
  { key: 'kyushu_n', name: '北部九州', rect: { low: { latitude: 32.6, longitude: 129.3 }, high: { latitude: 34.0, longitude: 131.9 } } },
  { key: 'kyushu_s', name: '南九州', rect: { low: { latitude: 30.9, longitude: 130.2 }, high: { latitude: 32.9, longitude: 132.1 } } },
  { key: 'okinawa', name: '沖縄', rect: { low: { latitude: 24.0, longitude: 122.9 }, high: { latitude: 27.9, longitude: 131.4 } } },
]

/** addressComponents優先で日本国内のplaceか判定（formattedAddress/電話でフォールバック）。 */
export function isJapanPlace(p: any): { isJapan: boolean; decided: boolean; country: string; basis: string } {
  const comps = Array.isArray(p?.addressComponents) ? p.addressComponents : []
  const cc = comps.find((c: any) => Array.isArray(c?.types) && c.types.includes('country'))
  const country = String(cc?.shortText || cc?.longText || '')
  if (country) {
    const jp = /^(JP|日本|Japan)$/i.test(country)
    return { isJapan: jp, decided: true, country, basis: 'addressComponents.country' }
  }
  const addr = p?.formattedAddress || ''
  const intl = p?.internationalPhoneNumber || ''
  if (isJapanAddress(addr)) return { isJapan: true, decided: true, country: '', basis: 'formattedAddress' }
  if (/^\+?81[\s-]?\d/.test(intl) || isJapanPhone(p?.nationalPhoneNumber)) return { isJapan: true, decided: true, country: '', basis: 'phone' }
  if (isForeignAddress(addr) || isForeignPhone(intl)) return { isJapan: false, decided: true, country: '', basis: 'foreign-markers' }
  return { isJapan: false, decided: false, country: '', basis: 'unknown' }
}

let detailExtSupported = true

export function getAdminClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（Vercel環境変数）')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

// 全国・新店系ワードでの検索クエリ（地域名・業種名・「日本」は入れない。日本寄せは languageCode=ja / regionCode=JP ＋取得後フィルタで担保）
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
    placesMaxDetailsPerDay: 300,
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

/** 第1段階: 軽い検索（1ページ）。pageToken指定で次ページ。nextPageToken も返す。rect指定で地域ブロック検索。 */
export async function searchLight(apiKey: string, query: string, maxResultCount: number, pageToken?: string, rect?: any): Promise<{ status: number; places: any[]; error: string | null; nextPageToken: string | null }> {
  try {
    const body: any = {
      textQuery: query, languageCode: 'ja', regionCode: 'JP',
      pageSize: Math.max(1, Math.min(20, maxResultCount)),
      // オープン予定（future opening）のビジネスも検索対象に含める（新店を取りこぼさない）
      includeFutureOpeningBusinesses: true,
      // 日本国内に限定（locationBiasではなくRestriction）。海外を結果に入れない。地域ブロック指定で全国を網羅。
      locationRestriction: { rectangle: rect || JAPAN_RECTANGLE },
    }
    if (pageToken) body.pageToken = pageToken
    // タイムアウト必須: Places APIが応答しないと関数が60秒上限で504になる。通常は1〜2秒で返るため8秒で打ち切り、
    // 1回の実行により多くのクエリを回す（=HOT発見数を増やす）。
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': LIGHT_FIELDS },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text().catch(() => '')
    clearTimeout(to)
    let json: any = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = {} }
    if (!res.ok) return { status: res.status, places: [], error: String(json?.error?.message || text || `HTTP ${res.status}`).slice(0, 400), nextPageToken: null }
    return { status: res.status, places: Array.isArray(json.places) ? json.places : [], error: null, nextPageToken: json.nextPageToken || null }
  } catch (e: any) {
    return { status: 0, places: [], error: String(e?.message || e), nextPageToken: null }
  }
}

/** 1クエリを複数ページ取得（nextPageTokenを辿る）。重複place_idは除外。
 *  deadlineMs必須級: ページングは1ページ最大12秒×3＋待機で約40秒かかり得るため、期限が近ければ
 *  次ページに進まない（これが無いと呼び出し元の予算チェックを通過した直後に60秒関数上限を突破し504になる）。 */
export async function searchPaged(apiKey: string, query: string, perPage: number, maxPages: number, resultLimit: number, rect?: any, deadlineMs?: number): Promise<{ status: number; places: any[]; error: string | null; pages: number; apiReturned: number }> {
  const seen = new Set<string>(); const out: any[] = []
  let token: string | undefined = undefined; let pages = 0; let apiReturned = 0; let status = 0; let error: string | null = null
  for (let i = 0; i < Math.max(1, maxPages); i++) {
    if (deadlineMs && Date.now() > deadlineMs - 10000) break  // 次の1ページ(最大~10s)が期限内に収まらない → 打ち切り
    const r: { status: number; places: any[]; error: string | null; nextPageToken: string | null } = await searchLight(apiKey, query, perPage, token, rect)
    status = r.status; if (r.error) { error = r.error; break }
    pages++; apiReturned += r.places.length
    for (const p of r.places) { const id = p.id || JSON.stringify(p.displayName); if (!seen.has(id)) { seen.add(id); out.push(p) } }
    if (out.length >= resultLimit || !r.nextPageToken) break
    token = r.nextPageToken
    await new Promise((rs) => setTimeout(rs, 1500))  // nextPageToken は数秒の伝播待ちが必要
  }
  return { status, places: out.slice(0, resultLimit), error, pages, apiReturned }
}

/** 第2段階: 詳細取得（電話・レビュー日・開店日）。openingDate/reviewsが400なら自動でBASEに落とす */
export async function placeDetails(apiKey: string, placeId: string): Promise<any | null> {
  async function attempt(ext: boolean) {
    // タイムアウト必須（60秒関数上限で504になるのを防ぐ）。Place Detailsは10秒で打ち切る。
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(DETAILS_ENDPOINT + encodeURIComponent(placeId) + '?languageCode=ja&regionCode=JP', {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': ext ? DETAIL_FIELDS_EXT : DETAIL_FIELDS_BASE },
      signal: ctrl.signal,
    })
    const text = await res.text().catch(() => '')
    clearTimeout(to)
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
// primaryType / types / 店名 から正規の業種を推定（フォーム選択肢と一致する値のみ）。
// 英語のtypesで拾えないケースは日本語の店名でも判定する。
function industryFromPlace(primaryType: string, types: string[], name: string): string {
  const hay = `${primaryType} ${(types || []).join(' ')}`
  return classifyIndustry(hay) || classifyIndustry(name)
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
  const aiInjectMode = (rawSettings?.aiInjectMode === 'strict' || rawSettings?.aiInjectMode === 'aggressive') ? rawSettings.aiInjectMode : 'standard'
  const autoImportPerRun = Math.max(1, Number(rawSettings?.autoImportPerRun) || 50)
  const autoImportPerDay = Math.max(1, Number(rawSettings?.autoImportPerDay) || 200)
  const opts = {
    hotMaxReviews: Number(rawSettings?.hotMaxReviews) > 0 ? Number(rawSettings.hotMaxReviews) : 5,
    warmMaxReviews: Number(rawSettings?.warmMaxReviews) > 0 ? Number(rawSettings.warmMaxReviews) : 15,
    exclude100: rawSettings?.exclude100 ?? true,
    unknownHold: rawSettings?.unknownHold ?? true,
    aiInjectMode,
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
  const detailsLimitPerRun = Math.max(1, Number(rawSettings?.placesDetailsLimitPerRun) || 100)  // 1回あたりPlace Details上限
  const skipDetailsIfReviewsOver = Math.max(1, Number(rawSettings?.placesSkipDetailsIfReviewsOver) || 100)  // 口コミN件以上はDetailsスキップ
  const openingDatePriority = rawSettings?.placesOpeningDatePriority !== false  // openingDate優先（既定ON）
  const pagesPerQuery = Math.max(1, Math.min(5, Number(rawSettings?.placesPagesPerQuery) || 3))  // 1クエリのページ取得数（nextPageToken）
  const resultsPerQueryLimit = Math.max(1, Math.min(100, Number(rawSettings?.placesResultsPerQueryLimit) || 60))  // 1クエリの最大件数

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
    openFuture: 0, openWithin90: 0, openWithin180: 0, openWithin365: 0, openOver365: 0, newGbpPriority: 0,
    reviews100Excluded: 0, reviews31Excluded: 0, closedPermExcluded: 0,
    apiReturned: 0, pages: 0, uniquePlaceIds: 0, existingPlaceIds: 0, reEvaluated: 0,
    dupSkip: 0, detailCapped: 0, foreignSkipped: 0, orgFiltered: 0,
    detailFailed: 0, judged: 0, skipped: 0, hotA: 0, hotB: 0,
    countryJP: 0, countryNonJP: 0, addressCompMissing: 0, japanByAddrOnly: 0,
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
    skipReasons: {} as Record<string, number>,
    saveErrorDetails: [] as any[],
  }
  let errorMessage = ''
  // 504回避: 実行全体の時間予算（Vercel maxDuration 60s に対する安全マージン）。超過後は新規クエリ/詳細取得を打ち切り次回へ。
  const runStart = Date.now()
  // 既定150秒(Vercel Pro・maxDuration300s): Detailsが終盤に走っても上限内に収まる余白を残す
  const RUN_BUDGET_MS = Math.max(20000, Math.min(280000, Number(rawSettings?.runBudgetMs) || 150000))
  const overBudget = () => (Date.now() - runStart) > RUN_BUDGET_MS
  const runDeadline = () => runStart + RUN_BUDGET_MS
  debug.runBudgetMs = RUN_BUDGET_MS
  const recordSaveError = (msg: string, ctx?: any) => {
    counts.saveError++
    if (debug.saveErrors.length < 5) debug.saveErrors.push(String(msg).slice(0, 300))
    if (debug.saveErrorDetails.length < 20) debug.saveErrorDetails.push({ message: String(msg).slice(0, 300), ...(ctx || {}) })
  }
  const addSkipReason = (k: string) => { debug.skipReasons[k] = (debug.skipReasons[k] || 0) + 1 }

  // ゾンビrun掃除: 60秒上限で強制終了され status='running' のまま残った過去runをerror化（「running」表示が残り続けるのを防ぐ）
  await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: 'タイムアウト/強制終了(60s上限)の可能性' }).eq('source', 'google_places').eq('status', 'running').lt('created_date', new Date(Date.now() - 180000).toISOString()).then(() => {}, () => {})
  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'google_places', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  try {
    const cases = await fetchCases(admin)
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount: number = importedToday || 0
    // 本日のPlace Details件数（コスト上限の基準）
    // 日次Details上限は「実際にDetailsを取得した候補」で数える（EXCLUDED等のlight判定のみの保存は数えない＝上限を無駄に消費しない）
    const { count: detailsTodayCount } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('last_details_fetched_at', startToday.toISOString())
    const detailsToday = detailsTodayCount || 0
    debug.detailsToday = detailsToday
    debug.searchMode = searchMode
    debug.languageCode = 'ja'
    debug.regionCode = 'JP'
    debug.japanFilter = true
    debug.locationRestriction = true
    debug.japanCountryFilter = true
    const nowIso = new Date().toISOString()

    // 全国エリアグリッド: 各クエリに地域ブロックを割り当て（東京偏重を避け全国網羅）。実行ごとに開始位置をずらす。
    const useGrid = nationwide && rawSettings?.placesAreaGrid !== false
    // 実行ごとに+1する回転オフセット（過去のgoogle_places実行回数）。以前は picked.length で固定化され
    // 地域↔クエリ対応が毎回同じになり、高indexの地域が永久に走査されないバグがあった。実行数で全地域を順に網羅する。
    const { count: gpRunCount } = await admin.from('auto_lead_runs').select('id', { count: 'exact', head: true }).eq('source', 'google_places')
    const gridOffset = (gpRunCount || 0)
    const regionsCovered = new Set<string>()
    let qi = -1
    for (const gq of picked) {
      qi++
      // 504回避: 予算超過 or 残りが1ページぶん(~15s)未満なら残りクエリは次回実行に回す
      if (overBudget() || (RUN_BUDGET_MS - (Date.now() - runStart)) < 15000) { debug.stoppedEarly = true; debug.deferredQueries = (debug.deferredQueries || 0) + 1; continue }
      const query = gq.query
      const region = useGrid ? REGION_RECTANGLES[(qi + gridOffset) % REGION_RECTANGLES.length] : null
      if (region) regionsCovered.add(region.name)
      const r = await searchPaged(apiKey, query, perQuery, pagesPerQuery, resultsPerQueryLimit, region?.rect, runDeadline())
      if (r.error) { counts.error++; errorMessage = r.error }
      counts.apiReturned += r.apiReturned; counts.pages += r.pages; counts.uniquePlaceIds += r.places.length
      // クエリ別の内訳（取得→Details→判定→保存→スキップ理由）
      const qstat: any = {
        query, region: region?.name || '全国', isNewOpen: gq.isNewOpen, status: r.status, placesLength: r.places.length, pages: r.pages, apiReturned: r.apiReturned, error: r.error,
        detail: 0, judged: 0, hot: 0, hold: 0, excluded: 0, skipped: 0, saved: 0, saveError: 0,
        reasons: {} as Record<string, number>, items: [] as any[],
      }
      const qReason = (k: string) => { qstat.reasons[k] = (qstat.reasons[k] || 0) + 1; addSkipReason(k) }
      const logItem = (it: any) => { if (qstat.items.length < 30) qstat.items.push(it) }

      // 既存(place_id)チェックをクエリ単位で一括取得（以前は1件ずつSELECTしており、予算切れ後も
      // 残り数十件×DB往復で60秒関数上限を突破→504の原因になっていた。60回→1回で高速化）
      const lpIds = r.places.map((p: any) => p.id).filter(Boolean)
      const existingByPlaceId = new Map<string, any>()
      if (lpIds.length) {
        const { data: exRows } = await admin.from('lead_candidates').select('*').in('google_place_id', lpIds)
        for (const row of (exRows || [])) if (row.google_place_id) existingByPlaceId.set(row.google_place_id, row)
      }

      for (const lp of r.places) {
        // 強制打ち切り: 予算+5秒を超えたら保存もせず即終了（60秒関数上限の死守。残りは次回実行で継続）
        if ((Date.now() - runStart) > RUN_BUDGET_MS + 5000) { debug.hardStopped = true; break }
        counts.fetched++
        const placeId: string = lp.id || ''
        const name: string = lp.displayName?.text || ''
        const address: string = lp.formattedAddress || ''
        const hay = `${name} ${address}`
        const reviewCount: number | null = typeof lp.userRatingCount === 'number' ? lp.userRatingCount : null
        const businessStatusLight: string = lp.businessStatus || ''

        // 口コミ件数の内訳
        if (reviewCount === null) counts.reviewUnknown++
        else if (reviewCount <= opts.hotMaxReviews) counts.review0_5++
        else if (reviewCount <= opts.warmMaxReviews) counts.review6_15++
        else if (reviewCount < 100) counts.review16_99++
        else counts.review100++

        // === 日本国内判定（最優先）===: 確定的に海外なら詳細を取らず保存もしない（HOT/HOLDに入れない）
        const jpLight = isJapanPlace(lp)
        if (jpLight.country === 'JP') counts.countryJP++
        else if (jpLight.country) counts.countryNonJP++
        if (!jpLight.country && !(Array.isArray(lp.addressComponents) && lp.addressComponents.length)) counts.addressCompMissing++
        if (jpLight.decided && !jpLight.isJapan) {
          counts.foreignSkipped++; counts.skipped++; qstat.skipped++; qReason(jpLight.country ? `日本国外(country=${jpLight.country})` : '日本国外')
          logItem({ placeId, name, address, country: jpLight.country || '—', isJapanPlace: false, result: 'SKIPPED', skip: '日本国外の候補のため除外', exclusion: '日本国外の候補のため除外', saved: false }); continue
        }

        // 店名に「ニュー/New/新店/新規」を含むだけの新規オープン系クエリ一致は店名誤ヒット（NewDays/ニューヤマザキ/
        // ○○ニュータウンSS等）。openingDate/FUTURE_OPENING/口コミ僅少の実根拠が無ければ保存もしない（リストを汚さない）。
        if (gq.isNewOpen && /(ニュー|ＮＥＷ|new|新店|新規)/i.test(name) && !lp.openingDate && businessStatusLight !== 'FUTURE_OPENING' && !(reviewCount !== null && reviewCount <= opts.hotMaxReviews)) {
          counts.skipped++; qstat.skipped++; qReason('店名にニュー/New（クエリ誤ヒット・新店根拠なし）')
          logItem({ placeId, name, address, userRatingCount: reviewCount, result: 'SKIPPED', skip: '店名ニュー/New誤ヒット（openingDate等の根拠なし）', saved: false }); continue
        }

        // 既存(place_id)を先に確認（クエリ冒頭で一括取得済みのMapから参照＝DB往復なし）
        const existing: any = placeId ? (existingByPlaceId.get(placeId) || null) : null
        if (existing) counts.existingPlaceIds++
        // === 30日スキップは「最新ロジックで完全評価済み」のときだけ。openingDate/Details未取得は再評価する（item6）===
        const fullyEvaluated = !!existing
          && existing.google_places_logic_version === GP_LOGIC_VERSION
          && existing.opening_date_checked_at != null
          && existing.last_details_fetched_at != null
        if (fullyEvaluated && existing.google_places_checked_at && (Date.now() - Date.parse(existing.google_places_checked_at)) < 30 * 86400000) {
          counts.dupSkip++; counts.skipped++; qstat.skipped++; qReason('place_id_30日以内・最新ロジックで評価済み')
          logItem({ placeId, name, address, userRatingCount: reviewCount, result: 'SKIPPED', skip: '30日place_id(評価済)', saved: false }); continue
        }
        if (existing && !fullyEvaluated) counts.reEvaluated++  // openingDate/Details/ロジック未評価 → 再評価対象

        // 明確な除外（Detailsを取らずEXCLUDED保存＝APIコスト削減・記録は残す）
        const chainish = CHAIN_HINT.test(name) || MALL_HINT.test(hay) || BRANCH_HINT.test(name)
        const orgLike = isOrgNonStore(name)
        const closedPermLight = businessStatusLight === 'CLOSED_PERMANENTLY'
        // 口コミ多数(>warmMax)かつ FUTURE_OPENING でない＝既存店。openingDateはlightで分からないため詳細は取らずEXCLUDED保存
        const tooManyReviewsLight = reviewCount !== null && reviewCount > opts.warmMaxReviews && businessStatusLight !== 'FUTURE_OPENING'
        const hardExclude = chainish || orgLike || closedPermLight || tooManyReviewsLight

        // === Details取得（hardExcludeでなければ）===
        let p: any = lp
        let detailFetched = false   // 実際にPlace Details APIを呼んだか（日次上限はこれで数える）
        const fromNewOpen = gq.isNewOpen
        if (!hardExclude) {
          // 504回避: 時間予算を超えたら詳細取得を打ち切り次回へ（SKIPPED）
          if (overBudget()) {
            counts.skipped++; qstat.skipped++; qReason('実行時間上限(次回継続)')
            logItem({ placeId, name, address, userRatingCount: reviewCount, result: 'SKIPPED', skip: '実行時間上限・次回継続', saved: false }); continue
          }
          // Place Details の1日上限/1回上限（コスト制御）→ SKIPPED（保存しない）
          if (detailsToday + counts.detailCalls >= maxDetailsPerDay || counts.detailCalls >= detailsLimitPerRun) {
            counts.detailCapped++; counts.skipped++; qstat.skipped++; qReason('Details上限超過（1回/1日）')
            logItem({ placeId, name, address, userRatingCount: reviewCount, result: 'SKIPPED', skip: 'Details上限', saved: false }); continue
          }
          // 口コミ多すぎ（openingDate優先設定時はDetailsを打たずスキップ。ただしFUTURE_OPENINGは取得）
          if (openingDatePriority && skipDetailsIfReviewsOver > 0 && reviewCount !== null && reviewCount >= skipDetailsIfReviewsOver && businessStatusLight !== 'FUTURE_OPENING') {
            counts.detailCapped++; counts.skipped++; qstat.skipped++; qReason(`口コミ${reviewCount}件(>=${skipDetailsIfReviewsOver})のためDetailsスキップ`)
            logItem({ placeId, name, address, userRatingCount: reviewCount, result: 'SKIPPED', skip: '口コミ多数Detailsスキップ', saved: false }); continue
          }
          const detail = await placeDetails(apiKey, placeId)
          counts.detailCalls++; qstat.detail++; detailFetched = true
          if (detail) p = detail
          else { counts.detailFailed++; qReason('Details取得失敗'); p = lp } // 取得失敗でもlight情報で判定・保存（握りつぶさない）
        }

        // === 日本国内判定（詳細のaddressComponentsで最終確認）===: 日本と確認できなければ保存しない
        const jp = isJapanPlace(p)
        if (jp.basis === 'formattedAddress' || jp.basis === 'phone') counts.japanByAddrOnly++
        if (!jp.isJapan) {
          counts.foreignSkipped++; counts.skipped++; qstat.skipped++; qReason(jp.country ? `日本国外(country=${jp.country})` : (jp.decided ? '日本国外' : '日本判定不可'))
          logItem({ placeId, name, address: p.formattedAddress || address, country: jp.country || '—', isJapanPlace: false, result: 'SKIPPED', skip: '日本国外/日本判定不可', exclusion: '日本国外の候補のため除外', saved: false }); continue
        }
        const jpCountry = jp.country || 'JP(住所判定)'

        const phone = phoneOf(p)
        if (phone) counts.phoneYes++
        const openingDate = parseOpeningDate(p.openingDate)
        const og = parseGoogleOpening(p.openingDate, p.businessStatus)
        if (og.has) counts.openingDateCount = (counts.openingDateCount || 0) + 1
        if (p.businessStatus === 'FUTURE_OPENING') counts.futureOpeningCount = (counts.futureOpeningCount || 0) + 1
        const { latest: latestPub, oldest: oldestPub } = reviewDates(p)
        const firstSeenDays = existing?.first_seen_at ? Math.max(0, Math.floor((Date.now() - Date.parse(existing.first_seen_at)) / 86400000)) : 0
        const region = regionFromAddress(p.formattedAddress || address)
        const industryGuess = industryFromPlace(p.primaryType || '', Array.isArray(p.types) ? p.types : [], name) || normalizeIndustry(gq.industry) || null

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
        counts.judged++; qstat.judged++
        // openingDate帯のカウント（UIログ用）
        const oBand = (classified as any).opening_date_band
        if (oBand === 'future') counts.openFuture++
        else if (oBand === 'd0_90') counts.openWithin90++
        else if (oBand === 'd91_180') counts.openWithin180++
        else if (oBand === 'd181_365') counts.openWithin365++
        else if (oBand === 'over365') counts.openOver365++
        if ((classified as any).is_new_gbp_priority) counts.newGbpPriority++
        if (classified.lead_temperature === 'EXCLUDED' && p.businessStatus === 'CLOSED_PERMANENTLY') counts.closedPermExcluded++
        if (classified.lead_temperature === 'EXCLUDED' && !og.has && (reviewCount ?? 0) >= 100) counts.reviews100Excluded++
        else if (classified.lead_temperature === 'EXCLUDED' && !og.has && (reviewCount ?? 0) >= 31) counts.reviews31Excluded++

        // === HOLDフォールバック ===
        // 取得できた日本の新店候補は、明確な除外理由が無ければ最低HOLDで保存（電話/openingDateが無くても確認余地ありとして残す）
        const fullAddress = p.formattedAddress || address
        const hasJapanAddr = isJapanAddress(fullAddress)
        const dupHit = !!classified.duplicate_of_case_id
        // ここに来る時点で日本国内は確定済み（海外は上流でスキップ）
        const hardExcludeReason = chainish || orgLike || closedPermLight || tooManyReviewsLight || dupHit
        if (classified.lead_temperature === 'EXCLUDED' && !hardExcludeReason && !!name && hasJapanAddr) {
          classified.lead_temperature = 'HOLD'
          classified.should_exclude_from_call_list = false
          classified.exclusion_reason = '電話/openingDate等は不足だが、日本国内・店名・Google Places取得済みのため保留（要確認）。'
        }
        const temp = classified.lead_temperature as string

        if (classified.oldest_review_is_recent) counts.oldestRecent++
        if (orgLike && temp === 'EXCLUDED') counts.orgFiltered++
        if (chainish && temp === 'EXCLUDED') counts.chainExcluded++
        if (temp === 'HOT') { counts.hot++; qstat.hot++; if (classified.hot_tier === 'A') counts.hotA = (counts.hotA || 0) + 1; else counts.hotB = (counts.hotB || 0) + 1 }
        else if (temp === 'EXCLUDED') { counts.excluded++; qstat.excluded++ }
        else { counts.hold++; qstat.hold++ }
        if (dupHit) { counts.duplicate++; qReason('既存案件と重複') }
        if (!classified.phone_normalized) { counts.noPhone++; qReason('電話番号なし') }
        if (!og.has) qReason('openingDateなし')
        if (chainish) qReason('チェーン/施設内/支店')
        if (orgLike) qReason('法人/団体/研究会')
        if (tooManyReviewsLight) qReason('口コミ多数(既存店)')

        // 営業時間（Places API v1: weekdayDescriptions は「月曜日: 11時00分～22時00分」等の整形済み文字列）
        const weekdayDesc: string[] = p.regularOpeningHours?.weekdayDescriptions || p.currentOpeningHours?.weekdayDescriptions || []
        const businessHours: string | null = Array.isArray(weekdayDesc) && weekdayDesc.length ? weekdayDesc.join('\n').slice(0, 300) : null

        const payload: any = {
          ...classified,
          source_type: 'AI自動投入',
          business_hours: businessHours,
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
          google_opening_date_raw: og.raw, has_google_opening_date: og.has, has_opening_date_badge: og.has,
          opening_date_source: og.has ? 'google_places' : null, opening_date_confidence: og.has ? og.confidence : null, opening_date_precision: og.has ? (og.day ? 'day' : og.month ? 'month' : 'year') : null,
          opening_date_band: (classified as any).opening_date_band || null, is_new_gbp_priority: !!(classified as any).is_new_gbp_priority,
          google_primary_type_display_name: (p.primaryTypeDisplayName?.text || p.primaryTypeDisplayName || null),
          google_places_logic_version: GP_LOGIC_VERSION, last_details_fetched_at: detailFetched ? nowIso : (existing?.last_details_fetched_at ?? null), last_evaluated_at: nowIso,
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

        // 保存（成功/失敗を必ず記録。握りつぶさない）
        let candidateId: string | null = existing?.id || null
        const alreadyImported = !!existing?.imported_to_cases
        let savedOk = false
        let saveErrMsg = ''
        if (existing) {
          const { error: upErr } = await admin.from('lead_candidates').update(payload).eq('id', existing.id)
          if (upErr) { saveErrMsg = upErr.message; recordSaveError('lead update: ' + upErr.message, { placeId, name }) } else { counts.saved++; qstat.saved++; savedOk = true }
        } else {
          const { data: ins, error: insErr } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
          if (insErr) { saveErrMsg = insErr.message; recordSaveError('lead insert: ' + insErr.message, { placeId, name }) } else { counts.saved++; qstat.saved++; savedOk = true }
          candidateId = ins?.id || null
        }
        if (saveErrMsg) qstat.saveError++
        // place単位のログ（42件がどこで消えたか追跡できるように）
        logItem({
          placeId, name, address: p.formattedAddress || address, phone: phone || null,
          country: jpCountry, isJapanPlace: true,
          businessStatus: p.businessStatus || null, openingDate: og.raw || null,
          userRatingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : reviewCount,
          result: temp, saved: savedOk, exclusion: classified.exclusion_reason || null, saveError: saveErrMsg || null,
        })

        // HOT自動投入（HOT_A / HOT_B。strictモードはHOT_Aのみ。1回/1日上限）
        const tierAllows = classified.hot_tier === 'A' || (classified.hot_tier === 'B' && aiInjectMode !== 'strict')
        if (autoImport && temp === 'HOT' && tierAllows && !classified.duplicate_of_case_id && !alreadyImported && importedCount < autoImportPerDay && (counts.imported < autoImportPerRun) && candidateId) {
          const memo = [
            `【AI自動投入 / GBP / ${classified.recommended_status || temp}】`,
            `投入理由: ${classified.auto_import_reason || ''}`,
            `AIコメント: ${classified.ai_comment || ''}`,
            `口コミ: ${payload.user_rating_count ?? '不明'} / 最古口コミ: ${classified.oldest_review_days_ago ?? '不明'}日前`,
            `到達スコア: ${classified.owner_reachability_score}`,
          ].join('\n')
          const dupCaseId = await findCaseIdByPhone(admin, classified.phone_number)
          if (dupCaseId) {
            await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId }).eq('id', candidateId)
          } else {
          const { data: created, error: caseErr } = await admin.from('cases').insert({
            name: classified.name, address: classified.address || '', phone1: classified.phone_number || '',
            industry: classified.industry || null, status: DEFAULT_STATUS, priority: classified.hot_tier === 'A' ? '高' : '中', hp1: payload.website_url,
            instagram: classified.instagram_url || null, business_hours: businessHours, source_urls: 'AI自動投入', memo, created_by_id: userId,
          }).select('id').single()
          if (caseErr) recordSaveError('case insert: ' + caseErr.message)
          if (created?.id) {
            await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId)
            counts.imported++; importedCount++
            await admin.from('audit_logs').insert({ action: 'create', entity: 'case', entity_id: created.id, entity_name: classified.name, detail: 'AI自動投入（Google Places）', actor_id: userId }).then(() => {}, () => {})
          }
          }
        }
      }

      // クエリ実行履歴を記録（ローテーション用）
      await admin.from('lead_query_log').upsert({
        query, source: 'google_places', last_run_at: nowIso,
        places_count: r.places.length, hot_count: qstat.hot, runs: 1,
        prefecture: prefectureOfArea(gq.area), area: gq.area,
      }, { onConflict: 'query' }).then(() => {}, () => {})

      // クエリ別の主なスキップ理由（上位3件）
      qstat.topReasons = Object.entries(qstat.reasons).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}${v}`)
      debug.queryResults.push(qstat)
    }

    // 集計整合性（places数 = SKIPPED + 判定対象 / 判定対象 = HOT+HOLD+EXCLUDED）
    debug.reconcile = {
      places: counts.fetched, skipped: counts.skipped, judged: counts.judged,
      hot: counts.hot, hold: counts.hold, excluded: counts.excluded, saved: counts.saved, saveError: counts.saveError,
      detailThisRun: counts.detailCalls, detailToday: detailsToday + counts.detailCalls, detailFailed: counts.detailFailed,
      ok: counts.fetched === (counts.skipped + counts.judged) && counts.judged === (counts.hot + counts.hold + counts.excluded),
    }
    // 日本国内フィルタの効き具合
    debug.japanStats = {
      countryJP: counts.countryJP, countryNonJP: counts.countryNonJP,
      addressCompMissing: counts.addressCompMissing, japanByAddrOnly: counts.japanByAddrOnly,
      foreignSkipped: counts.foreignSkipped,
    }
    // 自動投入0件の理由分類（A〜E）
    debug.autoImportDiag = counts.imported > 0 ? '投入あり'
      : counts.hot === 0 ? (counts.judged === 0 ? (counts.fetched === 0 ? '取得0件' : 'E: 全件スキップ（判定に進まず）') : 'A: HOT0件のため投入0')
        : (counts.saveError > 0 ? 'B: HOTありだがDB保存失敗' : 'C: HOTありだがcases投入失敗/上限')

    debug.estApiCalls = picked.length + counts.detailCalls
    debug.regionsCovered = Array.from(regionsCovered)
    debug.areaGrid = useGrid
    await admin.from('auto_lead_runs').update({
      status: 'success', finished_at: new Date().toISOString(),
      search_queries_count: picked.length, fetched_count: counts.fetched,
      hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded,
      imported_count: counts.imported, duplicate_count: counts.duplicate,
      error_count: counts.error, error_message: errorMessage || null,
    }).eq('id', runId)

    return { ok: true, runId, queries: picked.length, regionsCovered: Array.from(regionsCovered), ...counts, errorCount: counts.error, error: errorMessage || null, debug }
  } catch (e: any) {
    const msg = String(e?.message || e)
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: msg, error_count: counts.error + 1 }).eq('id', runId)
    throw new Error(msg)
  }
}

/** 既存のGoogle Places候補を Place Details(New) で再取得し、openingDate最優先で再判定（item9）。
 *  対象: place_id あり ＆ (openingDate未取得 or 口コミ31件以上 or HOLD/EXCLUDED)。コスト制御で上限あり。 */
export async function rejudgeExistingPlaces(admin: any, apiKey: string, opts: { limit?: number; nowIso: string }): Promise<{ scanned: number; detailed: number; updated: number; openingFound: number; hotB: number; excluded: number; caseUpdated: number }> {
  const limit = Math.min(300, Math.max(1, opts.limit || 100))
  const { data: rows } = await admin.from('lead_candidates')
    .select('id,name,address,phone_number,google_place_id,user_rating_count,imported_to_cases,imported_case_id,lead_temperature,is_new_gbp,has_google_opening_date')
    .not('google_place_id', 'is', null)
    .or('has_google_opening_date.is.null,has_google_opening_date.eq.false,user_rating_count.gte.31,lead_temperature.eq.HOLD,lead_temperature.eq.EXCLUDED')
    .limit(limit)
  const cases = await fetchCases(admin)
  let scanned = 0, detailed = 0, updated = 0, openingFound = 0, hotB = 0, excluded = 0, caseUpdated = 0
  for (const r of (rows || [])) {
    scanned++
    const pid = r.google_place_id
    if (!pid) continue
    const p = await placeDetails(apiKey, pid)
    await new Promise((rs) => setTimeout(rs, 120))
    detailed++
    if (!p) continue
    const og = parseGoogleOpening(p.openingDate, p.businessStatus)
    if (og.has) openingFound++
    const { latest, oldest } = reviewDates(p)
    const phone = phoneOf(p) || r.phone_number || ''
    const name = (p.displayName?.text || p.displayName || r.name || '')
    const classified: any = classifyLead({
      name, address: p.formattedAddress || r.address || '', phone_number: phone, website_url: p.websiteUri || '', place_id: pid,
      is_new_gbp: !!r.is_new_gbp, review_count: (typeof p.userRatingCount === 'number' ? p.userRatingCount : r.user_rating_count) ?? undefined,
      business_status: p.businessStatus || undefined, opening_date: parseOpeningDate(p.openingDate) || undefined,
      latest_review_publish_time: latest || undefined, oldest_review_publish_time: oldest || undefined,
    }, cases, {})
    const u: any = {
      lead_temperature: classified.lead_temperature, hot_tier: classified.hot_tier,
      has_google_opening_date: og.has, has_opening_date_badge: og.has,
      google_opening_date_year: og.year, google_opening_date_month: og.month, google_opening_date_day: og.day, google_opening_date_raw: og.raw,
      opening_date_band: classified.opening_date_band || null, is_new_gbp_priority: !!classified.is_new_gbp_priority,
      google_business_status: p.businessStatus || null, phone_number: phone || null, user_rating_count: typeof p.userRatingCount === 'number' ? p.userRatingCount : r.user_rating_count,
      ai_comment: classified.ai_comment || null, last_seen_at: opts.nowIso, opening_date_checked_at: opts.nowIso,
    }
    await admin.from('lead_candidates').update(u).eq('id', r.id)
    updated++
    if (classified.lead_temperature === 'HOT' && classified.hot_tier === 'B') hotB++
    if (classified.lead_temperature === 'EXCLUDED') excluded++
    if (r.imported_to_cases && r.imported_case_id) {
      const cu: any = {}; if (name) cu.name = name; if (phone) cu.phone1 = phone
      if (Object.keys(cu).length) { await admin.from('cases').update(cu).eq('id', r.imported_case_id).then(() => {}, () => {}); caseUpdated++ }
    }
  }
  return { scanned, detailed, updated, openingFound, hotB, excluded, caseUpdated }
}

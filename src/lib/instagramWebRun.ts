// ============================================================
// Instagram Web検索 新店候補取得（サーバー専用・全国検索）
// Meta API不使用。公開Web検索(Serper/Bing) + Anthropic判定のみ。
// 重要: 検索クエリに地域名・業種名を入れない（全国の新店系ハッシュタグ/語のみ）。
// 地域/業種は title/snippet/url から後段で抽出。コスト制御付き定期バッチ設計。
// ============================================================
import { searchLight, placeDetails, phoneOf, parseGoogleOpening } from './googlePlacesRun.js'
import { isForeignText, isForeignAddress, isJapanAddress, isJapanPhone } from './japanFilter.js'
import { buildHotReject, type HotCheck } from './hotReject.js'
import { fetchInstagramProfile, expandMapUrl, fetchPage, extractAddressLoose, regionFromUsername } from './enrichProfile.js'
import { scoreCandidate, tierToTemperature, autoImportAllowed, type InjectMode } from './hotTier.js'
import { detectChain } from './chainFilter.js'
import { detectBigOrPublic } from './targetFilter.js'
import { DEFAULT_STATUS } from './constants.js'

export function getDefaultIwSettings() {
  return {
    iwEnabled: true,
    iwAutoImport: false,        // HOT自動投入（初期OFF・HOLD中心）
    iwRequirePhone: false,      // 電話番号必須（初期OFF）
    iwPlacesRequired: false,    // Google Places照合必須（初期OFF）
    iwAnthropic: true,          // Anthropic判定（初期ON）
    iwMaxRunsPerDay: 4,         // 1日最大実行回数
    iwPerRun: 30,               // 1回最大クエリ数（後方互換）
    iwMaxQueriesPerRun: 30,     // 1回最大クエリ数（最低30・最大50）
    iwMaxQueriesPerDay: 120,    // 1日最大クエリ数
    iwPerQuery: 10,             // 1クエリ取得件数
    iwAnthropicDailyCap: 100,   // 1日最大AI判定件数
    iwProvider: 'serper',       // 検索プロバイダ: serper / bing / both
    iwSameQuerySkipDays: 0,     // 同一クエリのスキップ日数（0=毎日同じクエリOK・Instagramは新着が増えるため）
    iwSameUrlSkipDays: 7,       // 同一URLのスキップ日数（重複保存防止）
    // 外部情報補完（電話/住所を関連サイト・Placesから補完）
    iwEnrichEnabled: true,
    iwEnrichMaxQueries: 3,      // 1候補あたり追加検索の最大クエリ数
    iwEnrichPerQuery: 5,        // 補完1クエリの取得件数
    iwEnrichDailyCap: 100,      // 1日最大補完候補数
    // 検索モード: serper_free=簡易クエリのみ / bing_advanced=site:検索 / serper_paid=高度検索
    iwSearchMode: 'serper_free',
    iwAllowNoPhone: false,      // 電話番号なしでもHOT許可（既定OFF）
  }
}

// 簡易クエリ（Serper無料枠向け。site:・完全一致クォート・「日本」「地域名」「業種名」を使わない）。地域/業種は取得後の抽出・判定で見る。
export const NATIONAL_QUERIES_SIMPLE = [
  // 新店ワード本体（言い換えを大幅に拡充）
  'Instagram 新規オープンしました', 'Instagram 新規OPEN', 'Instagram 新規オープン', 'Instagram ニューオープン',
  'Instagram New Open', 'Instagram NEW OPEN', 'Instagram グランドオープン', 'Instagram GRAND OPEN',
  'Instagram プレオープン', 'Instagram pre open', 'Instagram オープンしました', 'Instagram オープンします',
  'Instagram 開店しました', 'Instagram 開店します', 'Instagram 開業しました', 'Instagram 開業します',
  'Instagram 開院しました', 'Instagram 開院します', 'Instagram 開設しました', 'Instagram 開設します',
  'Instagram リニューアルオープン', 'Instagram 移転オープン', 'Instagram 本日オープン', 'Instagram 明日オープン',
  'Instagram 近日オープン', 'Instagram もうすぐオープン', 'Instagram オープン準備中', 'Instagram 内装工事中',
  'Instagram 物件決まりました', 'Instagram 看板つきました', 'Instagram 予約開始', 'Instagram 受付開始',
  'Instagram 初投稿', 'Instagram はじめまして', 'Instagram 店舗準備', 'Instagram お店作り',
  'Instagram 開店準備', 'Instagram 独立開業', 'Instagram 新店舗', 'Instagram 新店', 'Instagram 新しいお店',
  // ハッシュタグ系
  '#新規オープン Instagram', '#ニューオープン Instagram', '#グランドオープン Instagram', '#プレオープン Instagram',
  '#開店 Instagram', '#開業 Instagram', '#開院 Instagram', '#新店 Instagram', '#新店舗 Instagram',
  '#オープンしました Instagram', '#オープン準備中 Instagram', '#開店準備 Instagram', '#独立開業 Instagram',
  '#移転オープン Instagram', '#リニューアルオープン Instagram', '#本日オープン Instagram', '#明日オープン Instagram',
  '#近日オープン Instagram', '#予約開始 Instagram', '#受付開始 Instagram',
]
// 高度クエリ（Bing / 有料Serper向け。site:instagram.com＋完全一致）。「日本」「地域名」「業種名」は入れない。
export const NATIONAL_QUERIES_ADVANCED = [
  'site:instagram.com "#新規オープン"', 'site:instagram.com "#ニューオープン"', 'site:instagram.com "#グランドオープン"',
  'site:instagram.com "#プレオープン"', 'site:instagram.com "#開店"', 'site:instagram.com "#開業"',
  'site:instagram.com "#開院"', 'site:instagram.com "#新店"', 'site:instagram.com "#新店舗"',
  'site:instagram.com "#独立開業"', 'site:instagram.com "#移転オープン"', 'site:instagram.com "#リニューアルオープン"',
  'site:instagram.com "#本日オープン"', 'site:instagram.com "#オープン準備中"', 'site:instagram.com "#開店準備"',
  'site:instagram.com "新規オープンしました"', 'site:instagram.com "オープンしました"', 'site:instagram.com "開業しました"',
  'site:instagram.com "開店しました"', 'site:instagram.com "開院しました"', 'site:instagram.com "本日オープン"',
  'site:instagram.com "グランドオープンしました"', 'site:instagram.com "プレオープンしました"', 'site:instagram.com "リニューアルオープン"',
  'site:instagram.com "予約開始"', 'site:instagram.com "受付開始"', 'site:instagram.com "独立開業"',
]
// 後方互換（既存参照用）。既定は簡易クエリ。
export const NATIONAL_QUERIES = NATIONAL_QUERIES_SIMPLE

/** site:・完全一致クォート・「日本」を外した簡易クエリへ変換（Serper無料枠/フォールバック用） */
export function simplifyQuery(q: string): string {
  let s = q.replace(/site:[^\s"']+/gi, '').replace(/["'”“]/g, '').replace(/\s+日本\s*$/u, '').replace(/\s+/g, ' ').trim()
  // ハッシュタグは「#xxx Instagram」、それ以外は「Instagram xxx」に整える
  if (!/instagram/i.test(s)) s = /^#/.test(s) ? `${s} Instagram` : `Instagram ${s}`
  return s
}

// ---- Web検索（Serper優先・無ければBing） ----
export function searchProvider(): 'serper' | 'bing' | null {
  if (process.env.SERPER_API_KEY) return 'serper'
  if (process.env.BING_SEARCH_API_KEY) return 'bing'
  return null
}
// Serper無料枠で禁止されやすいパターンのエラーか
function isFreePatternError(msg: string): boolean {
  return /not allowed for free|pattern not allowed|free account/i.test(String(msg || ''))
}

interface WebResult { title: string; url: string; snippet: string }

export async function webSearch(query: string, num: number, preferProvider?: 'serper' | 'bing'): Promise<{ results: WebResult[]; error: string | null; usedQuery?: string; fallbackFrom?: string; provider?: string }> {
  // preferProvider のキーがあればそれを使う。無ければ既定（Serper優先）
  const prov = (preferProvider === 'bing' && process.env.BING_SEARCH_API_KEY) ? 'bing'
    : (preferProvider === 'serper' && process.env.SERPER_API_KEY) ? 'serper'
    : searchProvider()
  // 1回の検索（504回避: 8秒で打ち切り）
  const doFetch = async (q: string): Promise<{ results: WebResult[]; error: string | null }> => {
    const ctrl = new AbortController()
    let timedOut = false
    const to = setTimeout(() => { timedOut = true; ctrl.abort() }, 8000)
    try {
      if (prov === 'serper') {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'X-API-KEY': process.env.SERPER_API_KEY as string, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, gl: 'jp', hl: 'ja', num: Math.min(20, num) }),
        })
        clearTimeout(to)
        const j: any = await res.json().catch(() => ({}))
        if (!res.ok) return { results: [], error: String(j?.message || `HTTP ${res.status}`).slice(0, 200) }
        const organic = Array.isArray(j.organic) ? j.organic : []
        return { results: organic.map((o: any) => ({ title: o.title || '', url: o.link || '', snippet: o.snippet || '' })), error: null }
      }
      if (prov === 'bing') {
        const u = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=${Math.min(20, num)}&mkt=ja-JP`
        const res = await fetch(u, { headers: { 'Ocp-Apim-Subscription-Key': process.env.BING_SEARCH_API_KEY as string }, signal: ctrl.signal })
        clearTimeout(to)
        const j: any = await res.json().catch(() => ({}))
        if (!res.ok) return { results: [], error: String(j?.error?.message || `HTTP ${res.status}`).slice(0, 200) }
        const vals = j?.webPages?.value || []
        return { results: vals.map((o: any) => ({ title: o.name || '', url: o.url || '', snippet: o.snippet || '' })), error: null }
      }
      return { results: [], error: '検索APIキー未設定（SERPER_API_KEY / BING_SEARCH_API_KEY）' }
    } catch (e: any) { clearTimeout(to); return { results: [], error: timedOut ? 'timeout(8000ms・検索API応答遅延)' : String(e?.message || e).slice(0, 200) } }
  }
  const r1 = await doFetch(query)
  // Serper無料枠で site:/完全一致が拒否された場合は簡易クエリへ自動フォールバック
  if (r1.error && isFreePatternError(r1.error)) {
    const simple = simplifyQuery(query)
    if (simple && simple !== query) {
      const r2 = await doFetch(simple)
      return { results: r2.results, error: r2.error, usedQuery: simple, fallbackFrom: query, provider: prov || undefined }
    }
  }
  return { results: r1.results, error: r1.error, usedQuery: query, provider: prov || undefined }
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
  // 日本国外（海外マーカーあり・日本住所/都道府県が取れない）は除外
  if (isForeignText(text)) return { pass: false, result: 'excluded_pre', reason: '日本国外の候補のため除外' }
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
  const foreign = !prefecture && (FOREIGN_RE.test(text) || isForeignText(text))
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

// ---- 電話/住所/連絡先URL 抽出（外部サイトのスニペットから） ----
const ADDR_RE = new RegExp(`(${PREFECTURES.join('|')})[^\\n。、）)｜|]{2,40}`)
function extractPhone(text: string): string {
  // 0始まり 10-11桁（ハイフン/括弧/空白あり）、0120、ハイフンなしも対応
  const m = text.match(/0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4}|0120[-\s]?\d{2,3}[-\s]?\d{2,3}|0\d{9,10}/)
  if (!m) return ''
  const d = m[0].replace(/[^\d]/g, '')
  if (d.length < 10 || d.length > 11) return ''
  return m[0].trim()
}
function classifyUrls(text: string): { line: string; reservation: string; official: string; instagram: string; all: string[] } {
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s　"'<>]+/g)).map((m) => m[0])
  const line = urls.find((u) => /lin\.ee|line\.me/i.test(u)) || ''
  const reservation = urls.find((u) => /(stores\.jp|reserva\.be|tol-app\.jp|select-type\.com|airrsv\.net|hotpepper\.jp|coubic|epark|reserve|yoyaku|booking)/i.test(u)) || ''
  const instagram = urls.find((u) => /instagram\.com/i.test(u)) || ''
  const official = urls.find((u) => !/instagram\.com/i.test(u) && u !== line && u !== reservation && !/lit\.link|linktr\.ee|instabio\.cc/i.test(u)) || ''
  return { line, reservation, official, instagram, all: urls }
}
function extractContacts(text: string) {
  const phone = extractPhone(text)
  const am = text.match(ADDR_RE)
  const address = am ? am[0].trim().slice(0, 60) : ''
  const region = extractRegion(text)
  const u = classifyUrls(text)
  return { phone, address, prefecture: region.prefecture, city: region.city, line: u.line, reservation: u.reservation, official: u.official, instagram: u.instagram }
}
export function usernameFromUrl(url: string): string {
  const m = url.match(/instagram\.com\/([A-Za-z0-9_.]+)/i)
  const u = m ? m[1] : ''
  return /^(p|reel|explore|stories|tv)$/i.test(u) ? '' : u
}
function nameMatch(a: string, b: string): boolean {
  const n = (s: string) => (s || '').replace(/[\s　・,.。、（）()【】\[\]『』「」'’]/g, '').toLowerCase()
  const x = n(a), y = n(b)
  if (!x || !y) return false
  return y.includes(x.slice(0, 4)) || x.includes(y.slice(0, 4))
}
// 優先予約/外部サイト
const ENRICH_SITES = ['instagram.com', 'google.com/maps', 'hotpepper.jp', 'beauty.hotpepper.jp', 'stores.jp', 'reserva.be', 'tol-app.jp', 'select-type.com', 'ekiten.jp', 'line.me']
function buildEnrichQueries(shop: string, username: string, area: string, max: number): string[] {
  const qs: string[] = []
  const a = area ? ` "${area}"` : ''
  if (shop) {
    qs.push(`"${shop}"${a} 電話番号`, `"${shop}"${a} 住所`, `"${shop}"${a} 公式`, `"${shop}"${a} Instagram`, `"${shop}"${a} 予約`, `"${shop}"${a} LINE`)
    qs.push(...ENRICH_SITES.map((s) => `"${shop}"${a} site:${s}`))
  }
  if (username && username !== shop) { qs.push(`"${username}" 電話番号`, `"${username}" 住所`, `"${username}" 予約`, ...ENRICH_SITES.slice(4).map((s) => `"${username}" site:${s}`)) }
  return qs.slice(0, Math.max(0, max))
}

export interface EnrichResult {
  phone: string; address: string; prefecture: string; city: string
  official: string; reservation: string; line: string; instagram: string; place_id: string
  // 取得元・信頼度（どこから住所/電話を取ったか）
  phone_source: string; address_source: string; google_maps_url: string
  profile_fetched: boolean; profile_reason: string; link_count: number; links_checked: number
  places_matched: boolean; fail_reason: string
  // 店名（プロフィール由来）・地域矛盾・不採用補完
  profile_name: string; place_name: string; region_conflict: boolean; rejected: { field: string; value: string; reason: string }[]
  // Google Places openingDate / businessStatus（口コミより強い新店シグナル）
  business_status: string; opening_raw: string | null; opening_confidence: number
  opening_year: number | null; opening_month: number | null; opening_day: number | null
  days_until_opening: number | null; days_since_opening: number | null; has_opening: boolean
  sources: { url: string; got: string }[]; status: 'not_started' | 'searched' | 'enriched' | 'failed'
  confidence: number; reason: string; queriesUsed: number
}

// 取得元ごとの信頼度の目安
const SRC_CONF: Record<string, number> = { google_places: 90, google_maps_url: 90, official_site: 85, instagram_profile: 75, snippet: 40 }
const SRC_LABEL: Record<string, string> = { google_places: 'Google Places', google_maps_url: 'Google Mapsリンク', official_site: '公式サイト', instagram_profile: 'Instagramプロフィール', snippet: '検索スニペット' }

/**
 * 外部情報補完: Instagramプロフィール本文 → Google Maps短縮URL展開 → 外部リンク(最大3) → Google Places照合（電話番号優先）。
 * 住所/電話の取得元と信頼度も返す。各fetchは8秒timeout・呼び出し回数は上限付き。
 */
export async function enrichCandidate(
  mapsKey: string | null,
  ctx: { shop: string; username: string; areaHint: string; industry: string; havePhone: string; haveAddress: string; instagramUrl?: string },
  opts: { maxQueries: number; perQuery: number; skipQuery?: Set<string>; onQuery?: (q: string) => void; fetchProfile?: boolean },
): Promise<EnrichResult> {
  let phone = ctx.havePhone || '', address = ctx.haveAddress || '', prefecture = '', city = ''
  let official = '', reservation = '', line = '', instagram = ctx.instagramUrl || '', place_id = ''
  let phoneSource = phone ? 'snippet' : '', addressSource = address ? 'snippet' : '', googleMapsUrl = ''
  let og: any = { has: false, raw: null, confidence: 0, year: null, month: null, day: null, daysUntil: null, daysSince: null }
  let businessStatus = ''
  let profileFetched = false, profileReason = '', linkCount = 0, linksChecked = 0, placesMatched = false
  let profileName = '', profilePref = '', regionConflict = false, placeName = ''
  const rejected: { field: string; value: string; reason: string }[] = []
  const sources: { url: string; got: string }[] = []
  const failReasons: string[] = []
  let queriesUsed = 0
  const HIGH_CONF = new Set(['google_places', 'google_maps_url', 'instagram_profile'])
  // 住所の都道府県がプロフィール地域と矛盾しないか（profilePref未確定なら常にOK）
  const regionOk = (addr: string): boolean => {
    if (!profilePref) return true
    const r = extractAddressLoose(addr)
    if (r.prefecture && r.prefecture !== profilePref) return false
    return true
  }
  // 住所/電話を取得元の信頼度つきで採用。低信頼(検索スニペット/公式)はプロフィール地域と矛盾したら不採用
  const setPhone = (v: string, src: string, url: string) => {
    if (!v || !isJapanPhone(v)) return
    // 検索スニペット由来の電話は、地域一致した住所 or Places一致がある時だけ採用（別店舗の誤一致防止）
    if (src === 'snippet' && !(placesMatched || (address && regionOk(address)))) { rejected.push({ field: 'phone', value: v.trim(), reason: '検索スニペット由来でプロフィール地域と一致確認できず不採用' }); regionConflict = true; return }
    if (!phone || (SRC_CONF[src] || 0) > (SRC_CONF[phoneSource] || 0)) { phone = v.trim(); phoneSource = src; sources.push({ url, got: `phone:${src}` }) }
  }
  const setAddr = (v: string, pf: string, ct: string, src: string, url: string) => {
    if (!v) return
    if (!HIGH_CONF.has(src) && !regionOk(v)) { rejected.push({ field: 'address', value: v, reason: `補完住所がInstagramプロフィールの地域(${profilePref})と矛盾` }); regionConflict = true; return }
    if (!address || (SRC_CONF[src] || 0) > (SRC_CONF[addressSource] || 0)) { address = v; addressSource = src; if (pf) prefecture = pf; if (ct) city = ct; sources.push({ url, got: `address:${src}` }) }
  }
  try {
    let mapUrl = ''
    // 1) Instagramプロフィール取得（投稿スニペットより優先）
    if (opts.fetchProfile !== false && ctx.username) {
      const prof = await fetchInstagramProfile(ctx.username)
      profileFetched = prof.ok
      profileReason = prof.reason
      profileName = prof.name || ''
      // プロフィール地域（住所→なければユーザー名の地名）を先に確定し、以降の補完の地域整合チェックに使う
      profilePref = prof.prefecture || regionFromUsername(ctx.username).prefecture || ''
      if (!profilePref && prof.city) profilePref = extractAddressLoose(prof.city).prefecture
      if (!prof.ok && prof.reason) failReasons.push(prof.reason)
      const purl = `https://www.instagram.com/${ctx.username}/`
      if (prof.phone) setPhone(prof.phone, 'instagram_profile', purl)
      if (prof.address) setAddr(prof.address, prof.prefecture, prof.city, 'instagram_profile', purl)
      else if (prof.prefecture || prof.city) { prefecture = prefecture || prof.prefecture; city = city || prof.city }
      if (prof.externalUrl && !official) official = prof.externalUrl
      linkCount = prof.links.length
      mapUrl = prof.mapUrl
    } else if (!ctx.username) { failReasons.push('Instagramユーザー名が取得できず') }

    // 2) Google Maps短縮URL展開（住所補完の最優先情報源）
    if (mapUrl) {
      googleMapsUrl = mapUrl
      const ex = await expandMapUrl(mapUrl)
      if (ex.timedOut) failReasons.push('Google Maps短縮URL展開タイムアウト')
      else if (!ex.ok) failReasons.push('Google Maps短縮URL展開失敗')
      if (ex.address) { const r = extractAddressLoose(ex.address); setAddr(ex.address, r.prefecture, r.city, 'google_maps_url', ex.finalUrl) }
      // 展開後の店名でPlaces照合（住所/電話/openingDate）
      if (mapsKey && (ex.name || ex.placeId) && (!phone || !address)) {
        const sr = await searchLight(mapsKey, `${ex.name || ctx.shop} ${prefecture || city || ctx.areaHint || ''}`.trim(), 3)
        const top = (sr.places || []).find((pl: any) => !isForeignAddress(pl.formattedAddress)) || null
        if (top) {
          place_id = top.id || place_id; placesMatched = true; if (top.displayName?.text) placeName = top.displayName.text
          const d = top.id ? await placeDetails(mapsKey, top.id) : null
          const p: any = d || top
          businessStatus = p.businessStatus || businessStatus
          const og2 = parseGoogleOpening(p.openingDate, p.businessStatus); if (og2.has) og = og2
          if (phoneOf(p)) setPhone(phoneOf(p), 'google_places', `https://www.google.com/maps/place/?q=place_id:${top.id}`)
          if (p.formattedAddress) { const reg = extractRegion(p.formattedAddress); setAddr(p.formattedAddress, reg.prefecture, reg.city, 'google_places', `https://www.google.com/maps/place/?q=place_id:${top.id}`) }
          if (!official && p.websiteUri) official = p.websiteUri
        }
      }
    } else if (opts.fetchProfile !== false) { failReasons.push('Google Mapsリンクなし') }

    // 3) 外部リンク（最大3件・Maps以外の公式/予約サイト）から電話・住所
    if ((!phone || !address) && official && /^https?:\/\//i.test(official)) {
      linksChecked++
      const pr = await fetchPage(official)
      if (pr.ok) {
        const c = extractContacts(pr.html.replace(/<[^>]+>/g, ' '))
        if (c.phone) setPhone(c.phone, 'official_site', official)
        if (c.address) { const r = extractAddressLoose(c.address || pr.html); setAddr(c.address, r.prefecture, r.city, 'official_site', official) }
      } else if (pr.timedOut) failReasons.push('外部リンク確認タイムアウト')
    }

    // 4) Google Places照合: 電話番号優先 → 店名+市区町村（電話一致は同一店舗の強シグナル）
    let placesCalls = 0
    if (mapsKey && (!phone || !address) && placesCalls < 2) {
      const area = [prefecture, city].filter(Boolean).join('') || ctx.areaHint || ''
      const q = phone ? phone : `${ctx.shop} ${area || ctx.industry || ''}`.trim()
      const sr = await searchLight(mapsKey, q, 3); placesCalls++
      const top = (sr.places || []).find((pl: any) => !isForeignAddress(pl.formattedAddress) && (phone ? true : nameMatch(ctx.shop, pl.displayName?.text || ''))) || null
      if (top) {
        place_id = top.id || place_id; placesMatched = true
        const d = top.id ? await placeDetails(mapsKey, top.id) : null
        const p: any = d || top
        businessStatus = p.businessStatus || businessStatus
        const og2 = parseGoogleOpening(p.openingDate, p.businessStatus); if (og2.has) og = og2
        if (phoneOf(p)) setPhone(phoneOf(p), 'google_places', `https://www.google.com/maps/place/?q=place_id:${top.id}`)
        if (p.formattedAddress) { const reg = extractRegion(p.formattedAddress); setAddr(p.formattedAddress, reg.prefecture, reg.city, 'google_places', `https://www.google.com/maps/place/?q=place_id:${top.id}`) }
        if (!official && p.websiteUri) official = p.websiteUri
      } else if (!phone) failReasons.push('Google Places一致なし')
    }

    // 5) 既存のWeb検索フォールバック（プロフィール/Mapsで取れない時のみ）
    if (!phone || !address) {
      const queries = buildEnrichQueries(ctx.shop, ctx.username, [prefecture, city].filter(Boolean).join('') || ctx.areaHint || '', opts.maxQueries)
      for (const qq of queries) {
        if (phone && address) break
        if (opts.skipQuery?.has(qq)) continue
        opts.onQuery?.(qq)
        queriesUsed++
        const { results } = await webSearch(qq, opts.perQuery)
        for (const r of results) {
          const c = extractContacts(`${r.title} ${r.snippet} ${r.url}`)
          if (c.phone) setPhone(c.phone, 'snippet', r.url)
          if (c.address) { const rr = extractAddressLoose(`${r.title} ${r.snippet}`); setAddr(c.address, rr.prefecture || c.prefecture, rr.city || c.city, 'snippet', r.url) }
          if (c.reservation && !reservation) { reservation = c.reservation; sources.push({ url: c.reservation, got: 'reservation' }) }
          if (c.official && !official) official = c.official
          if (c.line && !line) line = c.line
          if (c.instagram && !instagram) instagram = c.instagram
        }
      }
    }

    if (!prefecture && address) { const reg = extractAddressLoose(address); prefecture = reg.prefecture; city = city || reg.city }
    if (!phone) failReasons.push('電話番号を検出できず')
    if (!address) failReasons.push(prefecture || city ? '住所が市区町村までで番地不明' : 'プロフィール本文/外部リンクに住所なし')

    // 信頼度: 取得元のうち最も高い信頼度（電話/住所）を採用
    const confidence = Math.max(phone ? (SRC_CONF[phoneSource] || 40) : 0, address ? (SRC_CONF[addressSource] || 40) : 0, place_id ? 80 : 0)
    const status: EnrichResult['status'] = (phone || address) ? 'enriched' : (queriesUsed > 0 || profileFetched ? 'searched' : 'not_started')
    const reason = status === 'enriched'
      ? `補完: ${phone ? `電話(${SRC_LABEL[phoneSource] || phoneSource})` : ''}${phone && address ? ' ＋ ' : ''}${address ? `住所(${SRC_LABEL[addressSource] || addressSource})` : ''}${placesMatched ? ' / Places一致' : ''} 信頼度${confidence}`
      : `補完未取得: ${failReasons.slice(0, 3).join(' / ') || '手がかりなし'}`
    return {
      phone, address, prefecture, city, official, reservation, line, instagram, place_id,
      phone_source: phoneSource, address_source: addressSource, google_maps_url: googleMapsUrl,
      profile_fetched: profileFetched, profile_reason: profileReason, link_count: linkCount, links_checked: linksChecked,
      profile_name: profileName, place_name: placeName, region_conflict: regionConflict, rejected,
      places_matched: placesMatched, fail_reason: (phone && address) ? '' : failReasons.slice(0, 4).join(' / '),
      business_status: businessStatus, opening_raw: og.raw, opening_confidence: og.confidence, opening_year: og.year, opening_month: og.month, opening_day: og.day,
      days_until_opening: og.daysUntil, days_since_opening: og.daysSince, has_opening: og.has,
      sources, status, confidence, reason, queriesUsed,
    }
  } catch (e: any) {
    return {
      phone, address, prefecture, city, official, reservation, line, instagram, place_id,
      phone_source: phoneSource, address_source: addressSource, google_maps_url: googleMapsUrl,
      profile_fetched: profileFetched, profile_reason: profileReason, link_count: linkCount, links_checked: linksChecked,
      profile_name: profileName, place_name: placeName, region_conflict: regionConflict, rejected,
      places_matched: placesMatched, fail_reason: String(e?.message || e).slice(0, 120),
      business_status: businessStatus, opening_raw: og.raw, opening_confidence: og.confidence, opening_year: og.year, opening_month: og.month, opening_day: og.day,
      days_until_opening: og.daysUntil, days_since_opening: og.daysSince, has_opening: og.has,
      sources, status: 'failed', confidence: 0, reason: String(e?.message || e).slice(0, 120), queriesUsed,
    }
  }
}

// ---- Anthropic 判定 ----
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

function buildJudgePrompt(r: WebResult, enrich?: EnrichResult, username?: string): string {
  const enrichBlock = enrich ? `

外部情報補完（同じ店舗の予約サイト/公式/LINE/Google Places等から取得・信頼度${enrich.confidence}）:
- 補完電話: ${enrich.phone || '（なし）'}
- 補完住所: ${enrich.address || '（なし）'}（${enrich.prefecture || ''}${enrich.city || ''}）
- 予約URL: ${enrich.reservation || '（なし）'} / 公式: ${enrich.official || '（なし）'} / LINE: ${enrich.line || '（なし）'}
- Google Place ID: ${enrich.place_id || '（なし）'}
- 補完元URL: ${enrich.sources.map((s) => `${s.got}:${s.url}`).slice(0, 6).join(' , ') || '（なし）'}
※補完情報が同一店舗と判断できる場合は phone/prefecture/city/address に反映してよい。別店舗の可能性があれば HOLD。` : ''
  return `あなたは新規オープン店舗の営業リスト判定アシスタントです。以下のInstagram公開検索結果が「新規オープン/開業/開店/開院/独立開業/移転オープン」の新店候補かを判定し、JSONのみ返してください。検索クエリには地域名・業種名を含めていません。地域や業種は本文/補完情報から推定し、無ければ null にしてください（推測で東京都千代田区などを入れない）。username: ${username || '（不明）'}${enrichBlock}

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

export async function anthropicJudge(r: WebResult, enrich?: EnrichResult, username?: string): Promise<any | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, messages: [{ role: 'user', content: buildJudgePrompt(r, enrich, username) }] }),
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
  const perRun = Math.max(1, Math.min(50, Number(s.iwMaxQueriesPerRun) || Number(s.iwPerRun) || 30))  // 1回30〜50クエリ
  const maxQueriesPerDay = Math.max(1, Number(s.iwMaxQueriesPerDay) || 120)
  const sameQuerySkipDays = Math.max(0, Number(s.iwSameQuerySkipDays) || 0)  // 既定0=同一クエリ毎日OK
  const maxRunsPerDay = Math.max(1, Number(s.iwMaxRunsPerDay) || 4)
  const anthropicDailyCap = Math.max(0, Number(s.iwAnthropicDailyCap) || 100)
  const useAnthropic = s.iwAnthropic !== false && !!process.env.ANTHROPIC_API_KEY
  const dailyCap = Math.max(1, Number(s.dailyCap) || 30)
  const enrichEnabled = s.iwEnrichEnabled !== false
  const enrichMaxQueries = Math.max(0, Number(s.iwEnrichMaxQueries) || 3)
  const enrichPerQuery = Math.max(1, Math.min(10, Number(s.iwEnrichPerQuery) || 5))
  const enrichDailyCap = Math.max(0, Number(s.iwEnrichDailyCap) || 100)

  const counts = {
    queries: 0, results: 0, igUrls: 0, rulePassed: 0, preExcluded: 0, noOpenWord: 0,
    judged: 0, heuristicUsed: 0, placeMatched: 0, phoneYes: 0,
    hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, saved: 0, saveError: 0, error: 0, fallback: 0, dup: 0, serperError: 0, bingError: 0,
    areaKnown: 0, areaUnknown: 0, industryKnown: 0, industryUnknown: 0,
    enrichTried: 0, enrichSucceeded: 0, enrichPhone: 0, enrichAddress: 0, enrichQueries: 0,
    openingDateCount: 0, futureOpeningCount: 0,
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

    // 同一クエリのスキップ（既定0=スキップしない。Instagramは同じ検索語でも新着が増えるため）。URLは別途7日スキップ。
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString()
    const recent = new Set<string>()
    if (sameQuerySkipDays > 0) {
      const sinceQ = new Date(Date.now() - sameQuerySkipDays * 86400000).toISOString()
      const { data: recentRows } = await admin.from('ig_web_query_log').select('query').gte('last_run_at', sinceQ).limit(5000)
      for (const r of (recentRows || [])) recent.add(String(r.query))
    }
    // プロバイダ＆検索モードでクエリ集合を選択（Serperは無料枠でsite:/完全一致が拒否されるため簡易クエリ）
    const envProvider = searchProvider()
    const iwProvider = ['serper', 'bing', 'both'].includes(s.iwProvider) ? s.iwProvider : 'serper'
    const searchMode = s.iwSearchMode || 'serper_free'
    const useAdvanced = (searchMode === 'bing_advanced' && envProvider === 'bing') || searchMode === 'serper_paid'
    // both: 簡易＋高度を結合（重複除去）。それ以外は単一集合。
    const querySet = iwProvider === 'both'
      ? Array.from(new Set([...NATIONAL_QUERIES_SIMPLE, ...NATIONAL_QUERIES_ADVANCED]))
      : (useAdvanced ? NATIONAL_QUERIES_ADVANCED : NATIONAL_QUERIES_SIMPLE)
    debug.searchMode = searchMode; debug.iwProvider = iwProvider; debug.querySet = iwProvider === 'both' ? 'simple+advanced' : (useAdvanced ? 'advanced(site:)' : 'simple')
    debug.querySetSize = querySet.length
    const notSkipped = querySet.filter((q) => !recent.has(q))
    let picked = notSkipped.slice(0, runQueryLimit)
    if (picked.length === 0 && runQueryLimit > 0) picked = querySet.slice(0, runQueryLimit)
    // ログ: 予定/実行/スキップ/理由
    debug.plannedQueries = querySet.length
    debug.skippedByRecent = querySet.length - notSkipped.length
    debug.skippedByLimit = Math.max(0, notSkipped.length - picked.length)
    debug.runQueryLimit = runQueryLimit
    debug.queryLimitReason = runQueryLimit < perRun ? `本日のクエリ上限(残り${remainingQueries}/${maxQueriesPerDay})` : (picked.length < perRun ? `クエリ定義/スキップにより${picked.length}件` : 'OK')
    // 補完: 1日の補完候補上限と、7日以内に実行済みの補完クエリ
    const { count: enrichedTodayCount } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true })
      .eq('source', 'instagram_web_search').not('last_enriched_at', 'is', null).gte('last_enriched_at', startToday.toISOString())
    let enrichBudget = Math.max(0, enrichDailyCap - (enrichedTodayCount || 0))
    const { data: enrichRecentRows } = await admin.from('ig_enrich_log').select('query').gte('last_run_at', since7).limit(8000)
    const enrichRecent = new Set<string>((enrichRecentRows || []).map((r: any) => String(r.query)))
    const enrichQueriesToLog = new Set<string>()

    debug.queries = picked
    debug.runsToday = (runsToday || 0) + 1
    debug.queriesToday = queriesToday || 0
    debug.remainingQueries = remainingQueries
    debug.anthropicBudget = anthropicBudget
    debug.enrichBudget = enrichBudget

    const nowIso = new Date().toISOString()
    const { count: importedToday } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    let importedCount = importedToday || 0
    const iwMode: InjectMode = (s.aiInjectMode === 'strict' || s.aiInjectMode === 'aggressive') ? s.aiInjectMode : 'standard'
    const autoImportPerRun = Math.max(1, Number(s.autoImportPerRun) || 50)
    const autoImportPerDay = Math.max(1, Number(s.autoImportPerDay) || 200)
    let importedThisRun = 0

    for (const query of picked) {
      if (Date.now() - startMs > TIME_BUDGET) { debug.stoppedEarly = true; break }
      counts.queries++
      const before = { hot: counts.hot, hold: counts.hold, excluded: counts.excluded }
      const q: any = { query, results: 0, igUrls: 0, rulePassed: 0, judged: 0, heuristic: 0, hot: 0, hold: 0, excluded: 0, areaKnown: 0, areaUnknown: 0, industryKnown: 0, industryUnknown: 0, error: null }
      // both: site:クエリはBing優先（無料Serperはsite:不可）、それ以外はSerper。単一プロバイダ時は preferProvider 指定で env 既定に従う
      const preferProvider: ('serper' | 'bing' | undefined) = iwProvider === 'both' ? (/site:/i.test(query) ? 'bing' : 'serper') : (iwProvider === 'bing' ? 'bing' : iwProvider === 'serper' ? 'serper' : undefined)
      const { results, error, usedQuery, fallbackFrom, provider: usedProvider } = await webSearch(query, perQuery, preferProvider)
      if (error) { if (usedProvider === 'bing') counts.bingError = (counts.bingError || 0) + 1; else counts.serperError = (counts.serperError || 0) + 1 }
      // 簡易クエリへ自動フォールバックした場合は記録（失敗ではない）
      if (fallbackFrom) {
        counts.fallback = (counts.fallback || 0) + 1
        q.fallback = { from: fallbackFrom, to: usedQuery }
        if (!debug.searchFallbacks) debug.searchFallbacks = []
        if (debug.searchFallbacks.length < 5) debug.searchFallbacks.push({ from: fallbackFrom, to: usedQuery })
      }
      if (error) {
        counts.error++; q.error = error
        const prov = searchProvider() || '検索API'
        errorMessage = isFreePatternError(error)
          ? `Serper無料枠では高度な検索式が使えません。簡易検索でも失敗: ${error}（クエリ「${usedQuery || query}」）。設定の検索モードを確認してください。`
          : `${prov}検索の取得に失敗: ${error}（クエリ「${usedQuery || query}」）`
        if (!debug.searchErrors) debug.searchErrors = []
        if (debug.searchErrors.length < 5) debug.searchErrors.push({ failed_step: 'webSearch', provider: prov, query: usedQuery || query, detail: error })
        console.error('[instagram-web] webSearch error', { failed_step: 'webSearch', provider: prov, query: usedQuery || query, detail: error, timestamp: new Date().toISOString() })
      }

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

        // ベース抽出（無料）で店名/username/地域を得る
        const base = heuristicJudge(r)
        const username = usernameFromUrl(r.url)
        const baseRegion = extractRegion(`${r.title} ${r.snippet}`)
        const shop = base.shop_name || ''
        const industry0 = base.industry || extractIndustry(`${r.title} ${r.snippet}`) || ''

        // 外部情報補完: 電話または地域が無ければ、関連サイト/予約サイト/Placesから補完
        let enrich: EnrichResult | null = null
        // 504回避: 時間予算を超えたら補完はせず軽量判定のみ（続きは次回実行）
        const overBudget = Date.now() - startMs > TIME_BUDGET
        const needEnrich = enrichEnabled && !overBudget && enrichBudget > 0 && !!shop && (!base.phone_candidate || !baseRegion.prefecture || !base.address_candidate) && !base.is_foreign
        if (needEnrich) {
          enrich = await enrichCandidate(mapsKey, { shop, username, areaHint: baseRegion.area, industry: industry0, havePhone: base.phone_candidate || '', haveAddress: '', instagramUrl: r.url }, {
            maxQueries: enrichMaxQueries, perQuery: enrichPerQuery, skipQuery: enrichRecent, fetchProfile: true,
            onQuery: (qq) => { counts.enrichQueries++; q.enrichQueries = (q.enrichQueries || 0) + 1; enrichQueriesToLog.add(qq) },
          })
          enrichBudget--; counts.enrichTried++
          if (enrich.status === 'enriched') counts.enrichSucceeded++
          if (enrich.phone) counts.enrichPhone++
          if (enrich.address) counts.enrichAddress++
          if (enrich.has_opening) counts.openingDateCount++
          if (enrich.business_status === 'FUTURE_OPENING') counts.futureOpeningCount++
        }

        // AI判定（補完情報も渡す）。上限内のみAI、超過/OFF/失敗はベース（ルール）判定
        let j: any
        if (useAnthropic && anthropicBudget > 0) {
          j = await anthropicJudge(r, enrich || undefined, username)
          if (j) { counts.judged++; q.judged++; anthropicBudget-- }
          else { j = base; counts.heuristicUsed++; q.heuristic++ }
        } else { j = base; counts.heuristicUsed++; q.heuristic++ }

        // マージ（AI > 補完 > ベース）。地域のクエリ・フォールバックはしない（千代田区固定の修正）
        const prefecture = j.prefecture || enrich?.prefecture || baseRegion.prefecture || null
        const city = j.city || enrich?.city || baseRegion.city || null
        const area = [prefecture, city].filter(Boolean).join('') || null
        const industry = j.industry || industry0 || null
        const finalPhone = j.phone_candidate || enrich?.phone || base.phone_candidate || ''
        const addressVal = j.address_candidate || enrich?.address || null
        const officialVal = j.official_url_candidate || enrich?.official || null
        const reservationVal = j.reservation_url_candidate || enrich?.reservation || null
        const lineVal = j.line_url_candidate || enrich?.line || null
        const matchedPlaceId = enrich?.place_id || null
        const placeMatched = !!matchedPlaceId
        if (placeMatched) counts.placeMatched++
        if (finalPhone) counts.phoneYes++
        if (area) { counts.areaKnown++; q.areaKnown++ } else { counts.areaUnknown++; q.areaUnknown++ }
        if (industry) { counts.industryKnown++; q.industryKnown++ } else { counts.industryUnknown++; q.industryUnknown++ }

        // 日本国外は除外（補完後の住所/電話で海外と判明した場合も）
        const foreignFinal = j.is_foreign || isForeignAddress(addressVal) || (!!finalPhone && !isJapanPhone(finalPhone))
        const japanOk = !foreignFinal && (!!prefecture || isJapanAddress(addressVal) || isJapanPhone(finalPhone))
        // 営業向きHOT判定（HOT_A/HOT_B/HOLD/EXCLUDED）: Instagram投稿の新店根拠＋電話/住所で営業可能ならHOT
        const igNew = !!(j.newness_type && j.newness_type !== 'unknown')
        const ch = detectChain(j.shop_name || shop || '', `${r.title} ${r.snippet}`)
        // 道の駅/産直/JA/公共/大型施設/大手 は営業対象外（ターゲット=個人事業主・小規模店）。プロフィール名/本文/タイトルから検出
        const bigIW = detectBigOrPublic(`${enrich?.profile_name || ''} ${j.shop_name || shop || ''} ${addressVal || ''}`)
        const sc = scoreCandidate({
          source: 'instagram_web', isJapan: japanOk, hasShopName: !!(j.shop_name || shop), hasPhone: !!finalPhone && isJapanPhone(finalPhone),
          hasArea: !!area || !!addressVal, hasOpeningDate: !!enrich?.has_opening, isFuture: enrich?.business_status === 'FUTURE_OPENING',
          igNew, regionalNew: false, newListing: false, placesMatched: !!placeMatched, hasOfficial: !!(officialVal || reservationVal || lineVal),
          isChain: ch.definite || bigIW.exclude, chainSuspect: ch.suspect && !ch.definite, isOrg: bigIW.exclude, isEventRecruit: false, isForeign: foreignFinal, isDup: false, reviewMany: false,
          allowNoPhone: !!s.iwAllowNoPhone,
        }, iwMode)
        const tt = tierToTemperature(sc.tier)
        let temperature: string = tt.temperature
        let hotTier = tt.hot_tier
        if (bigIW.exclude) { temperature = 'EXCLUDED'; hotTier = null }  // 道の駅/産直/大型施設/公共/大手 → EXCLUDED
        // 設定: 電話必須/Places必須が有効なら未充足はHOLDに戻す
        if (temperature === 'HOT' && ((s.iwRequirePhone && !finalPhone) || (s.iwPlacesRequired && !placeMatched))) temperature = 'HOLD'
        if (temperature === 'HOT') { counts.hot++; q.hot++; if (hotTier === 'A') counts.hotA = (counts.hotA || 0) + 1; else counts.hotB = (counts.hotB || 0) + 1 }
        else if (temperature === 'EXCLUDED') { counts.excluded++; q.excluded++ }
        else { counts.hold++; q.hold++ }

        // 店名は Instagramプロフィール表示名を最優先（投稿タイトル『プレオープン始まります！！』等を店名にしない）
        const POST_TITLE_RE = /(プレ|グランド|ニュー)?オープン(しました|します|予定|のお知らせ|始まり)|開店|開業|開院|新規オープン|本日|お知らせ|キャンペーン|セール|！|!/
        const titleish = (s: string) => !s || POST_TITLE_RE.test(s) || s.length > 28
        // 店名: プロフィール表示名 > AI抽出店名 > ヒューリスティック店名。取れなければ『店名未確定』（地名プレースホルダは使わない）
        const name = (enrich?.profile_name && !titleish(enrich.profile_name)) ? enrich.profile_name
          : (j.shop_name && !titleish(j.shop_name)) ? j.shop_name
          : (shop && !titleish(shop)) ? shop
          : (enrich?.profile_name && enrich.profile_name.length <= 28) ? enrich.profile_name
          : '店名未確定'
        const sourcePostTitle = (r.title || '').slice(0, 200)
        const enrichNote = enrich ? ` / 補完[${enrich.status}:${enrich.reason}]` : ''
        const reason = foreignFinal
          ? '除外: 日本国外の候補のため除外'
          : j.exclusion_reason
          ? `除外: ${j.exclusion_reason}`
          : `新店根拠(${j.newness_type || 'unknown'}) 確度${j.confidence_score ?? '-'} / 地域:${area || '不明'} / 電話:${finalPhone || 'なし'}${enrichNote} / ${j.evidence_text || r.snippet?.slice(0, 100) || ''}${j._heuristic ? '（ルール判定）' : '（AI判定）'}`

        // HOT未達理由（Instagram Web向けチェックリスト）
        const iwConf = typeof j.confidence_score === 'number' ? j.confidence_score : (enrich?.confidence ?? 0)
        const iwChecks: HotCheck[] = [
          { key: 'has_japan', label: '日本国内', ok: foreignFinal ? false : (japanOk ? true : null), reasonKey: 'not_japan' },
          { key: 'has_shop_name', label: '店名あり', ok: !!name, reasonKey: 'shop_name_missing' },
          { key: 'has_industry', label: '業種推定', ok: industry ? true : null, reasonKey: 'industry_unknown' },
          { key: 'has_area', label: '住所/市区町村あり', ok: (area || addressVal) ? true : false, reasonKey: 'address_missing', value: (addressVal || area) || undefined },
          { key: 'has_phone', label: '日本の電話番号あり', ok: (finalPhone && isJapanPhone(finalPhone)) ? true : false, reasonKey: 'phone_missing', value: finalPhone || undefined },
          { key: 'has_newness', label: '新規オープン根拠あり', ok: (j.newness_type && j.newness_type !== 'unknown') ? true : null, reasonKey: 'newness_missing' },
          { key: 'has_opening_date', label: 'openingDate/開業予定あり', ok: enrich?.has_opening ? true : false, reasonKey: 'opening_date_missing' },
          { key: 'has_official', label: '公式/Places裏取りあり', ok: (officialVal || placeMatched) ? true : null, reasonKey: 'official_unverified' },
          { key: 'places_matched', label: 'Google Places一致', ok: placeMatched ? true : null, reasonKey: 'places_no_match' },
        ]
        const hotReject = buildHotReject({ source: 'instagram_web', temperature, confidence: iwConf, hotRequiredScore: s.iwHotRequiredScore, checks: iwChecks })

        const payload: any = {
          name, address: addressVal, industry,
          phone_number: finalPhone || null, website_url: officialVal,
          source: 'instagram_web_search', lead_source: 'instagram_web', source_type: 'AI自動投入(Instagram Web)',
          hot_reject_reasons: hotReject.hot_reject_reasons, hot_reject_summary: hotReject.hot_reject_summary,
          hot_check_result: hotReject.hot_check_result, hot_missing_requirements: hotReject.hot_missing_requirements,
          hot_blocking_reason: hotReject.hot_blocking_reason, hot_required_score: hotReject.hot_required_score,
          lead_temperature: temperature, hot_tier: hotTier, recommended_status: sc.tier,
          is_new_instagram: true, is_new_gbp: placeMatched,
          should_exclude_from_call_list: temperature === 'EXCLUDED',
          owner_reachability_score: finalPhone ? 65 : 30,
          auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason,
          instagram_url: r.url, search_query: query, search_title: (r.title || '').slice(0, 300), search_snippet: (r.snippet || '').slice(0, 500),
          // 元データ（snippet由来）と補完データの両方を保存。extracted_* には最終値（補完反映）を入れる
          extracted_shop_name: name, extracted_area: area, extracted_prefecture: prefecture, extracted_city: city,
          extracted_industry: industry, extracted_phone: finalPhone || base.phone_candidate || null, extracted_url: officialVal,
          line_url: lineVal, reservation_url: reservationVal, official_url: officialVal,
          enrichment_status: enrich?.status || 'not_started', enrichment_sources: enrich?.sources || null,
          enriched_phone: enrich?.phone || null, enriched_address: enrich?.address || null,
          enriched_prefecture: enrich?.prefecture || null, enriched_city: enrich?.city || null,
          enriched_official_url: enrich?.official || null, enriched_reservation_url: enrich?.reservation || null,
          enriched_line_url: enrich?.line || null, enriched_google_place_id: enrich?.place_id || null,
          enrichment_reason: enrich?.reason || null, enrichment_confidence: enrich?.confidence ?? null,
          last_enriched_at: enrich ? nowIso : null,
          // 取得元・信頼度（どこから住所/電話を取ったか）
          enriched_phone_source: enrich?.phone_source || null, enriched_address_source: enrich?.address_source || null,
          enriched_google_maps_url: enrich?.google_maps_url || null,
          enrichment_profile_fetched: enrich?.profile_fetched ?? null, enrichment_fail_reason: enrich?.fail_reason || null,
          source_post_title: sourcePostTitle, shop_name_source: enrich?.profile_name ? 'instagram_profile' : 'post_title',
          enrichment_rejected: enrich?.rejected?.length ? enrich.rejected : null, enrichment_region_conflict: enrich?.region_conflict ?? null,
          // Google openingDate / businessStatus（補完経由）
          google_business_status: enrich?.business_status || null, google_opening_date_raw: enrich?.opening_raw || null,
          google_opening_date_year: enrich?.opening_year ?? null, google_opening_date_month: enrich?.opening_month ?? null, google_opening_date_day: enrich?.opening_day ?? null,
          has_google_opening_date: enrich?.has_opening || false, opening_date_confidence: enrich?.opening_confidence ?? null,
          days_until_opening: enrich?.days_until_opening ?? null, days_since_opening: enrich?.days_since_opening ?? null,
          opening_date_source: enrich?.has_opening ? 'external_enrichment' : null,
          google_places_checked_at: enrich?.place_id ? nowIso : null, opening_date_checked_at: enrich?.has_opening ? nowIso : null,
          instagram_newness_reason: reason, anthropic_judgement: j, match_confidence: j.confidence_score ?? null, newness_type: j.newness_type || null,
          rule_filter_result: rf.result, skipped_reason: null, api_run_id: runId,
          google_place_id: matchedPlaceId, matched_google_place_id: matchedPlaceId,
          last_seen_at: nowIso, source_run_id: runId,
        }

        const { data: ins, error: insErr } = await admin.from('lead_candidates')
          .insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single()
        if (insErr) { counts.saveError++; if (debug.saveErrors.length < 5) debug.saveErrors.push(insErr.message) } else counts.saved++
        const candidateId = ins?.id || null

        if (s.iwAutoImport && autoImportAllowed(sc.tier, iwMode) && finalPhone && candidateId && importedCount < autoImportPerDay && importedThisRun < autoImportPerRun) {
          const memo = [`【AI自動投入 / Instagram Web(全国) / ${sc.tier}】`, `URL: ${r.url}`, `理由: ${reason}`, `クエリ: ${query}`].join('\n')
          const { data: created } = await admin.from('cases').insert({
            name, address: addressVal || '', phone1: finalPhone, industry,
            status: DEFAULT_STATUS, priority: sc.priority === 'high' ? '高' : '中', hp1: officialVal || null, instagram: r.url, source_urls: r.url, memo, created_by_id: userId,
          }).select('id').single()
          if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId); counts.imported++; importedCount++; importedThisRun++ }
        }

        if (!debug.sample) debug.sample = { query, url: r.url, title: r.title, snippet: r.snippet, rule: rf.result, judgement: j, area, temperature }
      }

      await admin.from('ig_web_query_log').upsert({ query, last_run_at: nowIso, runs: 1, results: q.results, hot_count: counts.hot - before.hot }, { onConflict: 'query' }).then(() => {}, () => {})
      debug.queryResults.push(q)
    }

    // 補完検索クエリの実行履歴を記録（7日スキップ用）
    for (const eq of enrichQueriesToLog) {
      await admin.from('ig_enrich_log').upsert({ query: eq, last_run_at: nowIso, runs: 1 }, { onConflict: 'query' }).then(() => {}, () => {})
    }

    // 概算コスト（Serperは本検索＋補完検索の合計）
    const totalSerperQueries = counts.queries + counts.enrichQueries
    debug.estSerperCost = Math.round(totalSerperQueries * SERPER_JPY_PER_QUERY * 10) / 10
    debug.estAnthropicCost = Math.round(counts.judged * ANTHROPIC_JPY_PER_JUDGE * 10) / 10
    debug.estTotalCost = Math.round((debug.estSerperCost + debug.estAnthropicCost) * 10) / 10
    debug.enrichSucceeded = counts.enrichSucceeded

    await admin.from('auto_lead_runs').update({
      status: 'success', finished_at: new Date().toISOString(), search_queries_count: counts.queries,
      fetched_count: counts.results, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded,
      imported_count: counts.imported, error_count: counts.error, error_message: errorMessage || null,
    }).eq('id', runId)

    // 注意: counts.error は数値（検索失敗回数）。UIの error 表示と衝突しないよう errorCount に退避し、
    //       error は最後のエラーメッセージ（文字列 or null）にする。
    debug.executedQueries = counts.queries
    debug.queryReport = `予定${debug.plannedQueries ?? querySet.length} / 実行${counts.queries} / スキップ(同一クエリ)${debug.skippedByRecent ?? 0} / 上限カット${debug.skippedByLimit ?? 0} / 理由:${debug.queryLimitReason || 'OK'} / Serperエラー${counts.serperError} / Bingエラー${counts.bingError}${debug.stoppedEarly ? ' / 時間上限で打ち切り' : ''}`
    return { ok: true, runId, ...counts, executedQueries: counts.queries, plannedQueries: debug.plannedQueries, skippedQueries: (debug.skippedByRecent || 0) + (debug.skippedByLimit || 0), queryReport: debug.queryReport, errorCount: counts.error, error: errorMessage || null, debug }
  } catch (e: any) {
    const msg = String(e?.message || e)
    console.error('[instagram-web] run failed', { failed_step: 'runInstagramWeb', message: msg, stack: e?.stack, timestamp: new Date().toISOString() })
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: msg }).eq('id', runId).then(() => {}, () => {})
    return { ok: false, error: `Instagram Web検索に失敗しました。詳細: ${msg}`, failed_step: 'runInstagramWeb', error_message: msg, debug }
  }
}

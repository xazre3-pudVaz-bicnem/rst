// ============================================================
// 店舗ディレクトリ型サイト（彩北なび等）の汎用パーサー（サーバー専用）
// 一覧ページ → 店舗詳細リンク抽出 → 詳細ページ取得 → 店名/電話/住所/OPEN日 抽出 → 判定。
// 記事本文は保存しない（短い抜粋・抽出結果のみ）。
// 他の地域ディレクトリにも拡張できるよう media_family ごとに設定を持つ。
// ============================================================
import { isForeignAddress, isJapanPhone, isOrgNonStore } from './japanFilter.js'
import { scoreCandidate, tierToTemperature, type HotTier, type InjectMode } from './hotTier.js'
import { detectChain } from './chainFilter.js'
import { detectBigOrPublic } from './targetFilter.js'
import { classifyIndustry } from './industry.js'

export interface DirectoryConfig {
  detailPattern: RegExp        // 店舗詳細URL（pathname+search）の判定
  industryHints?: RegExp
}

// media_family ごとの設定（拡張ポイント）
export const DIRECTORY_CONFIGS: Record<string, DirectoryConfig> = {
  saikohkunavi: {
    // 例: /shop/shop.shtml?s=2364
    detailPattern: /\/shop\/shop\.shtml\?s=\d+/i,
  },
}
// 既定（未知のディレクトリでも /shop/ 配下の詳細っぽいURLを拾う）
const DEFAULT_DIRECTORY: DirectoryConfig = {
  detailPattern: /\/(shop|store|tenpo|spot|detail)\/[^?]*\??[a-z]*=?\d+/i,
}

export function directoryConfig(mediaFamily?: string | null): DirectoryConfig {
  return (mediaFamily && DIRECTORY_CONFIGS[mediaFamily]) || DEFAULT_DIRECTORY
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x?\d+;/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface OpenDate { text: string; month: number | null; day: number | null; year: number | null; confidence: 'high' | 'mid' | 'low' | 'none'; iso: string | null }

/** 店名/タイトル/本文から「○月○日OPEN」等の開業日を抽出。年が無ければ現在年で補完（不自然なら confidence を下げる）。 */
export function extractOpenDateFromTitle(text: string, now = Date.now()): OpenDate {
  const t = String(text || '')
  // 年つき: 2026年6月28日 / 2026/6/28
  let m = t.match(/(20\d{2})[年./\-]\s?(\d{1,2})[月./\-]\s?(\d{1,2})日?/)
  let year: number | null = null, month: number | null = null, day: number | null = null
  if (m) { year = Number(m[1]); month = Number(m[2]); day = Number(m[3]) }
  else {
    // 年なし: 「6月28日OPEN/オープン/開店」
    m = t.match(/(\d{1,2})月(\d{1,2})日\s*(?:OPEN|ｵｰﾌﾟﾝ|オープン|開店|開業|開院|新規|リニューアル)?/i)
    if (m) { month = Number(m[1]); day = Number(m[2]) }
  }
  if (month == null || day == null || month < 1 || month > 12 || day < 1 || day > 31) {
    return { text: '', month: null, day: null, year: null, confidence: 'none', iso: null }
  }
  const openWord = /(OPEN|ｵｰﾌﾟﾝ|オープン|開店|開業|開院|グランドオープン|プレオープン)/i.test(t)
  const label = t.match(/\d{1,2}月\d{1,2}日\s*(?:OPEN|オープン|開店|開業|開院)?/i)?.[0] || `${month}月${day}日`
  // 年補完
  const nowD = new Date(now)
  let useYear = year
  if (useYear == null) {
    useYear = nowD.getFullYear()
    // 例: 現在12月で「1月OPEN」は翌年、現在1月で「12月OPEN」は前年の可能性
    const cand = new Date(useYear, month - 1, day).getTime()
    const diffDays = (cand - now) / 86400000
    if (diffDays > 200) useYear -= 1       // かなり未来→前年の開業
    else if (diffDays < -200) useYear += 1 // かなり過去→翌年の開業予定
  }
  const iso = `${useYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const dt = new Date(useYear, month - 1, day).getTime()
  const diffDays = Math.round((dt - now) / 86400000)
  // 確度: OPEN語あり＋日付明確=high、日付のみ=mid、±400日超など不自然=low
  let confidence: OpenDate['confidence'] = openWord ? 'high' : 'mid'
  if (Math.abs(diffDays) > 400) confidence = 'low'
  return { text: label, month, day, year: useYear, confidence, iso }
}

export interface DirectoryLink { url: string; title: string; open: OpenDate }

/** 一覧ページから店舗詳細リンクを抽出（media_family の detailPattern で判定）。 */
export function extractDirectoryListingLinks(html: string, base: URL, mediaFamily?: string | null): {
  links: DirectoryLink[]; totalLinks: number; detailLinks: number; openTagged: number
} {
  const cfg = directoryConfig(mediaFamily)
  const out: DirectoryLink[] = []
  const seen = new Set<string>()
  let totalLinks = 0, openTagged = 0
  for (const mt of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    totalLinks++
    const href = mt[1]
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue
    let abs: URL
    try { abs = new URL(href, base) } catch { continue }
    if (abs.host !== base.host) continue
    const pathAndSearch = abs.pathname + (abs.search || '')
    if (!cfg.detailPattern.test(pathAndSearch)) continue
    const key = abs.toString()
    if (seen.has(key)) continue
    seen.add(key)
    const title = stripTags(mt[2]).slice(0, 140)
    const open = extractOpenDateFromTitle(title)
    if (open.confidence !== 'none') openTagged++
    out.push({ url: key, title, open })
  }
  return { links: out, totalLinks, detailLinks: out.length, openTagged }
}

export interface DirectoryShopInfo {
  shop_name: string; phone: string; address: string; industry: string
  hours: string; holiday: string; official_url: string; instagram_url: string; map_url: string
  open: OpenDate; excerpt: string
}

/** テキストから正規の業種を推定（フォーム選択肢と一致する値のみ返す）。店名＋記事タイトル等の店舗固有テキストに使うこと。 */
export function detectIndustryFromText(text: string): string {
  return classifyIndustry(text)
}

const CHAIN_HINT = /(マクドナルド|スターバックス|スタバ|ケンタッキー|モスバーガー|ガスト|サイゼリヤ|吉野家|すき家|松屋|ドトール|タリーズ|コメダ|丸亀製麺|ユニクロ|GU|セブンイレブン|ファミリーマート|ローソン|QBハウス|ライザップ|チョコザップ|カーブス|ほっともっと|大戸屋|やよい軒|ニトリ|業務スーパー|ドン・?キホーテ|マツモトキヨシ|ウエルシア|スギ薬局)/i

function pickUrl(html: string, re: RegExp): string {
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) { if (re.test(m[1])) return m[1] }
  return ''
}

/** 店舗詳細ページHTMLから店名・電話・住所・業種・OPEN日などを抽出。 */
export function extractDirectoryShopInfo(html: string, fallbackTitle = ''): DirectoryShopInfo {
  const body = stripTags(html)
  const PREF = '北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県'
  // 店名: h2(店名表示) → og:title/h1から『地名のカテゴリ』パンくず＆サイト名を除去した実店名。ナビ/カテゴリは採用しない
  const og = stripTags(html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || '')
  const h1 = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
  const h2 = stripTags(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || '')
  const tt = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
  // パンくずカテゴリ判定（例: 千葉市中央区のレジャー・観光スポット / 船橋市のグルメ）
  const isCrumb = (s: string) => /^[^\s]{1,12}[都道府県市区町村][^\s]{0,10}の(グルメ|カフェ|レジャー|観光|スポット|公共施設|施設|美容|サロン|ショップ|お店|ニュース|エンタメ|ホテル|宿|温泉|病院|クリニック|教室|サービス|ショッピング|買い物)/.test(s.trim())
  const cleanCand = (raw: string): string => {
    let s = String(raw || '').replace(/\s*[|｜].*$/, '').trim()  // サイト名(| 以降)除去
    if (s.includes(' - ') || s.includes(' – ') || s.includes('｜')) {
      // 「カテゴリ - 店名」型: パンくずでないセグメントの最後を店名に
      const parts = s.split(/\s*[-–]\s*/).map((x) => x.trim()).filter(Boolean)
      const nonCrumb = parts.filter((p) => !isCrumb(p))
      s = (nonCrumb.length ? nonCrumb[nonCrumb.length - 1] : parts[parts.length - 1]) || s
    }
    if (isCrumb(s)) s = s.replace(/^[^\s]{1,12}[都道府県市区町村][^\s]{0,10}の[^\s]{1,16}?(スポット|グルメ|カフェ|公共施設|施設|美容室|サロン|お店|ニュース|エンタメ|ショップ|教室|サービス)\s*/, '').trim()
    return s.replace(/（[^）]*）\s*$/, '').trim().slice(0, 50)
  }
  // 優先: h2（実店名のことが多い・パンくびでなければ）→ og:title整形 → h1整形 → title → fallback
  let shop_name = ''
  for (const cand of [h2, cleanCand(og), cleanCand(h1), cleanCand(tt), stripTags(fallbackTitle)]) {
    const s = (cand === h2 ? h2 : cand).trim()
    if (s && !isCrumb(s) && s.length >= 2 && !/^(ニュース|メニュー|HOME|アクセス|クチコミ|お気に入り|TOP)/.test(s)) { shop_name = s.slice(0, 50); break }
  }
  if (!shop_name) shop_name = cleanCand(og) || cleanCand(h1) || stripTags(fallbackTitle).slice(0, 40)

  // 電話: tel:リンク → TEL/電話ラベル → 本文中の日本の番号
  let phone = (html.match(/href=["']tel:(\+?[\d-]{9,15})["']/i)?.[1] || '').replace(/^\+81/, '0')
  if (!phone) { const telLabel = body.match(/(?:TEL|ＴＥＬ|電話|でんわ|お問い合わせ)[^\d+]{0,6}(0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4})/i); if (telLabel) phone = telLabel[1] }
  if (!phone) { for (const m of body.matchAll(/0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4}/g)) { if (isJapanPhone(m[0])) { phone = m[0]; break } } }
  phone = phone.trim()

  // 住所: 都道府県アンカー最優先（『アクセス』ラベルはナビ誤爆するので使わない）。住所/所在地ラベル＋都道府県 → 都道府県アンカー → 市区町村+番地
  let address = ''
  const labelPref = body.match(new RegExp(`(?:住所|所在地)[:：\\s]{0,4}(〒?\\s*\\d{0,3}-?\\d{0,4}\\s*)?((?:${PREF})[^\\n。、）)]{3,50})`))
  const addrPref = body.match(new RegExp(`(?:${PREF})[一-龥ぁ-んァ-ヶ0-9０-９]{2,30}[-－0-9０-９]{1,12}`))
  const addr2 = body.match(/[一-龥ぁ-んァ-ヶ]{1,8}[市区町村][一-龥ぁ-んァ-ヶ0-9０-９]{1,20}[-－0-9０-９]{1,10}/)
  if (labelPref) address = ((labelPref[1] || '') + labelPref[2])
  else if (addrPref) address = addrPref[0]
  else if (addr2) address = addr2[0]
  // 末尾に続くナビ/付帯情報を切る（アクセス/営業時間/交通/地図/TEL等）
  address = address.replace(/(アクセス|営業時間|交通|地図|ＭＡＰ|MAP|TEL|ＴＥＬ|電話|定休|駐車|お問い?合わせ|ホームページ|公式|クチコミ|ニュース|メニュー).*$/i, '').replace(/\s+/g, '').slice(0, 60)

  // 業種は「店名＋記事タイトル」の店舗固有テキストを最優先（ページ全体だと関連記事のパン屋等を誤検出するため）。
  const industry = detectIndustryFromText(`${shop_name} ${fallbackTitle}`) || detectIndustryFromText(body.slice(0, 400)) || ''
  const hours = (body.match(/(?:営業時間|営業)[:：]?\s*([0-9０-９:：~〜\-\s]{4,30})/)?.[1] || '').trim().slice(0, 40)
  const holiday = (body.match(/(?:定休日|店休日|休み)[:：]?\s*([^\n。]{1,20})/)?.[1] || '').trim().slice(0, 30)
  const instagram_url = pickUrl(html, /instagram\.com/i)
  const map_url = pickUrl(html, /google\.[^/]*\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i)
  const official_url = pickUrl(html, /^https?:\/\//i) && (() => {
    for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
      const u = m[1]
      if (/instagram\.com|twitter\.com|x\.com|facebook\.com|line\.me|google\.|goo\.gl|saikohkunavi|saihokunavi/i.test(u)) continue
      return u
    }
    return ''
  })() || ''

  const open = extractOpenDateFromTitle(`${shop_name} ${fallbackTitle} ${body.slice(0, 600)}`)
  const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i)
  const excerpt = stripTags(desc?.[1] || body.slice(0, 200)).slice(0, 200)

  return { shop_name, phone, address, industry, hours, holiday, official_url, instagram_url, map_url, open, excerpt }
}

export interface DirectoryClassify { temperature: string; hot_tier: 'A' | 'B' | null; tier: HotTier; score: number; reason: string; priority: 'high' | 'normal' | null; isChain: boolean; isForeign: boolean }

/** ディレクトリ/マーケットプレイス候補の判定（新規掲載＝新店根拠。営業向きならHOT_A/HOT_B）。 */
export function classifyDirectoryCandidate(info: { shop_name: string; phone: string; address: string; open: OpenDate; isJapan: boolean }, mode: InjectMode = 'standard'): DirectoryClassify {
  const ch = detectChain(info.shop_name)
  const isChain = CHAIN_HINT.test(info.shop_name) || ch.definite
  const isForeign = isForeignAddress(info.address)
  const hasPhone = !!info.phone && isJapanPhone(info.phone)
  const hasAddr = !!info.address
  const hasOpen = info.open.confidence === 'high' || info.open.confidence === 'mid'
  // 大手/公共/大型施設/道の駅/産直/JA等は営業対象外（ターゲット=個人事業主・小規模店）
  const big = detectBigOrPublic(`${info.shop_name} ${info.address}`)
  const sc = scoreCandidate({
    source: 'regional_media', isJapan: info.isJapan, hasShopName: !!info.shop_name, hasPhone, hasArea: hasAddr,
    hasOpeningDate: hasOpen, isFuture: false, igNew: false, regionalNew: false, newListing: true,
    placesMatched: false, hasOfficial: false,
    isChain, chainSuspect: ch.suspect && !ch.definite, isOrg: isOrgNonStore(info.shop_name) || big.exclude, isEventRecruit: false, isForeign, isDup: false, reviewMany: false,
  }, mode)
  let { temperature, hot_tier } = tierToTemperature(sc.tier)
  let reason = sc.reason
  if (big.exclude) { temperature = 'EXCLUDED'; hot_tier = null; reason = `${big.reason}${reason}` }
  return { temperature, hot_tier, tier: sc.tier, score: sc.score, reason, priority: sc.priority, isChain: isChain || big.exclude, isForeign }
}

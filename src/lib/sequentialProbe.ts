// ============================================================
// 連番URL探索クロール（サーバー専用・地域メディアとは別枠）
//  - 文字コード自動判定(Shift_JIS/EUC-JP/UTF-8)＋文字化け検出
//  - じゃらん専用パーサー(jalan_spot_detail): 本体の基本情報のみ抽出（周辺おすすめは除外）
//  - 前回 last_checked_id の続きから再開＋少し戻り確認(backfill)
//  - valid/invalid判定。validのみ lead_candidates 保存・invalid/文字化けは probe_results に記録
//  - 連続not_found停止・1回20/1日100URL・30日再取得回避・robots配慮
// ============================================================
import { extractAddressLoose } from './enrichProfile.js'
import { extractJpPhone, sanitizeShopName, isValidJpPhone } from './regionalParsers.js'
import { detectBigOrPublic, detectBigOrPublicStrong, detectMultiStore } from './targetFilter.js'
import { renderPage, renderConfigured } from './regionalMediaRun.js'
import { isForeignAddress, isJapanAddress, isJapanPhone } from './japanFilter.js'
import { scoreCandidate, tierToTemperature, autoImportAllowed, type InjectMode } from './hotTier.js'
import { buildHotReject, type HotCheck } from './hotReject.js'
import { detectChain } from './chainFilter.js'
import { computeQuality } from './leadQuality.js'
import { webSearch } from './instagramWebRun.js'
import { DEFAULT_STATUS } from './constants.js'

const UA = 'RST-CRM-bot/1.0 (+lead research; respects robots.txt)'
const PROBE_TIMEOUT_MS = 8000

// ---- 文字コード判定つき取得 ----
function detectCharset(buf: Buffer, headerCt: string): string {
  const m = headerCt.match(/charset=["']?([\w-]+)/i)
  if (m) return m[1].toLowerCase()
  const head = buf.slice(0, 4096).toString('latin1')
  const meta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || head.match(/content=["'][^"']*charset=([\w-]+)/i)
  return (meta?.[1] || '').toLowerCase()
}
function normCharset(cs: string): string {
  const c = cs.replace(/[^a-z0-9_-]/g, '')
  if (/^(shift.?jis|sjis|ms932|windows-?31j|cp932)$/.test(c)) return 'shift_jis'
  if (/^(euc-?jp|eucjp)$/.test(c)) return 'euc-jp'
  if (/^(iso-?2022-?jp)$/.test(c)) return 'iso-2022-jp'
  if (/^utf-?8$/.test(c) || !c) return 'utf-8'
  return c
}
function decodeBuf(buf: Buffer, cs: string): string {
  try { return new TextDecoder(cs as any).decode(buf) } catch { try { return new TextDecoder('utf-8').decode(buf) } catch { return buf.toString('utf8') } }
}
function mojibakeRate(s: string): number {
  if (!s) return 1
  const sample = s.slice(0, 6000)
  const bad = (sample.match(/�/g) || []).length
  return bad / Math.max(1, sample.length)
}

interface FetchDecoded { ok: boolean; status: number; html: string; charset: string; decodeMethod: string; mojibakeRate: number; mojibake: boolean; timedOut: boolean }
async function fetchDecoded(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<FetchDecoded> {
  const ctrl = new AbortController()
  let timedOut = false
  const to = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ja' }, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(to)
    const buf = Buffer.from(await res.arrayBuffer())
    const detected = normCharset(detectCharset(buf, res.headers.get('content-type') || ''))
    let html = decodeBuf(buf, detected)
    let rate = mojibakeRate(html)
    let method = detected
    if (rate > 0.01) {
      for (const cs of ['shift_jis', 'euc-jp', 'utf-8']) {
        if (cs === detected) continue
        const h2 = decodeBuf(buf, cs); const r2 = mojibakeRate(h2)
        if (r2 < rate) { html = h2; rate = r2; method = cs }
      }
    }
    return { ok: res.ok, status: res.status, html, charset: detected || 'utf-8', decodeMethod: method, mojibakeRate: rate, mojibake: rate > 0.02, timedOut: false }
  } catch { clearTimeout(to); return { ok: false, status: 0, html: '', charset: '', decodeMethod: '', mojibakeRate: 1, mojibake: false, timedOut } }
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

const INVALID_RE = /(該当(観光スポット|施設|店舗)?情報は存在しません|ページが見つかりません|お探しのページ|404\s*Not\s*Found|エラーが発生|アクセスが集中|ただいま大変混み合)/i
const OPEN_RE = /(新規オープン|ニューオープン|グランドオープン|プレオープン|本日オープン|オープンしました|開店しました|開業しました|\d{1,2}月\d{1,2}日\s?(?:OPEN|オープン|開店|開業))/i
// 観光名所・公共施設のみ（電話/住所が無ければ営業対象外）
const FACILITY_RE = /(神社|神宮|大社|[^ァ-ヶ]寺$|お寺|寺院|仏閣|教会|公園|庭園|広場|駅$|空港|港$|役所|市役所|町村役場|区役所|図書館|博物館|美術館|資料館|城跡|城$|展望台|展望|海岸|砂浜|ビーチ|滝$|渓谷|峠|岬|湖$|池$|山$|岳$|温泉郷|景勝|名所|旧跡|史跡|記念碑|モニュメント)/

export interface JalanSpot { name: string; address: string; phone: string; category: string; official: string; mapUrl: string; reviews: string; valid: boolean; invalidReason: string; published?: string; updated?: string }
/** じゃらん観光スポット詳細ページのパーサー（本体の基本情報のみ。周辺おすすめは除外） */
export function parseJalanSpot(html: string, mojibake: boolean): JalanSpot {
  const empty: JalanSpot = { name: '', address: '', phone: '', category: '', official: '', mapUrl: '', reviews: '', valid: false, invalidReason: '' }
  if (mojibake) return { ...empty, invalidReason: '文字化けで読めない' }
  if (INVALID_RE.test(stripTags(html))) return { ...empty, invalidReason: 'ページ未存在/エラーページ' }
  const body = stripTags(html)

  // ===== 基本情報テーブル（th/td・dt/dd）を最優先で読む（所在地/お問い合わせ等はスポット固有なので全文走査でよい） =====
  const rows: { label: string; htmlVal: string; textVal: string }[] = []
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = m[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i)
    const td = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/i)
    if (th && td) rows.push({ label: stripTags(th[1]), htmlVal: td[1], textVal: stripTags(td[1].replace(/<br\s*\/?>/gi, ' ')) })
  }
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*(?:<dd[^>]*>([\s\S]*?)<\/dd>)/gi)) {
    rows.push({ label: stripTags(m[1]), htmlVal: m[2] || '', textVal: stripTags((m[2] || '').replace(/<br\s*\/?>/gi, ' ')) })
  }
  const hasBasicTable = /class=["'][^"']*basicInfo/i.test(html) || rows.some((r) => /名称|所在地|住所|お問い?合わせ|電話|TEL/i.test(r.label))
  const rowVal = (re: RegExp) => rows.find((r) => re.test(r.label))
  const nameRow = rowVal(/^名称|施設名|スポット名/)
  const addrRow = rowVal(/所在地|住所/)
  const telRow = rowVal(/お問い?合わせ|電話|TEL|問合/i)
  const catRow = rowVal(/ジャンル|カテゴリ|種別|分類/)

  // 名称: 【施設名】表記 → 基本情報「名称」→ og:title → h1（「アクセス・営業時間・料金情報」「｜じゃらん」等の付帯語を除去）
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ''
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''
  const rawName = nameRow?.textVal || stripTags(og || h1)
  const bracket = rawName.match(/[【「](.+?)[】」]/)
  let name = (bracket ? bracket[1] : rawName)
    .replace(/[|｜].*$/, '')
    .replace(/(の)?(アクセス|営業時間|料金|クチコミ|観光情報|詳細|地図|基本情報|周辺).*$/, '')
    .replace(/\s*[-–|｜]\s*じゃらん.*$/i, '')
    .replace(/[（(][ァ-ヶー゠-ヿ\s・]+[）)]\s*$/, '')  // 末尾の（カタカナ読み仮名）を除去（じゃらん名称欄）
    .trim().slice(0, 50)

  // 住所: 基本情報「所在地」を最優先 → 本文の所在地ラベル → 緩い抽出
  let address = ''
  if (addrRow) {
    const t = addrRow.textVal.replace(/地図.*$/,'').replace(/MAP.*$/i,'').trim()
    const m = t.match(/〒?\s*\d{0,3}-?\d{0,4}\s*([^\n]{4,60})/)
    address = (m ? m[0] : t).replace(/\s+/g, '').slice(0, 70)
  }
  if (!address) address = (body.match(/(?:所在地|住所)[:：\s]*([〒\d都道府県][^\n。｜|]{4,50})/)?.[1] || '').trim()
  if (!address) address = extractAddressLoose(body).address

  // 電話: 基本情報「お問い合わせ/TEL」を最優先（じゃらん予約ダイヤルは除外）
  let phone = ''
  if (telRow) phone = extractJpPhone(telRow.textVal)
  if (!phone) phone = extractJpPhone(body)
  const category = catRow?.textVal?.slice(0, 16) || (body.match(/(?:ジャンル|カテゴリ|種別)[:：\s]*([^\s|｜/]{2,16})/)?.[1] || '')
  const official = html.match(/href=["'](https?:\/\/(?!www\.jalan\.net)[^"']+)["'][^>]*>\s*(?:公式|ホームページ|HP|Webサイト)/i)?.[1] || (addrRow ? (addrRow.htmlVal.match(/href=["'](https?:\/\/(?!www\.jalan\.net)[^"']+)["']/i)?.[1] || '') : '')
  const mapUrl = html.match(/href=["'](https?:\/\/(?:maps\.google|www\.google\.[^/]*\/maps|maps\.app\.goo\.gl)[^"']+)["']/i)?.[1] || ''
  const reviews = (body.match(/(?:クチコミ|口コミ)\s*([\d,]+)\s*件/)?.[1] || '')

  // valid: 名称＋住所が必須（電話は任意）。基本情報テーブルが無く名称も無ければ未存在扱い
  let invalidReason = ''
  if (!hasBasicTable && !name && !address) invalidReason = '基本情報テーブルなし'
  else if (!name) invalidReason = '名称なし'
  else if (!address) invalidReason = '住所なし'
  return { name, address, phone, category, official, mapUrl, reviews, valid: !invalidReason, invalidReason }
}

// 食べログ詳細ページで店名に紛れ込む付帯語・固有のNG語
const TABELOG_INVALID_RE = /(指定されたページが見つかりません|ページが見つかりませんでした|現在掲載されていません|閉店しました|この店舗は存在しません|お探しのページは)/
const NAME_BAN_RE = /^(食べログ|口コミ|クチコミ|地図|メニュー|予約|ネット予約|店舗情報|アクセス|営業時間|クーポン|写真|空席確認)$/
/** 食べログ店舗詳細ページのパーサー（h1/og:title/パンくず優先で正式店名、店舗情報欄から住所・電話） */
export function parseTabelog(html: string, mojibake: boolean): JalanSpot {
  const empty: JalanSpot = { name: '', address: '', phone: '', category: '', official: '', mapUrl: '', reviews: '', valid: false, invalidReason: '' }
  if (mojibake) return { ...empty, invalidReason: '文字化けで読めない' }
  const body = stripTags(html)
  if (TABELOG_INVALID_RE.test(body) || INVALID_RE.test(body)) return { ...empty, invalidReason: 'ページ未存在/掲載終了' }

  // ① h1/h2 の display-name（食べログの店名表示）
  const dn = html.match(/<h[12][^>]*class=["'][^"']*display-name[^"']*["'][^>]*>([\s\S]*?)<\/h[12]>/i)?.[1] || ''
  // ② og:title「店名 (よみ) - エリア/ジャンル | 食べログ」→ 店名部分
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ''
  // ③ titleタグ
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  // ④ パンくず（末尾＝店名）
  const crumbs = Array.from(html.matchAll(/<(?:li|span|a)[^>]*(?:itemprop=["']name["']|class=["'][^"']*breadcrumb[^"']*["'])[^>]*>([\s\S]*?)<\/(?:li|span|a)>/gi)).map((m) => stripTags(m[1]).trim()).filter(Boolean)

  const cleanName = (raw: string): string => stripTags(raw)
    .replace(/\s*[-－―|｜/／].*$/, '')          // 「店名 - エリア/ジャンル | 食べログ」以降を除去
    .replace(/[（(][ぁ-んァ-ヶー\s]+[)）]\s*$/, '')  // 末尾の（よみがな）
    .replace(/[（(][^（）()]{0,30}(店|よみ)[）)]\s*$/, '')
    .replace(/\s+/g, ' ').trim().slice(0, 50)

  let name = cleanName(dn)
  if (!name || NAME_BAN_RE.test(name)) name = cleanName(og)
  if (!name || NAME_BAN_RE.test(name)) name = cleanName(title)
  if (!name || NAME_BAN_RE.test(name)) { const last = crumbs[crumbs.length - 1] || ''; if (last && !NAME_BAN_RE.test(last)) name = cleanName(last) }
  if (NAME_BAN_RE.test(name)) name = ''

  // 住所: rstinfo-table__address → 住所ラベル → 緩い抽出
  let address = stripTags((html.match(/<p[^>]*class=["'][^"']*rstinfo-table__address[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '').replace(/<br\s*\/?>/gi, ' ')).replace(/地図.*$/, '').replace(/\s+/g, '').slice(0, 70)
  if (!address) address = (body.match(/(?:所在地|住所)[:：\s]*([〒\d都道府県][^\n。｜|]{4,50})/)?.[1] || '').trim()
  if (!address) address = extractAddressLoose(body).address

  // 電話: rstinfo-table__tel-num（食べログ詳細ページの電話）→ 本文
  let phone = extractJpPhone(html.match(/class=["'][^"']*rstinfo-table__tel-num[^"']*["'][^>]*>([\s\S]*?)</i)?.[1] || '')
  if (!phone) phone = extractJpPhone(html.match(/<strong[^>]*tel[^>]*>([\s\S]*?)<\/strong>/i)?.[1] || '')
  if (!phone) phone = extractJpPhone(body)

  // ジャンル: og:title の「エリア/ジャンル」部分、または rstinfo
  const genre = (og.match(/-\s*[^/|｜]+\/([^|｜]+?)\s*[|｜]/)?.[1] || stripTags(html.match(/class=["'][^"']*rdheader-subinfo__item-text[^"']*["'][^>]*>([\s\S]*?)</i)?.[1] || '')).trim().slice(0, 16)
  const official = html.match(/href=["'](https?:\/\/(?!tabelog\.com)[^"']+)["'][^>]*>\s*(?:お店のホームページ|公式|オフィシャル)/i)?.[1] || ''
  const mapUrl = html.match(/href=["'](https?:\/\/(?:maps\.google|www\.google\.[^/]*\/maps|maps\.app\.goo\.gl)[^"']+)["']/i)?.[1] || ''

  let invalidReason = ''
  if (!name && !address) invalidReason = '店名/住所が取れない'
  else if (!name) invalidReason = '食べログ詳細ページから店名抽出失敗'
  return { name, address, phone, category: genre, official, mapUrl, reviews: '', valid: !invalidReason, invalidReason }
}

// EPARK店舗/EPARK歯科/Caloo病院/petCaloo動物病院 の詳細ページ共通パーサー（店名h1優先・〒/都道府県住所・tel/電話・口コミ件数）
const EPARK_CALOO_INVALID_RE = /(見つかりません|ページが存在しません|お探しのページ|該当する.*ありません|\[404\]|削除されたか|公開を終了)/
export function parseEparkCaloo(html: string, mojibake: boolean): JalanSpot {
  const empty: JalanSpot = { name: '', address: '', phone: '', category: '', official: '', mapUrl: '', reviews: '', valid: false, invalidReason: '' }
  if (mojibake) return { ...empty, invalidReason: '文字化けで読めない' }
  const body = stripTags(html)
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ''
  const h1 = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').trim()
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  if (EPARK_CALOO_INVALID_RE.test(og) || EPARK_CALOO_INVALID_RE.test(title) || INVALID_RE.test(body)) return { ...empty, invalidReason: 'ページ未存在/掲載終了' }
  // 店名/医院名: h1優先 → og:title整形（[エリア]/｜店舗情報 - EPARK / の口コミ・評判 (N件) / 【…】 を除去）
  const cleanName = (raw: string) => stripTags(raw)
    .replace(/の口コミ[・･].*$/, '').replace(/の評判.*$/, '').replace(/\s*[（(]\s*[\d,]+\s*件.*$/, '')
    .replace(/\s*[\[［【][^\]］】]*[\]］】]/g, '').replace(/\s*[|｜].*$/, '').replace(/\s*-\s*EPARK.*$/i, '').replace(/【[^】]*】/g, '').trim().slice(0, 50)
  let name = h1 ? cleanName(h1) : cleanName(og || title)
  if (!name) name = cleanName(og || title)
  // 住所: 〒+都道府県 を最優先（所在地/住所ラベル）→ 都道府県アンカー
  let address = (body.match(/〒\s*\d{3}-?\d{4}\s*((?:北海道|東京都|大阪府|京都府|[^\s]{2,3}県)[^\n。、）)【]{3,50})/)?.[1] || '').trim()
  if (!address) address = (body.match(/(?:所在地|住所)[:：\s]{0,4}(〒?\s*\d{0,3}-?\d{0,4}\s*(?:北海道|東京都|大阪府|京都府|[^\s]{2,3}県)[^\n。、）)【]{3,50})/)?.[1] || '').trim()
  if (!address) address = (body.match(/(?:北海道|東京都|大阪府|京都府|[^\s]{2,3}県)[一-龥ぁ-んァ-ヶ0-9０-９]{2,30}[-－0-9０-９]{1,12}/)?.[0] || '').trim()
  address = address.replace(/(大きな地図|地図で見る|アクセス|ＭＡＰ|MAP|電話|TEL|診療).*$/i, '').replace(/\s+/g, '').slice(0, 70)
  // 電話: tel:リンク → 電話/TEL/予約ラベル → 本文の日本の番号
  let phone = (html.match(/href=["']tel:(\+?[\d-]{9,15})["']/i)?.[1] || '').replace(/^\+81/, '0')
  if (!phone) phone = extractJpPhone(body.match(/(?:電話|TEL|ＴＥＬ|予約専用|お問い?合わせ)[^\d+]{0,8}(0\d[\d\-()\s]{8,15})/i)?.[1] || '')
  if (!phone) phone = extractJpPhone(body)
  // 口コミ件数（og:title「(N件)」/ 本文「口コミ N件」）
  const reviews = (og.match(/[（(]\s*([\d,]+)\s*件/)?.[1] || body.match(/口コミ[・･]?\s*([\d,]+)\s*件/)?.[1] || '').replace(/,/g, '')
  // 業種/診療科目（最初の語のみ。UI語/付帯語は除去）
  let category = (body.match(/診療科目[:：\s、，]*([一-龥ぁ-んァ-ヶ]{2,8}科)/)?.[1] || body.match(/(?:ジャンル|業種)[:：\s]*([一-龥ぁ-んァ-ヶ]{2,12})/)?.[1] || '').trim()
  if (/で探す|専門外来|資格|を探す|検索|ランキング|もっと見る/.test(category)) category = ''
  category = category.slice(0, 16)
  const official = html.match(/href=["'](https?:\/\/(?!epark\.jp|caloo\.jp|haisha-yoyaku\.jp)[^"']+)["'][^>]*>\s*(?:公式|ホームページ|オフィシャル|HP)/i)?.[1] || ''
  const mapUrl = html.match(/href=["'](https?:\/\/(?:maps\.google|www\.google\.[^/]*\/maps|maps\.app\.goo\.gl)[^"']+)["']/i)?.[1] || ''
  let invalidReason = ''
  if (!name && !phone && !address) invalidReason = '店名/電話/住所が取れない'
  return { name, address, phone, category, official, mapUrl, reviews, valid: !invalidReason, invalidReason }
}

// エキテン店舗詳細ページ。公開日/最終更新日（掲載日。開業日ではない）＋店名/電話/住所/業種。
const EKITEN_INVALID_RE = /(見つかりません|ページが存在しません|削除されたか|公開を終了|該当する店舗はありません|存在しないか|閉店しました|掲載を終了)/
export function parseEkiten(html: string, mojibake: boolean): JalanSpot {
  const empty: JalanSpot = { name: '', address: '', phone: '', category: '', official: '', mapUrl: '', reviews: '', valid: false, invalidReason: '', published: '', updated: '' }
  if (mojibake) return { ...empty, invalidReason: '文字化けで読めない' }
  const body = stripTags(html)
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ''
  if (EKITEN_INVALID_RE.test(og) || EKITEN_INVALID_RE.test(body.slice(0, 2000))) return { ...empty, invalidReason: 'ページ未存在/掲載終了' }
  // 店名: h1 → og:title（（エリア） | エキテン byGMO を除去）
  const h1 = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').trim()
  let name = (h1 || og.replace(/\s*[（(][^）)]*[)）]\s*$/, '').replace(/\s*[|｜].*$/, '')).replace(/\s*[（(][^）)]*[)）]\s*$/, '').replace(/\s*[|｜].*$/, '').trim().slice(0, 50)
  // 住所: 住所ラベル → 都道府県アンカー
  let address = (body.match(/(?:住所|所在地)[:：\s]{0,4}((?:北海道|東京都|大阪府|京都府|[^\s]{2,3}県)[一-龥ぁ-んァ-ヶ0-9０-９丁目番地号－−\-]{2,40})/)?.[1] || '').trim()
  if (!address) address = (body.match(/(?:北海道|東京都|大阪府|京都府|[^\s]{2,3}県)[一-龥ぁ-んァ-ヶ0-9０-９丁目番地号－−\-]{2,40}/)?.[0] || '').trim()
  address = address.replace(/(地図|アクセス|ＭＡＰ|MAP|電話|TEL|営業時間|ジャンル).*$/i, '').replace(/\s+/g, '').slice(0, 70)
  // 電話: tel: → 電話ラベル → 本文
  let phone = (html.match(/href=["']tel:(\+?[\d-]{9,15})["']/i)?.[1] || '').replace(/^\+81/, '0')
  if (!phone) phone = extractJpPhone(body)
  const category = (body.match(/(?:ジャンル|業種)[:：\s]*([一-龥ぁ-んァ-ヶ・]{2,16})/)?.[1] || '').replace(/(地図|アクセス|詳細|を探す|で探す).*$/, '').trim().slice(0, 20)
  const official = html.match(/href=["'](https?:\/\/(?!www\.ekiten\.jp|ekiten\.jp)[^"']+)["'][^>]*>\s*(?:公式|ホームページ|オフィシャル|HP)/i)?.[1] || ''
  const reviews = (body.match(/口コミ[・･]?\s*([\d,]+)\s*件/)?.[1] || og.match(/[（(]\s*([\d,]+)\s*件/)?.[1] || '').replace(/,/g, '')
  // 公開日 / 最終更新日: 「公開日</dt> ... <time datetime="YYYY/MM/DD">」
  const dateAfter = (label: string): string => {
    const i = html.indexOf(label)
    if (i < 0) return ''
    const seg = html.slice(i, i + 220)
    const dt = seg.match(/datetime=["']([0-9]{4}[\/年-][0-9]{1,2}[\/月-][0-9]{1,2})/)?.[1] || seg.match(/([0-9]{4}[\/年][0-9]{1,2}[\/月][0-9]{1,2}日?)/)?.[1] || ''
    return dt.replace(/[年月]/g, '/').replace(/日/g, '').replace(/\/$/, '')
  }
  const published = dateAfter('公開日')
  const updated = dateAfter('最終更新日') || dateAfter('更新日')
  let invalidReason = ''
  if (!name && !phone && !address) invalidReason = '店名/電話/住所が取れない'
  return { name, address, phone, category, official, mapUrl: '', reviews, valid: !invalidReason, invalidReason, published, updated }
}

/** 公開日(YYYY/MM/DD等)から今日との日数差（過去=正）。取れなければ null。 */
export function daysSinceDate(s?: string): number | null {
  if (!s) return null
  const t = Date.parse(String(s).replace(/\//g, '-'))
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86400000)
}

export interface ProbeTestItem { url: string; ok: boolean; status: number; charset: string; mojibake: boolean; valid: boolean; name: string; address: string; phone: string; category: string; parser_used: string; invalidReason: string }
/** 既知URL（または指定ID）でじゃらん専用パーサーを単体テスト（DB保存なし） */
export async function testProbeSite(site: any, ids?: number[]): Promise<{ ok: boolean; items: ProbeTestItem[]; summary: { addressOk: boolean; phoneOk: boolean; parserOk: boolean } }> {
  const template: string = site.url_template || ''
  const padding = Number(site.id_padding) || 0
  const testIds = (ids && ids.length ? ids : [231369, 231370, 231375])
  const items: ProbeTestItem[] = []
  const renderMode = String(site.rendering_mode || 'auto')
  for (const id of testIds) {
    const url = template.includes('{ID}') ? template.replace('{ID}', pad(id, padding)) : `https://www.jalan.net/kankou/spt_guide${pad(id, padding || 12)}/`
    let r = await fetchDecoded(url)
    await new Promise((rs) => setTimeout(rs, 400))
    const isJalan = (site.parser_type === 'jalan_spot_detail') || /jalan\.net/i.test(url)
    const isTabelog = (site.parser_type === 'tabelog_detail') || /tabelog\.com/i.test(url)
    const isEparkCaloo = /epark\.jp|haisha-yoyaku\.jp|caloo\.jp|petlife\.asia/i.test(url) || /^(epark_shopinfo_detail|epark_dental_detail|caloo_hospital_detail|pet_caloo_hospital_detail|petlife_detail)$/.test(site.parser_type || '')
    const isEkiten = /ekiten\.jp/i.test(url) || site.parser_type === 'ekiten_shop_detail'
    const parser_used = isJalan ? 'jalan_spot_detail' : isTabelog ? 'tabelog_detail' : isEparkCaloo ? (site.parser_type || 'epark_caloo_detail') : isEkiten ? 'ekiten_shop_detail' : 'generic_detail_page'
    const classifyTest = (resp: typeof r) => {
      const spot = isJalan ? parseJalanSpot(resp.html, resp.mojibake) : isTabelog ? parseTabelog(resp.html, resp.mojibake) : isEparkCaloo ? parseEparkCaloo(resp.html, resp.mojibake) : isEkiten ? parseEkiten(resp.html, resp.mojibake) : null
      const body = resp.html ? stripTags(resp.html) : ''
      const sn0 = spot ? sanitizeShopName(spot.name, { placesMatched: false }) : null
      const nm = sn0 && sn0.valid ? sn0.name : ''
      const addr = spot ? spot.address : extractAddressLoose(body).address
      const ph = (spot ? spot.phone : extractJpPhone(body)) || ''
      const cat = spot?.category || ''
      let status: 'valid' | 'invalid' | 'fetch_failed' | 'parser_failed'; let reason = ''
      if (!resp.ok || !resp.html) { status = resp.status === 404 ? 'invalid' : 'fetch_failed'; reason = resp.timedOut ? 'timeout' : `取得失敗(HTTP ${resp.status || 'network'})` }
      else if (INVALID_RE.test(body) || (spot && /未存在|掲載されていません|閉店しました|見つかりません|存在しません/.test(spot.invalidReason || ''))) { status = 'invalid'; reason = '該当ページなし' }
      else if (resp.mojibake) { status = 'parser_failed'; reason = '文字化け' }
      else if (nm || ph || addr || cat) { status = 'valid'; reason = '' }
      else { status = 'parser_failed'; reason = body.length < 200 ? '本文が薄い（要レンダリング）' : '抽出できず' }
      return { status, reason, name: nm, address: addr, phone: ph, category: cat }
    }
    let c = classifyTest(r); let rendered = false
    if ((c.status === 'fetch_failed' || c.status === 'parser_failed') && renderMode !== 'static' && renderConfigured()) {
      const rr = await renderPage(url, { waitMs: isTabelog ? 6000 : 4000 })
      if (rr.ok && rr.html) { r = { ok: true, status: rr.status || 200, html: rr.html, charset: 'utf-8', decodeMethod: 'render', mojibake: false, mojibakeRate: 0, timedOut: false } as any; c = classifyTest(r); rendered = true }
    }
    items.push({ url, ok: r.ok, status: r.status, charset: r.charset, mojibake: r.mojibake, valid: c.status === 'valid', name: c.name, address: c.address, phone: c.phone, category: c.category, parser_used, invalidReason: c.status === 'valid' ? '' : `${c.status}: ${c.reason}`, probeStatus: c.status, rendered, saveable: c.status === 'valid' && (!!c.name || (!!c.phone && !!c.address)) } as any)
  }
  // 既知の有効URL（先頭2件＝231369/231370想定）で住所・電話が取れたか
  const known = items.slice(0, 2)
  const addressOk = known.some((i) => !!i.address)
  const phoneOk = known.some((i) => !!i.phone)
  const parserOk = known.some((i) => i.valid)
  return { ok: true, items, summary: { addressOk, phoneOk, parserOk } }
}

function pad(id: number, padding: number): string { const s = String(id); return padding > 0 ? s.padStart(padding, '0') : s }

export interface ProbeResult {
  ok: boolean; siteName: string
  probed: number; valid: number; invalid: number; saved: number; saveError: number
  hot: number; hotA: number; hotB: number; hold: number; excluded: number; imported: number
  alreadyImported: number; importFailed: number
  timeouts: number; dupSkip: number; mojibake: number; fetchFail: number; parserFail: number; consecutiveNotFound: number
  startId: number; fromId: number; toId: number; nextId: number; nextIdBasis: string; probeMode: string; lastFoundId: number | null; lastValidId: number | null
  backfillFrom: number | null; backfillTo: number | null; items: any[]; reason: string; invalidTopReason: string
}

/** 1サイトの連番探索（既定=安全確認モード: 最後にvalidだったIDの次から再開）。DB保存込み。 */
export async function runSequentialProbe(admin: any, mapsKey: string | null, site: any, opts: {
  userId: string | null; runId: string | null; nowIso: string; mode: InjectMode
  forwardCount?: number; backfillCount?: number; startIdOverride?: number; force?: boolean
  probeMode?: 'safe' | 'advance'   // safe=last_valid_id+1 / advance=last_checked_id+1
  dayRemaining: number; autoImportPerRun: number; autoImportPerDay: number; importedToday: number; delayMs: number
  noRender?: boolean   // 一括探索: 重いレンダリングfallback(ScrapingBee~18s)を無効化して高速化
}): Promise<ProbeResult> {
  const probeMode: 'safe' | 'advance' = opts.probeMode || (site.probe_mode === 'advance' ? 'advance' : 'safe')
  const res: ProbeResult = {
    ok: true, siteName: site.name, probed: 0, valid: 0, invalid: 0, saved: 0, saveError: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, alreadyImported: 0, importFailed: 0,
    timeouts: 0, dupSkip: 0, mojibake: 0, fetchFail: 0, parserFail: 0, consecutiveNotFound: 0,
    startId: 0, fromId: 0, toId: 0, nextId: 0, nextIdBasis: '', probeMode, lastFoundId: site.last_found_id ?? null, lastValidId: site.last_valid_id ?? null,
    backfillFrom: null, backfillTo: null, items: [], reason: '', invalidTopReason: '',
  }
  const template: string = site.url_template || ''
  if (!template.includes('{ID}')) { res.ok = false; res.reason = 'url_template に {ID} がありません'; return res }
  const padding = Number(site.id_padding) || 0
  const maxNotFound = Math.max(1, Number(site.max_consecutive_not_found) || 10)
  const forward = Math.max(1, Math.min(Number(opts.forwardCount) || Number(site.forward_scan_count) || 20, 100, opts.dayRemaining))
  const backfill = Math.max(0, Math.min(Number(opts.backfillCount ?? site.backfill_scan_count ?? 5), 20))
  const sameIdRetryLimit = Math.max(1, Number(site.same_id_retry_limit) || 3)
  const invalidRetryIntervalH = Math.max(1, Number(site.invalid_retry_interval_hours) || 24)
  // 再開位置: 指定ID > (安全モード: last_valid_id+1 → last_found_id+1) / (先行モード: current_probe_id → last_checked_id+1) > start_probe_id
  const safeStart = site.last_valid_id != null ? Number(site.last_valid_id) + 1 : (site.last_found_id != null ? Number(site.last_found_id) + 1 : null)
  const advStart = site.current_probe_id != null ? Number(site.current_probe_id) : (site.last_checked_id != null ? Number(site.last_checked_id) + 1 : null)
  const fallbackStart = (Number(site.start_probe_id) || 1)
  const startId = opts.startIdOverride ?? (probeMode === 'safe' ? (safeStart ?? advStart ?? fallbackStart) : (advStart ?? safeStart ?? fallbackStart))
  res.startId = startId; res.fromId = startId
  const startedAt = opts.nowIso
  let consecutiveNotFound = Number(site.consecutive_not_found_count) || 0
  let importedThisRun = 0
  let importedCount = opts.importedToday
  let totalChecked = 0, totalValid = 0, totalInvalid = 0
  let firstUnconfirmed: number | null = null  // 最初の fetch_failed/parser_failed ID（次回はここから再開＝確認漏れを防ぐ）
  const renderMode = String(site.rendering_mode || 'auto')

  // 探索対象IDリスト: 前方20 ＋ 戻り確認(last_checked_id-backfill 〜 last_checked_id)
  const ids: number[] = []
  for (let i = 0; i < forward; i++) ids.push(startId + i)
  if (backfill > 0 && site.last_checked_id != null) {
    const bEnd = Number(site.last_checked_id)
    const bStart = bEnd - backfill + 1
    res.backfillFrom = bStart; res.backfillTo = bEnd
    for (let id = bStart; id <= bEnd; id++) if (id > 0 && !ids.includes(id)) ids.push(id)
  }

  for (const probedId of ids) {
    if (res.probed >= forward + backfill) break
    if (consecutiveNotFound >= maxNotFound && probedId >= startId) {
      res.reason = `not_found ${consecutiveNotFound}連続で前方探索停止`
      // 前方分を打ち切り、戻り確認のみ残す
      if (probedId >= startId) continue
    }
    if (opts.dayRemaining - res.probed <= 0) { res.reason = '1日のURL上限に到達'; break }
    const url = template.replace('{ID}', pad(probedId, padding))
    res.toId = Math.max(res.toId, probedId)

    // 手動force以外はスキップ判定。validは再取得しない。invalidは再確認するが、
    // 同一IDが same_id_retry_limit 回連続invalidで invalid_retry_interval_hours 以内なら一時スキップ（無限ループ防止）。
    if (!opts.force) {
      const { data: lg } = await admin.from('sequential_probe_results').select('valid_page,probe_status,invalid_reason,checked_at').eq('probed_url', url).order('checked_at', { ascending: false }).limit(10)
      const last = lg?.[0]
      const isConfirmedInvalidRow = (x: any) => x && x.valid_page === false && (x.probe_status === 'invalid' || /^invalid/.test(String(x.invalid_reason || '')))
      if (last) {
        if (last.valid_page === true) { res.dupSkip++; continue }            // validは再取得しない
        // 確認済みinvalid（404/不存在）が連続している時だけ一時スキップ。fetch_failed/parser_failed は常に再試行（飛ばさない）。
        if (isConfirmedInvalidRow(last)) {
          const invalidStreak = (() => { let c = 0; for (const x of (lg || [])) { if (isConfirmedInvalidRow(x)) c++; else break } return c })()
          const ageH = (Date.now() - Date.parse(last.checked_at)) / 3600000
          if (invalidStreak >= sameIdRetryLimit && ageH < invalidRetryIntervalH) { res.dupSkip++; continue }
        }
      }
    }

    let r = await fetchDecoded(url)
    await new Promise((rs) => setTimeout(rs, Math.max(200, opts.delayMs)))
    res.probed++; totalChecked++

    const isJalan = (site.parser_type === 'jalan_spot_detail') || /jalan\.net/i.test(url)
    const isTabelog = (site.parser_type === 'tabelog_detail') || /tabelog\.com/i.test(url)
    const isEparkCaloo = /epark\.jp|haisha-yoyaku\.jp|caloo\.jp|petlife\.asia/i.test(url) || /^(epark_shopinfo_detail|epark_dental_detail|caloo_hospital_detail|pet_caloo_hospital_detail|petlife_detail)$/.test(site.parser_type || '')
    const isEkiten = /ekiten\.jp/i.test(url) || site.parser_type === 'ekiten_shop_detail'
    const parserUsed = isJalan ? 'jalan_spot_detail' : isTabelog ? 'tabelog_detail' : isEparkCaloo ? (site.parser_type || 'epark_caloo_detail') : isEkiten ? 'ekiten_shop_detail' : 'generic_detail_page'

    // ===== 4分類: valid / invalid(404/不存在) / fetch_failed(403,429,5xx,timeout,network) / parser_failed(200だが抽出不可・文字化け) =====
    const classify = (resp: typeof r): { status: 'valid' | 'invalid' | 'fetch_failed' | 'parser_failed'; reason: string; spot: any; name: string; address: string; phone: string; category: string; bodyAll: string } => {
      const spot = isJalan ? parseJalanSpot(resp.html, resp.mojibake) : isTabelog ? parseTabelog(resp.html, resp.mojibake) : isEparkCaloo ? parseEparkCaloo(resp.html, resp.mojibake) : isEkiten ? parseEkiten(resp.html, resp.mojibake) : null
      const bodyAll = resp.html ? stripTags(resp.html) : ''
      const sn = sanitizeShopName(spot ? spot.name : '', { placesMatched: false })
      const name = sn.valid ? sn.name : ''
      const address = spot ? spot.address : extractAddressLoose(bodyAll).address
      const phone = (spot ? spot.phone : extractJpPhone(bodyAll)) || ''
      const category = spot?.category || ''
      // fetch層
      if (!resp.ok || !resp.html) {
        if (resp.status === 404) return { status: 'invalid', reason: 'HTTP 404（ページなし）', spot, name, address, phone, category, bodyAll }
        return { status: 'fetch_failed', reason: resp.timedOut ? 'timeout' : `取得失敗(HTTP ${resp.status || 'network'})`, spot, name, address, phone, category, bodyAll }
      }
      // 明確なnot-found表記（200でも該当ページなし）→ invalid
      if (INVALID_RE.test(bodyAll) || (spot && /未存在|掲載されていません|閉店しました|見つかりません|存在しません/.test(spot.invalidReason || ''))) {
        return { status: 'invalid', reason: '該当ページなし（not found表記）', spot, name, address, phone, category, bodyAll }
      }
      // 文字化け → parser_failed（invalid扱いしない・retry/render対象）
      if (resp.mojibake) return { status: 'parser_failed', reason: '文字化けで抽出不可', spot, name, address, phone, category, bodyAll }
      // 抽出成功（店名 or 電話 or 住所 or カテゴリ のいずれか）→ valid
      if (name || phone || address || category) return { status: 'valid', reason: '', spot, name, address, phone, category, bodyAll }
      // 200だが本文薄い/抽出できず → parser_failed（invalid扱いしない）
      return { status: 'parser_failed', reason: bodyAll.length < 200 ? '本文が薄い（要レンダリング）' : '店名/住所/電話が抽出できず', spot, name, address, phone, category, bodyAll }
    }

    let c = classify(r)
    // ===== レンダリング fallback: fetch_failed/parser_failed かつ rendering_mode!=static かつ レンダリングAPI設定あり =====
    let rendered = false
    if (!opts.noRender && (c.status === 'fetch_failed' || c.status === 'parser_failed') && renderMode !== 'static' && renderConfigured()) {
      const rr = await renderPage(url, { waitMs: isTabelog ? 6000 : 4000 })
      if (rr.ok && rr.html) {
        rendered = true
        r = { ok: true, status: rr.status || 200, html: rr.html, charset: 'utf-8', decodeMethod: 'render', mojibake: false, mojibakeRate: 0, timedOut: false } as any
        c = classify(r)
      }
    }

    if (r.timedOut) res.timeouts++
    if (r.mojibake) res.mojibake++
    const { status, spot, name, address, phone, category, bodyAll } = c
    const nameValid = !!name

    let savedCandidateId: string | null = null
    let createdCaseId: string | null = null

    // ===== invalid / fetch_failed / parser_failed の記録（cursorは invalid だけ進める） =====
    if (status !== 'valid') {
      const isConfirmedInvalid = status === 'invalid'
      if (isConfirmedInvalid) { res.invalid++; totalInvalid++; consecutiveNotFound++ }
      else { if (status === 'fetch_failed') res.fetchFail++; else res.parserFail++; if (firstUnconfirmed == null) firstUnconfirmed = probedId }  // fetch/parser失敗は確認漏れ＝次回ここから再開
      await admin.from('sequential_probe_results').insert({
        source_site_id: site.id, run_id: opts.runId, probed_id: probedId, probed_url: url, http_status: r.status,
        valid_page: false, invalid_reason: `${status}: ${c.reason}`, probe_status: status, charset_detected: r.charset, decode_method: r.decodeMethod,
        decode_success: !r.mojibake, mojibake_detected: r.mojibake, mojibake_rate: Math.round((r.mojibakeRate || 0) * 1000) / 1000,
        extracted_name: name || null, parser_used: parserUsed, error_message: status === 'fetch_failed' ? c.reason : null, checked_at: opts.nowIso,
      }).then(() => {}, () => {})
      if (res.items.length < 40) res.items.push({ probedId, url, valid: false, status: r.status, charset: r.charset, mojibake: r.mojibake, invalidReason: `${status}: ${c.reason}`, probeStatus: status, rendered, parserUsed, name, phone, address } as any)
      continue
    }

    // valid: 判定して保存
    res.valid++; totalValid++; res.lastFoundId = probedId; res.lastValidId = probedId; consecutiveNotFound = 0
    const official = spot?.official || ''
    const hasOpen = OPEN_RE.test(bodyAll)
    const newness_type = hasOpen ? 'possible_new_open' : 'source_new_listing'
    const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || /[市区町村]/.test(address))
    // 観光名所/公共施設のみ（電話なし）は営業対象外
    const facilityish = FACILITY_RE.test(`${name} ${category}`)
    const excludedFacility = facilityish && !(phone && isJapanPhone(phone))

    const chP = detectChain(name)
    const bigP0 = detectBigOrPublic(`${name} ${address} ${category}`)
    const bigStrongP = detectBigOrPublicStrong(name)  // 大手チェーン/量販/モール（元祖ニュータンタンメン/はなまるうどん等）
    const multiP = detectMultiStore(`${name} ${bodyAll.slice(0, 300)}`)
    const bigP = { exclude: bigP0.exclude || bigStrongP.exclude || multiP.exclude }
    const sc = scoreCandidate({
      source: 'regional_media', isJapan, hasShopName: nameValid, hasPhone: !!phone && isJapanPhone(phone), hasArea: !!address,
      hasOpeningDate: hasOpen, isFuture: false, igNew: false, regionalNew: false, newListing: true,
      placesMatched: false, hasOfficial: !!official,
      isChain: chP.definite || bigP.exclude, chainSuspect: chP.suspect && !chP.definite, isOrg: excludedFacility || bigP.exclude, isEventRecruit: false, isForeign: isForeignAddress(address), isDup: false, reviewMany: false,
    }, opts.mode)
    let { temperature, hot_tier } = tierToTemperature(sc.tier)
    if (bigP.exclude) { temperature = 'EXCLUDED'; hot_tier = null }  // 道の駅/産直/大型施設/公共/大手 は営業対象外
    // 新方針: HOTは電話＋住所が必須。店名未確定でも電話＋住所＋新規掲載根拠ありなら HOT-B（営業前に店名確認）
    let recommendedStatus: string = sc.tier
    const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone)
    let nameUnconfirmedHot = false
    let hotBlock = ''
    if (temperature === 'HOT') {
      if (!phoneOk) { hotBlock = '電話番号未取得'; temperature = 'HOLD'; hot_tier = null; recommendedStatus = 'HOLD' }
      else if (!address) { hotBlock = '住所未取得'; temperature = 'HOLD'; hot_tier = null; recommendedStatus = 'HOLD' }
      else if (!nameValid) { hot_tier = 'B'; nameUnconfirmedHot = true; recommendedStatus = 'HOT_B' }  // 店名未確定でもHOT-B
    } else if (temperature === 'HOLD' && !nameValid && phoneOk && !!address && !chP.definite && !excludedFacility && !isForeignAddress(address)) {
      temperature = 'HOT'; hot_tier = 'B'; nameUnconfirmedHot = true; recommendedStatus = 'HOT_B'  // 店名未確定HOLD→電話+住所+新規掲載ありでHOT-B昇格
    }
    // エキテン: 公開日(掲載日。開業日ではない)が直近7日以内のみ新規掲載候補としてHOT-B。8日以上前/取得不可は対象外。
    let ekitenPubDays: number | null = null
    if (isEkiten) {
      ekitenPubDays = daysSinceDate(spot?.published)
      if (ekitenPubDays == null) { temperature = 'HOLD'; hot_tier = null; recommendedStatus = 'HOLD'; hotBlock = '公開日取得不可' }
      else if (ekitenPubDays > 7) { temperature = 'EXCLUDED'; hot_tier = null; recommendedStatus = 'EXCLUDED'; hotBlock = `公開日${ekitenPubDays}日前(8日以上前)` }
      else if (phoneOk && address && !bigP.exclude && !chP.definite) { temperature = 'HOT'; hot_tier = 'B'; recommendedStatus = 'HOT_B' }
      else { temperature = 'HOLD'; hot_tier = null; recommendedStatus = 'HOLD'; hotBlock = !phoneOk ? '電話番号未取得' : !address ? '住所未取得' : '要確認' }
    }
    if (temperature === 'HOT') { res.hot++; if (hot_tier === 'A') res.hotA++; else res.hotB++ }
    else if (temperature === 'EXCLUDED') res.excluded++; else res.hold++

    const rmChecks: HotCheck[] = [
      { key: 'has_japan', label: '日本国内', ok: isForeignAddress(address) ? false : (isJapan ? true : null), reasonKey: 'not_japan' },
      { key: 'has_shop_name', label: '店名/施設名あり', ok: !!name, reasonKey: 'shop_name_missing' },
      { key: 'has_area', label: '住所あり', ok: !!address, reasonKey: 'address_missing', value: address || undefined },
      { key: 'has_phone', label: '日本の電話番号あり', ok: (phone && isJapanPhone(phone)) ? true : false, reasonKey: 'phone_missing', value: phone || undefined },
      { key: 'has_newness', label: '新規掲載候補', ok: true, reasonKey: 'newness_missing' },
      { key: 'has_opening_date', label: '新規オープン根拠', ok: hasOpen ? true : null, reasonKey: 'opening_date_missing' },
    ]
    const hotReject = buildHotReject({ source: 'regional_media', temperature, confidence: sc.score, checks: rmChecks })
    const finalName = nameValid ? name : '店名未確定'
    const holdNote = nameUnconfirmedHot ? '店名未確定だが電話・住所・新規掲載ありのため営業可能候補(HOT-B)。営業前に店名確認推奨。' : (hotBlock ? `${parserUsed}で${hotBlock}のため自動投入不可（要手動確認）。` : '')
    const payload: any = {
      name: finalName, address: address || null, industry: category || null, phone_number: phone || null, website_url: official || null,
      source: 'sequential_id_probe', lead_source: 'sequential_id_probe', source_type: 'AI自動投入(連番探索)',
      source_site_type: 'sequential_id_probe', parser_used: parserUsed, source_media_family: site.media_family || null, source_site_name: site.name,
      source_detail_url: url, source_list_url: template, probed_id: probedId, probed_url: url, probe_valid: true, probe_status: `HTTP ${r.status}`,
      charset_detected: r.charset, mojibake_detected: false,
      search_title: finalName.slice(0, 300), search_snippet: bodyAll.slice(0, 300), candidate_block_text_short: bodyAll.slice(0, 300),
      newness_type, regional_media_newness_reason: `連番探索(${parserUsed}) ID=${probedId}「${finalName}」${hasOpen ? '・OPEN表記あり' : '・新規掲載候補'} / ${holdNote}${sc.reason}`,
      first_discovered_at: opts.nowIso, regional_media_detected_at: opts.nowIso,
      lead_temperature: temperature, hot_tier, recommended_status: recommendedStatus, should_exclude_from_call_list: temperature === 'EXCLUDED',
      name_unconfirmed_hot: nameUnconfirmedHot, phone_source: phone ? 'detail_page' : null,
      ...(isEkiten ? { source_published_date: spot?.published || null, source_updated_date: spot?.updated || null, source_date_type: 'ekiten_published_date' } : {}),
      owner_reachability_score: phone ? 65 : 30, auto_import_reason: temperature === 'HOT' ? sc.reason : null,
      ai_comment: isEkiten ? `${ekitenPubDays != null ? `エキテン公開日 ${spot?.published}（${ekitenPubDays}日前${ekitenPubDays <= 7 ? '・直近7日以内の新規掲載候補' : '・8日以上前'}）。※公開日は開業日ではなくエキテン掲載公開日。` : 'エキテン公開日が取得できず。'}${holdNote ? holdNote + ' ' : ''}${sc.reason}` : `${holdNote}${sc.reason}`,
      extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null, extracted_industry: category || null, extracted_area: address || null, extracted_official_url: official || null,
      hot_reject_reasons: hotReject.hot_reject_reasons, hot_reject_summary: hotReject.hot_reject_summary, hot_check_result: hotReject.hot_check_result,
      hot_missing_requirements: hotReject.hot_missing_requirements, hot_blocking_reason: hotReject.hot_blocking_reason, hot_required_score: hotReject.hot_required_score,
      match_confidence: sc.score, last_seen_at: opts.nowIso, source_run_id: opts.runId,
    }
    const qr = computeQuality(payload)
    payload.quality_score = qr.score; payload.quality_grade = qr.grade; payload.industry_category = qr.category
    payload.dedup_key = qr.dedupKey; payload.quality_flags = qr.flags; payload.phone_pref_match = qr.phoneMatch; payload.quality_computed_at = opts.nowIso
    const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_detail_url', url).limit(1)
    let candidateId: string | null = exC?.[0]?.id || null
    if (!candidateId && phone) { const { data: byPhone } = await admin.from('lead_candidates').select('id').eq('phone_number', phone).limit(1); candidateId = byPhone?.[0]?.id || null }
    const alreadyImported = !!exC?.[0]?.imported_to_cases
    if (candidateId) { const { error } = await admin.from('lead_candidates').update(payload).eq('id', candidateId); if (error) res.saveError++; else res.saved++ }
    else { const { data: ins, error } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: opts.nowIso, imported_to_cases: false, created_by_id: opts.userId }).select('id').single(); if (error) res.saveError++; else res.saved++; candidateId = ins?.id || null }
    savedCandidateId = candidateId

    if (temperature === 'HOT' && alreadyImported) res.alreadyImported++
    // 自動投入は HOT（電話＋住所が揃えば店名未確定でも可。電話なし/住所なしは temperature が HOLD に降格済み）
    const effectiveTier = nameUnconfirmedHot ? 'HOT_B' : sc.tier
    if (temperature === 'HOT' && autoImportAllowed(effectiveTier as any, opts.mode) && address && phoneOk && candidateId && !alreadyImported && importedCount < opts.autoImportPerDay && importedThisRun < opts.autoImportPerRun) {
      const { data: created, error: caseErr } = await admin.from('cases').insert({ name: finalName, address: address || '', phone1: phone, industry: category || null, status: DEFAULT_STATUS, priority: sc.priority === 'high' ? '高' : '中', hp1: official || null, source_urls: url, memo: `【AI自動投入 / 連番URL探索 / ${nameUnconfirmedHot ? 'HOT_B(店名未確定)' : sc.tier}】取得元: ${site.name}\nID=${probedId}\nURL: ${url}\n電話: ${phone || '—'}\n住所: ${address || '—'}\n連番URL探索で新規存在確認${nameUnconfirmedHot ? '\n※営業前に店名確認推奨' : ''}`, created_by_id: opts.userId }).select('id').single()
      if (caseErr) res.importFailed = (res.importFailed || 0) + 1
      if (created?.id) { createdCaseId = created.id; await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: opts.nowIso, imported_case_id: created.id }).eq('id', candidateId); res.imported++; importedCount++; importedThisRun++ }
    }
    await admin.from('sequential_probe_results').insert({
      source_site_id: site.id, run_id: opts.runId, probed_id: probedId, probed_url: url, http_status: r.status, valid_page: true, invalid_reason: null, probe_status: 'valid',
      charset_detected: r.charset, decode_method: r.decodeMethod, decode_success: true, mojibake_detected: false, mojibake_rate: Math.round((r.mojibakeRate || 0) * 1000) / 1000,
      extracted_name: name || null, extracted_address: address || null, extracted_phone: phone || null, parser_used: parserUsed,
      saved_candidate_id: savedCandidateId, created_case_id: createdCaseId, checked_at: opts.nowIso,
    }).then(() => {}, () => {})
    if (res.items.length < 40) res.items.push({ probedId, url, valid: true, status: r.status, charset: r.charset, name: finalName, phone, address, category, newness_type, parserUsed, probeStatus: 'valid', rendered, saveResult: 'success', temperature: hot_tier ? `HOT-${hot_tier}` : temperature } as any)
  }

  const lastChecked = res.toId || (startId + forward - 1)
  // 最新のvalid ID（今回 or 既存）
  const newLastValid = res.lastValidId ?? site.last_valid_id ?? null
  const newLastFound = res.lastFoundId ?? site.last_found_id ?? null
  // 次回開始ID:
  //  - fetch_failed/parser_failed が今回あれば、その最小ID（確認漏れ）から再開＝飛ばさない
  //  - 全て確認済み(valid/invalid)なら 最後に確認したID+1
  //  - 安全モードは「最後にvalidだったID+1」を下限に（invalid範囲も飛ばさない）
  let nextId: number; let nextIdBasis: string
  if (firstUnconfirmed != null) {
    nextId = firstUnconfirmed
    nextIdBasis = `fetch/parser失敗ID(${firstUnconfirmed})が未確認のため、そこから再開（飛ばさない）`
  } else if (probeMode === 'safe') {
    if (newLastValid != null) { nextId = Number(newLastValid) + 1; nextIdBasis = `${lastChecked}まで確認済み・最後に有効だったID(${newLastValid})の次から` }
    else if (newLastFound != null) { nextId = Number(newLastFound) + 1; nextIdBasis = `最後に見つかったID(${newLastFound})の次から` }
    else { nextId = lastChecked + 1; nextIdBasis = `${lastChecked}まで確認済み（有効IDなし）` }
  } else { nextId = lastChecked + 1; nextIdBasis = `先行探索モード（${lastChecked}まで確認済み・+1）` }
  res.nextId = nextId; res.nextIdBasis = nextIdBasis; res.consecutiveNotFound = consecutiveNotFound
  // invalid の主理由（最多）
  const reasonCounts: Record<string, number> = {}
  for (const it of res.items) { if (!it.valid && it.invalidReason) reasonCounts[it.invalidReason] = (reasonCounts[it.invalidReason] || 0) + 1 }
  res.invalidTopReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  if (!res.reason) res.reason = res.valid > 0 ? `OK（valid ${res.valid}/probed ${res.probed}）` : `valid 0（probed ${res.probed}・invalid${res.invalid}/fetch失敗${res.fetchFail}/parser失敗${res.parserFail}・${res.invalidTopReason || (res.fetchFail > 0 ? 'fetch失敗（要レンダリング/再試行）' : 'ページ未存在')}）`
  // 差分巡回: fetch_failed / parser_failed は invalid扱いせず retry_ids に蓄積（再試行対象）。validになったIDは除去。
  const fetchFailedIds: number[] = res.items.filter((i: any) => i.probeStatus === 'fetch_failed').map((i: any) => Number(i.probedId)).filter((n: number) => !Number.isNaN(n))
  const parserFailedIds: number[] = res.items.filter((i: any) => i.probeStatus === 'parser_failed').map((i: any) => Number(i.probedId)).filter((n: number) => !Number.isNaN(n))
  const validIdSet = new Set(res.items.filter((i: any) => i.valid).map((i: any) => Number(i.probedId)))
  const prevRetry: number[] = Array.isArray(site.retry_ids) ? site.retry_ids.map(Number).filter((n: number) => !Number.isNaN(n)) : []
  const retryIds = Array.from(new Set([...prevRetry, ...fetchFailedIds, ...parserFailedIds])).filter((id) => !validIdSet.has(id)).slice(-200)
  await admin.from('source_sites').update({
    current_probe_id: nextId, next_start_id: nextId, last_checked_id: lastChecked, last_found_id: res.lastFoundId ?? site.last_found_id ?? null,
    last_valid_id: res.lastValidId ?? site.last_valid_id ?? null, last_invalid_id: res.invalid > 0 ? res.toId : (site.last_invalid_id ?? null),
    fetch_failed_ids: fetchFailedIds.slice(0, 100), parser_failed_ids: parserFailedIds.slice(0, 100), retry_ids: retryIds,
    last_success_at: res.valid > 0 ? opts.nowIso : (site.last_success_at ?? null), last_error_at: (res.fetchFail > 0 || res.parserFail > 0) ? opts.nowIso : (site.last_error_at ?? null),
    last_probe_started_at: startedAt, last_probe_finished_at: opts.nowIso, consecutive_not_found_count: consecutiveNotFound,
    total_checked_count: (Number(site.total_checked_count) || 0) + totalChecked, total_valid_count: (Number(site.total_valid_count) || 0) + totalValid, total_invalid_count: (Number(site.total_invalid_count) || 0) + totalInvalid,
    probe_result_summary: `今回${res.fromId}〜${res.toId} / valid${res.valid} invalid${res.invalid} fetch失敗${res.fetchFail} parser失敗${res.parserFail} / lead保存${res.saved} cases${res.imported} / 次回ID${nextId}（${nextIdBasis}）`.slice(0, 200),
    last_crawled_at: opts.nowIso, updated_at: opts.nowIso,
  }).eq('id', site.id).then(() => {}, () => {})
  return res
}

/** 全 sequential_id_probe サイトを実行（連番探索タブ用） */
export async function runAllSequentialProbes(admin: any, mapsKey: string | null, rawSettings: any, userId: string | null) {
  const s = rawSettings || {}
  const mode: InjectMode = (s.aiInjectMode === 'strict' || s.aiInjectMode === 'aggressive') ? s.aiInjectMode : 'standard'
  const nowIso = new Date().toISOString()
  const counts = { sources: 0, probed: 0, valid: 0, invalid: 0, saved: 0, saveError: 0, hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, alreadyImported: 0, importFailed: 0, mojibake: 0, fetchFail: 0, parserFail: 0, phoneYes: 0, addressYes: 0, dupSkip: 0, timeouts: 0 }
  const debug: any = { siteResults: [] as any[] }
  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: 'sequential_probe', status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null
  try {
    const { data: sites } = await admin.from('source_sites').select('*').eq('source_type', 'sequential_id_probe').eq('is_active', true).limit(50)
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: probedTodayCount } = await admin.from('sequential_probe_results').select('id', { count: 'exact', head: true }).gte('checked_at', startToday.toISOString())
    let dayRemaining = Math.max(0, (Number(s.probeDailyCap) || 500) - (probedTodayCount || 0))
    const { count: importedTodayCount } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', startToday.toISOString())
    const autoImportPerRun = Math.max(1, Number(s.autoImportPerRun) || 50)
    const autoImportPerDay = Math.max(1, Number(s.autoImportPerDay) || 200)
    // 「全ソースを確実に追う」: ソースを並列実行（別ドメインなので同時でもレート問題なし）。各ソースは
    // 内部で delay を入れつつ forwardCount 件を探索。レンダリングfallbackは無効(noRender)で高速化。
    // 並列なので全体時間 ≒ 最も遅い1ソース。1ソースがハングしても per-source ハード上限で全体を止めない。
    const bulkForward = Math.max(1, Math.min(30, Number(s.forwardCount) || 15))
    const bulkDelay = Math.max(150, Math.min(800, Number(s.delayMs) || 400))
    const perSiteCapMs = Math.max(8000, Math.min(40000, Number(s.perSiteCapMs) || 26000))  // 1ソース上限（cursorはこの範囲で更新される）
    const activeSites = (sites || []).filter((site: any) => site.probe_enabled !== false)
    const perSourceDay = Math.max(bulkForward, Math.floor(dayRemaining / Math.max(1, activeSites.length)))
    const results: any[] = await Promise.all(activeSites.map((site: any) => Promise.race([
      runSequentialProbe(admin, mapsKey, site, {
        userId, runId, nowIso, mode,
        forwardCount: bulkForward, backfillCount: 0, startIdOverride: undefined, force: !!s.force,
        probeMode: s.probeMode === 'advance' ? 'advance' : (site.probe_mode === 'advance' ? 'advance' : 'safe'),
        dayRemaining: perSourceDay, autoImportPerRun, autoImportPerDay, importedToday: importedTodayCount || 0, delayMs: bulkDelay, noRender: true,
      }).then((r: any) => ({ ...r, __site: site })),
      new Promise<any>((rs) => setTimeout(() => rs({ __timeout: true, __site: site }), perSiteCapMs)),
    ])))
    for (const pr of results) {
      const site = pr.__site
      if (pr.__timeout) { (debug as any).siteTimeout = ((debug as any).siteTimeout || 0) + 1; debug.siteResults.push({ site: site?.name, timeout: true }); continue }
      counts.sources++
      counts.probed += pr.probed; counts.valid += pr.valid; counts.invalid += pr.invalid; counts.saved += pr.saved; counts.saveError += pr.saveError
      counts.hot += pr.hot; counts.hotA += pr.hotA; counts.hotB += pr.hotB; counts.hold += pr.hold; counts.excluded += pr.excluded; counts.imported += pr.imported
      counts.alreadyImported += pr.alreadyImported; counts.importFailed += pr.importFailed
      counts.mojibake += pr.mojibake; counts.fetchFail += pr.fetchFail; counts.parserFail += pr.parserFail; counts.timeouts += pr.timeouts; counts.dupSkip += pr.dupSkip
      counts.phoneYes += pr.items.filter((i: any) => i.valid && i.phone).length
      counts.addressYes += pr.items.filter((i: any) => i.valid && i.address).length
      debug.siteResults.push(pr)
      const allInvalid = pr.probed > 0 && pr.valid === 0
      const hadError = pr.fetchFail > 0 || pr.timeouts > 0 || pr.mojibake > 0 || pr.parserFail > 0
      if (hadError || allInvalid) {
        const errType = pr.timeouts > 0 ? 'timeout' : pr.fetchFail > 0 ? 'fetch_fail' : pr.parserFail > 0 ? 'parser_fail' : pr.mojibake > 0 ? 'mojibake' : 'all_invalid'
        const errMsg = pr.timeouts > 0 ? `タイムアウト${pr.timeouts}件` : pr.fetchFail > 0 ? `fetch失敗${pr.fetchFail}件（要レンダリング/再試行）` : pr.parserFail > 0 ? `parser失敗${pr.parserFail}件（要確認）` : pr.mojibake > 0 ? `文字化け${pr.mojibake}件` : `今回validなし（${pr.probed}件中0件）`
        await admin.from('source_sites').update({ review_flag: true, last_error_type: errType, last_error_message: errMsg, updated_at: nowIso }).eq('id', site.id).then(() => {}, () => {})
      } else if (pr.valid > 0) {
        await admin.from('source_sites').update({ review_flag: false, last_error_type: null, last_error_message: null }).eq('id', site.id).then(() => {}, () => {})
      }
    }
    // 有効ソース0件は「成功」にしない（探索対象なしを明示）
    const noActive = counts.sources === 0
    await admin.from('auto_lead_runs').update({ status: noActive ? 'error' : 'success', finished_at: new Date().toISOString(), error_message: noActive ? '有効な連番URL探索ソースがありません（先にソースを有効化してください）' : null, search_queries_count: counts.sources, fetched_count: counts.valid, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded, imported_count: counts.imported }).eq('id', runId).then(() => {}, () => {})
    return { ok: true, runId, noActiveSources: noActive, ...counts, debug }
  } catch (e: any) {
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: String(e?.message || e) }).eq('id', runId).then(() => {}, () => {})
    throw e
  }
}

/** 既存の連番探索候補（連番探索候補/店名未確定）を source_detail_url から再取得し、正式店名・電話・住所を再抽出して更新。
 *  cases投入済みなら cases 側の店名も更新。tabelog/jalan を対象。 */
export async function recorrectProbeNames(admin: any, opts: { limit?: number; nowIso: string }): Promise<{ scanned: number; updated: number; held: number; caseUpdated: number; samples: any[] }> {
  const limit = Math.min(500, opts.limit || 200)
  const { data: rows } = await admin.from('lead_candidates')
    .select('id,name,source_detail_url,phone_number,address,imported_to_cases,imported_case_id,lead_temperature')
    .eq('lead_source', 'sequential_id_probe')
    .or('name.eq.連番探索候補,name.eq.店名未確定,name.is.null')
    .limit(limit)
  let scanned = 0, updated = 0, held = 0, caseUpdated = 0
  const samples: any[] = []
  for (const row of (rows || [])) {
    scanned++
    const url: string = row.source_detail_url || ''
    if (!url) continue
    const isJalan = /jalan\.net/i.test(url)
    const isTabelog = /tabelog\.com/i.test(url)
    if (!isJalan && !isTabelog) continue
    const r = await fetchDecoded(url)
    await new Promise((rs) => setTimeout(rs, 400))
    if (!r.ok || !r.html || r.mojibake) continue
    const spot = isJalan ? parseJalanSpot(r.html, r.mojibake) : parseTabelog(r.html, r.mojibake)
    const sn = sanitizeShopName(spot.name, { placesMatched: false })
    const newName = sn.valid ? sn.name : ''
    const newPhone = spot.phone || row.phone_number || null  // 食べログ詳細ページ由来を優先、無ければ既存維持
    const newAddr = spot.address || row.address || null
    const u: any = { parser_used: isJalan ? 'jalan_spot_detail' : 'tabelog_detail', source_detail_url: url }
    if (newName) {
      u.name = newName; u.extracted_shop_name = newName; u.search_title = newName.slice(0, 300)
      if (spot.phone) { u.phone_number = spot.phone; u.extracted_phone = spot.phone }
      if (spot.address) { u.address = spot.address; u.extracted_address = spot.address; u.extracted_area = spot.address }
      // 新方針: 電話＋住所が揃えばHOT-B以上（店名ありなら通常HOT）。電話/住所欠けはHOLD
      const phoneOk = !!newPhone && isValidJpPhone(String(newPhone))
      if (!(phoneOk && newAddr)) { u.recommended_status = 'HOLD'; if (row.lead_temperature === 'HOT') { u.lead_temperature = 'HOLD'; u.hot_tier = null } }
      await admin.from('lead_candidates').update(u).eq('id', row.id)
      updated++
      if (row.imported_to_cases && row.imported_case_id) {
        const cu: any = { name: newName }
        if (spot.phone) cu.phone1 = spot.phone
        if (spot.address) cu.address = spot.address
        await admin.from('cases').update(cu).eq('id', row.imported_case_id).then(() => {}, () => {})
        caseUpdated++
      }
      if (samples.length < 10) samples.push({ url, name: newName, phone: newPhone, address: newAddr, parser_used: u.parser_used })
    } else {
      // 再取得でも店名が取れない → 店名未確定。電話＋住所あれば HOT-B、無ければHOLD（新方針）
      u.name = '店名未確定'
      if (spot.phone) { u.phone_number = spot.phone; u.extracted_phone = spot.phone }
      if (spot.address) { u.address = spot.address; u.extracted_address = spot.address }
      const phoneOk = !!newPhone && isValidJpPhone(String(newPhone))
      if (phoneOk && newAddr) {
        u.lead_temperature = 'HOT'; u.hot_tier = 'B'; u.recommended_status = 'HOT_B'; u.name_unconfirmed_hot = true
        u.ai_comment = `${isTabelog ? 'tabelog_detail' : 'jalan_spot_detail'}: 店名未確定だが電話・住所ありのため営業可能候補(HOT-B)。営業前に店名確認推奨。`
        updated++
      } else {
        u.recommended_status = 'HOLD'; u.name_unconfirmed_hot = false
        if (row.lead_temperature === 'HOT') { u.lead_temperature = 'HOLD'; u.hot_tier = null }
        u.ai_comment = `${isTabelog ? 'tabelog_detail' : 'jalan_spot_detail'}再取得でも店名抽出失敗（${sn.reason}・${!phoneOk ? '電話なし' : '住所なし'}でHOLD）`
        held++
      }
      await admin.from('lead_candidates').update(u).eq('id', row.id)
    }
  }
  return { scanned, updated, held, caseUpdated, samples }
}

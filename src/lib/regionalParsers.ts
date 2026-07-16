// ============================================================
// 地域メディア巡回の汎用パーサー（サーバー専用）
//  - parser_type の自動判定（記事型/店舗ディレクトリ型/マーケットプレイス型/汎用本文スキャン）
//  - DOMブロック（カード/リスト/記事）単位で新店候補を抽出（記事リンクが無くても本文/カードから候補化）
//  - HORBY等の検索結果・店舗カード型サイトに対応
// 記事本文・HTML全文は保存しない（候補ブロックは300文字以内の抜粋のみ）。
// ============================================================
import { extractOpenDateFromTitle, type OpenDate } from './directoryParser.js'
import { extractAddressLoose, prefectureFromCity } from './enrichProfile.js'
import { isJapanPhone } from './japanFilter.js'
import { classifyIndustry } from './industry.js'

export type ParserType = 'openclose_article' | 'local_directory_new_listing' | 'marketplace_listing' | 'generic_page_text_scan' | 'horby_new_salon'

// 新店シグナル（強）。店舗自体の新規性。
const NEWNESS_STRONG = /(新規(?!メニュー|商品|サービス)|ニューオープン|NEW(?:\s?OPEN)?|新着|新規掲載|新規登録|新規オープン|プレオープン|グランドオープン|移転オープン|近日オープン|本日オープン|オープン|開店|開業|開院|\d{1,2}月\d{1,2}日\s?(?:OPEN|オープン|開店|開業)|20\d{2}年\d{1,2}月\s?(?:OPEN|オープン))/
// 新店シグナル（弱）
const NEWNESS_WEAK = /(掲載開始|新しく掲載|新店舗|新店|リニューアル|店舗表示)/
// 新店ではない（除外）
const NEWNESS_EXCLUDE = /(新メニュー|新商品|新サービス|キャンペーン|イベント|フェア|求人|スタッフ募集|アルバイト|バイト募集|周年|クーポン|ポップアップ|pop-?up|セール|福袋)/i

// 店名として不適切（サイト名/カテゴリ名/記事一覧見出し/説明文）
const BAD_SHOP_NAME_RE = /(ニューオープン情報|新店情報|開店情報|閉店情報|開店・閉店|店舗に関するニュース|サイトマップ|地域情報サイト|一覧|まとめ|ブログ|ニュース|毎日発信|情報を発信|を発信|記事を開く|記事|速報|グルメブログ|求人情報|駐車場|検索結果|カテゴリ|のお店|食べログ|ホットペッパー|ぐるなび|Retty|公式サイト|トップページ|ホーム|について|とは|話題の|おすすめ|特集|ランキング|レビュー|カウンター|今日[:：]|昨日[:：]|累計|姉妹サイト|広告掲載|広告のご案内|アクセスランキング|人気記事|関連記事|コメント|サイドバー|フッター|ヘッダー|メニュー)/

/** 店名を整形・検証。サイト名/カテゴリ/記事一覧見出し/説明文は無効（placesMatched時は長い正式名も許可）。 */
export function sanitizeShopName(raw: string, opts: { placesMatched?: boolean } = {}): { name: string; valid: boolean; reason: string } {
  const original = String(raw || '').trim()
  if (!original) return { name: '', valid: false, reason: '店名なし' }
  // 元文字列にサイト名/カテゴリ/メディア説明の語が含まれていれば店名ではない
  if (BAD_SHOP_NAME_RE.test(original)) return { name: '', valid: false, reason: 'サイト名/カテゴリ名/記事一覧見出しのため店名未確定' }
  // 軽い整形: 先頭【タグ】除去・前後の引用符除去・末尾のOPEN文言/句読点除去
  let s = original.replace(/^【[^】]*】\s*/, '').replace(/^[「『”"]|[」』”"]$/g, '').trim()
  s = s.replace(/(が)?(新規|ニュー|グランド|プレ|移転)?オープン(しました|します|予定|のお知らせ)?[^\n]*$/i, '')
    .replace(/(が)?(本日|近日|まもなく)?(開店|開業|開院)(しました|します|予定)?[^\n]*$/, '')
    .replace(/[、。!！\s]+$/, '').replace(/^[-–—|｜:：・　\s]+/, '').trim()
  if (!s) s = original.replace(/^【[^】]*】\s*/, '').replace(/^[「『”"]|[」』”"]$/g, '').trim()
  s = s.replace(/^[「『”"]+|[」』”"]+$/g, '').trim()
  if (!s || s.length < 2) return { name: '', valid: false, reason: '店名抽出失敗（記事タイトル/見出しのみ）' }
  if (BAD_SHOP_NAME_RE.test(s)) return { name: '', valid: false, reason: 'サイト名/カテゴリ名のため店名未確定' }
  // 価格/日付を含む「店名」は見出し断片（『日替わりランチがなんと600円！4月9日に』型）→ 店名未確定として扱う。
  // 全角数字（６００円）も対象にするため半角化してから判定（漢数字の「三日月」等は数字でないため誤爆しない）
  const sNum = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  if (/\d+\s*円|\d{1,2}月\d{1,2}日/.test(sNum)) return { name: '', valid: false, reason: '価格/日付を含む見出し断片のため店名未確定' }
  if (s.length >= 30 && !opts.placesMatched) return { name: '', valid: false, reason: '説明文の可能性（30字以上・Places未照合）' }
  return { name: s.slice(0, 40), valid: true, reason: '' }
}

export function newnessKeywords(text: string): { strong: string[]; weak: string[]; excluded: boolean } {
  const strong = Array.from(new Set((text.match(new RegExp(NEWNESS_STRONG, 'gi')) || []).map((s) => s.trim()))).slice(0, 6)
  const weak = Array.from(new Set((text.match(new RegExp(NEWNESS_WEAK, 'gi')) || []).map((s) => s.trim()))).slice(0, 6)
  return { strong, weak, excluded: NEWNESS_EXCLUDE.test(text) }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x?\d+;/g, ' ').replace(/\s+/g, ' ').trim()
}
function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
}

/** parser_type を判定（site設定 → URL/HTML構造から推定） */
export function detectParserType(site: any, html: string, url: string): ParserType {
  // 明示的な parser_type 指定を最優先（HORBY専用など）
  const pt = String(site?.parser_type || '')
  if (pt === 'horby_new_salon' || /u-word\.com|h-word\.com/i.test(url)) return 'horby_new_salon'
  // 詳細 parser_type 名 → エンジンの基本パーサーへマッピング（開店閉店/号外NET/つうしん/地域ブログ/リビングWeb=記事型、まいぷれ/ディレクトリ=新着型、食べログ新着=マーケット型）
  if (/^(openclose_article|goguynet_openclose|goguynet_index_discovery|goguynet_area_discovery|tsushin_openclosed|regional_blog_openclose|living_web_newopen)$/.test(pt)) return 'openclose_article'
  if (/^(mypl_newopen_list|mypl_area_discovery|mypl_submission_signal|newopen_submission_page|local_directory_new_listing)$/.test(pt)) return 'local_directory_new_listing'
  if (/^(tabelog_newopen_list|marketplace_listing)$/.test(pt)) return 'marketplace_listing'
  const st = String(site?.source_type || '')
  if (st === 'openclose_article' || st === 'local_directory_new_listing' || st === 'marketplace_listing' || st === 'generic_page_text_scan') return st as ParserType
  // 詳細 source_type 名のマッピング（seedの非標準 source_type に対応）
  if (/openclose|tsushin|goguynet|living|blog/i.test(st)) return 'openclose_article'
  if (/mypl|directory|newopen_submission|submission/i.test(st)) return 'local_directory_new_listing'
  if (/marketplace|tabelog/i.test(st)) return 'marketplace_listing'
  const fam = String(site?.media_family || '')
  if (['goguynet', 'kaitenheiten', 'tsushin'].includes(fam)) return 'openclose_article'
  if (['saikohkunavi', 'local_directory'].includes(fam)) return 'local_directory_new_listing'
  if (fam === 'horby') return 'horby_new_salon'
  // URLヒント: 検索結果/新着順/店舗一覧 → マーケットプレイス
  if (/(searchResult|\bsearch\b|sort(Type)?=|newest|\bstore\b|\bshop\b|\blist\b|menuType=)/i.test(url)) return 'marketplace_listing'
  // HTML構造: 店舗カードらしきクラスが多い → マーケットプレイス
  const cardHits = (html.match(/(class|id)=["'][^"']*(card|shop|store|result|item|tenpo|spot)[^"']*["']/gi) || []).length
  if (cardHits >= 5) return 'marketplace_listing'
  // 記事リンクらしき個別URLが多い → 記事型
  const articleish = (html.match(/href=["'][^"']*\/(archives|\d{4}\/\d{1,2}|\d{4,})/gi) || []).length
  if (articleish >= 5) return 'openclose_article'
  return 'generic_page_text_scan'
}

export interface BlockCandidate {
  shopName: string; address: string; prefecture: string; city: string; phone: string; industry: string
  open: OpenDate; detailUrl: string; matchedKeywords: string[]; blockText: string; isNew: boolean
  category: string; reviewish: string; preEnriched?: boolean; official?: string; phoneGated?: boolean
}

/** 日本の電話番号として妥当か（厳格）。00xx・短すぎ・桁数不正・郵便番号/日付混同を排除。 */
export function isValidJpPhone(raw: string): boolean {
  let d = String(raw || '').replace(/[^\d]/g, '')
  // 国際表記 +81-3-1234-5678 / 81 3 1234 5678 は国内形 03-1234-5678 に直してから検証する。
  // これが無いと isJapanPhone(/^\+?81/ で true) と判定が割れ、正当な日本の店舗が
  // 「電話番号が不正」としてHOLD降格していた（公式サイトの表記が +81 のケースで発火）。
  if (/^81\d{9,10}$/.test(d)) d = '0' + d.slice(2)
  if (d.length !== 10 && d.length !== 11) return false
  if (d[0] !== '0') return false
  if (/^(0120|0800|0570)\d{6}$/.test(d)) return true   // フリーダイヤル/ナビダイヤル(10桁)
  if (/^0[789]0\d{8}$/.test(d)) return true            // 携帯(11桁)
  if (/^050\d{8}$/.test(d)) return true                // IP電話(050・11桁)
  if (/^0[1-9]\d{8}$/.test(d)) return true             // 固定(10桁・2桁目1-9)
  return false
}

/** フリーダイヤル/ナビダイヤル（0120/0800/0570）か。店舗直通ではなくチェーン/コールセンターが多いため架電対象から除外する。 */
export function isTollFreeJp(raw?: string | null): boolean {
  const d = String(raw || '').replace(/[^\d]/g, '')
  return /^(0120|0800|0570)/.test(d)
}
// 共通: 日本の電話番号抽出（厳格バリデーション付き。0043 370-0043 / 03-52 等は不採用）
export function extractJpPhone(text: string): string {
  for (const m of text.matchAll(/(?:\+81[\s-]?)?0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4}|0120[-\s]?\d{2,3}[-\s]?\d{2,3}|0\d{9,10}/g)) {
    const cand = m[0].trim()
    if (isValidJpPhone(cand) && isJapanPhone(cand)) return cand
  }
  return ''
}

/** 記事タイトルから店名だけを切り出す（「」『』内 ＋ がオープン/開店 等の文脈）。検証はsanitizeShopNameで行う。 */
export function extractShopFromTitle(title: string): string {
  if (!title) return ''
  const t = String(title)
  const m =
    t.match(/(?:オープンするのは|新しくできたのは|オープンしたのは|誕生するのは)\s*[「『]([^」』]{2,40})[」』]/) ||
    t.match(/[「『]([^」』]{2,40})[」』]\s*(?:が|を|に)?\s*(?:グランドオープン|プレオープン|ニューオープン|オープン|開店|開業|開院|誕生|上陸|リニューアル)/) ||
    t.match(/[「『]([^」』]{2,40})[」』]/)
  if (!m) return ''
  const r = sanitizeShopName(m[1])
  return r.valid ? r.name : ''
}

/** 記事本文エリアだけを抽出（広告/サイドバー/関連記事/カウンター等を除外）。店名・住所・電話の優先抽出に使う。 */
export function extractMainContent(html: string): string {
  if (!html) return ''
  // 候補を全て集め「最も本文らしい（タグを除いた文字数が最大の）もの」を採る。
  // 以前は優先順で最初にヒットした1件を使っていたため、<article>/<main> が小さなティーザーだけを
  // 包むサイトでは極小の本文が返り（開店閉店.comで実測21字）、呼び出し側が「300字未満なら全文」の
  // フォールバックに落ちて、サイドバーの「最近の閉店記事」から店名・住所・開業日を誤抽出していた
  // （仙台の医院の extracted_area が『渋谷』になる等）。
  const cands: string[] = []
  const push = (re: RegExp) => { for (const m of html.matchAll(re)) if (m[1]) cands.push(m[1]) }
  push(/<article[^>]*>([\s\S]*?)<\/article>/gi)
  push(/<main[^>]*>([\s\S]*?)<\/main>/gi)
  push(/<div[^>]*class=["'][^"']*(?:entry-content|post-content|article-body|article__body|post_content|entry_content|single-content|single_content|post-body|td-post-content|記事本文|単一記事|content-inner)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<footer|<aside)/gi)
  push(/<div[^>]*id=["'](?:content|main|post|entry|main-content|primary)["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<footer|<aside)/gi)
  const textLen = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
  let content = html
  if (cands.length) {
    const best = cands.reduce((a, b) => (textLen(b) > textLen(a) ? b : a))
    if (textLen(best) >= 200) content = best  // 極小候補は採らず全文側の判断に委ねる
  }
  // 除外ブロックを削る（best-effort）
  content = content
    .replace(/<(nav|header|footer|aside|script|style|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(ul|div|section)[^>]*class=["'][^"']*(?:sidebar|side-bar|widget|related|popular|ranking|comment|share|sns|breadcrumb|pankuzu|\bad\b|ad-|ads|advertis|counter|banner|sister|footer|header|global-nav|gnav|menu)[^"']*["'][\s\S]{0,4000}?<\/\1>/gi, ' ')
  return content
}

const NAV_WORD = /^(ホーム|トップ|home|top|ログイン|login|会員|新規登録|もっと見る|一覧|検索|menu|メニュー|予約|マイページ|お問い合わせ|利用規約|プライバシー|地図|電話する|詳細|店舗表示|詳しく)$/i
/** 1ブロックHTMLから店舗候補を抽出 */
export function extractCandidateFromBlock(blockHtml: string, base: URL): BlockCandidate | null {
  const text = stripTags(blockHtml)
  if (text.length < 30 || text.length > 4000) return null
  const kw = newnessKeywords(text)
  const isNew = kw.strong.length > 0 && !kw.excluded
  // リンク収集
  const links: { url: string; text: string }[] = []
  for (const m of blockHtml.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let abs: URL; try { abs = new URL(m[1], base) } catch { continue }
    if (abs.host !== base.host) continue
    if (/^(mailto:|tel:|javascript:)/i.test(m[1])) continue
    links.push({ url: abs.toString(), text: stripTags(m[2]).slice(0, 60) })
  }
  // 店名: 見出し → 太字 → 非ナビのリンクテキスト
  const heading = blockHtml.match(/<(h[1-4]|strong|b)[^>]*>([\s\S]*?)<\/\1>/i)
  let shopName = heading ? stripTags(heading[2]) : ''
  if (!shopName || NAV_WORD.test(shopName)) {
    const linkName = links.map((l) => l.text).find((t) => t.length >= 2 && t.length <= 30 && !NAV_WORD.test(t) && !/^\d+$/.test(t))
    shopName = (linkName || shopName || '').trim()
  }
  shopName = shopName.replace(/\s+/g, ' ').replace(/(新規|NEW|OPEN|新着)\s*$/i, '').trim().slice(0, 40)
  // 詳細URL: store/shop/detail/tenpo/spot系 or 「店舗表示/詳細」リンク
  const detail = links.find((l) => /\/(store|shop|detail|tenpo|spot|item|result|info)\b|[?&](?:id|s|store|shop)=/i.test(l.url) && !/searchResult|search\?/i.test(l.url))
    || links.find((l) => /店舗表示|詳細|詳しく|みる|see|view/i.test(l.text))
    || links[0]
  const phone = extractJpPhone(text)
  const ad = extractAddressLoose(text)
  let prefecture = ad.prefecture
  let city = ad.city
  if (!prefecture) { const r = prefectureFromCity(text); prefecture = r.prefecture; city = city || r.city }
  const open = extractOpenDateFromTitle(text)
  const industry = classifyIndustry(`${shopName} ${text}`)
  const category = (text.match(/(?:ジャンル|カテゴリ)[:：]?\s*([^\s|｜/]{2,12})/)?.[1] || '')
  const reviewish = (text.match(/(?:★[\d.]+|評価[\d.]+|口コミ\d+件?|レビュー\d+)/)?.[0] || '')
  return {
    shopName, address: ad.address, prefecture, city, phone, industry, open,
    detailUrl: detail?.url || '', matchedKeywords: [...kw.strong, ...kw.weak].slice(0, 6),
    blockText: text.slice(0, 300), isNew, category, reviewish,
  }
}

export interface BlockExtractResult {
  candidates: BlockCandidate[]
  stats: { totalLinks: number; blockCount: number; keywordBlocks: number; detailLinks: number; bodyTextLen: number; newBadge: number; jsLikely: boolean }
}

// 都道府県名（HORBYの new_salon_area は都道府県のみのことが多い）
const PREF_RE = /(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/

/** HORBY（u-word.com/horby）の「NEW SALON / 新規加盟店舗」カードを抽出。
 *  ScrapingBeeでJS描画後HTMLを渡す。一覧カードに詳細リンク(href)が無いため店名/エリア/カテゴリのみ取得（→電話なしでHOLD）。 */
export function parseHorbyCards(html: string, base: URL): BlockExtractResult {
  const candidates: BlockCandidate[] = []
  // .new_salon_item ブロックを抽出（DOMのみ。CSSの .new_salon_item[...] は class=" で始まらないので除外される）
  const items = Array.from(html.matchAll(/<div[^>]+class="new_salon_item"[^>]*>([\s\S]*?)(?=<div[^>]+class="new_salon_item"|<\/div>\s*<\/div>\s*<\/section>|$)/gi))
  for (const m of items) {
    const block = m[1]
    let name = stripTags((block.match(/class="new_salon_name"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || '')).trim()
    if (!name) name = stripTags((block.match(/<a[^>]*title="([^"]+)"/i)?.[1] || '')).trim()
    const area = stripTags((block.match(/class="new_salon_area"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '')).trim()
    const tag = stripTags((block.match(/class="new_salon_tag_item"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '')).trim()
    const menu = stripTags((block.match(/class="menu_name"[^>]*>([\s\S]*?)<\//i)?.[1] || '')).trim()
    const detail = (block.match(/href=["']([^"']*(?:\/horby\/store\/|\/store\/)[^"']+)["']/i)?.[1] || '')  // 通常は無い（JSナビ）
    if (!name) continue
    const pref = (area.match(PREF_RE)?.[1] || '')
    // 一覧カードに詳細リンク(href)が無いため、店名で一意な合成URL（#付き＝fetchしない・重複保存防止用キー）
    const detailUrl = detail ? new URL(detail, base).href : `${base.origin}/horby#salon-${encodeURIComponent(name.slice(0, 40))}`
    candidates.push({
      shopName: name.slice(0, 60), address: pref ? `${pref}` : area, prefecture: pref ? (pref.length <= 3 && !/[都道府県]$/.test(pref) ? pref + (pref === '北海道' ? '' : pref === '東京' ? '都' : /大阪|京都/.test(pref) ? '府' : '県') : pref) : '',
      city: '', phone: '', industry: classifyIndustry(`${name} ${tag} ${menu}`), open: { text: '', date: '', confidence: 'none' } as any,
      detailUrl, matchedKeywords: ['新規加盟店舗'], blockText: `${name} ${area} ${tag} ${menu}`.trim().slice(0, 200), isNew: true,
      category: tag || '', reviewish: '',
    })
  }
  return { candidates, stats: { totalLinks: 0, blockCount: items.length, keywordBlocks: candidates.length, detailLinks: candidates.filter((c) => c.detailUrl).length, bodyTextLen: stripTags(html).length, newBadge: candidates.length, jsLikely: false } }
}

/** HORBY 店舗詳細ページ（/horby/store/storeDetail/{id}・JS描画後HTML）から ショップデータ を抽出。
 *  dl.shop_data_row の dt(ラベル)/dd(値) を読む。メールは「ログイン後に表示」のため取得しない。 */
export function parseHorbyDetail(html: string): { name: string; address: string; prefecture: string; phone: string; official: string; mapUrl: string; hours: string } {
  const rows: Record<string, string> = {}
  for (const m of html.matchAll(/<dl[^>]*class="[^"]*shop_data_row[^"]*"[^>]*>([\s\S]*?)<\/dl>/gi)) {
    const label = stripTags(m[1].match(/<dt[^>]*>([\s\S]*?)<\/dt>/i)?.[1] || '').trim()
    const ddHtml = m[1].match(/<dd[^>]*>([\s\S]*?)<\/dd>/i)?.[1] || ''
    if (label) rows[label] = ddHtml
  }
  const txt = (h: string) => stripTags((h || '').replace(/<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ').trim()
  const name = txt(rows['店舗名'] || rows['店名'] || '').slice(0, 60)
  const addrRaw = txt(rows['住所'] || '').replace(/地図を見る.*$/, '').trim()
  const address = addrRaw.replace(/\s+/g, '').slice(0, 70)
  const prefecture = (addrRaw.match(/(北海道|東京都|大阪府|京都府|[^\s]{2,3}県)/)?.[1] || '')
  const phone = (txt(rows['電話番号'] || rows['TEL'] || '').match(/0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4}/)?.[0] || '').trim()
  const official = ((rows['オフィシャルサイト'] || '').match(/href=["'](https?:\/\/[^"']+|[a-z0-9.-]+\.[a-z]{2,}[^"']*)["']/i)?.[1] || '')
  const mapUrl = ((rows['住所'] || '').match(/href=["'](https?:\/\/[^"']*maps[^"']+)["']/i)?.[1] || '')
  const hours = txt(rows['営業時間'] || '').slice(0, 40)
  return { name, address, prefecture, phone, official: official && !/^https?:/.test(official) ? `https://${official}` : official, mapUrl, hours }
}

// ============================================================
// 号外NET（goguynet系）記事詳細の「shop-info」構造化ブロック直取り。
// 記事本文の末尾に CMS 定型の店舗情報（店名/住所/電話/営業時間/リンク）が dt/dd で載っており、
// 見出し断片から店名を推測するより桁違いに正確。旧テンプレ記事は Googleマップ埋め込み（pb=...!2z<base64>）
// から店名/住所を復元する。ブロックが無いサイト/古い記事は found:false で既存フローへ完全フォールバック。
// ============================================================
export interface GoguynetShopInfo { name: string; address: string; phone: string; hours: string; holiday: string; station: string; officialUrl: string; instagramUrl: string; found: boolean; nameFromBlock: boolean }
export function parseGoguynetShopInfo(html: string): GoguynetShopInfo {
  const out: GoguynetShopInfo = { name: '', address: '', phone: '', hours: '', holiday: '', station: '', officialUrl: '', instagramUrl: '', found: false, nameFromBlock: false }
  if (!html) return out
  // マップ埋め込みフォールバック(2)(3)は号外NET系ページ限定（全地域メディアで発火させると
  // アクセス地図の駅名/緯度経度が店名としてすり抜ける）。shop-infoブロック(1)はclass名が特異なので常時可
  const isGoguynet = /goguynet/i.test(html)
  const norm = (s: string) => stripTags(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[−－‐]/g, '-').replace(/\s+/g, ' ').trim()
  // 1) shop-info ブロック（新テンプレ）
  const block = html.match(/<div[^>]+class=["'][^"']*shop-info[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'](?:prevnext|related)|<\/article>|$)/i)?.[1] || ''
  if (block) {
    out.name = norm(block.match(/class=["'][^"']*shop-info-name[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|h\d|p|span)>/i)?.[1] || '').slice(0, 60)
    out.nameFromBlock = !!out.name
    for (const m of block.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
      const label = norm(m[1])
      const ddHtml = m[2]
      const val = norm(ddHtml)
      if (/住所|所在地/.test(label)) out.address = val.slice(0, 80)
      else if (/電話|TEL/i.test(label)) out.phone = extractJpPhone(val)
      else if (/営業時間/.test(label)) out.hours = val.slice(0, 60)
      else if (/定休/.test(label)) out.holiday = val.slice(0, 40)
      else if (/最寄|アクセス|駅/.test(label)) out.station = val.slice(0, 40)
      else if (/リンク|URL|HP|ホームページ|サイト|SNS/i.test(label)) {
        for (const a of ddHtml.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
          const u = a[1]
          if (/instagram\.com/i.test(u)) { if (!out.instagramUrl) out.instagramUrl = u }
          else if (!/goguynet|google\.|maps\.|line\.me|lin\.ee|x\.com|twitter\.com|facebook\.com|youtube\.com/i.test(u)) { if (!out.officialUrl) out.officialUrl = u }
        }
      }
    }
  }
  // 埋め込み由来の店名候補として不適切な文字列（駅名/出口/路線/座標/住所そのもの）
  const badEmbedName = (s: string) => !s || s.length < 2 || s.length > 40 || /駅$|口$|線$|^[0-9.,\s\-]+$|丁目|番地|^〒/.test(s) || /^https?:/.test(s)
  // 2) 新型Googleマップ埋め込み（maps/embed/v1/place?q=店名,住所）で不足を補完（号外NET系限定）
  if (isGoguynet && (!out.address || !out.name)) {
    const q = html.match(/maps\/embed\/v1\/place\?[^"']*q=([^"'&]+)/i)?.[1]
    if (q) {
      try {
        const dec = decodeURIComponent(q.replace(/\+/g, ' '))
        const parts = dec.split(',').map((s) => s.trim()).filter(Boolean)
        if (parts.length >= 2) {
          if (!out.name && !badEmbedName(parts[0])) out.name = parts[0]
          const addr = parts.slice(1).join('')
          if (!out.address && /北海道|東京都|(?:京都|大阪)府|[一-龥]{2,3}県|[一-龥]{1,8}[市区町村]/.test(addr)) out.address = addr.slice(0, 80)
        }
      } catch { /* noop */ }
    }
  }
  // 3) 旧型pb=埋め込み: !2z<base64url> に店名/住所がUTF-8で入っている（サーバー専用なのでBuffer使用可・号外NET系限定）
  if (isGoguynet && (!out.address || !out.name)) {
    for (const m of html.matchAll(/!2z([A-Za-z0-9+/=_-]{8,})/g)) {
      try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
        const dec = Buffer.from(b64, 'base64').toString('utf8')
        if (!dec || /�/.test(dec)) continue
        if (!out.address && /^(〒?\s*\d{3}-?\d{4})?\s*(北海道|東京都|(?:京都|大阪)府|[一-龥]{2,3}県)/.test(dec.trim())) out.address = norm(dec).replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').slice(0, 80)
        else if (!out.name && !badEmbedName(norm(dec))) out.name = norm(dec).slice(0, 40)
      } catch { /* noop */ }
    }
  }
  out.found = !!(out.name || out.address || out.phone)
  return out
}

/** カード/リスト/記事ブロック単位で新店候補を抽出（マーケットプレイス/汎用本文スキャン共通） */
export function extractNewnessBlocks(html: string, base: URL): BlockExtractResult {
  const cleaned = cleanHtml(html)
  const bodyText = stripTags(cleaned)
  const totalLinks = (cleaned.match(/<a\s[^>]*href=/gi) || []).length
  // JSレンダリング/本文不足の検知（本文が極端に少なくscript主体）
  const scriptLen = (html.match(/<script[\s\S]*?<\/script>/gi) || []).join('').length
  const jsLikely = bodyText.length < 400 || (scriptLen > html.length * 0.6 && bodyText.length < 1200)
  // ブロック境界: article/li/section/tr/カードdiv の直前にマーカーを入れて分割
  const SEP = '@@RST_BLK@@'
  const marked = cleaned
    .replace(/<(article|li|section|tr)\b/gi, SEP + '<$1')
    .replace(/<div\b([^>]*(?:class|id)=["'][^"']*(?:card|item|shop|store|result|entry|post|list-item|tile|cell|tenpo|spot|box)[^"']*["'][^>]*)>/gi, SEP + '<div$1>')
  let parts = marked.split(SEP).filter((p) => p.length > 40)
  // 分割できない場合は本文全体を1ブロックとして汎用スキャン
  if (parts.length <= 1) parts = [cleaned]
  const candidates: BlockCandidate[] = []
  let keywordBlocks = 0, detailLinks = 0, newBadge = 0
  const seen = new Set<string>()
  for (const part of parts) {
    const c = extractCandidateFromBlock(part, base)
    if (!c) continue
    if (c.matchedKeywords.length > 0) keywordBlocks++
    if (/新規|NEW|新着/i.test(c.matchedKeywords.join(' '))) newBadge++
    if (c.detailUrl) detailLinks++
    if (!c.isNew || !c.shopName) continue
    const key = c.detailUrl || (c.shopName + '|' + c.address)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(c)
  }
  return { candidates, stats: { totalLinks, blockCount: parts.length, keywordBlocks, detailLinks, bodyTextLen: bodyText.length, newBadge, jsLikely } }
}

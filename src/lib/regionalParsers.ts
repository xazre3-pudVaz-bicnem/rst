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

export type ParserType = 'openclose_article' | 'local_directory_new_listing' | 'marketplace_listing' | 'generic_page_text_scan'

// 新店シグナル（強）。店舗自体の新規性。
const NEWNESS_STRONG = /(新規(?!メニュー|商品|サービス)|ニューオープン|NEW(?:\s?OPEN)?|新着|新規掲載|新規登録|新規オープン|プレオープン|グランドオープン|移転オープン|近日オープン|本日オープン|オープン|開店|開業|開院|\d{1,2}月\d{1,2}日\s?(?:OPEN|オープン|開店|開業)|20\d{2}年\d{1,2}月\s?(?:OPEN|オープン))/
// 新店シグナル（弱）
const NEWNESS_WEAK = /(掲載開始|新しく掲載|新店舗|新店|リニューアル|店舗表示)/
// 新店ではない（除外）
const NEWNESS_EXCLUDE = /(新メニュー|新商品|新サービス|キャンペーン|イベント|フェア|求人|スタッフ募集|アルバイト|バイト募集|周年|クーポン|ポップアップ|pop-?up|セール|福袋)/i

// 店名として不適切（サイト名/カテゴリ名/記事一覧見出し/説明文）
const BAD_SHOP_NAME_RE = /(ニューオープン情報|新店情報|開店情報|閉店情報|店舗に関するニュース|サイトマップ|一覧|まとめ|ブログ|ニュース|毎日発信|情報を発信|を発信|記事|速報|グルメブログ|求人情報|駐車場|検索結果|カテゴリ|のお店|食べログ|ホットペッパー|ぐるなび|Retty|公式サイト|トップページ|ホーム|について|とは|話題の|おすすめ|特集|ランキング|レビュー)/

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
  const st = String(site?.source_type || '')
  if (st === 'openclose_article' || st === 'local_directory_new_listing' || st === 'marketplace_listing' || st === 'generic_page_text_scan') return st as ParserType
  const fam = String(site?.media_family || '')
  if (['goguynet', 'kaitenheiten', 'tsushin'].includes(fam)) return 'openclose_article'
  if (['saikohkunavi', 'local_directory'].includes(fam)) return 'local_directory_new_listing'
  if (fam === 'horby' || /h-word\.com/i.test(url)) return 'marketplace_listing'
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
  category: string; reviewish: string
}

// 共通: 日本の電話番号抽出
export function extractJpPhone(text: string): string {
  for (const m of text.matchAll(/(?:\+81[\s-]?)?0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4}|0120[-\s]?\d{2,3}[-\s]?\d{2,3}|0\d{9,10}/g)) {
    if (isJapanPhone(m[0])) return m[0].trim()
  }
  return ''
}

const NAV_WORD = /^(ホーム|トップ|home|top|ログイン|login|会員|新規登録|もっと見る|一覧|検索|menu|メニュー|予約|マイページ|お問い合わせ|利用規約|プライバシー|地図|電話する|詳細|店舗表示|詳しく)$/i
const INDUSTRY_RE: { name: string; re: RegExp }[] = [
  { name: '中華料理', re: /中華|ラーメン|餃子/ }, { name: '居酒屋', re: /居酒屋|酒場|バル|ダイニングバー/ }, { name: 'カフェ', re: /カフェ|cafe|coffee|珈琲/i },
  { name: '飲食店', re: /レストラン|食堂|焼肉|寿司|そば|うどん|定食|弁当|惣菜|スイーツ|ケーキ|焼鳥|カレー|パン|ベーカリー/ },
  { name: '美容室', re: /美容室|ヘアサロン|美容院|hair/i }, { name: 'ネイルサロン', re: /ネイル|nail/i }, { name: 'エステ', re: /エステ|脱毛/ },
  { name: '整体', re: /整体|カイロ/ }, { name: '整骨院', re: /整骨院|接骨院/ }, { name: 'リラクゼーション', re: /リラク|もみほぐし/ },
  { name: 'クリニック', re: /クリニック|医院|診療所/ }, { name: '歯科', re: /歯科|デンタル/ }, { name: 'ジム・フィットネス', re: /ジム|フィットネス|ピラティス|ヨガ/ },
]

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
  const industry = INDUSTRY_RE.find((m) => m.re.test(text))?.name || ''
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

// ============================================================
// 地域情報サイトの記事タイトル/抜粋からの判定・抽出（決定論ルール）
// 記事本文は保存しない。短い抜粋＋抽出結果のみを扱う。
// ============================================================
import { PREFECTURES } from './areaPresets.js'
import { classifyIndustry } from './industry.js'
import { extractJpPhone } from './regionalParsers.js'

const AREA_TOKENS: string[] = (() => {
  const t = new Set<string>()
  for (const p of PREFECTURES) {
    t.add(p.label)
    for (const a of p.areas) {
      const bare = a.replace(p.label, '')
      if (bare) t.add(bare)
      const leaf = bare.replace(/^.+?[市区](?=.+[区])/, '')
      if (leaf && leaf !== bare) t.add(leaf)
    }
    for (const s of p.stations) t.add(s)
  }
  return Array.from(t).sort((a, b) => b.length - a.length)
})()

const OPEN_WORDS = ['新規オープン', 'ニューオープン', 'グランドオープン', 'プレオープン', 'オープンしました', 'オープンするみたい', 'オープンしたみたい', 'オープン', '開店', '開業', '開院', 'がオープン', 'できる', 'できた', 'newopen', 'grand open']
const REOPEN_WORDS = ['移転オープン', 'リニューアルオープン', 'リニューアル', '移転']
const CLOSE_WORDS = ['閉店', '休業', '閉業', '営業終了', '閉院']
const EVENT_WORDS = ['イベント', 'マルシェ', '催事', 'ポップアップ', 'popup', '期間限定', '周年', 'キャンペーン', 'フェア', '求人', '採用', 'スタッフ募集', '新メニュー', '新作', 'セール']
const CHAIN_HINT = /(マクドナルド|スターバックス|スタバ|ケンタッキー|モスバーガー|ガスト|サイゼリヤ|吉野家|すき家|松屋|ドトール|タリーズ|コメダ|丸亀製麺|ユニクロ|\bGU\b|ＧＵ|セブンイレブン|ファミリーマート|ローソン|QBハウス|ライザップ|チョコザップ|chocoZAP|カーブス|ほっともっと|大戸屋|やよい軒|ニトリ|業務スーパー|ドンキ|ドン・キホーテ|マツモトキヨシ|ウエルシア|スギ薬局)/i
const MALL_HINT = /(イオンモール|ららぽーと|アリオ|ルミネ|アトレ|パルコ|PARCO|高島屋|三越|伊勢丹|そごう|大丸|松坂屋|百貨店|駅ビル|エキュート|アウトレット|ショッピングモール|ショッピングセンター)/

export interface RegionalExtract {
  shop_name: string
  area: string
  address: string
  open_date: string
  industry: string
  phone: string
  detected_type: 'open' | 'close' | 'reopen' | 'event' | 'unknown'
  is_excluded: boolean
  exclude_reason: string
  is_chain: boolean
  is_mall: boolean
}

function detectType(title: string): RegionalExtract['detected_type'] {
  const t = title
  if (CLOSE_WORDS.some((w) => t.includes(w))) return 'close'
  if (REOPEN_WORDS.some((w) => t.includes(w))) return 'reopen'
  if (OPEN_WORDS.some((w) => t.toLowerCase().includes(w.toLowerCase()))) return 'open'
  if (EVENT_WORDS.some((w) => t.toLowerCase().includes(w.toLowerCase()))) return 'event'
  return 'unknown'
}

/** タイトルは新店系か（巡回時の一次フィルタ用） */
export function isOpenTitle(title: string): boolean {
  const ty = detectType(title)
  return ty === 'open' || ty === 'reopen'
}

export function extractFromArticle(title: string, bodyText: string): RegionalExtract {
  const text = `${title}\n${bodyText}`
  const detected_type = detectType(title)

  // 店名: 『…』「…」"…" を優先、なければ 【エリア】の直後〜
  let shop_name = ''
  const q = title.match(/[『「"]([^』」"]{2,30})[』」"]/)
  if (q) shop_name = q[1].trim()
  if (!shop_name) {
    const afterBracket = title.replace(/^【[^】]*】/, '').match(/([一-龥ぁ-んァ-ヶa-zA-Z0-9&'’\- ]{2,24})(?:が|で|に)?(?:オープン|開店|開業|開院)/)
    if (afterBracket) shop_name = afterBracket[1].trim()
  }

  // エリア: 【…】内優先 → 全文最長一致
  let area = ''
  const bra = title.match(/【([^】]+)】/)
  if (bra) area = AREA_TOKENS.find((t) => bra[1].includes(t)) || ''
  if (!area) area = AREA_TOKENS.find((t) => text.includes(t)) || ''

  // 住所: 47都道府県対応（従来は関東4都県のみで、号外NET全国展開後の43道府県の住所が構造的に取れなかった）。
  // 全角数字を半角化してからマッチ（「東京都台東区１−２−３」型の表記に対応）
  const normText = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[−－]/g, '-')
  // 住所候補は「先頭一致」で決めない。つうしん系の <title> は
  // 「記事名 - 松戸つうしん - 千葉県松戸市の地域情報ブログ」形式で、text の先頭は title のため、
  // 先頭一致だと本文の実住所より先にサイトのタグラインを住所として掴む（同一CMSの全記事で発火し、
  // 偽住所が案件に投入されるうえ「住所あり」と誤認して外部補完まで抑止されていた）。
  // → 候補を全件集め、ノイズ（タグライン/カテゴリ文言）を除外し、具体地点（丁目/番地/数字）を持つものを優先する。
  const PREF_ADDR_RE = /〒?\s*(?:\d{3}-?\d{4}\s*)?(?:北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)[^\n。、）)]{2,50}/g
  const ADDR_NOISE_RE = /(地域情報|情報ブログ|ブログ|ニュースサイト|情報サイト|ポータル|タウン情報|まとめ|一覧|特集|ランキング|の記事|お知らせ一覧|求人|不動産|で検索)/
  const addrCands: string[] = []
  for (const m of normText.matchAll(PREF_ADDR_RE)) addrCands.push(m[0])
  const cityOnly = normText.match(/[一-龥ぁ-んァ-ヶ]{1,8}[市区町村][^\n。、）)]{1,30}\d/)
  if (cityOnly) addrCands.push(cityOnly[0])
  const cleanAddr = (s: string) => s.replace(/^〒?\s*(?:\d{3}-?\d{4})?\s*/, '').trim().slice(0, 60)
  const usableAddrs = addrCands.map(cleanAddr).filter((s) => s.length >= 3 && !ADDR_NOISE_RE.test(s))
  const address = usableAddrs.find((s) => /(丁目|番地|\d)/.test(s)) || usableAddrs[0] || ''

  // 開店日: 「○月○日オープン」「2026/6/28」等
  const dateMatch = text.match(/(20\d{2}[年\/.-]\s?\d{1,2}[月\/.-]\s?\d{1,2}日?)/) || text.match(/(\d{1,2}月\d{1,2}日)(?:[^\n]{0,6}(?:オープン|開店|開業|オープン予定))/)
  const open_date = dateMatch ? dateMatch[1] || dateMatch[0] : ''

  const industry = classifyIndustry(text)

  // 電話: 検証込みの共通抽出（regionalParsers.extractJpPhone は isValidJpPhone 検証込み。
  // 素の正規表現だと郵便番号や価格の数字列を電話と誤認することがあった）
  const phone = extractJpPhone(bodyText)

  const is_chain = CHAIN_HINT.test(text)
  const is_mall = MALL_HINT.test(text)
  const eventWord = EVENT_WORDS.find((w) => title.toLowerCase().includes(w.toLowerCase()))

  let is_excluded = false
  let exclude_reason = ''
  if (detected_type === 'close') { is_excluded = true; exclude_reason = '閉店・休業記事のため除外。' }
  else if (detected_type === 'event' || eventWord) { is_excluded = true; exclude_reason = `イベント/催事/求人/周年/キャンペーン等（「${eventWord || ''}」）のため除外。` }
  else if (is_chain) { is_excluded = true; exclude_reason = 'チェーン店の可能性が高いため除外。' }
  else if (is_mall) { is_excluded = true; exclude_reason = '大型商業施設内の可能性が高いため除外。' }

  return { shop_name, area, address, open_date, industry, phone, detected_type, is_excluded, exclude_reason, is_chain, is_mall }
}

/** djb2 簡易ハッシュ（article_url_hash 用・依存なし） */
export function urlHash(url: string): string {
  let h = 5381
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0
  return h.toString(16)
}

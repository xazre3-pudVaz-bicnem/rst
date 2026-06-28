// ============================================================
// 地域情報サイトの記事タイトル/抜粋からの判定・抽出（決定論ルール）
// 記事本文は保存しない。短い抜粋＋抽出結果のみを扱う。
// ============================================================
import { PREFECTURES } from './areaPresets.js'

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
const CHAIN_HINT = /(マクドナルド|スターバックス|スタバ|ケンタッキー|モスバーガー|ガスト|サイゼリヤ|吉野家|すき家|松屋|ドトール|タリーズ|コメダ|丸亀製麺|ユニクロ|GU|セブンイレブン|ファミリーマート|ローソン|QBハウス|ライザップ|チョコザップ|chocoZAP|カーブス|ほっともっと|大戸屋|やよい軒|ニトリ|業務スーパー|ドンキ|ドン・キホーテ|マツモトキヨシ|ウエルシア|スギ薬局)/i
const MALL_HINT = /(イオンモール|ららぽーと|アリオ|ルミネ|アトレ|パルコ|PARCO|高島屋|三越|伊勢丹|そごう|大丸|松坂屋|百貨店|駅ビル|エキュート|アウトレット|ショッピングモール|ショッピングセンター)/

const INDUSTRY_MAP: { name: string; re: RegExp }[] = [
  { name: '整体', re: /整体|カイロ/ }, { name: '整骨院', re: /整骨院|接骨院/ }, { name: '鍼灸院', re: /鍼灸|はり灸/ },
  { name: '美容室', re: /美容室|ヘアサロン|hair|美容院/i }, { name: '理容室', re: /理容室|バーバー|barber/i },
  { name: 'ネイルサロン', re: /ネイル|nail/i }, { name: 'まつ毛サロン', re: /まつ毛|まつげ|マツエク|eyelash/i },
  { name: 'エステ', re: /エステ|脱毛|フェイシャル/ }, { name: 'リラクゼーション', re: /リラクゼーション|もみほぐし|リフレ/ },
  { name: 'パーソナルジム', re: /パーソナルジム|パーソナルトレーニング|フィットネス|ジム/ }, { name: 'ピラティス', re: /ピラティス|ヨガ/ },
  { name: 'カフェ', re: /カフェ|cafe|coffee|珈琲/i }, { name: 'ラーメン', re: /ラーメン|らーめん/ }, { name: 'パン屋', re: /パン屋|ベーカリー|bakery/i },
  { name: '居酒屋', re: /居酒屋|酒場|バル/ }, { name: '飲食店', re: /レストラン|食堂|ダイニング|焼肉|寿司|そば|うどん|定食|弁当|テイクアウト|スイーツ|ケーキ/ },
  { name: '歯科', re: /歯科|デンタル/ }, { name: '動物病院', re: /動物病院/ }, { name: 'クリニック', re: /クリニック|医院|診療所/ },
  { name: 'リフォーム', re: /リフォーム|リノベ/ }, { name: '美容クリニック', re: /美容クリニック|美容外科|美容皮膚科/ },
]

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

  // 住所
  const addrMatch = text.match(/(東京都|神奈川県|埼玉県|千葉県)[^\n。、）)]{2,40}/) || text.match(/[一-龥ぁ-んァ-ヶ]{1,8}[市区町村][^\n。、）)]{1,30}\d/)
  const address = addrMatch ? addrMatch[0].trim().slice(0, 60) : ''

  // 開店日: 「○月○日オープン」「2026/6/28」等
  const dateMatch = text.match(/(20\d{2}[年\/.-]\s?\d{1,2}[月\/.-]\s?\d{1,2}日?)/) || text.match(/(\d{1,2}月\d{1,2}日)(?:[^\n]{0,6}(?:オープン|開店|開業|オープン予定))/)
  const open_date = dateMatch ? dateMatch[1] || dateMatch[0] : ''

  const industry = INDUSTRY_MAP.find((m) => m.re.test(text))?.name || ''

  const phoneMatch = bodyText.match(/0\d{1,3}[-(]?\d{2,4}[-)]?\d{3,4}/)
  const phone = phoneMatch ? phoneMatch[0] : ''

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

// ============================================================
// Instagram caption からの店舗情報抽出（決定論ヒューリスティック）＋ A/B/C分類
// 注: ここは外部LLMを使わない自己完結の抽出器。将来LLM抽出に差し替え可能。
// 方針: Google Places照合は必須にしない。IG単体でも電話/LINE/予約URL等が
// 取れ、新規オープン文言＋一都三県エリアがあれば「Instagram単体HOT候補」。
// ============================================================
import { PREFECTURES } from './areaPresets.js'
import { classifyIndustry } from './industry.js'

// 一都三県のエリアトークン（caption内に bare 表記で出る想定）
const AREA_TOKENS: string[] = (() => {
  const tokens = new Set<string>()
  for (const p of PREFECTURES) {
    tokens.add(p.label) // 東京都 等
    for (const a of p.areas) {
      const bare = a.replace(p.label, '') // 東京都葛飾区 -> 葛飾区
      if (bare) tokens.add(bare)
      // 政令市の区（横浜市西区 -> 西区 も拾えるよう leaf も追加）
      const leaf = bare.replace(/^.+?[市区](?=.+[区])/, '')
      if (leaf && leaf !== bare) tokens.add(leaf)
    }
    for (const s of p.stations) tokens.add(s)
  }
  // 長い順に並べて最長一致を優先
  return Array.from(tokens).sort((a, b) => b.length - a.length)
})()

// 新規オープン系文言
const OPEN_WORDS = [
  '新規オープン', 'ニューオープン', 'グランドオープン', 'プレオープン', 'オープンしました', '本日オープン',
  '新規開店', '新店舗', '新店', '新規開業', '独立開業', '新規開院', '開院', '移転オープン', 'リニューアルオープン',
  '近日オープン', 'オープン予定', '開店', '開業', 'newopen', 'grandopen', 'preopen', 'newshop', 'newstore', 'opened',
]
// 除外（求人/催事/通販/周年など）
const EXCLUDE_WORDS = [
  '求人', '採用', 'スタッフ募集', 'アルバイト募集', 'バイト募集', '正社員募集',
  'イベント', 'マルシェ', '催事', 'ポップアップ', 'popup', 'pop-up', '期間限定出店', '出店',
  '周年', '◯周年', 'キャンペーン', '通販', 'オンラインショップ', 'オンラインサロン', 'online限定',
  '新メニュー', '新作', '入荷', 'クーポン', '日記', '施工事例', '施工実績', '工事完了',
]
// チェーン/大型施設の簡易ヒント
const CHAIN_HINT = /(マクドナルド|スターバックス|スタバ|ケンタッキー|モスバーガー|ガスト|サイゼリヤ|吉野家|すき家|松屋|ドトール|タリーズ|コメダ|丸亀製麺|ユニクロ|\bGU\b|ＧＵ|セブンイレブン|ファミリーマート|ローソン|QBハウス|TBC|ミュゼ|ライザップ|チョコザップ|chocoZAP|カーブス|ゴールドジム|ほっともっと|大戸屋|やよい軒)/i
const MALL_HINT = /(イオンモール|ららぽーと|アリオ|ルミネ|アトレ|パルコ|PARCO|高島屋|三越|伊勢丹|そごう|大丸|松坂屋|百貨店|駅ビル|エキュート|アウトレット|ショッピングモール|ショッピングセンター)/

function normalizePhone(s: string): string {
  return s.replace(/[^\d]/g, '')
}

export interface IgExtract {
  shop_name: string
  industry: string
  area: string
  address: string
  phone: string
  phone_normalized: string
  line_url: string
  reservation_url: string
  website_url: string
  account_url: string
  hashtags: string[]
  has_open_word: boolean
  open_word: string
  is_excluded: boolean
  exclude_word: string
  is_chain: boolean
  is_mall: boolean
  newness_score: number
  phone_reachable_score: number
}

export function extractFromCaption(caption: string, opts?: { username?: string }): IgExtract {
  const text = caption || ''
  const lower = text.toLowerCase()

  const hashtags = Array.from(text.matchAll(/#([^\s#　]+)/g)).map((m) => m[1])
  // URLたち
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s　]+/g)).map((m) => m[0])
  const line_url = urls.find((u) => /lin\.ee|line\.me/i.test(u)) || (/(?:LINE|ライン).{0,6}@?[a-z0-9_.-]+/i.test(text) ? 'LINEあり' : '')
  const reservation_url = urls.find((u) => /(reserve|reservation|yoyaku|booking|hotpepper|airrsv|coubic|stores\.jp|select-type|tabelog\.com\/.*\/rstLst|epark)/i.test(u)) || ''
  const website_url = urls.find((u) => u !== line_url && u !== reservation_url && !/instagram\.com/i.test(u)) || ''

  // 電話番号（日本の固定/携帯）
  const phoneMatch = text.match(/0\d{1,3}[-(]?\d{2,4}[-)]?\d{3,4}/)
  const phone = phoneMatch ? phoneMatch[0] : ''

  // エリア（最長一致）
  const area = AREA_TOKENS.find((t) => text.includes(t)) || ''

  // 住所候補（都県/市区から始まる断片）
  const addrMatch = text.match(/(東京都|神奈川県|埼玉県|千葉県)[^\n#＃]{2,40}/) || text.match(/[一-龥ぁ-んァ-ヶ]{1,8}[市区町村][^\n#＃]{1,30}\d/)
  const address = addrMatch ? addrMatch[0].trim().slice(0, 60) : ''

  // 業種
  const industry = classifyIndustry(text)

  // 新規オープン文言
  const open_word = OPEN_WORDS.find((w) => lower.includes(w.toLowerCase())) || ''
  const has_open_word = !!open_word

  // 除外語
  const exclude_word = EXCLUDE_WORDS.find((w) => lower.includes(w.toLowerCase())) || ''

  // 店名候補: @mention優先 → 先頭行（絵文字/ハッシュタグ除去）
  let shop_name = ''
  const atName = text.match(/@([A-Za-z0-9_.]{2,30})/)
  const firstLine = text.split(/\n/).map((l) => l.replace(/#[^\s#　]+/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim()).find((l) => l.length >= 2)
  if (firstLine && firstLine.length <= 30) shop_name = firstLine
  else if (opts?.username) shop_name = opts.username
  else if (atName) shop_name = atName[1]

  const account_url = opts?.username ? `https://www.instagram.com/${opts.username}/` : (atName ? `https://www.instagram.com/${atName[1]}/` : '')

  const is_chain = CHAIN_HINT.test(text)
  const is_mall = MALL_HINT.test(text)

  // スコア
  let newness_score = 0
  if (has_open_word) newness_score += 50
  if (/本日オープン|オープンしました|グランドオープン|新規オープン/i.test(text)) newness_score += 20
  if (/\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日/.test(text)) newness_score += 10 // 日付らしき
  if (area) newness_score += 20

  let phone_reachable_score = 0
  if (phone) phone_reachable_score += 60
  if (reservation_url) phone_reachable_score += 25
  if (line_url) phone_reachable_score += 15
  if (website_url) phone_reachable_score += 10

  return {
    shop_name, industry, area, address, phone, phone_normalized: normalizePhone(phone),
    line_url, reservation_url, website_url, account_url, hashtags,
    has_open_word, open_word, is_excluded: !!exclude_word, exclude_word,
    is_chain, is_mall,
    newness_score: Math.min(100, newness_score),
    phone_reachable_score: Math.min(100, phone_reachable_score),
  }
}

export type IgClassification = 'google_match_hot' | 'ig_only_hot' | 'hold' | 'excluded'

export interface IgClassifyOpts {
  requireOpenWord?: boolean   // 新規オープン文言必須（既定ON）
  requireArea?: boolean       // 一都三県エリア必須（既定ON）
  requirePhone?: boolean      // 自動投入は電話必須（既定ON）
  igAutoImport?: boolean      // IG単体HOT候補をcasesへ自動投入（既定OFF）
  igAllowWithoutPlace?: boolean // Places未照合でも自動投入可（既定OFF）
}

export interface IgClassifyResult {
  classification: IgClassification
  temperature: 'HOT' | 'HOLD' | 'EXCLUDED'
  auto_importable: boolean
  gbp_unregistered_candidate: boolean
  reason: string
}

/**
 * A/B/C分類。
 * placeHot=true は「Places照合あり＆既存の厳格HOT条件を満たす」を呼び出し側が判定して渡す。
 * placeMatched=true は Places で同一店舗が見つかった（HOTとは限らない）。
 */
export function classifyInstagram(
  ex: IgExtract,
  placeMatched: boolean,
  placeHot: boolean,
  opts: IgClassifyOpts = {},
): IgClassifyResult {
  const requireOpenWord = opts.requireOpenWord ?? true
  const requireArea = opts.requireArea ?? true

  // 1) 除外
  if (ex.is_excluded) return { classification: 'excluded', temperature: 'EXCLUDED', auto_importable: false, gbp_unregistered_candidate: false, reason: `除外語「${ex.exclude_word}」を含むため対象外（求人/催事/通販/周年等）。` }
  if (ex.is_chain) return { classification: 'excluded', temperature: 'EXCLUDED', auto_importable: false, gbp_unregistered_candidate: false, reason: 'チェーン店の可能性が高いため除外。' }
  if (ex.is_mall) return { classification: 'excluded', temperature: 'EXCLUDED', auto_importable: false, gbp_unregistered_candidate: false, reason: '大型商業施設内の可能性が高いため除外。' }

  // 2) 必須シグナル
  if (requireOpenWord && !ex.has_open_word) return { classification: 'hold', temperature: 'HOLD', auto_importable: false, gbp_unregistered_candidate: false, reason: '新規オープン系の文言が見つからないためHOLD。' }
  if (requireArea && !ex.area) return { classification: 'hold', temperature: 'HOLD', auto_importable: false, gbp_unregistered_candidate: false, reason: '一都三県のエリア情報が見つからないためHOLD。' }

  // 3) A: Google Places一致＆厳格HOT
  if (placeMatched && placeHot) {
    return { classification: 'google_match_hot', temperature: 'HOT', auto_importable: true, gbp_unregistered_candidate: false, reason: `Instagram新規オープン投稿＋Google Placesで同一店舗を確認（電話・口コミ日付が厳格条件を満たす）ため、Google照合HOTと判定。` }
  }

  // 4) B: Instagram単体HOT候補
  const hasContact = !!ex.phone || !!ex.line_url || !!ex.reservation_url || !!ex.website_url
  const strongIgOnly = hasContact && ex.has_open_word && !!ex.area && !!ex.shop_name && !!ex.industry
  if (strongIgOnly) {
    // 自動投入可否: 設定ON＋（電話必須なら電話あり）＋（Places未照合でも可の設定）
    let importable = false
    if (opts.igAutoImport) {
      const phoneOk = opts.requirePhone ? !!ex.phone : hasContact
      const placeOk = placeMatched || !!opts.igAllowWithoutPlace
      importable = phoneOk && placeOk
    }
    const gbpUnreg = !placeMatched
    const contactDesc = [ex.phone && '電話', ex.line_url && 'LINE', ex.reservation_url && '予約URL', ex.website_url && '公式URL'].filter(Boolean).join('・')
    return {
      classification: 'ig_only_hot', temperature: 'HOT', auto_importable: importable, gbp_unregistered_candidate: gbpUnreg,
      reason: `Instagram単体HOT候補：${ex.area}・${ex.industry}「${ex.shop_name}」、新規オープン文言「${ex.open_word}」、連絡先(${contactDesc})あり${gbpUnreg ? '。Google Places未照合（GBP未登録の可能性）' : '。Google Placesは一致したが厳格HOT条件未達'}。${importable ? '自動投入対象。' : '初期設定では自動投入せずHOLD扱い（要手動確認）。'}`,
    }
  }

  // 5) C: HOLD
  const missing = [!ex.phone && !ex.line_url && !ex.reservation_url && !ex.website_url && '連絡先', !ex.shop_name && '店名', !ex.industry && '業種'].filter(Boolean).join('・')
  return { classification: 'hold', temperature: 'HOLD', auto_importable: false, gbp_unregistered_candidate: !placeMatched, reason: `新規オープンの可能性はあるが${missing || '情報'}が弱いためHOLD（要手動確認）。` }
}

/** 検索対象ハッシュタグ（IGは7日30ユニーク制限のためローテーション） */
export const IG_HASHTAGS = [
  '新規オープン', 'ニューオープン', 'グランドオープン', 'プレオープン', 'オープンしました', '本日オープン',
  '開店', '新規開店', '新店舗', '新店', '開業', '新規開業', '独立開業', '開院', '新規開院',
  '移転オープン', 'リニューアルオープン', '近日オープン', 'オープン予定',
  'newopen', 'grandopen', 'preopen', 'newshop', 'newstore',
]

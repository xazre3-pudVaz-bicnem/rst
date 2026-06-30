// ============================================================
// 日本国内限定フィルタ（Google Places / Instagram Web / 地域メディア 共通）
// 「日本全国」だが「日本国外」は除外する。エリア/業種では絞らない。
// ============================================================

export const JP_PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
]

// 海外を示す明示マーカー（住所・スニペット用）
export const FOREIGN_HINT = /(United States|U\.?S\.?A\.?|アメリカ合衆国|アメリカ|Canada|カナダ|Australia|オーストラリア|United Kingdom|England|イギリス|英国|South Korea|Korea|韓国|대한민국|한국|Taiwan|台湾|臺灣|Hong Kong|香港|China|中国|上海|北京|Singapore|シンガポール|Thailand|タイランド|バンコク|Vietnam|ベトナム|Philippines|フィリピン|Indonesia|インドネシア|Malaysia|マレーシア|France|フランス|パリ|Germany|ドイツ|Italy|イタリア|Spain|スペイン|Oregon|California|New York|Texas|Washington|Florida|Nevada|Hawaii|ハワイ)/i

// 米国州2文字略号 + ZIP（例: "Bend, OR 97701"）
const US_STATE_ZIP = /\b[A-Z]{2}\s?\d{5}(?:-\d{4})?\b/

/** 住所に日本の都道府県 or 「日本」が含まれるか */
export function isJapanAddress(address?: string | null): boolean {
  if (!address) return false
  const a = String(address)
  if (/(^|[^A-Za-z])日本([^A-Za-z]|$)/.test(a) || a.includes('〒')) return true
  return JP_PREFECTURES.some((p) => a.includes(p))
}

/** 明らかに海外の住所か（海外マーカー or 米国ZIP、かつ日本判定でない） */
export function isForeignAddress(address?: string | null): boolean {
  if (!address) return false
  const a = String(address)
  if (isJapanAddress(a)) return false
  return FOREIGN_HINT.test(a) || US_STATE_ZIP.test(a)
}

/** 日本の電話番号か（国内0始まり10〜11桁 / +81 / 81始まり）。他の国際番号(+1等)はfalse */
export function isJapanPhone(raw?: string | null): boolean {
  if (!raw) return false
  const s = String(raw).trim()
  if (/^\+?81[\s-]?\d/.test(s)) return true
  if (/^\+/.test(s)) return false // +81以外の国際番号は海外
  const d = s.replace(/[^\d]/g, '')
  return /^0\d{9,10}$/.test(d) // 0始まり10〜11桁
}

/** 明らかに海外の電話番号か（+81以外の国際プレフィックス） */
export function isForeignPhone(raw?: string | null): boolean {
  if (!raw) return false
  const s = String(raw).trim()
  if (/^\+?81[\s-]?\d/.test(s)) return false
  return /^\+(?!81)/.test(s) || /^00[1-9]/.test(s)
}

// 営業対象外の法人・団体・研究会系（新店舗ではない）。店名に含まれると低優先/除外
export const ORG_NON_STORE = /(機構|協会|観光協会|商工会(議所)?|振興会|振興公社|公社|事業団|事業協同組合|協同組合|連合会|連盟|学会|研究会|研究所(?!.*クリニック)|財団|社団|一般社団法人|一般財団法人|公益社団法人|公益財団法人|NPO法人|NPO|特定非営利活動法人|独立行政法人|地方公共団体|自治体|労働組合|生活協同組合|農業協同組合|JA[ 　]|委員会|評議会|本部|総本部|連絡会|協議会)/

/** 店名が法人・団体・研究会系（営業対象の新店舗ではない可能性が高い）か */
export function isOrgNonStore(name?: string | null): boolean {
  if (!name) return false
  return ORG_NON_STORE.test(String(name))
}

/** スニペット/本文が海外（日本語・日本住所が取れず海外マーカーあり） */
export function isForeignText(text?: string | null): boolean {
  if (!text) return false
  const t = String(text)
  if (isJapanAddress(t)) return false
  return FOREIGN_HINT.test(t) || US_STATE_ZIP.test(t)
}

/**
 * 日本国内候補としての総合判定。
 * - excluded: 明らかに海外（海外住所/海外電話/海外マーカー）→ EXCLUDED
 * - japan: 日本の住所/都道府県、または日本の電話番号が確認できる（HOTに必要）
 */
export function judgeJapan(opts: { address?: string | null; phone?: string | null; text?: string | null }): {
  isJapan: boolean; isForeign: boolean; reason: string
} {
  const foreignAddr = isForeignAddress(opts.address)
  const foreignPh = isForeignPhone(opts.phone)
  const foreignTx = !opts.address && isForeignText(opts.text)
  const isForeign = foreignAddr || foreignPh || foreignTx
  const isJapan = !isForeign && (isJapanAddress(opts.address) || isJapanPhone(opts.phone))
  let reason = ''
  if (isForeign) reason = '日本国外の候補のため除外'
  return { isJapan, isForeign, reason }
}

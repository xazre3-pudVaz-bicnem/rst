import {
  CHAIN_NAMES, MALL_KEYWORDS, STATION_KEYWORDS, BRANCH_KEYWORDS, EXCLUDED_NAME_KEYWORDS,
} from './constants.js'
import { phoneDigits, normalizeAddress, normalizeUrl } from './utils.js'
import type { Case, LeadCandidate, RawLead, LeadTemperature, ClassifyOpts } from './types.js'

const includesAny = (text: string, list: readonly string[]) =>
  list.some((k) => k && text.includes(k))

/** 既存casesとの重複を検出し、重複案件IDを返す（無ければ null） */
export function findDuplicateCaseId(raw: RawLead, cases: Case[]): string | null {
  const phone = phoneDigits(raw.phone_number)
  const nameAddr = `${(raw.name ?? '').trim()}|${normalizeAddress(raw.address)}`
  const web = normalizeUrl(raw.website_url)
  const insta = normalizeUrl(raw.instagram_url)
  for (const c of cases) {
    if (phone && [c.phone1, c.phone2, c.phone3].map(phoneDigits).some((d) => d && d === phone)) return c.id
    if (`${c.name.trim()}|${normalizeAddress(c.address)}` === nameAddr) return c.id
    if (web && (normalizeUrl(c.hp1) === web || normalizeUrl(c.hp2) === web)) return c.id
    if (insta && normalizeUrl(c.instagram) === insta) return c.id
  }
  return null
}

const SIGNAL_TEXT: Record<string, string> = {
  is_new_gbp: '新規GBP（Googleビジネスプロフィール）',
  is_new_website: '新規ホームページ',
  is_new_ad_listing: '新規広告掲載',
  is_new_instagram: 'Instagram新規運用',
}
const PROPOSAL_TEXT: Record<string, string> = {
  is_new_gbp: 'MEO初期整備・Googleマップ最適化・HP制作',
  is_new_website: 'SEO/AIO/MEO連動施策・LP改善',
  is_new_ad_listing: 'LP改善・HP制作・MEO対策',
  is_new_instagram: 'SNS運用代行・公式HP制作・MEO',
}

function buildReason(signals: string[], reviewCount: number | null): string {
  const head = signals.length === 0
    ? '新規シグナルは未検出'
    : signals.map((s) => SIGNAL_TEXT[s] ?? s).join('・') + ' を検出'
  const rv = reviewCount === null ? '口コミ件数不明' : `口コミ${reviewCount}件`
  return `${head}（${rv}）。`
}

interface CommentCtx {
  temperature: LeadTemperature
  signals: string[]
  score: number
  reviewCount: number | null
  reviewKnown: boolean
  fresh: boolean
  mid: boolean
  high: boolean
  veryHigh: boolean
  isChain: boolean
  inMall: boolean
  inStation: boolean
  isBranch: boolean
  isDup: boolean
  excludedName: boolean
  hasPhone: boolean
}

function buildComment(c: CommentCtx): string {
  const { temperature, signals, score, reviewCount } = c
  if (c.isDup) return '既存案件と電話番号・店名/住所・Web情報のいずれかが一致したため、重複として除外しました。'
  if (c.excludedName) return '官公庁・医療・金融・教育機関など、明らかに営業対象外の業態と判断したため除外しました。'

  if (temperature === 'EXCLUDED') {
    // 口コミ過多による除外
    if (c.veryHigh || c.high) {
      return `Google Placesで検出しましたが、口コミ件数が${reviewCount}件と多く、既にGoogle上で十分に認知されている既存店舗の可能性が高いため、自動投入対象外としました。`
    }
    // チェーン/施設内/支店による除外
    const reasons: string[] = []
    if (c.isChain) reasons.push('大手チェーン/フランチャイズ名を検出')
    if (c.inMall) reasons.push('大型商業施設内テナント')
    if (c.inStation) reasons.push('駅ビル内テナント')
    if (c.isBranch) reasons.push('大手企業の支店・営業所の可能性')
    const r = reasons.length ? reasons.join('・') : 'オーナー・決裁者に繋がりにくい業態'
    return `Google Placesで検出しましたが、${r}のため、店舗電話ではオーナー・決裁者に繋がりにくいと判断し、自動投入対象から除外しました（到達スコア ${score}）。`
  }

  if (temperature === 'HOLD') {
    if (!c.hasPhone) return 'Google Placesで検出しましたが、電話番号が確認できないため自動投入せず保留にしました。'
    if (!c.reviewKnown) return 'Google Placesで検出しましたが、口コミ件数が取得できず新規性の判断が曖昧なため、自動投入せず保留にしました。'
    if (c.mid || c.high) return `Google Placesで検出しましたが、口コミ件数が${reviewCount}件で新規開業の確度が中程度のため、自動投入せず保留にしました。手動確認を推奨します。`
    return `Google Placesで検出しましたが、新規シグナルが弱い、または個人店/チェーン判定が曖昧なため、自動投入せず保留にしました（到達スコア ${score}）。`
  }

  if (temperature === 'WARM') {
    return '新設法人の可能性を検出（電話番号あり）。明確な新規GBP/HP/広告/Instagramシグナルは未検出のため、参考情報として保留しています。'
  }

  // HOT
  const firstSignal = signals[0]
  const proposal = firstSignal ? PROPOSAL_TEXT[firstSignal] : 'MEO初期整備・HP制作'
  return `Googleビジネスプロフィールを新規候補として検出しました。電話番号が確認でき、口コミ件数が${reviewCount}件以下のため、Googleマップ掲載直後または開業直後の可能性があります。店名・住所から大型チェーンや商業施設内テナントではなく、個人店舗・小規模事業者（到達スコア ${score}）と判断しました。${proposal}の提案優先度が高いです。`
}

/**
 * 生候補を判定して LeadCandidate 相当の確定フィールドを返す。
 * 口コミ件数(user_rating_count)を主軸に新規/既存を厳格に分類する。
 */
export function classifyLead(raw: RawLead, cases: Case[], opts?: ClassifyOpts): Partial<LeadCandidate> {
  const hotMax = opts?.hotMaxReviews ?? 5
  const warmMax = opts?.warmMaxReviews ?? 15
  const exclude100 = opts?.exclude100 ?? true
  const unknownHold = opts?.unknownHold ?? true

  const name = (raw.name ?? '').trim()
  const address = (raw.address ?? '').trim()
  const hay = `${name} ${address}`
  const phoneNorm = phoneDigits(raw.phone_number)
  const hasPhone = !!phoneNorm

  // 除外系の検出
  const isChain = includesAny(name, CHAIN_NAMES)
  const inMall = includesAny(hay, MALL_KEYWORDS)
  const inStation = includesAny(hay, STATION_KEYWORDS)
  const isBranch = includesAny(name, BRANCH_KEYWORDS)
  const excludedName = includesAny(hay, EXCLUDED_NAME_KEYWORDS)

  // オーナー到達スコア
  let score = 90
  if (isChain) score = Math.min(score, 25)
  if (inMall) score = Math.min(score, 35)
  if (inStation) score = Math.min(score, 30)
  if (isBranch) score = Math.min(score, 35)
  if (raw.is_new_corporation) score = Math.min(100, score + 3)
  score = Math.max(0, Math.min(100, score))

  // 口コミ件数
  const reviewCount: number | null = typeof raw.review_count === 'number' ? raw.review_count : null
  const reviewKnown = reviewCount !== null
  const fresh = reviewKnown && (reviewCount as number) <= hotMax            // 0〜5
  const mid = reviewKnown && (reviewCount as number) > hotMax && (reviewCount as number) <= warmMax  // 6〜15
  const high = reviewKnown && (reviewCount as number) > warmMax && (reviewCount as number) < 100      // 16〜99
  const veryHigh = reviewKnown && (reviewCount as number) >= 100            // 100+

  const operational = raw.business_status ? raw.business_status === 'OPERATIONAL' : true

  // 新規GBP（first_seenだけでは新規にしない。口コミ5件以下＋電話＋営業中＋非チェーン/施設内/支店）
  const firstSeen = !!raw.is_new_gbp
  const isNewGbp =
    firstSeen && hasPhone && fresh && operational && !isChain && !inMall && !inStation && !isBranch

  const signalFlags = {
    is_new_gbp: isNewGbp,
    is_new_instagram: !!raw.is_new_instagram,
    is_new_website: !!raw.is_new_website,
    is_new_ad_listing: !!raw.is_new_ad_listing,
  }
  const signals = (Object.keys(signalFlags) as (keyof typeof signalFlags)[]).filter((k) => signalFlags[k])
  const hasSignal = signals.length > 0

  const dupId = findDuplicateCaseId(raw, cases)
  const isDup = !!dupId
  const shouldExclude = isDup || excludedName || score < 50

  // 温度判定（口コミ件数を厳格に反映）
  let temperature: LeadTemperature
  if (isDup) temperature = 'EXCLUDED'
  else if (excludedName) temperature = 'EXCLUDED'
  else if (!hasPhone) temperature = 'HOLD'
  else if (score < 50) temperature = 'EXCLUDED'                 // チェーン/施設内/支店が明確
  else if (exclude100 && veryHigh) temperature = 'EXCLUDED'     // 口コミ100件以上＝既存店
  else if (high) temperature = 'EXCLUDED'                       // 16〜99件も既存寄り → 除外
  else if (!reviewKnown && unknownHold) temperature = 'HOLD'    // 口コミ不明 → 保留
  else if (hasSignal && fresh && score >= 80 && !shouldExclude) temperature = 'HOT'
  else if (mid) temperature = 'HOLD'                            // 6〜15件 → 保留
  else if (raw.is_new_corporation) temperature = 'WARM'
  else temperature = 'HOLD'

  const exclusionReasons: string[] = []
  if (isDup) exclusionReasons.push('既存案件と重複')
  if (excludedName) exclusionReasons.push('営業対象外の業態')
  if (isChain) exclusionReasons.push('大手チェーン/フランチャイズ')
  if (inMall) exclusionReasons.push('大型商業施設内テナント')
  if (inStation) exclusionReasons.push('駅ビル内テナント')
  if (isBranch) exclusionReasons.push('大手企業の支店・営業所')
  if (!hasPhone) exclusionReasons.push('電話番号なし')
  if (veryHigh) exclusionReasons.push(`口コミ${reviewCount}件（既存人気店の可能性）`)
  else if (high) exclusionReasons.push(`口コミ${reviewCount}件（既存店寄り）`)
  else if (mid) exclusionReasons.push(`口コミ${reviewCount}件（新規確度 中）`)
  if (!reviewKnown) exclusionReasons.push('口コミ件数不明')

  const detected = [
    ...signals,
    ...(raw.is_new_corporation ? (['is_new_corporation'] as string[]) : []),
  ]

  const comment = buildComment({
    temperature, signals: signals as string[], score, reviewCount, reviewKnown,
    fresh, mid, high, veryHigh, isChain, inMall, inStation, isBranch, isDup, excludedName, hasPhone,
  })

  return {
    name,
    address: address || null,
    industry: raw.industry || null,
    phone_number: raw.phone_number || null,
    phone_normalized: phoneNorm || null,
    website_url: raw.website_url || null,
    instagram_url: raw.instagram_url || null,
    place_id: raw.place_id || null,
    source_type: raw.source_type || 'AI自動投入',
    is_new_gbp: isNewGbp,
    is_new_instagram: signalFlags.is_new_instagram,
    is_new_website: signalFlags.is_new_website,
    is_new_ad_listing: signalFlags.is_new_ad_listing,
    is_new_corporation: !!raw.is_new_corporation,
    detected_signals: detected,
    is_chain_store: isChain,
    is_large_franchise: isChain,
    is_in_shopping_mall: inMall,
    is_in_station_building: inStation,
    is_large_company_branch: isBranch,
    owner_reachability_score: score,
    exclusion_reason: exclusionReasons.length ? exclusionReasons.join(' / ') : null,
    should_exclude_from_call_list: shouldExclude,
    auto_import_reason: buildReason(signals as string[], reviewCount),
    ai_comment: comment,
    lead_temperature: temperature,
    duplicate_of_case_id: dupId,
    user_rating_count: reviewCount,
  }
}

/** HOT判定（自動投入の最終条件） */
export function isHot(c: Partial<LeadCandidate>): boolean {
  return c.lead_temperature === 'HOT'
}

/** Phase1用モック候補（口コミ件数・営業状態付き） */
export function generateMockLeads(): RawLead[] {
  return [
    { name: '炭火焼鳥 とり源', address: '東京都杉並区高円寺南3-12-5', industry: '飲食', phone_number: '03-1234-5678', is_new_gbp: true, review_count: 2, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    { name: 'Nail Salon Mary', address: '神奈川県川崎市中原区小杉町2-8-1', industry: '美容', phone_number: '044-222-3344', instagram_url: 'https://instagram.com/nail_mary', is_new_instagram: true, review_count: 3, business_status: 'OPERATIONAL', source_type: 'Instagram新規' },
    { name: '整体院 ことのは', address: '埼玉県さいたま市浦和区高砂4-1-9', industry: '健康', phone_number: '048-555-7788', website_url: 'https://kotonoha-seitai.jp', is_new_website: true, review_count: 1, business_status: 'OPERATIONAL', source_type: 'HP新規' },
    { name: 'カフェ＆バル すずらん', address: '千葉県柏市柏3-5-12', industry: '飲食', phone_number: '04-7100-2200', is_new_ad_listing: true, review_count: 0, business_status: 'OPERATIONAL', source_type: '広告新規' },
    { name: 'パーソナルジム FORCE', address: '東京都目黒区自由が丘1-9-3', industry: '健康', phone_number: '03-9090-1010', is_new_gbp: true, is_new_website: true, is_new_corporation: true, review_count: 4, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    // 口コミ多数の既存人気店 → EXCLUDED（新規GBPでも除外）
    { name: 'P.S.Gemmie hair salon', address: '東京都葛飾区新小岩1-1-1', industry: '美容', phone_number: '03-3333-2222', is_new_gbp: true, review_count: 2431, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    // 口コミ中程度 → HOLD
    { name: '美容室 Lien', address: '東京都葛飾区亀有3-2-1', industry: '美容', phone_number: '03-5555-1212', is_new_gbp: true, review_count: 12, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    // 電話番号なし → HOLD
    { name: 'リラクゼーション 月', address: '東京都新宿区神楽坂5-1', industry: '美容', is_new_gbp: true, review_count: 2, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    // 大手チェーン → EXCLUDED
    { name: 'スターバックスコーヒー 高円寺店', address: '東京都杉並区高円寺北2-3-1', industry: '飲食', phone_number: '03-3333-0000', is_new_gbp: true, review_count: 5, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    // 大型商業施設内 → EXCLUDED
    { name: 'Hair Make ALOHA', address: '千葉県船橋市浜町2-1-1 ららぽーとTOKYO-BAY 2F', industry: '美容', phone_number: '047-100-9999', is_new_gbp: true, review_count: 3, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    // 支店 → EXCLUDED寄り
    { name: '○○保険 さいたま支店', address: '埼玉県さいたま市大宮区桜木町1-7-5', industry: 'その他', phone_number: '048-600-1111', is_new_website: true, review_count: 8, business_status: 'OPERATIONAL', source_type: 'HP新規' },
    // 新設法人のみ（シグナルなし）→ WARM
    { name: '合同会社 みらいキッチン', address: '東京都板橋区成増2-15-3', industry: '飲食', phone_number: '03-7777-2222', is_new_corporation: true, review_count: 0, business_status: 'OPERATIONAL', source_type: '法人登記' },
    // 個人店・口コミ少 → HOT
    { name: 'BodyCare ほぐし処 結', address: '茨城県つくば市研究学園5-19', industry: '健康', phone_number: '029-800-3210', is_new_gbp: true, review_count: 1, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
  ]
}

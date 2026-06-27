import {
  CHAIN_NAMES, MALL_KEYWORDS, STATION_KEYWORDS, BRANCH_KEYWORDS, EXCLUDED_NAME_KEYWORDS,
} from './constants.js'
import { phoneDigits, normalizeAddress, normalizeUrl } from './utils.js'
import type { Case, LeadCandidate, RawLead, LeadTemperature } from './types.js'

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

function buildReason(signals: string[]): string {
  if (signals.length === 0) return '新規シグナルは未検出（電話番号あり・参考情報のみ）。'
  const parts = signals.map((s) => SIGNAL_TEXT[s] ?? s)
  return `${parts.join('・')} を検出しました。`
}

/** 判定結果に基づく詳細AIコメント */
function buildComment(
  c: {
    temperature: LeadTemperature
    signals: string[]
    score: number
    isChain: boolean
    inMall: boolean
    inStation: boolean
    isBranch: boolean
    isDup: boolean
    excludedName: boolean
    isNewCorp: boolean
  },
): string {
  const { temperature, signals, score, isChain, inMall, inStation, isBranch } = c
  if (c.isDup) return '既存案件と電話番号・店名/住所・Web情報のいずれかが一致したため、重複として除外しました。'
  if (c.excludedName) return '官公庁・医療・金融・教育機関など、明らかに営業対象外の業態と判断したため除外しました。'

  const firstSignal = signals[0]
  const sigText = firstSignal ? SIGNAL_TEXT[firstSignal] : ''
  const proposal = firstSignal ? PROPOSAL_TEXT[firstSignal] : 'HP制作・MEO・SNS運用'

  if (temperature === 'EXCLUDED') {
    const reasons: string[] = []
    if (isChain) reasons.push('大手チェーン/フランチャイズ名を店名に検出')
    if (inMall) reasons.push('大型商業施設内テナント')
    if (inStation) reasons.push('駅ビル内テナント')
    if (isBranch) reasons.push('大手企業の支店・営業所の可能性')
    const r = reasons.length ? reasons.join('・') : 'オーナー・決裁者に繋がりにくい業態'
    return `${sigText ? sigText + 'は検出しましたが、' : ''}${r}のため、店舗電話ではオーナー・決裁者に繋がりにくいと判断し、自動投入対象から除外しました（到達スコア ${score}）。`
  }

  if (temperature === 'HOLD') {
    if (signals.length > 0) {
      return `${sigText}を検出しHOT条件は満たしますが、チェーン店/個人店または商業施設内かの判断が曖昧で、オーナー到達可能性が中程度（スコア ${score}）のため保留にしました。担当者の目視確認のうえ手動投入を推奨します。`
    }
    return `電話番号はありますが新規シグナルが弱く情報不足のため保留にしました（スコア ${score}）。`
  }

  if (temperature === 'WARM') {
    return `新設法人の可能性を検出（電話番号あり）。ただし新規GBP/HP/広告/Instagramの明確なシグナルが未検出のため、参考情報として保留しています。動きが出れば優先度が上がります。`
  }

  // HOT
  return `${buildReason(signals)}店名・住所・Web情報から全国チェーンや大型商業施設内テナントではなく、個人店舗または小規模事業者の可能性が高い（オーナー到達スコア ${score}）と判断しました。${c.isNewCorp ? '新設法人の可能性もあり開業初期と見られます。' : ''}提案商材は${proposal}が有力。テレアポは「最近Googleマップ/SNS/広告を始めたタイミング」を切り口に、Web集客の初期整備を訴求するのが有効です。`
}

/**
 * 生候補を判定して LeadCandidate 相当の確定フィールドを返す。
 * 既存casesとの重複も判定する。
 */
export function classifyLead(raw: RawLead, cases: Case[]): Partial<LeadCandidate> {
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

  // オーナー到達スコア（個人店=高、チェーン/施設内/支店=低）
  let score = 90
  if (isChain) score = Math.min(score, 25)
  if (inMall) score = Math.min(score, 35)
  if (inStation) score = Math.min(score, 30)
  if (isBranch) score = Math.min(score, 35)
  if (raw.is_new_corporation) score = Math.min(100, score + 3)
  score = Math.max(0, Math.min(100, score))

  // 新規シグナル
  const signalFlags = {
    is_new_gbp: !!raw.is_new_gbp,
    is_new_instagram: !!raw.is_new_instagram,
    is_new_website: !!raw.is_new_website,
    is_new_ad_listing: !!raw.is_new_ad_listing,
  }
  const signals = (Object.keys(signalFlags) as (keyof typeof signalFlags)[]).filter((k) => signalFlags[k])
  const hasSignal = signals.length > 0

  // 重複
  const dupId = findDuplicateCaseId(raw, cases)
  const isDup = !!dupId

  const shouldExclude = isDup || excludedName || score < 50

  // 温度判定
  let temperature: LeadTemperature
  if (isDup) temperature = 'EXCLUDED'
  else if (excludedName) temperature = 'EXCLUDED'
  else if (!hasPhone) temperature = 'HOLD'
  else if (score < 50) temperature = 'EXCLUDED'        // チェーン/施設内/支店が明確
  else if (hasSignal && score >= 80) temperature = 'HOT'
  else if (hasSignal && score >= 50) temperature = 'HOLD'  // 曖昧 → 保留
  else if (raw.is_new_corporation) temperature = 'WARM'
  else temperature = 'HOLD'

  // 除外理由
  const exclusionReasons: string[] = []
  if (isDup) exclusionReasons.push('既存案件と重複')
  if (excludedName) exclusionReasons.push('営業対象外の業態')
  if (isChain) exclusionReasons.push('大手チェーン/フランチャイズ')
  if (inMall) exclusionReasons.push('大型商業施設内テナント')
  if (inStation) exclusionReasons.push('駅ビル内テナント')
  if (isBranch) exclusionReasons.push('大手企業の支店・営業所')
  if (!hasPhone) exclusionReasons.push('電話番号なし')

  const detected = [
    ...signals,
    ...(raw.is_new_corporation ? (['is_new_corporation'] as string[]) : []),
  ]

  const comment = buildComment({
    temperature, signals: signals as string[], score, isChain, inMall, inStation, isBranch,
    isDup, excludedName, isNewCorp: !!raw.is_new_corporation,
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
    is_new_gbp: signalFlags.is_new_gbp,
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
    auto_import_reason: buildReason(signals as string[]),
    ai_comment: comment,
    lead_temperature: temperature,
    duplicate_of_case_id: dupId,
  }
}

/** HOT判定（自動投入の最終条件） */
export function isHot(c: Partial<LeadCandidate>): boolean {
  return (
    !!c.phone_normalized &&
    (!!c.is_new_gbp || !!c.is_new_instagram || !!c.is_new_website || !!c.is_new_ad_listing) &&
    c.should_exclude_from_call_list === false &&
    (c.owner_reachability_score ?? 0) >= 80
  )
}

/** Phase1用モック候補（実API接続前の検証用） */
export function generateMockLeads(): RawLead[] {
  return [
    { name: '炭火焼鳥 とり源', address: '東京都杉並区高円寺南3-12-5', industry: '飲食', phone_number: '03-1234-5678', is_new_gbp: true, review_count: 2, source_type: 'GBP新規' },
    { name: 'Nail Salon Mary', address: '神奈川県川崎市中原区小杉町2-8-1', industry: '美容', phone_number: '044-222-3344', instagram_url: 'https://instagram.com/nail_mary', is_new_instagram: true, source_type: 'Instagram新規' },
    { name: '整体院 ことのは', address: '埼玉県さいたま市浦和区高砂4-1-9', industry: '健康', phone_number: '048-555-7788', website_url: 'https://kotonoha-seitai.jp', is_new_website: true, source_type: 'HP新規' },
    { name: 'カフェ＆バル すずらん', address: '千葉県柏市柏3-5-12', industry: '飲食', phone_number: '04-7100-2200', is_new_ad_listing: true, source_type: '広告新規' },
    { name: 'パーソナルジム FORCE', address: '東京都目黒区自由が丘1-9-3', industry: '健康', phone_number: '03-9090-1010', is_new_gbp: true, is_new_website: true, is_new_corporation: true, source_type: 'GBP新規' },
    // 電話番号なし → HOLD
    { name: 'リラクゼーション 月', address: '東京都新宿区神楽坂5-1', industry: '美容', is_new_instagram: true, source_type: 'Instagram新規' },
    // 大手チェーン → EXCLUDED
    { name: 'スターバックスコーヒー 高円寺店', address: '東京都杉並区高円寺北2-3-1', industry: '飲食', phone_number: '03-3333-0000', is_new_gbp: true, source_type: 'GBP新規' },
    // 大型商業施設内 → EXCLUDED
    { name: 'Hair Make ALOHA', address: '千葉県船橋市浜町2-1-1 ららぽーとTOKYO-BAY 2F', industry: '美容', phone_number: '047-100-9999', is_new_gbp: true, source_type: 'GBP新規' },
    // 駅ビル内 → EXCLUDED
    { name: 'TEA HOUSE 葉月', address: '東京都立川市柴崎町3-1-1 ルミネ立川 5F', industry: '飲食', phone_number: '042-500-1234', is_new_instagram: true, source_type: 'Instagram新規' },
    // 支店 → EXCLUDED寄り
    { name: '○○保険 さいたま支店', address: '埼玉県さいたま市大宮区桜木町1-7-5', industry: 'その他', phone_number: '048-600-1111', is_new_website: true, source_type: 'HP新規' },
    // 新設法人のみ（シグナルなし）→ WARM
    { name: '合同会社 みらいキッチン', address: '東京都板橋区成増2-15-3', industry: '飲食', phone_number: '03-7777-2222', is_new_corporation: true, source_type: '法人登記' },
    // 大手ブランド名含むが小規模かも → HOLD（曖昧, スコア中）になりやすいケース。ここでは個人店として高スコア
    { name: 'BodyCare ほぐし処 結', address: '茨城県つくば市研究学園5-19', industry: '健康', phone_number: '029-800-3210', is_new_gbp: true, review_count: 1, source_type: 'GBP新規' },
  ]
}

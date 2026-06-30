import {
  CHAIN_NAMES, MALL_KEYWORDS, STATION_KEYWORDS, BRANCH_KEYWORDS, EXCLUDED_NAME_KEYWORDS,
} from './constants.js'
import { phoneDigits, normalizeAddress, normalizeUrl } from './utils.js'
import { judgeJapan, isJapanAddress, isJapanPhone } from './japanFilter.js'
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
  mid: boolean
  isChain: boolean
  inMall: boolean
  inStation: boolean
  isBranch: boolean
  isDup: boolean
  excludedName: boolean
  hasPhone: boolean
  newnessReason: string
  countZero: boolean
  oldestDaysAgo: number | null
  oldestRecent: boolean
  fromNewOpenQuery: boolean
}

function buildComment(c: CommentCtx): string {
  const { temperature, score, reviewCount, oldestDaysAgo } = c
  if (c.isDup) return '既存案件と電話番号・店名/住所・Web情報のいずれかが一致したため、重複として除外しました。'
  if (c.excludedName) return '官公庁・医療・金融・教育機関など、明らかに営業対象外の業態と判断したため除外しました。'

  if (temperature === 'EXCLUDED') {
    if (c.isChain || c.inMall || c.inStation || c.isBranch) {
      const reasons: string[] = []
      if (c.isChain) reasons.push('大手チェーン/フランチャイズ')
      if (c.inMall) reasons.push('大型商業施設内テナント')
      if (c.inStation) reasons.push('駅ビル・百貨店内テナント')
      if (c.isBranch) reasons.push('大手企業の支店・営業所')
      return `Google Placesで検出しましたが、${reasons.join('・')}のため、店舗電話ではオーナー・決裁者に繋がりにくいと判断し除外しました（到達スコア ${score}）。`
    }
    if (!c.hasPhone) return 'Google Placesで検出しましたが、電話番号が確認できないため除外しました。'
    return `口コミ${reviewCount}件のため、新規GBP候補ではなく既存店舗の可能性が高く除外しました。`
  }

  if (temperature === 'HOLD') {
    if (!c.hasPhone) return '電話番号が確認できないため、自動投入せず保留にしました。'
    if (reviewCount === null) return '口コミ件数が取得できず新規性の判断が曖昧なため、自動投入せず保留にしました。'
    if (c.mid) return `口コミ${reviewCount}件のため、新店判定としては弱く、自動投入せず保留にしました。`
    if (c.countZero) return '口コミ0件のため新規GBPの可能性はありますが、新規オープン系クエリやopeningDateなどの追加根拠がないため、自動投入せず保留にしました。'
    if (oldestDaysAgo === null) return `口コミ${reviewCount}件ですが、口コミ投稿日が取得できず新規性を確認できないため、自動投入せず保留にしました。`
    if (!c.oldestRecent) return `口コミ${reviewCount}件ですが、一番古い口コミが${oldestDaysAgo}日前のため、新店判定としては弱く、自動投入せず保留にしました。`
    return `新規性の根拠が弱いため、自動投入せず保留にしました（到達スコア ${score}）。`
  }

  if (temperature === 'WARM') {
    return '新設法人の可能性を検出（電話番号あり）。明確な新規シグナルは未検出のため、参考情報として保留しています。'
  }

  // HOT
  if (c.countZero) {
    const why = c.fromNewOpenQuery ? '新規オープン系クエリで取得された' : c.newnessReason
    return `口コミ0件、電話番号あり、${why}ため、Googleビジネスプロフィール掲載直後または開業直後の可能性が高いと判断し、自動投入しました。`
  }
  return `口コミ${reviewCount}件、取得できた口コミの一番古い投稿日が${oldestDaysAgo}日前のため、新規オープンまたはGBP掲載直後の可能性が高いと判定しました（${c.newnessReason}）。`
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
  // 日本国内限定: 海外の電話番号は採用しない（HOT条件で日本番号を要求）
  const phoneIsJapan = isJapanPhone(raw.phone_number)
  const hasPhone = !!phoneNorm
  const hasJapanPhone = hasPhone && phoneIsJapan

  // 日本国内判定（「日本全国」だが「日本国外」は除外）
  const jp = judgeJapan({ address, phone: raw.phone_number, text: `${name} ${address}` })
  const isForeign = jp.isForeign
  const addrIsJapan = isJapanAddress(address)
  // 日本性が確認できる（住所に都道府県/日本、または日本の電話番号）
  const japanConfirmed = !isForeign && (addrIsJapan || hasJapanPhone)

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

  const dupId = findDuplicateCaseId(raw, cases)
  const isDup = !!dupId

  // 到達不可（チェーン/施設内/駅ビル/支店）
  const nonReachable = isChain || inMall || inStation || isBranch
  const hardExclude = isDup || excludedName || nonReachable || !hasPhone || veryHigh || isForeign

  // ---- 新規性シグナル ----
  const hasWebsite = !!normalizeUrl(raw.website_url)
  const firstSeenDays = typeof raw.first_seen_days === 'number' ? raw.first_seen_days : 0
  const fromNewOpenQuery = !!raw.from_new_open_query

  // 開業日が現在±90日以内（未来＝開業予定も含む。口コミより強い新店シグナル）
  const openingWithin90 = (() => {
    if (!raw.opening_date) return false
    const t = Date.parse(raw.opening_date)
    if (Number.isNaN(t)) return false
    return Math.abs(Date.now() - t) <= 90 * 86400000
  })()
  // businessStatus = FUTURE_OPENING は「開業予定」の強シグナル
  const futureOpening = raw.business_status === 'FUTURE_OPENING'
  const hasOpeningDate = !!raw.opening_date

  // ---- 口コミ投稿日(publishTime)による判定（新店判定は最古=oldest を重視） ----
  const toDaysAgo = (s: string | null | undefined): number | null => {
    if (!s) return null
    const t = Date.parse(s)
    return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000))
  }
  const latestPub = raw.latest_review_publish_time || null
  const oldestPub = raw.oldest_review_publish_time || null
  const latestDaysAgo = toDaysAgo(latestPub)
  const oldestDaysAgo = toDaysAgo(oldestPub)
  // 取得できた口コミ（最大5件）の一番古い投稿日が30日以内か＝全口コミが新しい＝新店可能性
  const oldestRecent = oldestDaysAgo !== null && oldestDaysAgo <= 30
  // 口コミ日付の確認可否（0件は確認不要、1件以上は投稿日が取れたか）
  const reviewDatesChecked = reviewCount === 0 || oldestDaysAgo !== null

  const countZero = reviewCount === 0
  const count1to5 = reviewKnown && (reviewCount as number) >= 1 && (reviewCount as number) <= hotMax
  const countOk = reviewKnown && (reviewCount as number) <= hotMax  // 0〜5

  // 口コミゲート（HOT必須）：0件はOK／1〜5件は最古口コミ30日以内。
  // ただし openingDate(±90日) または FUTURE_OPENING があれば口コミより優先＝ゲート通過。
  const recencyOk = countZero ? true : ((count1to5 && oldestRecent) || openingWithin90 || futureOpening)

  // 新規性の根拠（first_seenだけでは不可。openingDate/FUTURE_OPENING / 新規オープン系クエリ / 口コミ少+HPなし）
  const newnessStrong =
    openingWithin90 ||
    futureOpening ||
    fromNewOpenQuery ||
    (reviewKnown && (reviewCount as number) <= 3 && !hasWebsite)

  const isNewCandidate = !hardExclude && countOk && recencyOk && newnessStrong
  // HOTは日本国内が必須（日本の住所/都道府県＋日本の電話番号）
  const isHotFinal = isNewCandidate && score >= 80 && japanConfirmed && hasJapanPhone

  // 口コミ日付の判定理由（新店判定は最古を重視）
  const reviewNewnessReason = countZero
    ? '口コミ0件（新規可能性あり）'
    : (oldestDaysAgo === null
        ? '口コミ投稿日が取得できず（自動投入対象外）'
        : (oldestRecent
            ? `最古口コミ ${oldestDaysAgo}日前（30日以内＝全口コミが新しい）`
            : `最古口コミ ${oldestDaysAgo}日前（30日超・新店判定は弱い）`))

  // 新規判定理由
  const newnessParts: string[] = []
  if (futureOpening) newnessParts.push('Google開業予定(FUTURE_OPENING)')
  if (openingWithin90) newnessParts.push(`Google開業日±90日以内(${raw.opening_date})`)
  if (fromNewOpenQuery) newnessParts.push('新規オープン系クエリで取得')
  if (reviewKnown && (reviewCount as number) <= 3 && !hasWebsite) newnessParts.push(`口コミ${reviewCount}件・HPなし・個人店`)
  const newnessReason = isNewCandidate
    ? `${countZero ? '口コミ0件' : `口コミ${reviewCount}件・${reviewNewnessReason}`} / ${newnessParts.join(' / ')}`
    : hardExclude ? '除外条件に該当（新規候補外）'
      : !countOk ? `口コミ${reviewCount}件で多い（新規候補外）`
        : !recencyOk ? '最新口コミが30日超 または 日付取得不可'
          : !newnessStrong ? 'openingDate/新規オープン系クエリ/HPなし等の新規根拠なし'
            : '新規条件を満たさず'

  const isNewGbp = isNewCandidate
  const signalFlags = {
    is_new_gbp: isNewGbp,
    is_new_instagram: !!raw.is_new_instagram,
    is_new_website: !!raw.is_new_website,
    is_new_ad_listing: !!raw.is_new_ad_listing,
  }
  const signals = (Object.keys(signalFlags) as (keyof typeof signalFlags)[]).filter((k) => signalFlags[k])

  // 温度判定
  const closedPerm = raw.business_status === 'CLOSED_PERMANENTLY'
  const closedTemp = raw.business_status === 'CLOSED_TEMPORARILY'
  let temperature: LeadTemperature
  if (isForeign) temperature = 'EXCLUDED'                      // 日本国外（海外住所/海外電話）
  else if (isDup) temperature = 'EXCLUDED'
  else if (excludedName) temperature = 'EXCLUDED'
  else if (nonReachable) temperature = 'EXCLUDED'              // チェーン/施設内/駅ビル/支店
  else if (closedPerm) temperature = 'EXCLUDED'               // 閉業
  // 電話番号なし: openingDate/FUTURE_OPENING 等の強い新規根拠があればHOLD（自動投入はしない）、無ければEXCLUDED
  else if (!hasPhone) temperature = newnessStrong ? 'HOLD' : 'EXCLUDED'
  else if (closedTemp) temperature = 'HOLD'                   // 一時休業は要確認HOLD
  else if (reviewKnown && (reviewCount as number) > warmMax && !openingWithin90 && !futureOpening) temperature = 'EXCLUDED'  // 16件以上だが開業日シグナルが無い既存店
  else if (isHotFinal) temperature = 'HOT'
  else if (mid) temperature = 'HOLD'                           // 6〜15件
  else if (!reviewKnown && unknownHold) temperature = 'HOLD'   // 口コミ不明
  else if (raw.is_new_corporation && countOk) temperature = 'WARM'
  else temperature = 'HOLD'                                    // 1〜5で根拠不足/口コミ古い等

  const exclusionReasons: string[] = []
  if (isForeign) exclusionReasons.push('日本国外の候補のため除外')
  else if (!japanConfirmed && hasPhone && !isForeign) exclusionReasons.push('日本の住所/都道府県が未確認（要確認）')
  if (isDup) exclusionReasons.push('既存案件と重複')
  if (excludedName) exclusionReasons.push('営業対象外の業態')
  if (isChain) exclusionReasons.push('大手チェーン/フランチャイズ')
  if (inMall) exclusionReasons.push('大型商業施設内テナント')
  if (inStation) exclusionReasons.push('駅ビル内テナント')
  if (isBranch) exclusionReasons.push('大手企業の支店・営業所')
  if (!hasPhone) exclusionReasons.push('電話番号なし')
  if (veryHigh) exclusionReasons.push(`口コミ${reviewCount}件（既存人気店の可能性）`)
  else if (high) exclusionReasons.push(`口コミ${reviewCount}件（16件以上・既存店）`)
  else if (mid) exclusionReasons.push(`口コミ${reviewCount}件（6〜15件・新店判定弱）`)
  else if (count1to5 && !oldestRecent) {
    exclusionReasons.push(oldestDaysAgo === null ? '口コミ投稿日が取得できず' : `最古口コミ${oldestDaysAgo}日前（30日超）`)
  } else if (countOk && !newnessStrong) {
    exclusionReasons.push('新規根拠なし（openingDate/新規オープン系/HPなし）')
  }
  if (!reviewKnown) exclusionReasons.push('口コミ件数不明')

  const detected = [
    ...signals,
    ...(raw.is_new_corporation ? (['is_new_corporation'] as string[]) : []),
  ]

  const comment = buildComment({
    temperature, signals: signals as string[], score, reviewCount, mid,
    isChain, inMall, inStation, isBranch, isDup, excludedName, hasPhone,
    newnessReason, countZero, oldestDaysAgo, oldestRecent, fromNewOpenQuery,
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
    should_exclude_from_call_list: hardExclude,
    auto_import_reason: buildReason(signals as string[], reviewCount),
    ai_comment: comment,
    lead_temperature: temperature,
    duplicate_of_case_id: dupId,
    user_rating_count: reviewCount,
    opening_date: raw.opening_date ?? null,
    opening_date_source: raw.opening_date ? 'google_places_openingDate' : null,
    google_business_status: raw.business_status ?? null,
    has_google_opening_date: hasOpeningDate,
    is_new_opening_candidate: isNewCandidate,
    newness_reason: newnessReason,
    days_since_first_seen: firstSeenDays,
    from_new_open_query: fromNewOpenQuery,
    latest_review_publish_time: latestPub,
    oldest_review_publish_time: oldestPub,
    latest_review_days_ago: latestDaysAgo,
    oldest_review_days_ago: oldestDaysAgo,
    oldest_review_is_recent: oldestRecent,
    review_dates_checked: reviewDatesChecked,
    review_newness_reason: reviewNewnessReason,
  }
}

/** HOT判定（自動投入の最終条件） */
export function isHot(c: Partial<LeadCandidate>): boolean {
  return c.lead_temperature === 'HOT'
}

/** Phase1用モック候補（口コミ件数・投稿日付き） */
export function generateMockLeads(): RawLead[] {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
  const RECENT = daysAgo(10)   // 最古口コミも30日以内＝新店
  const OLD = daysAgo(120)     // 最古口コミが古い＝既存店
  return [
    // 口コミ0件＋新規オープン系クエリ相当 → HOT
    { name: '炭火焼鳥 とり源', address: '東京都杉並区高円寺南3-12-5', industry: '飲食', phone_number: '03-1234-5678', review_count: 0, business_status: 'OPERATIONAL', from_new_open_query: true, source_type: 'GBP新規' },
    // 口コミ3件・最古10日前・HPなし → HOT
    { name: 'Nail Salon Mary', address: '神奈川県川崎市中原区小杉町2-8-1', industry: '美容', phone_number: '044-222-3344', review_count: 3, business_status: 'OPERATIONAL', latest_review_publish_time: daysAgo(2), oldest_review_publish_time: RECENT, from_new_open_query: true, source_type: 'GBP新規' },
    // 口コミ4件だが最古120日前 → HOLD（新店判定弱）
    { name: '整体院 ことのは', address: '埼玉県さいたま市浦和区高砂4-1-9', industry: '健康', phone_number: '048-555-7788', review_count: 4, business_status: 'OPERATIONAL', latest_review_publish_time: daysAgo(5), oldest_review_publish_time: OLD, source_type: 'GBP新規' },
    // 口コミ0件＋openingDate直近 → HOT
    { name: 'カフェ＆バル すずらん', address: '千葉県柏市柏3-5-12', industry: '飲食', phone_number: '04-7100-2200', review_count: 0, business_status: 'OPERATIONAL', opening_date: daysAgo(20), source_type: 'GBP新規' },
    // 口コミ2件・最古8日前・HPなし → HOT
    { name: 'パーソナルジム FORCE', address: '東京都目黒区自由が丘1-9-3', industry: '健康', phone_number: '03-9090-1010', review_count: 2, business_status: 'OPERATIONAL', latest_review_publish_time: daysAgo(3), oldest_review_publish_time: daysAgo(8), opening_date: daysAgo(25), source_type: 'GBP新規' },
    // 口コミ多数の既存人気店 → EXCLUDED
    { name: 'P.S.Gemmie hair salon', address: '東京都葛飾区新小岩1-1-1', industry: '美容', phone_number: '03-3333-2222', review_count: 2431, business_status: 'OPERATIONAL', source_type: 'GBP新規' },
    // 口コミ中程度(6〜15) → HOLD
    { name: '美容室 Lien', address: '東京都葛飾区亀有3-2-1', industry: '美容', phone_number: '03-5555-1212', review_count: 12, business_status: 'OPERATIONAL', latest_review_publish_time: daysAgo(4), oldest_review_publish_time: daysAgo(40), source_type: 'GBP新規' },
    // 電話番号なし → EXCLUDED
    { name: 'リラクゼーション 月', address: '東京都新宿区神楽坂5-1', industry: '美容', review_count: 0, business_status: 'OPERATIONAL', from_new_open_query: true, source_type: 'GBP新規' },
    // 大手チェーン → EXCLUDED
    { name: 'スターバックスコーヒー 高円寺店', address: '東京都杉並区高円寺北2-3-1', industry: '飲食', phone_number: '03-3333-0000', review_count: 5, business_status: 'OPERATIONAL', oldest_review_publish_time: RECENT, from_new_open_query: true, source_type: 'GBP新規' },
    // 大型商業施設内 → EXCLUDED
    { name: 'Hair Make ALOHA', address: '千葉県船橋市浜町2-1-1 ららぽーとTOKYO-BAY 2F', industry: '美容', phone_number: '047-100-9999', review_count: 3, business_status: 'OPERATIONAL', oldest_review_publish_time: RECENT, source_type: 'GBP新規' },
    // 支店 → EXCLUDED
    { name: '○○保険 さいたま支店', address: '埼玉県さいたま市大宮区桜木町1-7-5', industry: 'その他', phone_number: '048-600-1111', review_count: 8, business_status: 'OPERATIONAL', source_type: 'HP新規' },
    // 口コミ0件だが新規根拠なし（通常クエリのみ）→ HOLD
    { name: '合同会社 みらいキッチン', address: '東京都板橋区成増2-15-3', industry: '飲食', phone_number: '03-7777-2222', review_count: 0, business_status: 'OPERATIONAL', website_url: 'https://mirai-kitchen.jp', is_new_corporation: true, source_type: '法人登記' },
    // 個人店・口コミ1件・最古10日前・HPなし → HOT
    { name: 'BodyCare ほぐし処 結', address: '茨城県つくば市研究学園5-19', industry: '健康', phone_number: '029-800-3210', review_count: 1, business_status: 'OPERATIONAL', latest_review_publish_time: daysAgo(6), oldest_review_publish_time: daysAgo(10), source_type: 'GBP新規' },
  ]
}

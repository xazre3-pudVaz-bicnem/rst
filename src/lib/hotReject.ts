// ============================================================
// HOT未達理由ビルダー（Google Places / Instagram Web / 地域メディア 共通）
// 「なぜHOTではなくHOLD/EXCLUDEDなのか」を一目で分かる形に整形する。
// 純粋関数（外部依存なし）。各ソースが HotCheck[] を渡す。
// ============================================================

export const HOT_REQUIRED_SCORE_DEFAULT = 75 // HOT基準点
export const HOLD_MIN_SCORE_DEFAULT = 40     // HOLD基準点（未満はEXCLUDED寄り）

export interface HotCheck {
  key: string
  label: string            // 画面表示用ラベル
  ok: boolean | null       // true=満たす / false=不足 / null=未確定
  reasonKey?: string       // hot_reject_reasons に入れる安定キー（省略時 key）
  value?: string           // 取得済みの値（例: 電話番号）。表示に使う
}

export interface HotRejectInput {
  source: 'google_places' | 'instagram_web' | 'regional_media'
  temperature: string
  confidence: number       // 候補の確度（0-100）
  hotRequiredScore?: number
  checks: HotCheck[]
}

export interface HotRejectResult {
  hot_reject_reasons: string[]
  hot_reject_summary: string
  hot_check_result: Record<string, any>
  hot_missing_requirements: string[]
  hot_blocking_reason: string | null
  hot_required_score: number
}

// 主要ブロッカーの優先順位（先頭ほど重大）
const BLOCKER_PRIORITY = [
  'not_japan', 'duplicate', 'event_or_campaign', 'chain_or_large_store',
  'phone_missing', 'address_missing', 'newness_missing', 'opening_date_missing',
  'official_unverified', 'places_no_match', 'post_old', 'too_many_reviews',
  'oldest_review_old', 'industry_unknown', 'shop_name_missing', 'confidence_low',
]

const SOURCE_LABEL: Record<string, string> = {
  google_places: 'Google Places',
  instagram_web: 'Instagram投稿',
  regional_media: '地域メディア記事',
}

export function buildHotReject(input: HotRejectInput): HotRejectResult {
  const hotRequiredScore = input.hotRequiredScore ?? HOT_REQUIRED_SCORE_DEFAULT
  const confidenceOk = input.confidence >= hotRequiredScore
  const isHot = input.temperature === 'HOT'

  // confidence を疑似チェックとして追加（HOTでなく確度が基準未満なら不足扱い）
  const checks: HotCheck[] = [...input.checks]
  checks.push({
    key: 'confidence', label: `確度${input.confidence} / HOT基準${hotRequiredScore}`,
    ok: confidenceOk ? true : null, reasonKey: 'confidence_low',
  })

  const satisfied = checks.filter((c) => c.ok === true)
  const failed = checks.filter((c) => c.ok === false)
  const unknown = checks.filter((c) => c.ok === null)

  // hot_check_result: 各条件の true/false/null ＋ 確度・基準
  const checkResult: Record<string, any> = {}
  for (const c of checks) checkResult[c.key] = c.ok
  checkResult.confidence = input.confidence
  checkResult.hot_required_score = hotRequiredScore
  checkResult.confidence_ok = confidenceOk
  checkResult.is_hot = isHot

  if (isHot) {
    return {
      hot_reject_reasons: [],
      hot_reject_summary: 'HOT条件を満たしています。',
      hot_check_result: checkResult,
      hot_missing_requirements: [],
      hot_blocking_reason: null,
      hot_required_score: hotRequiredScore,
    }
  }

  // 不足/未確定を理由・要件リスト化
  const reasons: string[] = []
  const missing: string[] = []
  for (const c of failed) { reasons.push(c.reasonKey || c.key); missing.push(c.label) }
  for (const c of unknown) {
    const rk = (c.reasonKey || c.key)
    if (rk === 'confidence_low') { reasons.push(rk); missing.push(c.label) }
    else { reasons.push(`${rk}_uncertain`); missing.push(`${c.label}（未確定）`) }
  }

  // 主要ブロッカー
  const allReasonKeys = [...failed.map((c) => c.reasonKey || c.key), ...unknown.map((c) => (c.reasonKey || c.key))]
  let blocking: string | null = null
  for (const p of BLOCKER_PRIORITY) { if (allReasonKeys.includes(p)) { blocking = p; break } }

  // サマリ文（取得済み情報 → 不足理由）
  const got: string[] = []
  if (satisfied.find((c) => c.key === 'has_phone')) got.push('電話番号')
  if (satisfied.find((c) => c.key === 'has_address' || c.key === 'has_area')) got.push('住所')
  if (satisfied.find((c) => c.key === 'has_official')) got.push('公式/予約')
  const gotStr = got.length ? `${got.join('・')}は取得済み` : '連絡先が弱い'
  const lackStr = missing.length ? missing.slice(0, 4).join(' / ') : '新規性の確度不足'
  const src = SOURCE_LABEL[input.source] || ''
  const summary = `${gotStr}だが、${lackStr}のためHOT未達（${src}・確度${input.confidence}<基準${hotRequiredScore}${confidenceOk ? '※確度は基準以上' : ''}）。`

  return {
    hot_reject_reasons: Array.from(new Set(reasons)),
    hot_reject_summary: summary,
    hot_check_result: checkResult,
    hot_missing_requirements: missing,
    hot_blocking_reason: blocking ? blockingLabel(blocking) : null,
    hot_required_score: hotRequiredScore,
  }
}

// reasonKey → 日本語ラベル（hot_blocking_reason 用）
const BLOCKER_LABEL: Record<string, string> = {
  not_japan: '日本国内判定が弱い',
  duplicate: '既存案件と重複',
  event_or_campaign: '求人/イベント/POP/周年等の可能性',
  chain_or_large_store: 'チェーン/大手/大型店の可能性',
  phone_missing: '電話番号なし',
  address_missing: '住所/エリア不明',
  newness_missing: '新規オープン根拠が弱い',
  opening_date_missing: 'openingDateなし',
  official_unverified: '公式サイト/裏取り未確認',
  places_no_match: 'Google Places一致なし',
  post_old: '投稿が古い',
  too_many_reviews: 'Google口コミが多い',
  oldest_review_old: '最古口コミが古い',
  industry_unknown: '業種不明',
  shop_name_missing: '店名の抽出精度が低い',
  confidence_low: 'confidenceがHOT基準未満',
}
function blockingLabel(key: string): string { return BLOCKER_LABEL[key] || key }

// ============================================================
// 営業リスト向けHOT判定（HOT_A / HOT_B / HOLD / EXCLUDED）共通ロジック。
// 「完璧な新店証明」ではなく「営業してよい確度」でHOT化する。純粋関数。
// ============================================================
export type HotTier = 'HOT_A' | 'HOT_B' | 'HOLD' | 'EXCLUDED'

export interface TierInput {
  source: 'google_places' | 'instagram_web' | 'regional_media'
  isJapan: boolean
  hasShopName: boolean
  hasPhone: boolean        // 日本の電話番号あり
  hasArea: boolean         // 住所または市区町村以上
  hasOpeningDate: boolean  // Google openingDate / OPEN日表記
  isFuture: boolean        // businessStatus = FUTURE_OPENING
  igNew: boolean           // Instagram投稿の新店根拠
  regionalNew: boolean     // 地域メディア記事の新店根拠
  newListing: boolean      // 新規掲載一覧（彩北なび/HORBY等）由来
  placesMatched: boolean   // Google Places一致
  hasOfficial: boolean     // 公式/予約/LINE
  // 明確な除外
  isChain: boolean         // 明確な大手チェーン/グループ → EXCLUDED
  chainSuspect?: boolean   // チェーン/大手の疑い → HOLD止まり（HOTにしない）
  allowNoPhone?: boolean   // 電話番号なしでもHOT許可（既定OFF）。OFFなら電話なしはHOTにしない
  isOrg: boolean
  isEventRecruit: boolean
  isForeign: boolean
  isDup: boolean
  reviewMany: boolean      // 口コミ過多の既存人気店
}

export interface TierResult { tier: HotTier; score: number; reason: string; autoImportable: boolean; priority: 'high' | 'normal' | null }

// しきい値
export const TIER_THRESHOLD = { hotA: 75, hotB: 60, hold: 35 }

export type InjectMode = 'strict' | 'standard' | 'aggressive'
/** モード別に自動投入対象か（EXCLUDEDはどのモードでも投入しない） */
export function autoImportAllowed(tier: HotTier, mode: InjectMode): boolean {
  if (tier === 'EXCLUDED' || tier === 'HOLD') return false
  if (tier === 'HOT_A') return true
  return mode !== 'strict' // HOT_B は standard / aggressive で投入
}

export function scoreCandidate(f: TierInput, mode: InjectMode = 'standard'): TierResult {
  // 明確な不要リストは即EXCLUDED
  if (f.isForeign) return excluded('日本国外')
  if (f.isEventRecruit) return excluded('求人/イベント/ポップアップ等')
  if (f.isDup) return excluded('重複')
  if (f.isChain) return excluded('大手チェーン/グループ会社の可能性')
  if (f.isOrg) return excluded('法人/団体/研究会')
  if (f.reviewMany) return excluded('口コミ過多の既存人気店')

  const r: string[] = []
  let s = 0
  if (f.isJapan) { s += 20 }
  if (f.hasShopName) { s += 15 }
  if (f.hasPhone) { s += 25; r.push('電話番号あり') } else { s -= 40 }
  if (f.hasArea) { s += 20; r.push('住所あり') } else { s -= 25 }
  const newness = f.hasOpeningDate || f.isFuture || f.igNew || f.regionalNew || f.newListing
  if (newness) s += 25; else s -= 20
  if (f.hasOpeningDate) { s += 30; r.push('開業日あり') }
  if (f.isFuture) { s += 35; r.push('開業予定(FUTURE_OPENING)') }
  if (f.igNew) { s += 20; r.push('Instagram新店投稿あり') }
  if (f.regionalNew) { s += 25; r.push('地域メディア新店記事あり') }
  if (f.newListing) { s += 20; r.push('新規掲載ページ由来') }
  if (f.placesMatched) { s += 15; r.push('Google Places一致') }
  if (f.hasOfficial) { s += 10 }

  let tier: HotTier = s >= TIER_THRESHOLD.hotA ? 'HOT_A' : s >= TIER_THRESHOLD.hotB ? 'HOT_B' : s >= TIER_THRESHOLD.hold ? 'HOLD' : 'EXCLUDED'
  // 原則: 電話＋住所＋新店根拠＋日本 なら最低 HOT_B
  if (f.hasPhone && f.hasArea && newness && f.isJapan && tier === 'HOLD') tier = 'HOT_B'
  // Google Places単体は誤爆が多い: openingDate/FUTURE が無ければ HOT_A にしない
  if (f.source === 'google_places' && !(f.hasOpeningDate || f.isFuture) && tier === 'HOT_A') tier = 'HOT_B'
  // チェーン/大手の疑い: 電話・住所・新店根拠があってもHOTにせずHOLD止まり（手動確認）
  if (f.chainSuspect && (tier === 'HOT_A' || tier === 'HOT_B')) { tier = 'HOLD'; r.push('チェーン/大手疑いのため手動確認') }
  // 電話番号なしはHOTにしない（設定でallowNoPhone時のみ許可）。住所/公式があってもHOLD
  if (!f.hasPhone && !f.allowNoPhone && (tier === 'HOT_A' || tier === 'HOT_B')) { tier = 'HOLD'; r.push('電話番号未取得のため自動投入不可') }

  const reasonHead = tier === 'HOT_A' ? 'HOT-A（優先架電）' : tier === 'HOT_B' ? 'HOT-B（通常架電）' : tier === 'HOLD' ? 'HOLD（要確認）' : 'EXCLUDED'
  const reason = `${reasonHead}：${r.join(' / ') || '根拠が弱い'}（スコア${s}）${!f.hasOpeningDate && (tier === 'HOT_A' || tier === 'HOT_B') ? '・openingDateなしだが営業可能' : ''}`
  return { tier, score: s, reason, autoImportable: autoImportAllowed(tier, mode), priority: tier === 'HOT_A' ? 'high' : tier === 'HOT_B' ? 'normal' : null }

  function excluded(why: string): TierResult {
    return { tier: 'EXCLUDED', score: -100, reason: `EXCLUDED：${why}`, autoImportable: false, priority: null }
  }
}

/** tier → 既存UIの lead_temperature（HOT_A/HOT_B はまとめて HOT）。hot_tier は A/B を別途保持。 */
export function tierToTemperature(tier: HotTier): { temperature: string; hot_tier: 'A' | 'B' | null } {
  if (tier === 'HOT_A') return { temperature: 'HOT', hot_tier: 'A' }
  if (tier === 'HOT_B') return { temperature: 'HOT', hot_tier: 'B' }
  return { temperature: tier, hot_tier: null }
}

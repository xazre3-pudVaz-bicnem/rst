// ============================================================
// 未投入HOTの一括投入スイープ。サーバー専用。
// 1) 電話/住所が無いHOTはルール上HOT禁止 → HOLDへ降格
// 2) 適格な未投入HOT(電話有効+住所+非除外+案件重複なし)を cases へ投入（架電前メモも転記）
// 自動巡回の各回末尾＋手動ボタンから呼ぶ。重複二重投入はしない。
// ============================================================
import { isJapanPhone, isForeignAddress } from './japanFilter.js'
import { isValidJpPhone } from './regionalParsers.js'
import { onlyDigits, looksLikeArticle, isRealStoreAddress } from './leadQuality.js'
import { detectBigOrPublicStrong, looksLikeBranchStore, IG_FOLLOWERS_IMPORT_EXCLUDE } from './targetFilter.js'
import { detectChain } from './chainFilter.js'
import { placeDetails, reviewDates } from './googlePlacesRun.js'
import { fetchInstagramProfile } from './enrichProfile.js'
import { DEFAULT_STATUS } from './constants.js'

// Instagram URL から username を抽出（p/reel/explore等の非プロフィールは除外）
function igUsername(url?: string | null): string {
  const m = String(url || '').match(/instagram\.com\/([A-Za-z0-9_.]+)/i)
  const u = m?.[1] || ''
  return u && !/^(p|reel|reels|explore|tv|stories|accounts)$/i.test(u) ? u : ''
}

const FIELDS = 'id,name,phone_number,extracted_phone,address,extracted_address,hot_tier,industry,industry_category,website_url,official_url,instagram_url,call_memo,sales_priority_grade,regional_media_newness_reason,search_snippet,auto_import_reason,should_exclude_from_call_list,is_chain_store,is_large_franchise,oldest_review_days_ago,user_rating_count,google_user_rating_count'

// 最古クチコミが30日超 = 既に30日以上前から口コミが付いている＝新規店ではない（投入対象外）。
// クチコミデータが無い(null/0)候補は判定不能なので許可（新規で口コミ0件のケースを弾かないため）。
const MAX_OLDEST_REVIEW_DAYS = 30
function reviewTooOld(c: any): boolean {
  const oldest = Number(c.oldest_review_days_ago)
  return Number.isFinite(oldest) && oldest > MAX_OLDEST_REVIEW_DAYS
}

// Google口コミ30件以上 = 確立済み（新店ではない）→ 除外。連番/地域メディア等でGoogle件数が無い候補はPlacesで確認。
export const BIG_GOOGLE_REVIEWS = 30

// 連番/地域メディア等でGoogleデータが無い候補を、投入前にPlacesで確認する。
// 口コミ件数だけでなく「最古クチコミが何日前か」も取得し、1ヶ月超なら既存店として弾く（tabelog登録は新しくても店は古いケースを捕捉。例: サケノバ=Google口コミ14件・最古1年前）。
export async function placesEstablishmentSignal(mapsKey: string, name: string, address: string): Promise<{ count: number | null; oldestDays: number | null }> {
  try {
    const q = `${name} ${address}`.trim()
    if (!q || !mapsKey) return { count: null, oldestDays: null }
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': mapsKey, 'X-Goog-FieldMask': 'places.id,places.userRatingCount,places.displayName,places.formattedAddress' },
      body: JSON.stringify({ textQuery: q, languageCode: 'ja', regionCode: 'JP', maxResultCount: 1 }),
    })
    if (!res.ok) return { count: null, oldestDays: null }
    const j: any = await res.json()
    const p = j.places?.[0]
    if (!p) return { count: null, oldestDays: null }
    const count = Number(p.userRatingCount || 0)
    let oldestDays: number | null = null
    // 口コミがある候補のみ Place Details で最古クチコミ日を取得（0件はそもそも新規の可能性）
    if (p.id && count > 0) {
      const det = await placeDetails(mapsKey, p.id)
      const oldest = det ? reviewDates(det).oldest : null
      if (oldest) { const d = Math.floor((Date.now() - Date.parse(oldest)) / 86400000); if (Number.isFinite(d)) oldestDays = d }
    }
    return { count, oldestDays }
  } catch { return { count: null, oldestDays: null } }
}

export async function sweepHotToCases(admin: any, opts: { limit?: number; userId?: string | null; mapsKey?: string | null; budgetMs?: number } = {}): Promise<any> {
  const limit = Math.max(1, Math.min(500, opts.limit || 200))
  const userId = opts.userId || null
  const mapsKey = opts.mapsKey || null
  const nowIso = new Date().toISOString()
  // 時間予算（自動巡回の60s枠を守るため）。外部ルックアップ(Places詳細/IGフォロワー)は残り時間があるときだけ実行。
  const deadline = Date.now() + Math.max(3000, opts.budgetMs ?? 600000)
  const { data: rows, error } = await admin.from('lead_candidates').select(FIELDS).eq('lead_temperature', 'HOT').eq('imported_to_cases', false).limit(limit)
  if (error) return { ok: false, error: error.message }
  const list: any[] = rows || []
  let downgraded = 0, imported = 0, linkedDup = 0, skipped = 0, reviewExcluded = 0
  let placesLookups = 0, igLookups = 0, timedOut = false
  const MAX_PLACES = 50, MAX_IG = 40
  for (const c of list) {
    // 予算切れ: 残りは今回スキップ（EXCLUDEDを誤投入しないため、判定不能でも投入はしない＝次回に持ち越し）
    if (Date.now() > deadline) { timedOut = true; break }
    const phone = c.phone_number || c.extracted_phone || ''
    const address = c.address || c.extracted_address || ''
    const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone)
    // 1) 電話/住所なし・国外・除外フラグ → HOLD降格（HOT禁止ルールの是正）
    if (!phoneOk || !address || isForeignAddress(address) || c.should_exclude_from_call_list) {
      await admin.from('lead_candidates').update({ lead_temperature: c.should_exclude_from_call_list ? 'EXCLUDED' : 'HOLD', hot_tier: null, auto_insert_skipped_reason: !phoneOk ? '電話番号なし(HOT禁止)→HOLD' : !address ? '住所なし(HOT禁止)→HOLD' : '除外条件' }).eq('id', c.id)
      downgraded++; continue
    }
    // 1.5) 最古クチコミが30日超 = 既存店（新規ではない）→ 投入せずHOLD降格（候補が自前の最古日を持つ場合）
    if (reviewTooOld(c)) {
      await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: `最古クチコミ${c.oldest_review_days_ago}日前(30日超=既存店)のため新規投入対象外→HOLD` }).eq('id', c.id)
      downgraded++; continue
    }
    // 1.55) Googleデータで確立済み判定。※Googleの件数のみ（連番等のuser_rating_countはサイト側なので使わない）。
    //   件数 or 最古クチコミ日が不明なら Places で確認（上限あり）。tabelog登録が新しくても店が古いケース（Google口コミが1ヶ月超前から付いている）を捕捉。
    let gReviews = c.google_user_rating_count == null ? NaN : Number(c.google_user_rating_count)
    let placesOldestDays: number | null = null
    const ownOldestUnknown = !Number.isFinite(Number(c.oldest_review_days_ago))
    if ((!Number.isFinite(gReviews) || ownOldestUnknown) && mapsKey && placesLookups < MAX_PLACES && Date.now() < deadline - 2500 && (c.name && c.name !== '店名未確定') && address) {
      placesLookups++
      const sig = await placesEstablishmentSignal(mapsKey, c.name, address)
      if (sig.count != null) { gReviews = sig.count; await admin.from('lead_candidates').update({ google_user_rating_count: sig.count }).eq('id', c.id).then(() => {}, () => {}) }
      if (sig.oldestDays != null) placesOldestDays = sig.oldestDays
    }
    // Google口コミ30件以上 = 確立済み → EXCLUDED
    if (Number.isFinite(gReviews) && gReviews >= BIG_GOOGLE_REVIEWS) {
      await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, user_rating_count: gReviews, auto_insert_skipped_reason: `Google口コミ${gReviews}件(30件以上=確立済み)のため除外` }).eq('id', c.id)
      reviewExcluded++; continue
    }
    // 最古クチコミが1ヶ月超（Places取得分も含め全候補に統一適用）= 既存店 → 投入せずHOLD降格
    if (placesOldestDays != null && placesOldestDays > MAX_OLDEST_REVIEW_DAYS) {
      await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, oldest_review_days_ago: placesOldestDays, auto_insert_skipped_reason: `Google最古クチコミ${placesOldestDays}日前(1ヶ月超=既存店)のため新規投入対象外→HOLD` }).eq('id', c.id)
      downgraded++; continue
    }
    // 1.6) 実店舗ではない記事/まとめ・カテゴリ住所・大手チェーン/量販/ショッピングモール → 投入せずHOLD降格
    const gtext = `${c.name || ''} ${c.regional_media_newness_reason || ''} ${c.search_snippet || ''}`
    const bigStrong = detectBigOrPublicStrong(gtext)
    const chainDef = detectChain(c.name || '', c.regional_media_newness_reason || '').definite
    const branch = looksLikeBranchStore(c.name)
    if (looksLikeArticle(c.name, c.regional_media_newness_reason) || !isRealStoreAddress(address) || bigStrong.exclude || chainDef || branch) {
      const why = branch ? '支店/チェーン店（○○店）' : bigStrong.exclude ? `大手/量販/モール(${bigStrong.hit})` : chainDef ? '大手チェーン' : looksLikeArticle(c.name, c.regional_media_newness_reason) ? '記事/まとめ' : 'カテゴリ住所で店舗住所でない'
      await admin.from('lead_candidates').update({ lead_temperature: bigStrong.exclude || chainDef ? 'EXCLUDED' : 'HOLD', hot_tier: null, should_exclude_from_call_list: bigStrong.exclude || chainDef, auto_insert_skipped_reason: `${why}のため投入対象外` }).eq('id', c.id)
      downgraded++; continue
    }
    // 1.7) Instagramフォロワー1000人以上 = 確立済み → 投入しない。IGリンクがある候補のみ確認（ログイン壁で取れない場合はスキップ）。
    const igUser = igUsername(c.instagram_url)
    if (igUser && igLookups < MAX_IG && Date.now() < deadline - 3500) {
      igLookups++
      const prof = await fetchInstagramProfile(igUser).catch(() => null)
      const followers = prof?.followers || 0
      if (followers >= IG_FOLLOWERS_IMPORT_EXCLUDE) {
        await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: `Instagramフォロワー${followers}人(1000人以上=確立済み)のため投入対象外` }).eq('id', c.id)
        reviewExcluded++; continue
      }
    }
    // 2) 既存案件と電話重複なら、二重投入せず候補をリンク
    const digits = onlyDigits(phone)
    const { data: exCase } = await admin.from('cases').select('id').or(`phone1.eq.${phone},phone1.ilike.%${digits}%`).limit(1)
    if (exCase?.[0]) {
      await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: exCase[0].id, auto_insert_skipped_reason: '既存案件と電話重複のためリンク' }).eq('id', c.id)
      linkedDup++; continue
    }
    // 3) 投入
    const name = c.name && c.name !== '店名未確定' ? c.name : (c.name || '（店名未確定）')
    const memo = [`【一括投入 / HOT-${c.hot_tier || 'B'}${c.sales_priority_grade ? ` / 営業${c.sales_priority_grade}` : ''}】`, `理由: ${c.auto_import_reason || c.regional_media_newness_reason || ''}`, `電話: ${phone}`, `住所: ${address}`, ...(c.call_memo ? ['', c.call_memo] : [])].join('\n')
    const { data: created, error: ce } = await admin.from('cases').insert({ name, address, phone1: phone, industry: c.industry || c.industry_category || null, status: DEFAULT_STATUS, priority: c.hot_tier === 'A' ? '高' : '中', hp1: c.website_url || c.official_url || null, instagram: c.instagram_url || null, source_urls: c.auto_import_reason || 'AI一括投入', memo, created_by_id: userId }).select('id').single()
    if (ce || !created?.id) { skipped++; await admin.from('lead_candidates').update({ auto_insert_attempted: true, auto_insert_success: false, auto_insert_error: ce?.message || 'case作成失敗' }).eq('id', c.id); continue }
    await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id, auto_insert_attempted: true, auto_insert_success: true }).eq('id', c.id)
    imported++
  }
  return { ok: true, scanned: list.length, imported, linkedDup, downgraded, reviewExcluded, skipped, timedOut }
}

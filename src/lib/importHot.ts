// ============================================================
// 未投入HOTの一括投入スイープ。サーバー専用。
// 1) 電話/住所が無いHOTはルール上HOT禁止 → HOLDへ降格
// 2) 適格な未投入HOT(電話有効+住所+非除外+案件重複なし)を cases へ投入（架電前メモも転記）
// 自動巡回の各回末尾＋手動ボタンから呼ぶ。重複二重投入はしない。
// ============================================================
import { isJapanPhone, isForeignAddress } from './japanFilter.js'
import { isValidJpPhone, isTollFreeJp } from './regionalParsers.js'
import { onlyDigits, looksLikeArticle, isRealStoreAddress, phoneAddressMatch, isVirtualOfficeAddress } from './leadQuality.js'
import { detectBigOrPublicStrong, detectBigOrPublic, detectSameIndustry, looksLikeBranchStore, detectMultiStore, IG_FOLLOWERS_IMPORT_EXCLUDE } from './targetFilter.js'
import { detectChain } from './chainFilter.js'
import { placeDetails, reviewDates } from './googlePlacesRun.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { fetchInstagramProfile } from './enrichProfile.js'
import { openProx } from './salesScore.js'
import { DEFAULT_STATUS } from './constants.js'

// Web検索スニペットからフォロワー数＋bioを取得（IGログイン壁対策。instagramWebRunと同等のローカル実装＝循環import回避）
async function followersViaSerper(username: string): Promise<{ followers: number | null; bio: string }> {
  const key = process.env.SERPER_API_KEY
  if (!key || !username) return { followers: null, bio: '' }
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 7000)
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: `instagram.com/${username} followers`, gl: 'jp', hl: 'ja', num: 4 }),
    })
    const j: any = await res.json().catch(() => ({})); clearTimeout(to)
    const profRe = new RegExp(`instagram\\.com/${username.replace(/\./g, '\\.')}/?(\\?|$)`, 'i')
    // 最初のマッチで即returnしない: 1件目がフォロワー数なしのリール結果でも後続結果に数が載ることがある
    let matchedBio = ''
    for (const o of (Array.isArray(j.organic) ? j.organic : [])) {
      const text = `${o.title || ''} ${o.snippet || ''}`
      if (!profRe.test(String(o.link || '').split('#')[0]) && !new RegExp(`\\(@${username.replace(/\./g, '\\.')}\\)`, 'i').test(o.title || '')) continue
      let followers: number | null = null
      const m = text.match(/([\d,，]+(?:\.\d+)?)\s*([KkMm万])?\+?\s*(?:人)?\s*(?:Followers|followers|フォロワー)/) || text.match(/フォロワー\s*([\d,，]+(?:\.\d+)?)\s*([KkMm万])?/)
      if (m) {
        let n = Number(String(m[1]).replace(/[,，]/g, ''))
        const unit = (m[2] || '').toLowerCase()
        if (Number.isFinite(n)) {
          if (unit === 'k') n *= 1000
          else if (unit === 'm') n *= 1000000
          else if (m[2] === '万') n *= 10000
          // 0はプレースホルダ/古いバリアントページの可能性があるため「既知の0」とは扱わない（未確認=null）
          if (n > 0 && n < 100000000) followers = Math.round(n)
        }
      }
      if (!matchedBio) matchedBio = String(o.snippet || '').slice(0, 400)
      if (followers != null) return { followers, bio: matchedBio }
    }
    return { followers: null, bio: matchedBio }
  } catch { /* noop */ }
  return { followers: null, bio: '' }
}

// Instagram URL から username を抽出（p/reel/explore等の非プロフィールは除外）
function igUsername(url?: string | null): string {
  const m = String(url || '').match(/instagram\.com\/([A-Za-z0-9_.]+)/i)
  const u = m?.[1] || ''
  return u && !/^(p|reel|reels|explore|tv|stories|accounts)$/i.test(u) ? u : ''
}

const FIELDS = 'id,name,phone_number,extracted_phone,address,extracted_address,hot_tier,industry,industry_category,website_url,official_url,instagram_url,call_memo,sales_priority_grade,sales_priority_score,regional_media_newness_reason,search_snippet,auto_import_reason,should_exclude_from_call_list,is_chain_store,is_large_franchise,oldest_review_days_ago,user_rating_count,google_user_rating_count,phone_source,enriched_phone_source,enriched_address_source,name_unconfirmed_hot,source_detail_url,source_type,business_hours,first_seen_at,opening_date,opening_date_source,opening_date_confidence,days_until_opening,days_since_opening,google_business_status'

// phone_source/address_source の内部値 → 人が読める取得元ラベル
function sourceLabel(v?: string | null): string {
  const map: Record<string, string> = {
    google_places: 'Google Places', places: 'Google Places', google_maps_url: 'GoogleマップURL',
    detail_page: '掲載ページ（詳細）', article: '記事本文', list: '一覧ページ', snippet: '検索スニペット',
    enrich: 'Web補完', instagram_profile: 'Instagramプロフィール', official: '公式サイト',
  }
  return v ? (map[v] || v) : '不明'
}
// 電話番号の取得元（enriched優先）を人が読める形で
function phoneOrigin(c: any): string {
  return sourceLabel(c.enriched_phone_source || c.phone_source)
}

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
/**
 * Places の検索結果が「照会した店舗そのもの」かを確認する。
 * places:searchText は完全一致が無くても近隣の別店を必ず返すため、照合せずに採用すると
 * 「まだGoogleに載っていない新店」に別店の口コミ数が付き、確立済みとして除外されてしまう
 * （＝営業ターゲットである新店を狙い撃ちで落とす）。店名の部分一致＋市区町村の一致で本人確認する。
 */
function placeMatchesQuery(name: string, address: string, displayName: string, formattedAddress: string): boolean {
  const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　・･,，、.。'’"”\-−ー－_（）()【】[\]]/g, '')
  const n = norm(name), d = norm(displayName)
  if (n.length < 2 || d.length < 2) return false
  if (!d.includes(n) && !n.includes(d)) return false      // 店名がどちらにも含まれない＝別店
  const a = norm(address), f = norm(formattedAddress)
  if (!a || !f) return true                                // 住所が無ければ店名一致のみで判断
  const city = address.match(/[一-龥ぁ-んァ-ヶ]{1,8}[市区町村]/)  // 市区町村が違えば同名の別店
  return !city || f.includes(norm(city[0]))
}

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
    // 別店を掴んでいないか本人確認。照合できない＝Google未掲載の可能性が高く新店の重要なサインなので、
    // 既存店シグナルとしては「不明(null)」を返す（呼び出し側は count!=null のときだけ除外判定する）。
    // ここで抜けると後続の Place Details 呼び出しも省けるためAPIコストも減る。
    if (!placeMatchesQuery(name, address, p.displayName?.text || p.displayName || '', p.formattedAddress || '')) {
      return { count: null, oldestDays: null }
    }
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
  // 品質優先の2クエリ窓埋め: sweepは予算切れで途中終了が常態のため「窓に何を入れるか＋処理順」が投入品質を決める。
  // Q1=開業シグナル付き候補（古くても開業目前なら最優先で窓に入れる）、Q2=従来の新しい順で残りを埋める。
  // ※開業予定リードの価値は日単位で減衰する。first_seen_at単独順では「たまたま新しいB級」がHOT-A/開業目前を締め出していた。
  const half = Math.ceil(limit / 2)
  const { data: rowsOpen } = await admin.from('lead_candidates').select(FIELDS)
    .eq('lead_temperature', 'HOT').eq('imported_to_cases', false)
    .or('google_business_status.eq.FUTURE_OPENING,days_until_opening.not.is.null,days_since_opening.lte.30')
    .order('sales_priority_score', { ascending: false, nullsFirst: false })
    .limit(half)
  const { data: rows, error } = await admin.from('lead_candidates').select(FIELDS).eq('lead_temperature', 'HOT').eq('imported_to_cases', false).order('first_seen_at', { ascending: false }).limit(limit)
  if (error) return { ok: false, error: error.message }
  const byId = new Map<string, any>()
  for (const r of [...(rowsOpen || []), ...(rows || [])]) { if (!byId.has(r.id)) byId.set(r.id, r) }
  // 処理順: HOT-A優先 → 開業に近い順（openProx昇順）→ 営業優先度スコア降順 → 新しい順。
  // 予算で打ち切られても常に「最良のprefix」が処理済みになる。
  const list: any[] = [...byId.values()].sort((a, b) =>
    ((a.hot_tier === 'A' ? 0 : 1) - (b.hot_tier === 'A' ? 0 : 1))
    || (openProx(a) - openProx(b))
    || ((Number(b.sales_priority_score) || 0) - (Number(a.sales_priority_score) || 0))
    || (Date.parse(b.first_seen_at || 0) - Date.parse(a.first_seen_at || 0)),
  ).slice(0, limit)
  let downgraded = 0, imported = 0, linkedDup = 0, skipped = 0, reviewExcluded = 0
  let placesLookups = 0, igLookups = 0, timedOut = false
  const MAX_PLACES = 150, MAX_IG = 100
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
    // 1.1) フリーダイヤル/ナビダイヤル(0120/0800/0570) = 店舗直通でない（チェーン/コールセンター）→ 投入せず除外
    if (isTollFreeJp(phone)) {
      await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: `フリーダイヤル(${phone})は店舗直通でないため対象外` }).eq('id', c.id)
      reviewExcluded++; continue
    }
    // 1.2) 固定電話の市外局番と住所の都道府県が不一致 = 別店舗/本社番号の誤抽出の疑い → 投入せずHOLD（架電前に人が確認）
    if (phoneAddressMatch(phone, address) === 'mismatch') {
      await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: `電話(${phone})の市外局番と住所の都道府県が不一致（別店舗/本社番号の誤抽出の疑い）→HOLD` }).eq('id', c.id)
      downgraded++; continue
    }
    // 1.22) バーチャルオフィス/登記用住所 = 実店舗なし開業（MEO/HP営業の対象外）。確定語=EXCLUDED / 汎用語=HOLD
    {
      const vo = isVirtualOfficeAddress(address)
      if (vo.definite) {
        await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: `バーチャルオフィス/登記用住所（${vo.word}）＝実店舗なしのため対象外` }).eq('id', c.id)
        reviewExcluded++; continue
      }
      if (vo.hit) {
        await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: `レンタル/シェアオフィス系住所（${vo.word}）＝実店舗か要確認→HOLD` }).eq('id', c.id)
        downgraded++; continue
      }
    }
    // 1.25) 共有電話番号: 同じ番号が多数の候補に出現＝ポータル転送/代行/掲載用番号（店舗直通でない）→ 投入せずHOLD
    {
      const { count: sharedCands } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).eq('phone_number', phone)
      if ((sharedCands || 0) >= 8) {
        await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: `同一電話番号が候補${sharedCands}件で使用（ポータル転送/代行番号の疑い）→HOLD` }).eq('id', c.id)
        downgraded++; continue
      }
    }
    // 1.28) 同名×同市の既存案件 = 電話違いの同一店 → 二重投入せずリンク
    if (c.name && c.name !== '店名未確定') {
      // 都道府県を先に消費してから市区を取る（『東京都千代田区』を市区トークンにすると県なし住所の案件とマッチしなくなる）
      const cityM = String(address).match(/(?:北海道|東京都|(?:京都|大阪)府|[一-龥]{2,3}県)?([一-龥ぁ-んァ-ヶ0-9０-９]{1,8}?[市区町村])/)
      const cityTok = cityM?.[1] || ''
      const { data: sameName } = await admin.from('cases').select('id,name,address').ilike('name', c.name).limit(3)
      const normNm = (s: string) => String(s || '').replace(/[\s　・&＆'’\-－ー()（）【】\[\]]/g, '').toLowerCase()
      const hitCase = (sameName || []).find((x: any) => normNm(x.name) === normNm(c.name) && (!cityTok || String(x.address || '').includes(cityTok)))
      if (hitCase) {
        await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: hitCase.id, auto_insert_skipped_reason: '同名同市の既存案件があるためリンク（二重投入防止）' }).eq('id', c.id)
        linkedDup++; continue
      }
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
    // 強語(大手/チェーン)の判定は「店名のみ」に対して行う（targetFilter.ts の規約）。
    // 本文/スニペットを渡すと「セブンイレブンの向かい」「スタバから徒歩3分」等のランドマーク記述で
    // 個人店が EXCLUDED＝恒久除外になっていた。他ゲート(importGate.ts / excludeGate.ts)は店名のみで統一済み。
    const gtext = `${c.name || ''} ${c.regional_media_newness_reason || ''} ${c.search_snippet || ''}`
    const bigStrong = detectBigOrPublicStrong(c.name || '')
    const chainDef = detectChain(c.name || '').definite
    const branch = looksLikeBranchStore(c.name)
    // 多店舗は経営主体の文脈を必須にした強語のみ（MULTI_STORE_RE）なので本文も検査してよい
    const multi = detectMultiStore(gtext)  // 2店舗以上/姉妹店/FC（分類時のみ検査で投入ゲートに無かった＝バイパスしていた）
    // 投入ゲート(importGate)と同等にするため、sweepに欠けていた2つを追加。
    // importGateの冒頭コメントは「スイープは自前で同等チェックを実装済み」と宣言していたが実際は欠落しており、
    // (1) 同業者（Web制作/広告代理店/集客コンサル＝自社と同業＝見込み客でない）
    // (2) STRONG_BIG_RE に無い大手/公共（ホールディングス/総合病院/PARCO/ルミネ/生協/SA・PA 等）
    // が sweep 経由で cases に素通りしていた（HOT_Aなら優先架電キューにも乗る）。
    const same = detectSameIndustry(c.name || '')
    const bigPlain = detectBigOrPublic(`${c.name || ''} ${address || ''}`)
    if (looksLikeArticle(c.name, c.regional_media_newness_reason) || !isRealStoreAddress(address) || bigStrong.exclude || chainDef || branch || multi.exclude || same.exclude || bigPlain.exclude) {
      const excludeHard = bigStrong.exclude || chainDef || multi.exclude || same.exclude || bigPlain.exclude
      const why = same.exclude ? `同業者（${same.hit}）` : bigPlain.exclude ? `大手/公共/大型施設（${bigPlain.hit}）` : branch ? '支店/チェーン店（○○店）' : multi.exclude ? `2店舗以上/姉妹店/FC(${String(multi.hit).trim()})` : bigStrong.exclude ? `大手/量販/モール(${bigStrong.hit})` : chainDef ? '大手チェーン' : looksLikeArticle(c.name, c.regional_media_newness_reason) ? '記事/まとめ' : 'カテゴリ住所で店舗住所でない'
      await admin.from('lead_candidates').update({ lead_temperature: excludeHard ? 'EXCLUDED' : 'HOLD', hot_tier: null, should_exclude_from_call_list: excludeHard, auto_insert_skipped_reason: `${why}のため投入対象外` }).eq('id', c.id)
      downgraded++; continue
    }
    // 1.7) Instagramフォロワー1000人以上 = 確立済み → 投入しない。
    //   Instagram由来の候補は「フォロワー数を確認できるまで投入しない」（/p//reel/でユーザー名が取れない・
    //   ログイン壁で不明のまま高フォロワー店がすり抜けていたため）。他ソースはIGリンクがある場合のみ任意確認。
    const isIgSource = /instagram/i.test(String(c.source_type || ''))
    let igUser = igUsername(c.instagram_url)
    if (!igUser && isIgSource) igUser = (String(c.search_snippet || '').match(/@([A-Za-z0-9_.]{3,30})/)?.[1] || '').replace(/\.+$/, '')
    if (isIgSource) {
      if (!igUser) {
        await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: 'Instagramユーザー名が特定できずフォロワー確認不可→手動確認' }).eq('id', c.id)
        downgraded++; continue
      }
      if (igLookups >= MAX_IG || Date.now() >= deadline - 3500) { skipped++; continue }  // 予算切れ: 次回のフォロワー確認へ持ち越し
      igLookups++
      const prof = await fetchInstagramProfile(igUser).catch(() => null)
      // ※fetchInstagramProfileはログイン壁で読めなくてもfollowers:0を返す。0=未確認としてfallbackへ（1000人超のすり抜け防止）
      let followers = prof && typeof prof.followers === 'number' && prof.followers > 0 ? prof.followers : null
      if (followers == null) {
        const web = await followersViaSerper(igUser)  // Webスニペットfallback
        followers = web.followers
        // bioに多店舗/大手語（グループ公式/◯店舗を展開等）→ フォロワー数が読めなくても除外
        if (web.bio && (detectMultiStore(web.bio).exclude || detectBigOrPublicStrong(web.bio).exclude)) {
          await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: 'Instagramプロフィールに多店舗/大手語のため投入対象外' }).eq('id', c.id)
          reviewExcluded++; continue
        }
      }
      if (followers == null) {
        await admin.from('lead_candidates').update({ lead_temperature: 'HOLD', hot_tier: null, auto_insert_skipped_reason: 'Instagramフォロワー数を確認できず（1000人以上の可能性）→手動確認' }).eq('id', c.id)
        downgraded++; continue
      }
      if (followers >= IG_FOLLOWERS_IMPORT_EXCLUDE) {
        await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: `Instagramフォロワー${followers}人(1000人以上=確立済み)のため投入対象外` }).eq('id', c.id)
        reviewExcluded++; continue
      }
    } else if (igUser && igLookups < MAX_IG && Date.now() < deadline - 3500) {
      igLookups++
      const prof = await fetchInstagramProfile(igUser).catch(() => null)
      // 非IGソースは「確認できたら除外」の任意チェック（未確認はHOLDにしない）。
      // ただしログイン壁でprofが0のときはWebスニペットでも確認する（1000人超の大手すり抜け防止）
      let followers = prof && typeof prof.followers === 'number' && prof.followers > 0 ? prof.followers : null
      if (followers == null && Date.now() < deadline - 3500) followers = (await followersViaSerper(igUser)).followers
      if ((followers ?? 0) >= IG_FOLLOWERS_IMPORT_EXCLUDE) {
        await admin.from('lead_candidates').update({ lead_temperature: 'EXCLUDED', hot_tier: null, should_exclude_from_call_list: true, auto_insert_skipped_reason: `Instagramフォロワー${followers}人(1000人以上=確立済み)のため投入対象外` }).eq('id', c.id)
        reviewExcluded++; continue
      }
    }
    // 2) 既存案件と電話重複なら、二重投入せず候補をリンク。
    //    ※桁が欠けた部分番号(%digits%)は無関係な案件に誤マッチして"重複扱い"で新店を握り潰すため、
    //      完全な10/11桁のときだけ末尾10桁で照合する。
    //    ※phone1は『03-1234-5678』等ハイフン付きで保存されるため、連続10桁のilikeでは一致しない。
    //      ハイフンを跨がない末尾4桁で粗く引いてから数字正規化で厳密照合する。
    const digits = onlyDigits(phone)
    const dial = digits.slice(-10)
    let exCase: any[] | null = null
    if (digits.length === 10 || digits.length === 11) {
      // 末尾アンカー（%last4）: 電話番号は末尾4桁で終わるため後方一致で十分。%last4%だと市外局番等の中間4桁にも
      // 当たり、候補件数がlimitを超えて真の重複がページ外に落ちる（重複案件を作る）リスクが上がる
      const { data: rough } = await admin.from('cases').select('id,phone1').ilike('phone1', `%${digits.slice(-4)}`).limit(60)
      exCase = (rough || []).filter((x: any) => onlyDigits(String(x.phone1 || '')).endsWith(dial)).slice(0, 1)
    }
    if (exCase?.[0]) {
      await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: exCase[0].id, auto_insert_skipped_reason: '既存案件と電話重複のためリンク' }).eq('id', c.id)
      linkedDup++; continue
    }
    // 3) 投入
    const name = c.name && c.name !== '店名未確定' ? c.name : (c.name || '（店名未確定）')
    const nameUnclear = !c.name || c.name === '店名未確定'
    const origin = phoneOrigin(c)
    // 開業タイミング（メモ・priority・自動再コールで共用）。
    // 信用条件: (1) opening_date列がある行のみ「投入時点の値」で再計算して使う（days_*スナップショットは
    //   発見からの経過日数ぶんズレており、そのまま使うと再コールが開業後に飛ぶ事故になる）
    // (2) テキスト由来（article_text_*）は確度60以上かつ月のみ精度でない場合のみ信用
    //   （開業予定キューと同じゲート。conf30の「7月オープン」→7/1丸めで再コール登録される穴を塞ぐ）
    const srcOd = String(c.opening_date_source || '')
    const isTextOd = /^article_text/.test(srcOd)
    const odTrusted = !!c.opening_date && (!isTextOd || (Number(c.opening_date_confidence ?? 0) >= 60 && !/month$/.test(srcOd)))
    let duo: number | null = null
    let dso: number | null = null
    if (odTrusted) {
      const t = Date.parse(String(c.opening_date).slice(0, 10) + 'T00:00:00+09:00')
      if (Number.isFinite(t)) { const diff = Math.round((t - Date.now()) / 86400000); duo = diff >= 0 ? diff : null; dso = diff < 0 ? -diff : null }
    }
    const openSoon = (duo != null && duo >= 0) || (dso != null && dso >= 0 && dso <= 14) || c.google_business_status === 'FUTURE_OPENING'
    const openLine = duo != null ? `開業予定: ${c.opening_date || ''}（あと${duo}日）→ 開業前はGBP整備・HP・MEO提案の黄金期。今すぐ接触が最適` :
      (dso != null && dso <= 30) ? `開業: ${c.opening_date || ''}（${dso}日前にオープン）→ 開業直後で集客整備の提案最適期` :
      c.google_business_status === 'FUTURE_OPENING' ? '開業前(FUTURE_OPENING)→ 開業前提案の黄金期' : ''
    const memo = [
      `【一括投入 / HOT-${c.hot_tier || 'B'}${c.sales_priority_grade ? ` / 営業${c.sales_priority_grade}` : ''}${openSoon ? ' / 開業近接' : ''}】`,
      `店名: ${nameUnclear ? '店名未確定' : name}`,
      `電話: ${phone}　←取得元: ${origin}`,
      `住所: ${address}${c.enriched_address_source ? `（取得元: ${sourceLabel(c.enriched_address_source)}）` : ''}`,
      ...(openLine ? [openLine] : []),
      ...(nameUnclear ? [`⚠️ 店名が未確定です。この電話番号（取得元: ${origin}）が対象店のものか、架電前に住所・${c.source_detail_url ? '掲載ページ' : '検索'}で店名をご確認ください。`] : []),
      `理由: ${c.auto_import_reason || c.regional_media_newness_reason || ''}`,
      ...(c.source_detail_url ? [`掲載元: ${c.source_detail_url}`] : []),
      ...(c.call_memo ? ['', c.call_memo] : []),
    ].join('\n')
    // priority: HOT-A / 開業近接 / 営業S は「高」（開業タイミングを逃さない）
    const priorityHigh = c.hot_tier === 'A' || openSoon || c.sales_priority_grade === 'S'
    const { data: created, error: ce } = await admin.from('cases').insert({ name, address, phone1: phone, industry: normalizeIndustry(c.industry) || classifyIndustry(name) || normalizeIndustry(c.industry_category) || null, status: DEFAULT_STATUS, priority: priorityHigh ? '高' : '中', hp1: c.website_url || c.official_url || null, instagram: c.instagram_url || null, business_hours: c.business_hours || null, source_urls: c.auto_import_reason || 'AI一括投入', memo, created_by_id: userId }).select('id').single()
    if (ce || !created?.id) { skipped++; await admin.from('lead_candidates').update({ auto_insert_attempted: true, auto_insert_success: false, auto_insert_error: ce?.message || 'case作成失敗' }).eq('id', c.id); continue }
    await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id, auto_insert_attempted: true, auto_insert_success: true }).eq('id', c.id)
    imported++
    // 開業日ドリブンの自動再コール（runOpeningSoonQueueから移植: sweepが先に投入するとimported_to_cases=trueで
    // queueの対象外になり再コールが永久に未登録になる穴を塞ぐ）。開業4日以上先なら「開業3日前の10:00 JST」に登録。
    if (duo != null && duo >= 4) {
      try {
        const { data: exR } = await admin.from('recalls').select('id').eq('case_id', created.id).eq('done', false).limit(1)
        if (!exR?.[0]) {
          // VercelはUTC実行のためsetHours(10)だと19:00 JSTかつJST深夜帯は日付が1日ズレる。JST暦日で(duo-3)日後の01:00 UTC(=10:00 JST)
          const jstBase = new Date(Date.now() + 9 * 3600000 + (duo - 3) * 86400000)
          const target = new Date(Date.UTC(jstBase.getUTCFullYear(), jstBase.getUTCMonth(), jstBase.getUTCDate(), 1, 0, 0))
          await admin.from('recalls').insert({ case_id: created.id, case_name: name, target_at: target.toISOString(), done: false, memo: `開業${duo}日前に投入（自動）。開業3日前アプローチ: GBP整備・HP・MEOは開業前が最適。`, created_by_id: userId })
        }
      } catch { /* noop */ }
    }
  }
  return { ok: true, scanned: list.length, imported, linkedDup, downgraded, reviewExcluded, skipped, timedOut }
}

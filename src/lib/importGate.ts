// ============================================================
// 統一投入前ゲート（全ソース共通の最終関門）。サーバー専用。
// cases への自動投入直前に必ず通す。経路ごとのチェック漏れ（IWフォロワー/支店名/既存店/地域不一致 等の
// すり抜けバグが個別実装で繰り返し発生した）を構造的に根絶する。
// 判定: ok=true → 投入可 / action='hold'|'exclude' → 候補を降格して投入しない / linkCaseId → 既存案件へリンク。
// ※注意: importHot(スイープ)からは呼ばない（placesEstablishmentSignalの循環importを避けるため。
//   スイープは自前で同等チェックを実装済み）。
// ============================================================
import { isJapanPhone, isForeignAddress } from './japanFilter.js'
import { isValidJpPhone, isTollFreeJp } from './regionalParsers.js'
import { isRealStoreAddress, phoneAddressMatch, onlyDigits } from './leadQuality.js'
import { detectBigOrPublic, detectBigOrPublicStrong, detectMultiStore, looksLikeBranchStore } from './targetFilter.js'
import { detectChain } from './chainFilter.js'
import { placesEstablishmentSignal, BIG_GOOGLE_REVIEWS } from './importHot.js'

export interface GateInput {
  name: string; phone: string; address: string
  text?: string                 // 周辺テキスト（多店舗/チェーン検出の補助）
  mapsKey?: string | null
  skipEstablishment?: boolean   // 呼び出し元が既にGoogle口コミ既存店チェック済みならtrue
  budgetEndMs?: number          // これを過ぎる外部確認はスキップ（時間予算の死守）
}
export interface GateResult { ok: boolean; action: 'import' | 'hold' | 'exclude' | 'link'; reason: string; linkCaseId?: string | null }

const pass: GateResult = { ok: true, action: 'import', reason: '' }
const hold = (reason: string): GateResult => ({ ok: false, action: 'hold', reason })
const exclude = (reason: string): GateResult => ({ ok: false, action: 'exclude', reason })

// 住所から市区町村トークンを抽出（同名同市の重複案件検出用）。
// 都道府県を先に消費してから市区を取る（『東京都千代田区』を返すと県なし住所の案件とマッチしなくなる）。
function cityOf(address: string): string {
  const m = String(address || '').match(/(?:北海道|東京都|(?:京都|大阪)府|[一-龥]{2,3}県)?([一-龥ぁ-んァ-ヶ0-9０-９]{1,8}?[市区町村])/)
  return m ? m[1] : ''
}
const normName = (s: string) => String(s || '').replace(/[\s　・&＆'’\-－ー()（）【】\[\]]/g, '').toLowerCase()

export async function caseImportGate(admin: any, g: GateInput): Promise<GateResult> {
  const name = String(g.name || '').trim()
  const phone = String(g.phone || '').trim()
  const address = String(g.address || '').trim()
  const budgetEnd = g.budgetEndMs || (Date.now() + 20000)

  // 1) 電話（HOTの絶対条件）: 日本の有効な番号・フリーダイヤル/ナビダイヤル不可
  if (!phone || !isJapanPhone(phone) || !isValidJpPhone(phone)) return hold('電話番号なし/無効（投入ゲート）')
  if (isTollFreeJp(phone)) return exclude(`フリーダイヤル(${phone})は店舗直通でないため対象外（投入ゲート）`)
  // 2) 住所: 実店舗住所・国内
  if (!address || !isRealStoreAddress(address) || isForeignAddress(address)) return hold('実店舗住所なし/国外（投入ゲート）')
  // 3) 電話×住所の地域整合（固定電話の市外局番と都道府県の不一致=別店舗/本社番号の誤抽出）
  if (phoneAddressMatch(phone, address) === 'mismatch') return hold(`電話(${phone})と住所の地域不一致（誤抽出/本社番号の疑い・投入ゲート)`)
  // 4) 店名: チェーン/支店(○○店)/大手・公共/多店舗
  if (name && name !== '店名未確定') {
    if (detectChain(name, g.text || '').definite) return exclude('大手チェーンのため対象外（投入ゲート）')
    if (looksLikeBranchStore(name)) return exclude('支店/チェーン店名（○○店）のため対象外（投入ゲート）')
    const big = detectBigOrPublic(`${name} ${address}`)
    if (big.exclude) return exclude(`${big.hit}（大手/公共/大型施設）のため対象外（投入ゲート）`)
    const bigStrong = detectBigOrPublicStrong(name)
    if (bigStrong.exclude) return exclude(`${bigStrong.hit}（大手）のため対象外（投入ゲート）`)
  }
  const multi = detectMultiStore(`${name} ${(g.text || '').slice(0, 300)}`)
  if (multi.exclude) return exclude(`多店舗/FC(${String(multi.hit).trim()})のため対象外（投入ゲート）`)

  // 5) 共有電話番号の検出: 同じ番号が多数の候補に出現＝ポータル転送/代行/掲載用番号の可能性（店舗直通でない）
  const digits = onlyDigits(phone)
  try {
    const { count: sharedCands } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).eq('phone_number', phone)
    if ((sharedCands || 0) >= 8) return hold(`同一電話番号が候補${sharedCands}件で使用（ポータル転送/代行番号の疑い・投入ゲート）`)
  } catch { /* noop */ }
  // 既に2件以上の案件で同じ番号が使われている場合も共有番号の疑い（1件なら呼び出し元がリンク処理する）
  // ※phone1はハイフン付き保存が多く連続10桁のilikeでは一致しない → 末尾4桁で粗く引いて数字正規化で厳密照合
  try {
    if (digits.length >= 10) {
      const dial = digits.slice(-10)
      // 末尾アンカー（%last4）: 中間4桁への誤ヒットで候補がlimitを超え、真の共有番号がページ外に落ちるのを防ぐ
      const { data: rough } = await admin.from('cases').select('id,phone1').ilike('phone1', `%${digits.slice(-4)}`).limit(80)
      const sharedCases = (rough || []).filter((c: any) => onlyDigits(String(c.phone1 || '')).endsWith(dial)).length
      if (sharedCases >= 2) return hold(`同一電話番号が既存案件${sharedCases}件に存在（共有番号の疑い・投入ゲート）`)
    }
  } catch { /* noop */ }

  // 6) 同名×同市の既存案件 = 電話違いの同一店（別回線/番号変更）→ 二重投入せずリンク
  if (name && name !== '店名未確定' && address) {
    try {
      const city = cityOf(address)
      const { data: sameName } = await admin.from('cases').select('id,name,address').ilike('name', name).limit(3)
      const hit = (sameName || []).find((c: any) => normName(c.name) === normName(name) && (!city || String(c.address || '').includes(city)))
      if (hit) return { ok: false, action: 'link', reason: `同名同市の既存案件があるためリンク（二重投入防止・投入ゲート）`, linkCaseId: hit.id }
    } catch { /* noop */ }
  }

  // 7) 既存店ガード（Google口コミ30件以上/最古クチコミ30日超）。呼び出し元が確認済みならスキップ。
  if (!g.skipEstablishment && g.mapsKey && name && name !== '店名未確定' && Date.now() < budgetEnd - 8000) {
    try {
      const est = await Promise.race([
        placesEstablishmentSignal(g.mapsKey, name, address),
        new Promise<{ count: null; oldestDays: null }>((rs) => setTimeout(() => rs({ count: null, oldestDays: null }), 7000)),
      ])
      if (est.count != null && est.count >= BIG_GOOGLE_REVIEWS) return exclude(`Google口コミ${est.count}件(30件以上=確立済み)のため対象外（投入ゲート）`)
      if (est.oldestDays != null && est.oldestDays > 30) return hold(`Google最古クチコミ${est.oldestDays}日前(1ヶ月超=既存店)のため投入対象外（投入ゲート）`)
    } catch { /* noop */ }
  }

  return pass
}

/** ゲート否認時の候補降格を1行で行うヘルパ。 */
export async function applyGateDowngrade(admin: any, candidateId: string | null, gate: GateResult): Promise<void> {
  if (!candidateId || gate.ok) return
  if (gate.action === 'link' && gate.linkCaseId) {
    await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: new Date().toISOString(), imported_case_id: gate.linkCaseId, auto_insert_skipped_reason: gate.reason }).eq('id', candidateId).then(() => {}, () => {})
    return
  }
  await admin.from('lead_candidates').update({
    lead_temperature: gate.action === 'exclude' ? 'EXCLUDED' : 'HOLD', hot_tier: null,
    should_exclude_from_call_list: gate.action === 'exclude', auto_insert_skipped_reason: gate.reason,
  }).eq('id', candidateId).then(() => {}, () => {})
}

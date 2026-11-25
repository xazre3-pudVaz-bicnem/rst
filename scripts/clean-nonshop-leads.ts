/* ============================================================
 * 既存データの掃除: 件名が「店名でない」案件／チェーンの案件を整理する
 *   npm run clean:leads            … 変更せず内容だけ表示（ドライラン）
 *   npm run clean:leads -- --apply … 実際に更新する
 *
 * 判定の順番（何度実行しても同じ結果になるよう、現在の件名だけを基準に判断する）
 *   1. 今の件名が店名として問題なし → 何もしない
 *   2. 今の件名が チェーン/支店/大手/公共/対象外カテゴリ → ステータス「対象外案件」
 *   3. 今の件名がページタイトル/UI文字列/断片           → ステータス「対象外案件」
 *   4. 「店名未確定」→ 現行仕様で許容しているので触らない
 *
 * 【件名の自動復元はしない】候補の search_title から実店名を取り直す処理を入れて実行したが、
 *   search_title 自体が記事タイトルであることが多く（「鍼灸院 開業の完全ガイド」「エステサロン開業の
 *   全手順」＝同業の記事、「◯◯市/◯◯駅の宿泊施設 - EPARK」＝ポータル見出し）、
 *   196件中おおよそ半分が記事の断片に置き換わってしまった。店名を名乗れない案件は架電もできないので、
 *   対象外にして候補側（lead_candidates）に電話・住所を残し、実店名が取れたら再投入する方針にする。
 *
 * 安全策: アポ・進行中ステータスの案件は触らない。削除は一切しない（ステータス変更のみ）。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'
import { looksNotShopName, detectBigOrPublic, detectBigOrPublicStrong, detectMultiStore, looksLikeBranchStore, detectExcludedCategory, detectClosureNews } from '../src/lib/targetFilter.js'
import { detectChain } from '../src/lib/chainFilter.js'
import { brandKey, CHAIN_MIN_CITIES } from '../src/lib/chainLearn.js'

const APPLY = process.argv.includes('--apply')
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || ''
const UNCONFIRMED = ['店名未確定', '（店名未確定）']
/** 営業判断が入っている案件は触らない */
const TOUCHABLE_STATUS = ['新規', '失注', '対象外案件']

async function main() {
  if (!DB_URL) { console.error('✗ SUPABASE_DB_URL が未設定です（.env）'); process.exit(1) }
  const c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  const q = async (s: string, p: any[] = []) => (await c.query(s, p)).rows
  console.log(`=== 店名クリーニング（${APPLY ? '実行' : 'ドライラン'}） ===\n`)

  // 学習済みチェーンブランド
  const brands = new Map<string, { brand: string; city_count: number }>()
  for (const r of await q(`select brand, brand_key, city_count from chain_brands where city_count >= ${CHAIN_MIN_CITIES}`)) {
    brands.set(r.brand_key, { brand: r.brand, city_count: r.city_count })
  }
  console.log(`学習済みチェーンブランド: ${brands.size}件`)

  /** 店名が営業対象外（チェーン/支店/大手/公共/対象外カテゴリ）なら理由を返す。
   *  ※chainFilterの「疑い(suspect)」は使わない（「グループトレーニング」等の誤検知が出るため） */
  const outOfScope = (name: string): string => {
    const n = String(name || '')
    const lb = brands.get(brandKey(n))
    if (lb) return `チェーン（自社データで「${lb.brand}」の支店を${lb.city_count}市区町村で確認）`
    if (detectClosureNews(n).exclude) return '閉店/休業の見出し'
    if (detectChain(n).definite) return '大手チェーン'
    const ex = detectExcludedCategory(n); if (ex.exclude) return `対象外カテゴリ(${ex.hit})`
    if (looksLikeBranchStore(n)) return '支店/チェーン店名(○○店)'
    const b = detectBigOrPublic(n); if (b.exclude) return `大手/公共/大型(${b.hit})`
    const bs = detectBigOrPublicStrong(n); if (bs.exclude) return `大手(${bs.hit})`
    if (detectMultiStore(n).exclude) return '多店舗/FC'
    return ''
  }

  // ---- 1) 候補の降格（HOTで店名でないもの。投入済みも含む＝AI投入リストのHOTに出続けるため） ----
  const cands = await q(`
    select id, name, imported_to_cases from lead_candidates
    where lead_temperature in ('HOT','WARM') and name is not null`)
  const toHold = cands.filter((r: any) => looksNotShopName(r.name).bad)
  console.log(`\n[1] HOTで店名でないもの: ${toHold.length}件 → HOLDへ降格（うち投入済み ${toHold.filter((r: any) => r.imported_to_cases).length}件）`)
  if (APPLY && toHold.length) {
    for (let i = 0; i < toHold.length; i += 500) {
      await c.query(
        `update lead_candidates set lead_temperature='HOLD', hot_tier=null,
           auto_insert_skipped_reason='店名がページタイトル/UI文字列のため投入せず（実店名の再取得待ち）'
         where id = any($1::uuid[])`, [toHold.slice(i, i + 500).map((r: any) => r.id)])
    }
    console.log(`     → ${toHold.length}件を降格しました`)
  }

  // ---- 2) 案件の件名修正 / 対象外化 ----
  const caseRows = await q(`select id, name, status from cases`)
  const candRows = await q(`select id, imported_case_id from lead_candidates where imported_case_id is not null`)
  const appoRows = await q(`select distinct case_id from appointments where case_id is not null`)
  const candByCase = new Map<string, any>()
  for (const r of candRows) if (!candByCase.has(r.imported_case_id)) candByCase.set(r.imported_case_id, r)
  const appoSet = new Set(appoRows.map((r: any) => r.case_id))

  const disable: any[] = []; const skipped: any[] = []
  for (const r of caseRows) {
    const cur = String(r.name || '')
    if (UNCONFIRMED.includes(cur)) continue                          // 4. 店名未確定は現行仕様で許容
    const nb = looksNotShopName(cur)
    const oos = outOfScope(cur)
    if (!nb.bad && !oos) continue                                    // 1. 問題なし
    if (appoSet.has(r.id) || !TOUCHABLE_STATUS.includes(String(r.status))) { skipped.push(r); continue }
    if (r.status === '対象外案件') continue
    disable.push({ ...r, why: oos || nb.reason, cand_id: candByCase.get(r.id)?.id || null })     // 2/3
  }

  console.log(`\n[2] 「対象外案件」にする: ${disable.length}件`)
  const whyCount = new Map<string, number>()
  for (const r of disable) { const k = String(r.why).replace(/（.*/, ''); whyCount.set(k, (whyCount.get(k) || 0) + 1) }
  for (const [k, v] of [...whyCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}件 ${k}`)
  for (const r of disable.slice(0, 12)) console.log(`       例: 「${String(r.name).slice(0, 26)}」 ${String(r.why).slice(0, 44)}`)
  console.log(`\n[3] アポ/進行中のため触らない案件: ${skipped.length}件`)

  if (APPLY) {
    const today = new Date().toISOString().slice(0, 10)
    for (let i = 0; i < disable.length; i += 300) {
      const chunk = disable.slice(i, i + 300)
      await c.query(
        `update cases set status='対象外案件',
           memo = coalesce(memo,'') || '\n【自動判定】営業対象外（店名クリーニング ' || $2 || '）'
         where id = any($1::uuid[])`, [chunk.map((r) => r.id), today])
      const candIds = chunk.map((r) => r.cand_id).filter(Boolean)
      if (candIds.length) {
        await c.query(
          `update lead_candidates set lead_temperature='EXCLUDED', hot_tier=null, should_exclude_from_call_list=true,
             auto_insert_skipped_reason='店名クリーニングで営業対象外と判定（チェーン/支店/大手/店名復元不可）'
           where id = any($1::uuid[])`, [candIds])
      }
    }
    console.log(`\n→ 対象外案件 ${disable.length}件 を更新しました`)
  } else {
    console.log('\n※ ドライランです。実行するには --apply を付けてください')
  }
  await c.end()
}
main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

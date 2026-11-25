/* ============================================================
 * 既存データの掃除: 店名が「店名でない」案件／チェーンの案件を整理する
 *   npm run clean:leads            … 変更せず内容だけ表示（ドライラン）
 *   npm run clean:leads -- --apply … 実際に更新する
 *
 * やること
 *  1) 候補(lead_candidates)で店名がページタイトル/UI文字列のもの（未投入）→ HOLDへ降格
 *     ＝ AI投入リストのHOTから外す。電話/住所は残すので店名を取り直せば復活できる
 *  2) 案件(cases)で件名が「Google」「ご予約内容の選択」等のもの
 *     - 候補の search_title から実店名を復元できる → 件名を書き換え
 *     - 復元した名前がチェーン/支店/大手/対象外カテゴリ → ステータス「対象外案件」
 *     - 復元できない → ステータス「対象外案件」（架電リストから外れる）
 *  3) 案件の件名が学習済みチェーンブランドと一致 → ステータス「対象外案件」
 *
 * 安全策: アポがある案件は絶対に触らない。削除は一切しない（ステータス変更と件名修正だけ）。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'
import { looksNotShopName, detectBigOrPublic, detectBigOrPublicStrong, detectMultiStore, looksLikeBranchStore, detectExcludedCategory, detectClosureNews } from '../src/lib/targetFilter.js'
import { detectChain } from '../src/lib/chainFilter.js'
import { sanitizeShopName } from '../src/lib/regionalParsers.js'
import { brandKey, CHAIN_MIN_CITIES } from '../src/lib/chainLearn.js'

const APPLY = process.argv.includes('--apply')
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || ''

/** 復元した店名が営業対象外（チェーン/支店/大手/公共/対象外カテゴリ）か */
function outOfScope(name: string): string {
  if (detectClosureNews(name).exclude) return '閉店/休業の見出し'
  if (detectChain(name).definite) return '大手チェーン'
  const ex = detectExcludedCategory(name); if (ex.exclude) return `対象外カテゴリ(${ex.hit})`
  if (looksLikeBranchStore(name)) return '支店/チェーン店名(○○店)'
  const b = detectBigOrPublic(name); if (b.exclude) return `大手/公共/大型(${b.hit})`
  const bs = detectBigOrPublicStrong(name); if (bs.exclude) return `大手(${bs.hit})`
  if (detectMultiStore(name).exclude) return '多店舗/FC'
  return ''
}

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

  // ---- 1) 候補の降格（未投入のみ） ----
  const cands = await q(`
    select id, name, lead_temperature from lead_candidates
    where imported_to_cases = false and lead_temperature in ('HOT','WARM') and name is not null`)
  const toHold = cands.filter((r: any) => looksNotShopName(r.name).bad)
  console.log(`\n[1] 未投入HOTのうち店名でないもの: ${toHold.length}件 → HOLDへ降格`)
  for (const r of toHold.slice(0, 8)) console.log(`     「${String(r.name).slice(0, 36)}」`)
  if (APPLY && toHold.length) {
    for (let i = 0; i < toHold.length; i += 500) {
      const ids = toHold.slice(i, i + 500).map((r: any) => r.id)
      await c.query(
        `update lead_candidates set lead_temperature='HOLD', hot_tier=null,
           auto_insert_skipped_reason='店名がページタイトル/UI文字列のため投入せず（実店名の再取得待ち）'
         where id = any($1::uuid[])`, [ids])
    }
    console.log(`     → ${toHold.length}件を降格しました`)
  }

  // ---- 2)(3) 案件の件名修正 / 対象外化 ----
  // 相関サブクエリは15,000案件×10万候補でタイムアウトするため、素のSELECTを4本に分けてJS側で突き合わせる
  const caseRows = await q(`select id, name, status, phone1, address from cases`)
  const candRows = await q(`select id, imported_case_id, search_title, lead_temperature from lead_candidates where imported_case_id is not null`)
  const appoRows = await q(`select distinct case_id from appointments where case_id is not null`)
  const callRows = await q(`select distinct case_id from call_logs where case_id is not null`)
  const candByCase = new Map<string, any>()
  for (const r of candRows) if (!candByCase.has(r.imported_case_id) || r.search_title) candByCase.set(r.imported_case_id, r)
  const appoSet = new Set(appoRows.map((r: any) => r.case_id))
  const callSet = new Set(callRows.map((r: any) => r.case_id))
  const cases = caseRows.map((r: any) => {
    const cd = candByCase.get(r.id)
    return { ...r, search_title: cd?.search_title || null, cand_id: cd?.id || null, has_appo: appoSet.has(r.id), has_call: callSet.has(r.id) }
  })
  const rename: any[] = []; const disable: any[] = []; const skipped: any[] = []
  for (const r of cases) {
    const name = String(r.name || '')
    const nb = looksNotShopName(name)
    const chainHit = brands.get(brandKey(name))
    // 「店名未確定」の案件は現行仕様で許容しているので対象外化はしない。
    // ただし search_title から実店名が復元できるなら件名を直す（架電時に店名が分かるようになる）
    const unconfirmed = name === '店名未確定' || name === '（店名未確定）'
    if (!nb.bad && !chainHit && !unconfirmed) continue
    if (r.has_appo) { skipped.push(r); continue }          // アポ済みは触らない
    if (r.status === '対象外案件') continue
    if (unconfirmed) {
      const sn0 = r.search_title ? sanitizeShopName(String(r.search_title)) : { name: '', valid: false, reason: '' }
      // 復元できない / 復元結果が同じ（search_titleが「店名未確定」のまま）なら触らない
      if (!sn0.valid || /店名未確定/.test(sn0.name) || brandKey(sn0.name) === brandKey(name)) continue
      const oos0 = outOfScope(sn0.name) || (brands.get(brandKey(sn0.name)) ? 'チェーン（学習ブランド）' : '')
      if (oos0) disable.push({ ...r, why: `実店名「${sn0.name}」は${oos0}`, resolved: sn0.name })
      else rename.push({ ...r, resolved: sn0.name })
      continue
    }
    if (chainHit && !nb.bad) { disable.push({ ...r, why: `チェーン（自社データで「${chainHit.brand}」の支店を${chainHit.city_count}市区町村で確認）` }); continue }
    // search_title から実店名を復元
    const sn = r.search_title ? sanitizeShopName(String(r.search_title)) : { name: '', valid: false, reason: '' }
    if (sn.valid) {
      const oos = outOfScope(sn.name) || (brands.get(brandKey(sn.name)) ? 'チェーン（学習ブランド）' : '')
      if (oos) disable.push({ ...r, why: `実店名「${sn.name}」は${oos}`, resolved: sn.name })
      else rename.push({ ...r, resolved: sn.name })
    } else {
      disable.push({ ...r, why: nb.reason || '店名が復元できず' })
    }
  }
  console.log(`\n[2] 件名を実店名に修正できる案件: ${rename.length}件`)
  for (const r of rename.slice(0, 12)) console.log(`     「${String(r.name).slice(0, 18).padEnd(18)}」→「${r.resolved}」`)
  console.log(`\n[3] 「対象外案件」にする案件: ${disable.length}件（うち架電済み ${disable.filter((r) => r.has_call).length}件）`)
  const whyCount = new Map<string, number>()
  for (const r of disable) { const k = String(r.why).replace(/（.*/, '').replace(/「.*?」は/, ''); whyCount.set(k, (whyCount.get(k) || 0) + 1) }
  for (const [k, v] of [...whyCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}件 ${k}`)
  for (const r of disable.slice(0, 10)) console.log(`       例: 「${String(r.name).slice(0, 20)}」 ${r.why}`)
  console.log(`\n[4] アポがあるため触らない案件: ${skipped.length}件`)
  const stDist = new Map<string, number>()
  for (const r of disable) stDist.set(String(r.status || '-'), (stDist.get(String(r.status || '-')) || 0) + 1)
  console.log(`[5] 対象外にする案件の現在ステータス: ${[...stDist.entries()].map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  // 進行中（見込み/折返し待ち/アポ/成約 等）は営業の判断が入っているので触らない
  const inProgress = disable.filter((r) => !['新規', '対象外案件', '失注'].includes(String(r.status)))
  if (inProgress.length) {
    console.log(`     ※ 進行中ステータスのため対象外化しない: ${inProgress.length}件`)
    for (const r of inProgress.slice(0, 10)) console.log(`       「${String(r.name).slice(0, 22)}」 ${r.status}`)
  }
  const disableSafe = disable.filter((r) => ['新規', '失注'].includes(String(r.status)))

  if (APPLY) {
    for (const r of rename) {
      await c.query(`update cases set name=$1, memo = coalesce(memo,'') || $2 where id=$3`,
        [r.resolved, `\n【自動修正】件名「${r.name}」はページタイトルだったため実店名に修正（${new Date().toISOString().slice(0, 10)}）`, r.id])
      if (r.cand_id) await c.query(`update lead_candidates set name=$1, extracted_shop_name=$1 where id=$2`, [r.resolved, r.cand_id])
    }
    for (let i = 0; i < disableSafe.length; i += 300) {
      const chunk = disableSafe.slice(i, i + 300)
      await c.query(
        `update cases set status='対象外案件',
           memo = coalesce(memo,'') || '\n【自動判定】' || $2 || '（店名クリーニング）'
         where id = any($1::uuid[])`, [chunk.map((r) => r.id), '営業対象外'])
      // 候補側もHOTから外す（AI投入リストに残り続けないように）
      const candIds = chunk.map((r) => r.cand_id).filter(Boolean)
      if (candIds.length) {
        await c.query(
          `update lead_candidates set lead_temperature='EXCLUDED', hot_tier=null, should_exclude_from_call_list=true,
             auto_insert_skipped_reason='店名クリーニングで営業対象外と判定（チェーン/支店/大手/店名復元不可）'
           where id = any($1::uuid[])`, [candIds])
      }
    }
    console.log(`\n→ 件名修正 ${rename.length}件 / 対象外案件 ${disableSafe.length}件 を更新しました`)
  } else {
    console.log('\n※ ドライランです。実行するには --apply を付けてください')
  }
  await c.end()
}
main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

/* ============================================================
 * 連番探索の配分を実績（架電→アポ率）に合わせて組み替える
 *   npm run rebalance:probe            … 変更せず表示（ドライラン）
 *   npm run rebalance:probe -- --apply … 実際に更新
 *
 * 根拠（2026-11-25 時点の実測）
 *   じゃらん観光・体験  架電330  アポ29  8.8%  ← 食べログの5倍。なのに枠は47分の1だった
 *   食べログ 地方       岩手12.5% 佐賀7.1% 鳥取6.3% 和歌山6.1% 福井5.3% 岐阜/宮城5.0% 北海道/広島3.8%
 *   食べログ 大都市     大阪0.8% 神奈川0.7% 静岡0.7% 群馬0.9% 千葉0.0%（いずれも架電100件以上）
 * → 地方ほど競合が少なく刺さる。大都市は飽和。枠を実績順に振り直す。
 *
 * 変更するのは source_sites.forward_scan_count（1回の巡回で見るID数）だけ。いつでも戻せる。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'

const APPLY = process.argv.includes('--apply')
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || ''

/** 名前の一部 → 新しい1回あたり探索件数 */
const PLAN: Array<{ match: string; count: number; why: string }> = [
  { match: 'じゃらん観光スポット', count: 50, why: 'アポ率8.8%＝最優秀。枠を最大化' },
  // 地方の高実績県（アポ率3.8%以上）
  ...['岩手', '佐賀', '鳥取', '和歌山', '福井', '岐阜', '宮城', '山梨', '広島', '北海道']
    .map((p) => ({ match: `食べログ　${p}`, count: 40, why: 'アポ率3.8%以上の高実績県' })),
  // 大都市の低実績県（架電100件以上でアポ率1%未満）
  ...['大阪', '神奈川', '千葉', '静岡', '群馬']
    .map((p) => ({ match: `食べログ　${p}`, count: 8, why: '架電100件以上でアポ率1%未満＝飽和' })),
]

async function main() {
  if (!DB_URL) { console.error('✗ SUPABASE_DB_URL が未設定です'); process.exit(1) }
  const c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  const { rows: sites } = await c.query(
    `select id, name, forward_scan_count from source_sites where source_type='sequential_id_probe' and is_active = true`)
  console.log(`=== 連番探索の配分変更（${APPLY ? '実行' : 'ドライラン'}） ===\n対象サイト ${sites.length}件\n`)

  const changes: any[] = []
  for (const p of PLAN) {
    const hit = sites.filter((s: any) => String(s.name).includes(p.match))
    if (!hit.length) { console.log(`  ※ 「${p.match}」に一致するサイトなし`); continue }
    for (const s of hit) {
      if (Number(s.forward_scan_count) === p.count) continue
      changes.push({ id: s.id, name: s.name, from: s.forward_scan_count, to: p.count, why: p.why })
    }
  }
  for (const ch of changes) {
    console.log(`  ${String(ch.name).slice(0, 24).padEnd(24)} ${String(ch.from).padStart(3)} → ${String(ch.to).padStart(3)} 件/回   ${ch.why}`)
  }
  const total = sites.reduce((n: number, s: any) => n + (Number(s.forward_scan_count) || 15), 0)
  const after = total + changes.reduce((n, ch) => n + (ch.to - (Number(ch.from) || 15)), 0)
  console.log(`\n1巡回あたりの合計探索数: ${total} → ${after} 件`)

  if (APPLY) {
    for (const ch of changes) {
      await c.query(`update source_sites set forward_scan_count = $1, updated_at = now() where id = $2`, [ch.to, ch.id])
    }
    console.log(`→ ${changes.length}サイトの配分を更新しました`)
  } else {
    console.log('\n※ ドライランです。実行するには --apply を付けてください')
  }
  await c.end()
}
main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

/* ============================================================
 * 取得元の実績（架電→アポ率）を集計し、案件の優先度（一覧のドットの色）を付け直す。
 *   npm run refresh:priority
 * 通常は20分おきの巡回Cronが6時間間隔で自動実行する。これはその手動実行版。
 * 手動登録の案件（source_urls なし）には触らない。
 * ============================================================ */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { refreshSourcePerformance } from '../src/lib/sourcePerf.js'

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です'); process.exit(1) }
  const admin = createClient(url, key, { auth: { persistSession: false } })
  const r = await refreshSourcePerformance(admin)
  console.log(`取得元 ${r.sources}件 を集計（高 ${r.high} / 中 ${r.mid} / 低 ${r.low}）`)
  console.log(`案件の優先度を更新: ${r.updated}件`)
  console.log('実績上位:')
  for (const t of r.top) console.log('   ', t)
}
main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

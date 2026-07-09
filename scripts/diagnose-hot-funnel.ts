/** HOTファネル診断（読み取りのみ）: 今日の候補/温度分布/投入ブロック理由TOPを表示。 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const iso = today.toISOString()

  const cnt = async (q: any) => (await q).count ?? 0
  const savedToday = await cnt(admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('first_seen_at', iso))
  const importedToday = await cnt(admin.from('lead_candidates').select('id', { count: 'exact', head: true }).gte('imported_at', iso))
  const hotNow = await cnt(admin.from('lead_candidates').select('id', { count: 'exact', head: true }).eq('lead_temperature', 'HOT').eq('imported_to_cases', false))
  const holdNow = await cnt(admin.from('lead_candidates').select('id', { count: 'exact', head: true }).eq('lead_temperature', 'HOLD'))
  console.log(`本日保存候補: ${savedToday} / 本日投入: ${importedToday} / 未投入HOT: ${hotNow} / HOLD総数: ${holdNow}`)

  // 今日更新された候補のスキップ理由TOP
  const { data: reasons } = await admin.from('lead_candidates').select('auto_insert_skipped_reason')
    .not('auto_insert_skipped_reason', 'is', null).gte('last_seen_at', iso).limit(3000)
  const tally = new Map<string, number>()
  for (const r of (reasons || [])) { const k = String(r.auto_insert_skipped_reason).slice(0, 60); tally.set(k, (tally.get(k) || 0) + 1) }
  console.log('\n--- 本日のスキップ/降格理由 TOP15 ---')
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(v).padStart(4)}  ${k}`)

  // 全期間のHOLD理由TOP（山の在処）
  const { data: reasonsAll } = await admin.from('lead_candidates').select('auto_insert_skipped_reason')
    .eq('lead_temperature', 'HOLD').not('auto_insert_skipped_reason', 'is', null).limit(5000)
  const tally2 = new Map<string, number>()
  for (const r of (reasonsAll || [])) { const k = String(r.auto_insert_skipped_reason).slice(0, 60); tally2.set(k, (tally2.get(k) || 0) + 1) }
  console.log('\n--- HOLD全体の理由 TOP15 ---')
  for (const [k, v] of [...tally2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(v).padStart(4)}  ${k}`)

  // 今日のソース別 保存件数
  const { data: bySrc } = await admin.from('lead_candidates').select('source').gte('first_seen_at', iso).limit(3000)
  const tally3 = new Map<string, number>()
  for (const r of (bySrc || [])) tally3.set(String(r.source || '?'), (tally3.get(String(r.source || '?')) || 0) + 1)
  console.log('\n--- 本日のソース別保存 ---')
  for (const [k, v] of [...tally3.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${String(v).padStart(4)}  ${k}`)

  // Serper消費
  const { data: cost } = await admin.from('app_config').select('value').eq('key', 'discovery_cost').maybeSingle()
  console.log('\ndiscovery_cost:', JSON.stringify(cost?.value || {}))
}
main().catch((e) => { console.error(e); process.exit(1) })

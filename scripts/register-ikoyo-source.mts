/**
 * いこーよ（iko-yo.net/facilities/{ID}）を連番探索ソースとして登録（冪等）。
 * 子供のおでかけ施設ディレクトリ＝情報ディレクトリ型で電話・住所が載る（JSON-LD）。
 * 密度約90%・電話保有約84%・単一グローバル連番。じゃらん系と同じ「営業慣れしてない層」。
 * 現在の最前線IDを検出し、そこをfrontierに設定して過去分は掘らず今後の新規掲載だけ追う。
 * 実行: npx tsx scripts/register-ikoyo-source.mts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { parseIkoyo } from '../src/lib/sequentialProbe.js'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function isValid(id: number): Promise<{ ok: boolean; name?: string; tel?: string }> {
  try {
    const r = await fetch(`https://iko-yo.net/facilities/${id}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, redirect: 'follow' })
    if (r.status !== 200) return { ok: false }
    const html = await r.text()
    const p = parseIkoyo(html, false)
    return { ok: !!(p.name || p.phone || p.address), name: p.name, tel: p.phone }
  } catch { return { ok: false } }
}

async function main() {
  const { data: existing } = await admin.from('source_sites').select('id').eq('source_type', 'sequential_id_probe').ilike('url_template', '%iko-yo.net%').maybeSingle()
  if (existing) { console.log('既に登録済み。スキップ。'); return }

  // 最前線ID検出: 50000から上方向へ、40連続missで打ち切り、最後のvalidをfrontierに
  let lastValid = 0, miss = 0
  for (let id = 50000; id <= 60000; id++) {
    const v = await isValid(id)
    await new Promise((r) => setTimeout(r, 120))
    if (v.ok) { lastValid = id; miss = 0; if (lastValid % 200 === 0 || id === 50000) console.log(`  valid ${id}: ${v.name || '—'} ${v.tel || ''}`) }
    else { miss++; if (miss >= 40) break }
  }
  if (!lastValid) { console.log('❌ frontier検出失敗'); return }
  const frontier = lastValid
  console.log(`✅ frontier(最前線ID) = ${frontier}`)

  await admin.from('source_sites').insert({
    name: 'いこーよ（子供のおでかけ施設）', base_url: 'https://iko-yo.net/facilities/',
    list_url: 'https://iko-yo.net/', url_template: 'https://iko-yo.net/facilities/{ID}',
    normalized_url_template: 'https://iko-yo.net/facilities', source_key: 'https://iko-yo.net/facilities|ikoyo_facility_detail',
    source_type: 'sequential_id_probe', parser_type: 'ikoyo_facility_detail', media_family: 'ikoyo', category_label: 'おでかけ施設',
    is_active: true, probe_enabled: true, reliability_score: 65,
    crawl_interval_days: 1, crawl_interval_hours: 24, id_padding: 0, scan_direction: 'forward', probe_mode: 'advance',
    probe_batch_size: 20, max_probe_per_run: 20, forward_scan_count: 25, backfill_scan_count: 0,
    max_consecutive_not_found: 25, same_id_retry_limit: 3, invalid_retry_interval_hours: 24,
    rendering_mode: 'auto', detail_rendering_mode: 'auto', detail_fetch_enabled: true, max_detail_pages_per_run: 20,
    review_flag: true, priority: 100,
    last_valid_id: frontier, last_found_id: frontier, last_checked_id: frontier,
    current_probe_id: frontier, start_probe_id: frontier, next_start_id: frontier,
  })
  console.log('✅ いこーよ を連番探索ソースとして登録しました（frontier=' + frontier + '）')
}
main().catch((e) => { console.error(e); process.exit(1) })

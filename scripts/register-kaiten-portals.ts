/**
 * 全国の「開店まとめ」ポータルを地域メディア巡回(source_sites)へ直接登録（冪等）。
 * SERP経由のつまみ食いではなく、毎日20〜50件の新規開店記事を載せる一次ソースを2時間おきに直接クロールする。
 * 実行: npx tsx scripts/register-kaiten-portals.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SITES = [
  { name: '開店閉店.com（全国・開店）', base_url: 'https://kaiten-heiten.com', list_url: 'https://kaiten-heiten.com/category/open/', media_family: 'local_news' },
  { name: '開店閉店.com（全国・新着）', base_url: 'https://kaiten-heiten.com', list_url: 'https://kaiten-heiten.com/', media_family: 'local_news' },
]

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  for (const s of SITES) {
    const { data: dup } = await admin.from('source_sites').select('id,is_active').eq('list_url', s.list_url).limit(1)
    if (dup?.[0]) {
      if (!dup[0].is_active) { await admin.from('source_sites').update({ is_active: true, disabled_reason: null, updated_at: new Date().toISOString() }).eq('id', dup[0].id); console.log(`再有効化: ${s.name}`) }
      else console.log(`登録済み: ${s.name}`)
      continue
    }
    const { error } = await admin.from('source_sites').insert({
      name: s.name, base_url: s.base_url, list_url: s.list_url,
      media_family: s.media_family, source_type: 'generic_page_text_scan', parser_type: 'generic_page_text_scan',
      category_label: '店舗新着', is_active: true, reliability_score: 70, crawl_interval_hours: 12,
      created_by: 'manual_script', last_crawl_result: '開店まとめポータルとして手動登録', updated_at: new Date().toISOString(),
    })
    console.log(error ? `失敗: ${s.name}: ${error.message}` : `登録: ${s.name}`)
  }
  const { count } = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true).neq('source_type', 'sequential_id_probe')
  console.log(`地域メディア有効サイト合計: ${count}`)
}
main().catch((e) => { console.error(e); process.exit(1) })

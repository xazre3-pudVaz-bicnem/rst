/**
 * トリムトリム（trimtrim.jp / ペットトリミングサロン検索）を連番URL探索の取得元として登録（冪等）。
 *   - 詳細ページ https://trimtrim.jp/salon-detail/{連番ID} に 電話番号＋〒付き住所 が明記されている
 *   - 掲載15,900店超・IDは増え続けるため、新しいIDの出現＝新規掲載として拾える
 *   - robots.txt は User-agent:* Allow:/ ＋ Crawl-delay:2（間隔を空けて巡回する）
 * 実行: npx tsx scripts/register-trimtrim-source.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

/** 発番済みの最前線ID（実測 2026-07: 21000=有効 / 21200以上=未発番）。新規掲載はこの先に発番される。 */
const TRIMTRIM_FRONTIER_ID = 21000

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const patch = {
    name: 'トリムトリム（ペットサロン新規掲載）',
    base_url: 'https://trimtrim.jp',
    list_url: 'https://trimtrim.jp/salons',
    url_template: 'https://trimtrim.jp/salon-detail/{ID}',
    source_type: 'sequential_id_probe',
    parser_type: 'trimtrim_salon_detail',
    media_family: 'trimtrim',
    category_label: '店舗新着',
    is_active: true,
    reliability_score: 72,
    probe_mode: 'safe',
    // 探索開始IDは「発番済みの最前線」に置く。ID1から始めると既存15,900店を延々と探索して
    // 新着に永遠に到達しない（実害: next_start_id=11 のまま停滞していた）。
    // 実測: 21000=有効 / 21200以上=未発番 → 以降に発番される新規掲載だけを拾う。
    start_probe_id: TRIMTRIM_FRONTIER_ID,
    next_start_id: TRIMTRIM_FRONTIER_ID,
    rendering_mode: 'static',        // 静的HTMLに店名/電話/住所あり
    detail_fetch_enabled: true,
    disabled_reason: null,
    disabled_at: null,
    updated_at: new Date().toISOString(),
  }

  const { data: dup } = await admin.from('source_sites').select('id').ilike('base_url', '%trimtrim%').limit(1)
  if (dup?.[0]) {
    const { error } = await admin.from('source_sites').update(patch).eq('id', dup[0].id)
    console.log(error ? `更新失敗: ${error.message}` : `更新: ${patch.name}`)
  } else {
    const { error } = await admin.from('source_sites').insert({ ...patch, created_by: 'manual_script' })
    console.log(error ? `登録失敗: ${error.message}` : `登録: ${patch.name}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

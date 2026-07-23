/**
 * トリムトリム（trimtrim.jp / ペットトリミングサロン検索）を連番URL探索の取得元として登録（冪等）。
 *   - 詳細ページ https://trimtrim.jp/salon-detail/{連番ID} に 電話番号＋〒付き住所 が明記されている
 *   - 掲載15,900店超・IDは増え続けるため、新しいIDの出現＝新規掲載として拾える
 *   - robots.txt は User-agent:* Allow:/ ＋ Crawl-delay:2（間隔を空けて巡回する）
 * 実行: npx tsx scripts/register-trimtrim-source.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

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

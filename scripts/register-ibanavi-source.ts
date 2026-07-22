/**
 * いばナビ（ibanavi.net）を「店舗ディレクトリ新着」ソースとして正しく設定（冪等）。
 *   - 一覧 https://ibanavi.net/shop?sort=latest（静的HTMLに新着店リンクあり・JS不要）
 *   - 詳細 /shop/{id} に住所・電話・営業時間・OPEN表記が揃う → directoryパーサーで取得
 * 従来は source_type=html_list で URL に sort=/shop を含むためマーケット型に誤判定され、
 * カード1/詳細0 で0件だった。parser_type と media_family を directory 型に矯正する。
 * 実行: npx tsx scripts/register-ibanavi-source.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const LIST_URL = 'https://ibanavi.net/shop?sort=latest'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const patch = {
    name: 'いばナビ（茨城・店舗新着）',
    base_url: LIST_URL,
    list_url: LIST_URL,
    source_type: 'local_directory_new_listing',
    parser_type: 'local_directory_new_listing',
    media_family: 'ibanavi',          // DIRECTORY_CONFIGS['ibanavi'] を適用（店名は<title>から取得）
    category_label: '店舗新着',
    is_active: true,
    reliability_score: 78,            // goguynet(70)より上位で優先巡回に乗せる
    crawl_interval_hours: 12,
    rendering_mode: 'static',         // 一覧・詳細とも静的取得可（ScrapingBee不要でコスト0）
    detail_rendering_mode: 'static',
    detail_fetch_enabled: true,
    // 差分カーソルを一旦クリアして新着を取り直す（旧カーソルは /shop/list/sgt/250 の誤URL）
    latest_item_url: null,
    last_seen_shop_url: null,
    last_seen_article_url: null,
    disabled_reason: null,
    disabled_at: null,
    last_crawl_result: 'ディレクトリ型として再設定（手動スクリプト）',
    updated_at: new Date().toISOString(),
  }

  const { data: dup } = await admin.from('source_sites').select('id').ilike('base_url', '%ibanavi%').limit(1)
  if (dup?.[0]) {
    const { error } = await admin.from('source_sites').update(patch).eq('id', dup[0].id)
    console.log(error ? `更新失敗: ${error.message}` : `更新: いばナビ (${dup[0].id})`)
  } else {
    const { error } = await admin.from('source_sites').insert({ ...patch, created_by: 'manual_script' })
    console.log(error ? `登録失敗: ${error.message}` : '登録: いばナビ')
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

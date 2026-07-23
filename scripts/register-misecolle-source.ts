/**
 * みせコレ（mise-colle.com / ～みんなの名店コレクション～）を記事型の取得元として登録（冪等）。
 *   - WordPress。記事URLは /{postID}（日付を含まない）ため、鮮度判定は記事メタの公開日で行われる
 *     （openclose_article パーサーの articleMeta が published_at を読む → saveDays の鮮度ゲートが効く）
 *   - 記事に「店名」「住所」が構造化されている。電話は記載が無いため、投入後の
 *     missing_phone_recheck_queue（住所+店名→Google Placesで電話補完）で拾う想定。
 *   - robots.txt は /wp-admin のみ Disallow。sitemap あり。
 * 実行: npx tsx scripts/register-misecolle-source.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const patch = {
    name: 'みせコレ（新着レポート）',
    base_url: 'https://mise-colle.com',
    list_url: 'https://mise-colle.com/',
    source_type: 'openclose_article',
    parser_type: 'openclose_article',
    media_family: 'local_news',
    category_label: '店舗新着',
    is_active: true,
    reliability_score: 74,
    crawl_interval_hours: 12,
    rendering_mode: 'static',
    detail_fetch_enabled: true,
    disabled_reason: null,
    disabled_at: null,
    updated_at: new Date().toISOString(),
  }

  const { data: dup } = await admin.from('source_sites').select('id').ilike('base_url', '%mise-colle%').limit(1)
  if (dup?.[0]) {
    const { error } = await admin.from('source_sites').update(patch).eq('id', dup[0].id)
    console.log(error ? `更新失敗: ${error.message}` : `更新: ${patch.name}`)
  } else {
    const { error } = await admin.from('source_sites').insert({ ...patch, created_by: 'manual_script' })
    console.log(error ? `登録失敗: ${error.message}` : `登録: ${patch.name}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

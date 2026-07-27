/**
 * 彩北なび（saihokunavi.net / 埼玉県北部の地域情報サイト）を店舗ディレクトリ新着ソースとして登録（冪等）。
 *   - 一覧 https://saihokunavi.net/shop/?sort=newest（新着順）
 *   - 詳細 /shop/shop.shtml?s={ID} に 店名・電話・住所・営業時間 が揃う
 * 背景: 既存の登録は base_url が www.saikohkunavi.net（綴り誤り＝ドメイン消滅）と
 *   www.saihokunavi.net（旧URL扱い）で、どちらも無効化されており有効なソースが1つも無かった。
 *   実ドメインは saihokunavi.net（www無し）。media_family='saikohkunavi' は既存の
 *   DIRECTORY_CONFIGS['saikohkunavi']（nameOrder h1優先・detailPattern shop.shtml?s=）を流用する。
 * 実行: npx tsx scripts/register-saihokunavi-source.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const LIST_URL = 'https://saihokunavi.net/shop/?sort=newest'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const patch = {
    name: '彩北なび（埼玉北部・店舗新着）',
    base_url: LIST_URL,
    list_url: LIST_URL,
    source_type: 'local_directory_new_listing',
    parser_type: 'local_directory_new_listing',
    media_family: 'saikohkunavi',   // 既存のディレクトリ設定を流用（h1=実店名 / detailPattern=shop.shtml?s=）
    category_label: '店舗新着',
    is_active: true,
    reliability_score: 74,
    crawl_interval_hours: 12,
    rendering_mode: 'static',       // 一覧・詳細とも静的取得可
    detail_fetch_enabled: true,
    disabled_reason: null,
    disabled_at: null,
    updated_at: new Date().toISOString(),
  }

  // 既存の彩北なび行（消滅/旧ドメイン含む）を無効化してから、実ドメインで1本に統一
  const { data: olds } = await admin.from('source_sites').select('id,base_url')
    .or('base_url.ilike.%saihokunavi%,base_url.ilike.%saikohkunavi%,name.ilike.%彩北なび%,name.ilike.%埼北なび%')
  for (const o of olds || []) {
    if (o.base_url === LIST_URL) continue
    await admin.from('source_sites').update({ is_active: false, disabled_reason: '実ドメイン saihokunavi.net(/shop/?sort=newest) に統一', disabled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', o.id)
  }

  const { data: dup } = await admin.from('source_sites').select('id').eq('base_url', LIST_URL).limit(1)
  if (dup?.[0]) {
    const { error } = await admin.from('source_sites').update(patch).eq('id', dup[0].id)
    console.log(error ? `更新失敗: ${error.message}` : `更新: ${patch.name}`)
  } else {
    const { error } = await admin.from('source_sites').insert({ ...patch, created_by: 'manual_script' })
    console.log(error ? `登録失敗: ${error.message}` : `登録: ${patch.name}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

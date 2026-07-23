/**
 * 埼北つーしん「さいつう」(sai2.info) を開店・閉店記事の取得元として登録（冪等）。
 *
 * 背景: これまで「埼北つうしん/彩北なび」として登録されていたのは実在しない/別ドメイン
 *       （saikou-tsushin.com, saihoku-tsushin.com, saihokunavi.net 等）で、記事リンク0のまま
 *       空回りしていた。実サイトは sai2.info で、/archives/tag/開店・閉店 に新店記事が並ぶ。
 * 記事には「◆店名／…」「◆住所／…」が構造化されている（電話は無いのでPlaces補完で取得）。
 * 実行: npx tsx scripts/register-sai2-source.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const LIST_URL = 'https://sai2.info/archives/tag/' + encodeURIComponent('開店・閉店')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 実在しない/記事0で空回りしていた旧ドメイン（fetch不可なら無効化する）
const LEGACY = ['saikou-tsushin.com', 'saihoku-tsushin.com', 'saihokunavi.net', 'saihoku-navi.com', 'saikohkunavi.net']

async function alive(host: string): Promise<boolean> {
  try {
    const r = await fetch(`https://${host}/`, { headers: { 'User-Agent': UA }, redirect: 'follow' })
    if (!r.ok) return false
    const h = await r.text()
    return h.length > 2000
  } catch { return false }
}

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const patch = {
    name: '埼北つーしん さいつう（開店・閉店）',
    base_url: 'https://sai2.info',
    list_url: LIST_URL,
    source_type: 'openclose_article',
    parser_type: 'openclose_article',
    media_family: 'local_news',
    category_label: '開店閉店',
    is_active: true,
    reliability_score: 78,
    crawl_interval_hours: 12,
    rendering_mode: 'static',      // 静的HTMLに記事リンク・店名/住所あり
    detail_fetch_enabled: true,
    disabled_reason: null,
    disabled_at: null,
    updated_at: new Date().toISOString(),
  }

  const { data: dup } = await admin.from('source_sites').select('id').ilike('base_url', '%sai2.info%').limit(1)
  if (dup?.[0]) {
    const { error } = await admin.from('source_sites').update(patch).eq('id', dup[0].id)
    console.log(error ? `更新失敗: ${error.message}` : `更新: ${patch.name}`)
  } else {
    const { error } = await admin.from('source_sites').insert({ ...patch, created_by: 'manual_script' })
    console.log(error ? `登録失敗: ${error.message}` : `登録: ${patch.name}`)
  }

  // 旧ドメインの生死を確認し、死んでいる有効サイトは無効化（巡回枠の無駄を除く）
  for (const host of LEGACY) {
    const { data: rows } = await admin.from('source_sites').select('id,name,base_url,is_active').ilike('base_url', `%${host}%`)
    for (const r of rows || []) {
      if (!r.is_active) continue
      const ok = await alive(host)
      if (!ok) {
        await admin.from('source_sites').update({
          is_active: false, disabled_reason: `実在しない/記事0の旧ドメイン（実サイトは sai2.info）`, disabled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', r.id)
        console.log(`無効化: ${r.name} (${r.base_url})`)
      } else {
        console.log(`生存のため維持: ${r.name} (${r.base_url})`)
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

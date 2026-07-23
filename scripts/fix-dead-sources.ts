/**
 * 「巡回しているのに0件/失敗」の取得元を実サイト構造に合わせて修正（冪等）。
 *   - 調布つうしん: 記事型サイト(/archives/*.html が204件)なのに html_list → marketplace_card_parser が
 *     当たり「カード0」で0件だった。openclose_article に矯正。
 *   - 湘南人: クローラからは HTTP 403（WAF/IP起因）。ブラウザUAでは200で取得できるため
 *     rendering_mode=auto にしてレンダリングAPI経由のfallbackを許可する。
 *   - 埼北つうしん(saikou-tsushin.com): タイトル空のplaceholderで記事0。実サイトは sai2.info に
 *     登録済みのため無効化する。
 * 実行: npx tsx scripts/fix-dead-sources.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const now = new Date().toISOString()

  // 1) 調布つうしん → 記事型へ矯正
  {
    const { data } = await admin.from('source_sites').select('id,name').ilike('base_url', '%chofucity.com%')
    for (const r of data || []) {
      const { error } = await admin.from('source_sites').update({
        source_type: 'openclose_article', parser_type: 'openclose_article', media_family: 'tsushin',
        category_label: '開店閉店', rendering_mode: 'static', is_active: true,
        last_crawl_result: '記事型(openclose_article)へ矯正（手動スクリプト）', updated_at: now,
      }).eq('id', r.id)
      console.log(error ? `失敗 ${r.name}: ${error.message}` : `矯正: ${r.name} → openclose_article`)
    }
  }

  // 2) 湘南人 → レンダリングfallbackを許可（403回避）
  {
    const { data } = await admin.from('source_sites').select('id,name').ilike('base_url', '%shonanjin.com%')
    for (const r of data || []) {
      const { error } = await admin.from('source_sites').update({
        rendering_mode: 'auto', is_active: true,
        last_crawl_result: '403のためrendering_mode=autoへ変更（手動スクリプト）', updated_at: now,
      }).eq('id', r.id)
      console.log(error ? `失敗 ${r.name}: ${error.message}` : `変更: ${r.name} → rendering_mode=auto`)
    }
  }

  // 3) 旧「埼北つうしん」(placeholderドメイン) → 無効化（実サイトは sai2.info）
  {
    const { data } = await admin.from('source_sites').select('id,name').ilike('base_url', '%saikou-tsushin.com%')
    for (const r of data || []) {
      const { error } = await admin.from('source_sites').update({
        is_active: false, disabled_reason: 'placeholderドメインで記事0（実サイトは sai2.info に登録済み）',
        disabled_at: now, updated_at: now,
      }).eq('id', r.id)
      console.log(error ? `失敗 ${r.name}: ${error.message}` : `無効化: ${r.name}`)
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

/**
 * 記事型サイト（開店・閉店記事）が marketplace_card_parser（カード型）と誤判定され、
 * 記事リンクを1件も抽出できず候補0になっていたものを記事型(openclose_article)へ一括矯正（冪等）。
 *
 * 背景: 号外NET系(goguynet.jp)・各種「つうしん」/「◯◯102.com」等の地域メディアが
 *   source_type/parser_type='marketplace_listing' や html_list+fam=other で登録されており、
 *   カード型パーサーが当たって「カード0/詳細0」になっていた（例: 荒川ローカルマガジン、
 *   江東区minamisuna1、葛飾つうしん、船橋つうしん）。
 * 方針: (1) 号外NET系ドメインは無条件で記事型へ。 (2) それ以外の marketplace_listing は
 *   「HOT実績が1件も無いもの」だけ記事型へ（実際にカード型で機能しているサイトは残す）。
 *   ただし tabelog / mypl / horby など専用パーサーを持つものは対象外。
 * 実行: npx tsx scripts/fix-article-sites-misclassified.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SPECIAL = /tabelog\.com|u-word\.com|h-word\.com|mypl\.net|saihokunavi|saikohkunavi/i

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: sites } = await admin.from('source_sites').select('id,name,base_url,source_type,parser_type,media_family,last_crawled_at')
    .eq('is_active', true).neq('source_type', 'sequential_id_probe')
  // HOT実績（source_site_name 紐づけ）
  const { data: cands } = await admin.from('lead_candidates').select('source_site_name,lead_temperature')
  const hotByName = new Map<string, number>()
  for (const c of cands || []) {
    if (c.lead_temperature === 'HOT' && c.source_site_name) hotByName.set(c.source_site_name, (hotByName.get(c.source_site_name) || 0) + 1)
  }

  let fixed = 0
  for (const s of sites || []) {
    if (SPECIAL.test(s.base_url || '')) continue
    const isGoguyNet = /goguynet\.jp|tsushin\.com|tsushin\.jp|[a-z]+102\.com|minamisuna1\.com|arakawa102\.com/i.test(s.base_url || '')
    const isMarket = s.source_type === 'marketplace_listing' || (s.source_type === 'html_list' && !s.parser_type)
    const hot = hotByName.get(s.name) || 0
    // 号外NET系は無条件、その他のカード/未設定型はHOT実績0のものだけ矯正
    if (!(isGoguyNet || (isMarket && hot === 0))) continue
    if (s.source_type === 'openclose_article' && s.parser_type === 'openclose_article') continue
    const fam = ['goguynet', 'tsushin', 'kaitenheiten', 'local_news'].includes(s.media_family) ? s.media_family : (isGoguyNet ? 'tsushin' : 'local_news')
    await admin.from('source_sites').update({
      source_type: 'openclose_article', parser_type: 'openclose_article', media_family: fam,
      rendering_mode: 'static', updated_at: new Date().toISOString(),
      last_crawl_result: '記事型(openclose_article)へ矯正（同型誤判定の一括修正）',
    }).eq('id', s.id)
    fixed++
  }
  console.log(`記事型へ矯正: ${fixed}件`)
}
main().catch((e) => { console.error(e); process.exit(1) })

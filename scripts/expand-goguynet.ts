/**
 * 号外NET（100超の市区ローカルニュース網）の「開店/閉店」カテゴリを全市区ぶん一括登録（冪等）。
 * 既登録の市区別 cat_openclose 直取りは 電話4/住所5/HOT2 等の実績がある勝ちフォーマット。
 * ハブページ/トップから市区サブドメインを自動抽出し、勝ちフォーマットの設定をクローンして登録する。
 * 実行: npx tsx scripts/expand-goguynet.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const HUBS = ['', 'saitama', 'tokyo', 'kanagawa', 'chiba', 'osaka', 'aichi', 'hokkaido', 'fukuoka', 'hyogo', 'kyoto', 'shizuoka', 'hiroshima', 'miyagi', 'niigata', 'okayama', 'kumamoto', 'kagoshima', 'nagano', 'gifu', 'mie', 'ibaraki', 'tochigi', 'gunma', 'nara', 'shiga', 'ehime', 'kagawa', 'tokushima', 'kochi', 'okinawa']

async function fetchText(url: string): Promise<string> {
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000)
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 RST-CRM-bot/1.0', 'Accept-Language': 'ja' }, signal: ctrl.signal })
    clearTimeout(to)
    return r.ok ? await r.text() : ''
  } catch { return '' }
}

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  // 勝ちフォーマット（実績のある既存行）の設定をクローン元にする
  const { data: tmplRows } = await admin.from('source_sites').select('*').ilike('base_url', '%ichihara.goguynet.jp%').limit(1)
  const tmpl = tmplRows?.[0]
  if (!tmpl) { console.error('クローン元（ichihara.goguynet.jp）が見つかりません'); process.exit(1) }
  console.log(`クローン元: ${tmpl.name} parser=${tmpl.parser_type} source_type=${tmpl.source_type}`)

  // ハブ/トップから市区サブドメインを抽出
  const subs = new Set<string>()
  for (const hub of HUBS) {
    const html = await fetchText(`https://goguynet.jp/${hub}`)
    for (const m of html.matchAll(/https?:\/\/([a-z0-9-]+)\.goguynet\.jp/g)) {
      const s = m[1]
      if (s && !['www', 'goguynet'].includes(s)) subs.add(s)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`発見サブドメイン: ${subs.size}件`)

  // 既登録を除外して一括登録
  const { data: existing } = await admin.from('source_sites').select('base_url,list_url').ilike('base_url', '%goguynet%')
  const has = (sub: string) => (existing || []).some((e: any) => String(e.base_url).includes(`${sub}.goguynet.jp`) || String(e.list_url || '').includes(`${sub}.goguynet.jp`))
  let added = 0, skipped = 0, failed = 0
  for (const sub of [...subs].sort()) {
    if (has(sub)) { skipped++; continue }
    const { error } = await admin.from('source_sites').insert({
      name: `号外NET ${sub} 開店閉店`,
      base_url: `https://${sub}.goguynet.jp/category/cat_openclose`,
      list_url: `https://${sub}.goguynet.jp/category/cat_openclose/`,
      media_family: tmpl.media_family || 'local_news',
      source_type: tmpl.source_type, parser_type: tmpl.parser_type,
      category_label: '店舗新着', is_active: true, reliability_score: 70,
      crawl_interval_hours: tmpl.crawl_interval_hours || 12,
      rendering_mode: tmpl.rendering_mode || null,
      created_by: 'goguynet_expand_script', last_crawl_result: '号外NET網の一括展開で登録',
      updated_at: new Date().toISOString(),
    })
    if (error) { failed++; if (failed <= 3) console.log(`失敗 ${sub}: ${error.message}`) }
    else added++
  }
  const { count } = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true).ilike('base_url', '%goguynet%')
  console.log(`登録: ${added} / 既存skip: ${skipped} / 失敗: ${failed} / 号外NET有効サイト合計: ${count}`)
}
main().catch((e) => { console.error(e); process.exit(1) })

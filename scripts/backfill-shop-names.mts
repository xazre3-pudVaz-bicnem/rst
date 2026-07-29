/**
 * 店名がサイト名/店名未確定のまま投入された既存案件を、掲載元ページから店名再取得して埋める（冪等・一回性）。
 * ① 連番系(tabelog/jalan)は recorrectProbeNames で候補＋案件名を再訂正。
 * ② 記事/ディレクトリ系(goguynet/tsushin/local_news/trimtrim/kaitenheiten/未分類)は
 *    掲載元URLを取得し、媒体別パーサー(parseGoguynetShopInfo/extractDirectoryShopInfo/extractShopFromTitle)で
 *    店名を抽出→sanitizeShopNameで検証→有効なら案件name＋候補nameを更新。
 * 実行: npx tsx scripts/backfill-shop-names.mts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { recorrectProbeNames } from '../src/lib/sequentialProbe.js'
import { fetchPage } from '../src/lib/enrichProfile.js'
import { extractShopFromTitle, sanitizeShopName, parseGoguynetShopInfo } from '../src/lib/regionalParsers.js'
import { extractDirectoryShopInfo } from '../src/lib/directoryParser.js'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const nowIso = new Date().toISOString()

// サイト名/未確定っぽい店名の判定（＝要修正の対象）
const BAD_NAME_RE = /\.(com|jp|net)|店名未確定|（店名未確定）|まとめ|マガジン|ナビ$|情報$/i
const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()

async function main() {
  // ① 連番系（tabelog/jalan）
  const probe = await recorrectProbeNames(admin, { limit: 300, nowIso })
  console.log(`① 連番系(tabelog/jalan): scanned=${probe.scanned} 候補更新=${probe.updated} 案件更新=${probe.caseUpdated} HOLD=${probe.held}`)

  // ② 記事/ディレクトリ系ほか — 残った要修正案件を掲載元URLから再取得
  const { data: rows } = await admin.from('cases')
    .select('id,name,source_urls')
    .eq('status', '新規')
  const targets = (rows || []).filter((c: any) => BAD_NAME_RE.test(c.name || '') && /^https?:\/\//i.test(c.source_urls || ''))
  console.log(`② 記事/ディレクトリ系 対象: ${targets.length}件`)

  let fixed = 0, failed = 0
  for (const c of targets) {
    const url: string = c.source_urls
    // 根ドメインのみ(パス無し)は個別店を特定できないためスキップ
    const path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '')
    if (path.replace(/\//g, '').length < 2) { failed++; continue }

    const res = await fetchPage(url, 9000)
    await new Promise((r) => setTimeout(r, 300))
    if (!res.ok || !res.html) { failed++; continue }
    const html = res.html
    const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    const og = stripTags(html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || '')
    const h1 = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')

    // 媒体別に店名を抽出
    let raw = ''
    if (/trimtrim\.jp/i.test(url)) raw = extractDirectoryShopInfo(html, title, 'trimtrim').shop_name || ''
    else if (/goguynet\.jp|tsushin\./i.test(url)) raw = parseGoguynetShopInfo(html).shopName || extractShopFromTitle(og || title || h1) || ''
    else raw = extractShopFromTitle(og || title || h1) || h1 || og || ''

    const sn = sanitizeShopName(raw, { placesMatched: false })
    if (!sn.valid || !sn.name || BAD_NAME_RE.test(sn.name) || sn.name === c.name) { failed++; continue }

    await admin.from('cases').update({ name: sn.name, updated_date: nowIso }).eq('id', c.id)
    await admin.from('lead_candidates').update({ name: sn.name, extracted_shop_name: sn.name }).eq('imported_case_id', c.id).then(() => {}, () => {})
    fixed++
    if (fixed <= 15) console.log(`   ✅ 「${c.name}」→「${sn.name}」  ${url.slice(0, 55)}`)
  }
  console.log(`② 店名復元: ${fixed}件 / 復元できず: ${failed}件（掲載元が根ドメイン・ページ消滅・店名抽出不可）`)
}
main().catch((e) => { console.error(e); process.exit(1) })

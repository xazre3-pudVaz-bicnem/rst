/**
 * 食べログ連番探索エリアを未カバー県へ拡張（冪等）。
 * 各県の新着順リスト(rstLst?SrtT=nod)から現在の最前線shop IDを検出し、そこをfrontierに設定して
 * source_sites に sequential_id_probe を登録する。過去店を掘らず「今後の新規掲載」だけを追う。
 * DRYRUN=1 で検出のみ（登録しない）。
 * 実行: npx tsx scripts/add-tabelog-areas.mts   /   DRYRUN=1 npx tsx scripts/add-tabelog-areas.mts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { parseTabelog } from '../src/lib/sequentialProbe.js'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const DRY = process.env.DRYRUN === '1'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 未カバー32県: [都道府県コード2桁, romaji, 日本語]
const PREFS: [string, string, string][] = [
  ['02', 'aomori', '青森'], ['03', 'iwate', '岩手'], ['05', 'akita', '秋田'], ['06', 'yamagata', '山形'],
  ['07', 'fukushima', '福島'], ['08', 'ibaraki', '茨城'], ['09', 'tochigi', '栃木'], ['10', 'gunma', '群馬'],
  ['16', 'toyama', '富山'], ['17', 'ishikawa', '石川'], ['18', 'fukui', '福井'], ['19', 'yamanashi', '山梨'],
  ['20', 'nagano', '長野'], ['21', 'gifu', '岐阜'], ['24', 'mie', '三重'], ['25', 'shiga', '滋賀'],
  ['29', 'nara', '奈良'], ['30', 'wakayama', '和歌山'], ['31', 'tottori', '鳥取'], ['32', 'shimane', '島根'],
  ['35', 'yamaguchi', '山口'], ['36', 'tokushima', '徳島'], ['37', 'kagawa', '香川'], ['38', 'ehime', '愛媛'],
  ['39', 'kochi', '高知'], ['41', 'saga', '佐賀'], ['42', 'nagasaki', '長崎'], ['43', 'kumamoto', '熊本'],
  ['44', 'oita', '大分'], ['45', 'miyazaki', '宮崎'], ['46', 'kagoshima', '鹿児島'], ['47', 'okinawa', '沖縄'],
]

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/** 新着順リストから県内最大shop IDを検出 */
async function detectFrontier(romaji: string): Promise<number | null> {
  const html = await fetchText(`https://tabelog.com/${romaji}/rstLst/?SrtT=nod`).catch(() => '')
  if (!html) return null
  const re = new RegExp(`tabelog\\.com/${romaji}/[A-Z]\\d+/[A-Z]\\d+/(\\d+)/`, 'g')
  let m: RegExpExecArray | null; let max = 0
  while ((m = re.exec(html))) { const n = Number(m[1]); if (n > max) max = n }
  // 相対リンク形式も拾う
  const re2 = new RegExp(`/${romaji}/[A-Z]\\d+/[A-Z]\\d+/(\\d+)/`, 'g')
  while ((m = re2.exec(html))) { const n = Number(m[1]); if (n > max) max = n }
  return max > 0 ? max : null
}

async function main() {
  const { data: existing } = await admin.from('source_sites').select('url_template').eq('source_type', 'sequential_id_probe').ilike('url_template', '%tabelog.com%')
  const have = new Set((existing || []).map((s: any) => (String(s.url_template).match(/tabelog\.com\/([a-z]+)\//) || [])[1]).filter(Boolean))

  let added = 0, failed: string[] = []
  for (const [pp, romaji, jp] of PREFS) {
    if (have.has(romaji)) { console.log(`skip ${jp}(${romaji}): 既存`); continue }
    const tmpl = `https://tabelog.com/${romaji}/A${pp}01/A${pp}0101/{ID}/`
    const frontier = await detectFrontier(romaji)
    await new Promise((r) => setTimeout(r, 500))
    if (!frontier) { failed.push(`${jp}(${romaji})`); console.log(`❌ ${jp}(${romaji}): frontier検出失敗`); continue }
    // 検証: frontier shopページが実際にパースできるか
    const shopUrl = tmpl.replace('{ID}', String(frontier))
    const shopHtml = await fetchText(shopUrl).catch(() => '')
    const parsed = shopHtml ? parseTabelog(shopHtml, false) : ({ name: '' } as any)
    console.log(`✅ ${jp}(${romaji}) frontier=${frontier} 検証店名=「${parsed?.name || '—'}」`)
    if (DRY) { added++; continue }
    const normalized = `https://tabelog.com/${romaji}/A${pp}01/A${pp}0101`
    await admin.from('source_sites').insert({
      name: `食べログ　${jp}`, base_url: `${normalized}/`, list_url: `https://tabelog.com/${romaji}/rstLst/?SrtT=nod`,
      url_template: tmpl, normalized_url_template: normalized, source_key: `${normalized}|tabelog_detail`,
      source_type: 'sequential_id_probe', parser_type: 'tabelog_detail', media_family: 'tabelog', category_label: 'グルメ',
      prefecture: jp, is_active: true, probe_enabled: true, reliability_score: 65,
      crawl_interval_days: 1, crawl_interval_hours: 24, id_padding: 0, scan_direction: 'forward', probe_mode: 'advance',
      probe_batch_size: 20, max_probe_per_run: 20, forward_scan_count: 25, backfill_scan_count: 0,
      max_consecutive_not_found: 25, same_id_retry_limit: 3, invalid_retry_interval_hours: 24,
      rendering_mode: 'auto', detail_rendering_mode: 'auto', detail_fetch_enabled: true, max_detail_pages_per_run: 20,
      review_flag: true, priority: 100,
      // frontier: 現在の最前線に全ID系フィールドを合わせ、次回からforwardで新規だけ追う
      last_valid_id: frontier, last_found_id: frontier, last_checked_id: frontier,
      current_probe_id: frontier, start_probe_id: frontier, next_start_id: frontier,
    }).then(() => { added++ }, (e: any) => { failed.push(`${jp}:${e.message}`) })
  }
  console.log(`\n=== ${DRY ? 'DRYRUN ' : ''}完了: ${added}件${DRY ? '検出' : '登録'} / 失敗${failed.length}件 ${failed.join(', ')} ===`)
}
main().catch((e) => { console.error(e); process.exit(1) })

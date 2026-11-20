// ============================================================
// 保健所「営業許可」オープンデータの追加候補を探す調査スクリプト。
//
//   自治体のCKANカタログ（BODIK/東京都など）を検索し、見つかったCSVを実際に落として
//   本番と同じパーサ(extractFreshPermitRows)に通し、「直近◯日の新規許可が何件取れるか」を測る。
//   件数が出たものだけ、PERMIT_SOURCES に貼れる形で出力する。
//
//   使い方:
//     npm run probe:permits                      … BODIKを検索
//     npm run probe:permits -- --host=catalog.data.metro.tokyo.lg.jp
//     npm run probe:permits -- --days=90 --max=40
//
//   注意: 自治体サイトに負荷をかけないため1件ごとに間隔を空ける（--wait=ミリ秒）。
//   短時間に叩くと403で弾かれる（BODIKで実際にブロックされた）。弾かれたら時間を空けて再実行する。
// ============================================================
import { extractFreshPermitRows, type PermitSource } from '../src/lib/newSourceEngines.js'

const UA = 'Mozilla/5.0 (compatible; RST-crawler/1.0)'
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1]
const HOST = arg('host', 'data.bodik.jp')
const DAYS = Number(arg('days', '90'))
const MAX = Number(arg('max', '60'))
const WAIT = Number(arg('wait', '2500'))
const QUERIES = arg('q', '食品営業許可,食品等営業許可,飲食店営業許可,美容所').split(',')
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms))
/** 営業対象外のデータセット（宿泊/浴場/統計/講習など）は見ない */
const SKIP_RE = /旅館|浴場|興行|統計|講習|検査|バス|クリーニング|建築|開発|産業廃棄物|保育所|薬局|医療機器|ロス削減/

async function ckan(path: string): Promise<any | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://${HOST}/api/3/action/${path}`, { headers: { 'User-Agent': UA } })
      const t = await r.text()
      if (t.startsWith('{')) return JSON.parse(t)
      console.log(`  （カタログがHTMLを返した: アクセス制限の可能性。${(i + 1) * 10}秒待機）`)
      await sleep((i + 1) * 10000)
    } catch { await sleep(5000) }
  }
  return null
}

const since = Date.now() - DAYS * 86400000
const seen = new Set<string>()
const pkgs: any[] = []
for (const q of QUERIES) {
  const j = await ckan(`package_search?q=${encodeURIComponent(q)}&rows=100`)
  for (const p of j?.result?.results || []) if (!seen.has(p.id)) { seen.add(p.id); pkgs.push(p) }
  await sleep(WAIT)
}
console.log(`\n${HOST}: データセット ${pkgs.length}件を検査（鮮度窓 ${DAYS}日）\n`)

const hits: { org: string; title: string; fresh: number; tel: number; url: string; pkgId: string; salon: boolean; sample: string }[] = []
let checked = 0
for (const p of pkgs) {
  if (checked >= MAX) break
  const org = p.organization?.title || '?'
  const title = String(p.title || '')
  if (SKIP_RE.test(title)) continue
  const csvs = (p.resources || []).filter((r: any) => /csv|tsv/i.test(String(r.format || '')) || /\.(csv|tsv)(\?|$)/i.test(String(r.url || '')))
  if (!csvs.length) continue
  // 「新規」「直近」「月別」のファイルを優先（新規許可だけのファイルはそのまま使える）
  csvs.sort((a: any, b: any) => (/新規|直近|月別/.test(String(b.name || '')) ? 1 : 0) - (/新規|直近|月別/.test(String(a.name || '')) ? 1 : 0))
  const res = csvs[0]
  const url = String(res.url)
  const salon = /美容所|理容所|環境衛生/.test(title)
  const src: PermitSource = {
    key: 'probe', label: title, kind: /新規|直近|月別/.test(title + String(res.name || '')) ? 'monthly_new' : 'std_registry',
    industry: salon ? 'salon' : 'food', delimiter: /\.tsv$/i.test(url) ? '\t' : ',', urls: () => [],
  }
  checked++
  await sleep(WAIT)
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 40000)
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' }, signal: ctrl.signal, redirect: 'follow' })
    clearTimeout(to)
    if (!r.ok) { console.log(`× ${org} / ${title.slice(0, 26)} … HTTP ${r.status}`); continue }
    const ab = await r.arrayBuffer()
    if (ab.byteLength > 25 * 1024 * 1024) { console.log(`× ${org} / ${title.slice(0, 26)} … 25MB超（取込対象外）`); continue }
    const out = extractFreshPermitRows(src, Buffer.from(ab), since)
    if (out.error) { console.log(`× ${org} / ${title.slice(0, 26)} … ${out.error.slice(0, 60)}`); continue }
    const tel = out.fresh.filter((f) => f.tel).length
    const s = out.fresh[0]
    console.log(`${out.fresh.length > 0 ? '○' : '・'} ${org} / ${title.slice(0, 26)} … 全${out.rows}行 新規${out.fresh.length}件（電話あり${tel}）`)
    if (out.fresh.length > 0) hits.push({ org, title, fresh: out.fresh.length, tel, url, pkgId: p.id, salon, sample: s ? `${s.name} / ${s.addr} / ${s.tel || '電話なし'} / ${s.iso}` : '' })
  } catch (e: any) { console.log(`× ${org} / ${title.slice(0, 26)} … ${String(e?.message || e).slice(0, 40)}`) }
}

hits.sort((a, b) => b.fresh - a.fresh)
console.log(`\n==== 使えるデータセット ${hits.length}件（PERMIT_SOURCES に貼る形） ====\n`)
for (const h of hits) {
  const key = (h.org.replace(/[都道府県市区町村]/g, '') || 'src').toLowerCase().slice(0, 12)
  // ファイル名に日付が入るものは毎月URLが変わるのでCKANで解決する
  const dated = /\d{8}[^/]*\.csv$/i.test(h.url)
  console.log(`  // ${h.org} ${h.title}（実測 直近${DAYS}日で${h.fresh}件・電話あり${h.tel}件）`)
  console.log(`  //   例: ${h.sample}`)
  if (dated) {
    const m = h.url.match(/\/download\/(.+?)[\d]{8}/)
    console.log(`  { key: '${key}', label: '${h.org} ${h.title.slice(0, 16)}', kind: 'std_registry',${h.salon ? " industry: 'salon'," : ''} recencyDays: ${DAYS},`)
    console.log(`    ckan: { pkgId: '${h.pkgId}', match: '${m?.[1] || 'download/'}'${HOST === 'data.bodik.jp' ? '' : `, host: '${HOST}'`} }, urls: () => [] },`)
  } else {
    console.log(`  { key: '${key}', label: '${h.org} ${h.title.slice(0, 16)}', kind: 'std_registry',${h.salon ? " industry: 'salon'," : ''} recencyDays: ${DAYS},`)
    console.log(`    urls: () => ['${h.url}'] },`)
  }
}

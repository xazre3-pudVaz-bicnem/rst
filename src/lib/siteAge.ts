// ============================================================
// 公式サイトの「立ち上げ日」推定（サーバー専用）。
// GBPのクチコミが無い候補でも、HPが何年も前から存在すれば既存店、最近立ったなら新店、と見分けるために使う。
// 判定は本文中の日付の最古（＝お知らせ/ブログのアーカイブの最初＝サイト年齢の代理）と、
// 「ホームページを公開しました」等の公開告知に付く日付。
// ============================================================

const HP_LAUNCH_RE = /(?:ホームページ|公式(?:ホームページ|サイト)|Web\s?サイト|当サイト|サイト)(?:を)?(?:公開|開設|リニューアル|オープン)/i

function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * HTML本文から「サイトが最初に立った日」を推定し、その日数（過去）を返す。判定不能は null。
 * ① 公開/開設/リニューアル告知の近傍日付（＝立ち上げ日そのもの）を最優先。
 * ② 無ければ本文中の全日付の最古（お知らせアーカイブの最初）。
 * ※2000-01-01 より前・未来日は無視（創業年『1950年』等の沿革ノイズや誤日付を避ける）。
 */
export function siteLaunchDaysAgoFromHtml(html: string, nowMs: number = Date.now()): number | null {
  if (!html) return null
  const body = strip(html)
  const minMs = Date.parse('2000-01-01T00:00:00+09:00')
  const inRange = (t: number) => !Number.isNaN(t) && t <= nowMs + 86400000 && t >= minMs
  const pymd = (y: string, mo: string, d: string) =>
    Date.parse(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+09:00`)
  const dateStr = '(20\\d{2})[年./\\-]\\s?(\\d{1,2})[月./\\-]\\s?(\\d{1,2})'

  // ① 公開告知の近傍日付
  const near = new RegExp(`${dateStr}[^\\n]{0,40}?${HP_LAUNCH_RE.source}|${HP_LAUNCH_RE.source}[^\\n]{0,40}?${dateStr}`, 'ig')
  const launch: number[] = []
  let mm: RegExpExecArray | null; let g0 = 0
  while ((mm = near.exec(body)) && g0++ < 40) {
    const y = mm[1] || mm[4], mo = mm[2] || mm[5], d = mm[3] || mm[6]
    if (y && mo && d) { const t = pymd(y, mo, d); if (inRange(t)) launch.push(t) }
  }
  if (launch.length) return Math.floor((nowMs - Math.min(...launch)) / 86400000)

  // ② 本文中の全日付の最古
  const cand: number[] = []
  const re = /(20\d{2})[年./\-]\s?(\d{1,2})[月./\-]\s?(\d{1,2})/g
  let m: RegExpExecArray | null; let g = 0
  while ((m = re.exec(body)) && g++ < 150) { const t = pymd(m[1], m[2], m[3]); if (inRange(t)) cand.push(t) }
  if (cand.length) return Math.floor((nowMs - Math.min(...cand)) / 86400000)
  return null
}

/** 公式サイトURLを取得し、立ち上げからの日数を返す。取得失敗・判定不能は null。 */
export async function fetchSiteLaunchDaysAgo(url: string, timeoutMs = 8000, nowMs = Date.now()): Promise<number | null> {
  if (!url || !/^https?:\/\//.test(url)) return null
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSTBot/1.0; +lead research)' } })
    if (!r.ok) return null
    const html = await r.text()
    return siteLaunchDaysAgoFromHtml(html, nowMs)
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

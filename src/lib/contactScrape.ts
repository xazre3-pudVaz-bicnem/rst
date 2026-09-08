// ============================================================
// 公式サイトから電話・住所を取り出す（外部API課金ゼロ）。サーバー専用。
//  Google Placesの課金を停止したため、電話番号の補完はこちらが主経路になる。
//  HOTの条件（電話+住所+新店根拠）は変えない。欠けている電話を無料で埋めて、
//  本来HOTになるはずだった候補を取りこぼさないための処理。
//
//  取得順（信頼度の高い順）:
//   1. JSON-LD の telephone / address（店舗サイトで最も正確）
//   2. tel: リンク
//   3. 本文テキストの電話・住所パターン
//   4. トップに無ければ「お問い合わせ/アクセス/店舗情報」等の下層ページを最大2枚だけ辿る
// ============================================================
import { extractJpPhone, isValidJpPhone, isTollFreeJp } from './regionalParsers.js'
import { extractAddressLoose } from './enrichProfile.js'
import { isJapanPhone } from './japanFilter.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 RST-CRM-bot/1.0'

export interface ScrapedContact {
  phone: string
  address: string
  /** 取得元の内訳（デバッグ・監査用） */
  phoneFrom: '' | 'jsonld' | 'tel_link' | 'text'
  addressFrom: '' | 'jsonld' | 'text'
  /** 実際に電話/住所が取れたページ */
  foundUrl: string
  pagesFetched: number
}

const EMPTY: ScrapedContact = { phone: '', address: '', phoneFrom: '', addressFrom: '', foundUrl: '', pagesFetched: 0 }

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja' },
      redirect: 'follow', signal: ctrl.signal,
    })
    if (!res.ok) return ''
    const ct = String(res.headers.get('content-type') || '')
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return ''
    return (await res.text()).slice(0, 600_000)   // 巨大ページで詰まらないよう上限
  } catch {
    return ''
  } finally {
    clearTimeout(to)
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** JSON-LD（schema.org）から telephone / address を拾う。店舗サイトで最も正確な取得元。 */
function fromJsonLd(html: string): { phone: string; address: string } {
  let phone = '', address = ''
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []
  const visit = (node: any, depth = 0) => {
    if (!node || depth > 6) return
    if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return }
    if (typeof node !== 'object') return
    if (!phone && typeof node.telephone === 'string') phone = node.telephone
    const a = node.address
    if (!address && a) {
      if (typeof a === 'string') address = a
      else if (typeof a === 'object') {
        const parts = [a.addressRegion, a.addressLocality, a.streetAddress].filter((x: any) => typeof x === 'string' && x.trim())
        if (parts.length) address = parts.join('')
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, depth + 1)
  }
  for (const b of blocks) {
    const raw = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim()
    try { visit(JSON.parse(raw)) } catch { /* 壊れたJSON-LDは無視 */ }
    if (phone && address) break
  }
  return { phone, address }
}

/** tel: リンクから電話番号を拾う */
function fromTelLink(html: string): string {
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const v = String(m[1]).replace(/[^0-9+]/g, '').replace(/^\+81/, '0')
    if (isValidJpPhone(v) && !isTollFreeJp(v)) return v
  }
  return ''
}

/** 連絡先が載っていそうな下層ページのURL（お問い合わせ・アクセス・店舗情報 等） */
function contactLinks(html: string, baseUrl: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi
  for (const m of html.matchAll(re)) {
    const href = m[1]
    const label = stripTags(m[2])
    const hay = `${href} ${label}`
    if (!/(contact|access|about|company|info|shop|store|tenpo|inquiry|お問(い)?合(わ)?せ|問い合わせ|アクセス|店舗情報|会社概要|概要|所在地|地図)/i.test(hay)) continue
    let abs = ''
    try { abs = new URL(href, baseUrl).toString() } catch { continue }
    if (!/^https?:/i.test(abs)) continue
    try {
      // 別ドメインへ飛ぶリンク（SNS・予約サイト等）は辿らない
      if (new URL(abs).host.replace(/^www\./, '') !== new URL(baseUrl).host.replace(/^www\./, '')) continue
    } catch { continue }
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push(abs)
    if (out.length >= 4) break
  }
  return out
}

function pickPhone(html: string, text: string): { phone: string; from: ScrapedContact['phoneFrom'] } {
  const ld = fromJsonLd(html)
  const ldPhone = ld.phone ? ld.phone.replace(/[^0-9+]/g, '').replace(/^\+81/, '0') : ''
  if (ldPhone && isValidJpPhone(ldPhone) && !isTollFreeJp(ldPhone)) return { phone: ldPhone, from: 'jsonld' }
  const tel = fromTelLink(html)
  if (tel) return { phone: tel, from: 'tel_link' }
  const t = extractJpPhone(text)
  if (t && isJapanPhone(t) && isValidJpPhone(t) && !isTollFreeJp(t)) return { phone: t, from: 'text' }
  return { phone: '', from: '' }
}

function pickAddress(html: string, text: string): { address: string; from: ScrapedContact['addressFrom'] } {
  const ld = fromJsonLd(html)
  if (ld.address) {
    const r = extractAddressLoose(ld.address)
    if (r.address) return { address: r.address, from: 'jsonld' }
  }
  const r = extractAddressLoose(text)
  if (r.address) return { address: r.address, from: 'text' }
  return { address: '', from: '' }
}

/**
 * 公式サイトから電話・住所を取得する（API課金なし）。
 * @param url    公式サイトのURL
 * @param opts.need 既に持っている項目は探さない（'phone' | 'address' | 'both'）
 * @param opts.budgetMs 全体の時間予算（既定8秒）。超えたらそこまでの結果を返す。
 */
export async function scrapeContact(
  url: string,
  opts: { need?: 'phone' | 'address' | 'both'; budgetMs?: number } = {},
): Promise<ScrapedContact> {
  if (!url || !/^https?:\/\//i.test(url)) return { ...EMPTY }
  const need = opts.need ?? 'both'
  const budget = Math.max(3000, opts.budgetMs ?? 8000)
  const startedAt = Date.now()
  const remain = () => budget - (Date.now() - startedAt)

  const out: ScrapedContact = { ...EMPTY }
  const wantPhone = need === 'phone' || need === 'both'
  const wantAddr = need === 'address' || need === 'both'

  const top = await fetchHtml(url, Math.min(6000, remain()))
  if (!top) return out
  out.pagesFetched++
  const topText = stripTags(top)
  if (wantPhone) { const p = pickPhone(top, topText); if (p.phone) { out.phone = p.phone; out.phoneFrom = p.from; out.foundUrl = url } }
  if (wantAddr) { const a = pickAddress(top, topText); if (a.address) { out.address = a.address; out.addressFrom = a.from; out.foundUrl = out.foundUrl || url } }

  const satisfied = () => (!wantPhone || out.phone) && (!wantAddr || out.address)
  if (satisfied()) return out

  // トップに無い場合だけ、お問い合わせ/アクセス系を最大2枚辿る（店舗サイトは下層に連絡先を置く例が多い）
  for (const link of contactLinks(top, url).slice(0, 2)) {
    if (remain() < 2500) break
    const sub = await fetchHtml(link, Math.min(5000, remain()))
    if (!sub) continue
    out.pagesFetched++
    const subText = stripTags(sub)
    if (wantPhone && !out.phone) { const p = pickPhone(sub, subText); if (p.phone) { out.phone = p.phone; out.phoneFrom = p.from; out.foundUrl = link } }
    if (wantAddr && !out.address) { const a = pickAddress(sub, subText); if (a.address) { out.address = a.address; out.addressFrom = a.from; out.foundUrl = out.foundUrl || link } }
    if (satisfied()) break
  }
  return out
}

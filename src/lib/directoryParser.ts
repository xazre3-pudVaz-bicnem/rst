// ============================================================
// 店舗ディレクトリ型サイト（彩北なび等）の汎用パーサー（サーバー専用）
// 一覧ページ → 店舗詳細リンク抽出 → 詳細ページ取得 → 店名/電話/住所/OPEN日 抽出 → 判定。
// 記事本文は保存しない（短い抜粋・抽出結果のみ）。
// 他の地域ディレクトリにも拡張できるよう media_family ごとに設定を持つ。
// ============================================================
import { isForeignAddress, isJapanPhone, isOrgNonStore } from './japanFilter.js'
import { scoreCandidate, tierToTemperature, type HotTier, type InjectMode } from './hotTier.js'
import { detectChain } from './chainFilter.js'
import { detectBigOrPublic } from './targetFilter.js'
import { classifyIndustry } from './industry.js'

export interface DirectoryConfig {
  detailPattern: RegExp        // 店舗詳細URL（pathname+search）の判定
  /** 店舗詳細ではないURL（一覧/絞込/クーポン等）。detailPattern に一致してもこれに当たれば除外する。 */
  excludePattern?: RegExp
  industryHints?: RegExp
  /**
   * 店名候補の優先順（既定: h2→og→h1→title→一覧タイトル）。
   * サイトによっては h2 がタブ見出しだったり、og/title が「店名 - 業種 / 市 - サイト名」形式で
   * 汎用整形では店名が取れないため、media_family 単位で順序を上書きできるようにする。
   */
  nameOrder?: Array<'h1' | 'h2' | 'og' | 'title' | 'fallback'>
}

// media_family ごとの設定（拡張ポイント）
export const DIRECTORY_CONFIGS: Record<string, DirectoryConfig> = {
  // 彩北なび。実ドメインは saihokunavi.net（family名の 'saikohkunavi' は既存DB行との互換のため綴りを維持）。
  saikohkunavi: {
    // 例: /shop/shop.shtml?s=2364
    // ?s=NNNN&e=..&t=.. は同一店の「特集」表示で、店名が「◯◯特集」になり開業日も特集記事の日付を
    // 拾ってしまう（同じ店が二重に候補化される）。正準形 ?s=NNNN だけを店舗詳細とみなす。
    detailPattern: /\/shop\/shop\.shtml\?s=\d+$/i,
    // h2 はタブ見出し「基本情報」、og/title は「店名 - 業種 / 市 - サイト名」で末尾がサイト名になるため
    // h1（実店名）→ 一覧のリンクテキスト の順で採用する。
    nameOrder: ['h1', 'fallback'],
  },
  // いばナビ（茨城の地域情報サイト）。詳細は /shop/{id}（正準形のみ。/coupon /review は除外）。
  // h2/h1 はキャッチコピー（「〜がOPEN！」）なので、店名は <title>「店名[市/ジャンル]｜…いばナビ」から取る。
  ibanavi: {
    detailPattern: /\/shop\/\d+$/i,
    nameOrder: ['title', 'h1', 'fallback'],
  },
  // トリムトリム（ペットトリミングサロン検索）。詳細は /salon-detail/{連番ID}。
  // h1/h2 は「空き状況」等の見出しなので、店名は <title>「店名 | トリムトリム - トリムトリム」から取る。
  trimtrim: {
    detailPattern: /\/salon-detail\/\d+$/i,
    nameOrder: ['title', 'og', 'fallback'],
  },
}
// 既定（未知のディレクトリでも /shop/ 配下の詳細っぽいURLを拾う）
// 一覧/絞込/クーポン等の「店舗詳細ではないURL」を除く。これが無いと:
//  - まいぷれの業種絞込 /shop/list?c=1 が /(shop)\/[^?]*\??[a-z]*=?\d+/ に完全一致し、
//    絞込リンク126〜128本がDOM順で店舗カードより先に並ぶため、詳細fetchの5枠を全て食い潰していた
//    （拾える店名も「全て」「居酒屋・ダイニングバー」等のカテゴリ名になる）
//  - アミーカ千葉の /detail/179/coupon.html が本体 /detail/179/ と別URLとして二重に候補化されていた
const DIRECTORY_NON_DETAIL_RE = /\/(list|search|category|categories|genre|area|ranking|coupon|menu|photo|review|map|access)(\/|\.|\?|$)/i
const DEFAULT_DIRECTORY: DirectoryConfig = {
  detailPattern: /\/(shop|store|tenpo|spot|detail)\/[^?]*\??[a-z]*=?\d+/i,
  excludePattern: DIRECTORY_NON_DETAIL_RE,
}

export function directoryConfig(mediaFamily?: string | null): DirectoryConfig {
  return (mediaFamily && DIRECTORY_CONFIGS[mediaFamily]) || DEFAULT_DIRECTORY
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x?\d+;/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface OpenDate { text: string; month: number | null; day: number | null; year: number | null; confidence: 'high' | 'mid' | 'low' | 'none'; iso: string | null }

/** 店名/タイトル/本文から「○月○日OPEN」等の開業日を抽出。年が無ければ現在年で補完（不自然なら confidence を下げる）。 */
export function extractOpenDateFromTitle(text: string, now = Date.now()): OpenDate {
  const t = String(text || '')
  // 年つき: 2026年6月28日 / 2026/6/28
  let m = t.match(/(20\d{2})[年./\-]\s?(\d{1,2})[月./\-]\s?(\d{1,2})日?/)
  let year: number | null = null, month: number | null = null, day: number | null = null
  if (m) { year = Number(m[1]); month = Number(m[2]); day = Number(m[3]) }
  else {
    // 年なし: 「6月28日OPEN/オープン/開店」
    m = t.match(/(\d{1,2})月(\d{1,2})日\s*(?:OPEN|ｵｰﾌﾟﾝ|オープン|開店|開業|開院|新規|リニューアル)?/i)
    if (m) { month = Number(m[1]); day = Number(m[2]) }
  }
  if (month == null || day == null || month < 1 || month > 12 || day < 1 || day > 31) {
    return { text: '', month: null, day: null, year: null, confidence: 'none', iso: null }
  }
  const openWord = /(OPEN|ｵｰﾌﾟﾝ|オープン|開店|開業|開院|グランドオープン|プレオープン)/i.test(t)
  const label = t.match(/\d{1,2}月\d{1,2}日\s*(?:OPEN|オープン|開店|開業|開院)?/i)?.[0] || `${month}月${day}日`
  // 年補完
  const nowD = new Date(now)
  let useYear = year
  if (useYear == null) {
    useYear = nowD.getFullYear()
    // 例: 現在12月で「1月OPEN」は翌年、現在1月で「12月OPEN」は前年の可能性
    const cand = new Date(useYear, month - 1, day).getTime()
    const diffDays = (cand - now) / 86400000
    if (diffDays > 200) useYear -= 1       // かなり未来→前年の開業
    else if (diffDays < -200) useYear += 1 // かなり過去→翌年の開業予定
  }
  const iso = `${useYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const dt = new Date(useYear, month - 1, day).getTime()
  const diffDays = Math.round((dt - now) / 86400000)
  // 確度: OPEN語あり＋日付明確=high、日付のみ=mid、±400日超など不自然=low
  let confidence: OpenDate['confidence'] = openWord ? 'high' : 'mid'
  if (Math.abs(diffDays) > 400) confidence = 'low'
  return { text: label, month, day, year: useYear, confidence, iso }
}

// ============================================================
// 全ソース共通の開業日テキスト抽出（アンカー方式・高精度版）
// extractOpenDateFromTitle はディレクトリ経路の互換維持のため変更せず併存させ、
// 記事タイトル/本文/スニペットにはこちらを使う。純関数・外部依存なし
// （regionalMediaRun/newSourceEngines/serpDiscovery から循環なしで共用するため）。
// ============================================================

/**
 * 開業日抽出の結果。daysUntil/daysSince の符号規約は googlePlacesRun.parseGoogleOpening と同一
 * （開業日-現在 が 0以上→daysUntil、負→daysSince=絶対値。両方同時に非nullにはならない）。
 * precision は lead_candidates に専用カラムが無いため、呼び出し側で opening_date_source に
 * 'article_text_day' | 'article_text_part' | 'article_text_month' として符号化する規約。
 */
export interface TextOpeningDate { iso: string; raw: string; year: number; month: number; day: number; precision: 'day' | 'part' | 'month'; confidence: number; daysUntil: number | null; daysSince: number | null; yearInferred: boolean }

// オープン語（アンカー）。閉店告知や販促文の日付を拾わないよう、日付との共起でのみ発火させる
const OPEN_ANCHOR_RE = /(グランドオープン|プレオープン|ニューオープン|リニューアルオープン|新規オープン|移転オープン|オープン|ｵｰﾌﾟﾝ|(?<![A-Za-z])OPEN(?![A-Za-z])|新規開店|新装開店|開店|開業|開院|開所|開局)/i
// 強ラベル: 開業イベントを明示する語（confidence +10 の根拠）
const OPEN_STRONG_RE = /(グランドオープン|プレオープン|ニューオープン|新規オープン|新規開店|新装開店|開業|開院)/i
// オープン語の直後がこれらなら販促/経過の文脈（「オープン記念セール」「オープンから」等）でありオープン日アンカーにしない
const OPEN_EXCLUDE_AFTER_RE = /^\s*(記念|から|以来|以降|後|当時|セール|フェア|キャンペーン|価格|特価|限定|\d+\s*周年)/
// 閉店・周年（回顧）文脈: 日付の前後30字にあればその日付は開業日として不採用
const OPEN_CLOSE_CONTEXT_RE = /(閉店|閉業|閉院|閉館|閉園|閉鎖|廃業|休業|営業終了|閉場|\d+\s*周年|創業\s*\d)/
// 日付トークン: 「2026年7月15日」「7月15日」「7月上旬」「7月」「2026/7/15」「7/15」。
// 電話番号・価格の誤爆を避けるため、ハイフン区切り数字は年つき以外は対象にしない
const OPEN_DATE_TOKEN_RE = /(?<!\d)(?:(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(?:(\d{1,2})\s*日|(上旬|中旬|下旬))?|(20\d{2})[/.](\d{1,2})[/.](\d{1,2})|(\d{1,2})\/(\d{1,2})(?![\d/.]))/g
const OPEN_WEEKDAY_JA = '日月火水木金土'

/**
 * 記事タイトル/本文/スニペットから開業日を1件抽出する共通関数（全ソース共用の基盤）。
 * アンカー方式: 日付とオープン語が「。」（改行含む）を跨がず20字以内に共起した場合のみ採用。
 * - 旬（上旬/中旬/下旬）は 5/15/25日 に丸めて precision:'part'、月のみは1日扱いで precision:'month'
 * - 年なしは publishedIso（無ければ nowMs）基準に Y-1/Y/Y+1 の最近接年を推定
 *   （括弧曜日「(火)」があれば曜日一致年のみ採用・全滅なら破棄＝誤年推定の防波堤）
 * - ガード: 前後30字の閉店/周年語、日付直後の「まで/をもって」、相異なる日付3件以上（まとめ記事）、
 *   現在±400日超 → いずれも null（誤抽出がHOT昇格や再コールを誤駆動しないための多層防御）
 * - confidence 0-100: 基礎50 / 明示年+20 / day精度+15 / 強ラベル+10 / 曜日一致+15 / 月のみ-10 / 年推定-10、
 *   相異なるアンカー付き日付が複数拮抗する場合は55キャップ
 * 代表例:
 * - 採用: 「7月15日(火)グランドオープン」→ day精度・曜日検証・強ラベルで高confidence
 * - null: 「12月28日をもって閉店」（閉店文脈）/「オープンから3周年」（経過文脈・開業日語共起なし）/
 *         「セールは7月31日まで」（期限表現）
 */
export function extractOpeningDateFromText(text: string, opts?: { publishedIso?: string | null; nowMs?: number }): TextOpeningDate | null {
  const nowMs = opts?.nowMs ?? Date.now()
  let t = String(text || '').slice(0, 12000)
  if (!t.trim()) return null
  // 全角→半角の正規化（数字/英字/括弧/区切り）。改行は文境界として「。」に落とす（アンカーが文を跨がないように）
  t = t
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/／/g, '/').replace(/．/g, '.').replace(/[−－‐―]/g, '-')
    .replace(/[\r\n]+/g, '。')
  // 年推定の基準は記事公開日（無ければ現在）。開業告知記事は開業日の前後数週間に出るため最近接が最も当たる
  const pubMs = opts?.publishedIso ? Date.parse(opts.publishedIso) : NaN
  const refMs = Number.isFinite(pubMs) ? pubMs : nowMs
  const baseYear = new Date(refMs).getFullYear()

  interface Tok { start: number; end: number; raw: string; year: number | null; month: number; day: number | null; part: string | null }
  const toks: Tok[] = []
  for (const m of t.matchAll(OPEN_DATE_TOKEN_RE)) {
    const year = m[1] ? Number(m[1]) : m[5] ? Number(m[5]) : null
    const month = Number(m[2] ?? m[6] ?? m[8])
    const dayRaw = m[3] ?? m[7] ?? m[9]
    const day = dayRaw != null ? Number(dayRaw) : null
    if (!(month >= 1 && month <= 12)) continue
    if (day != null && !(day >= 1 && day <= 31)) continue
    toks.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0].trim(), year, month, day, part: m[4] ?? null })
  }
  if (!toks.length) return null

  // まとめ記事ガード: 「日まで特定できる」相異なる日付が3件以上ある文章は単一店舗の開業告知と断定できない
  // （年の有無だけの表記ゆれを同一視するため月-日をキーにする）
  const distinctDates = new Set<string>()
  for (const tk of toks) { if (tk.day != null || tk.part) distinctDates.add(`${tk.month}-${tk.day ?? tk.part}`) }
  if (distinctDates.size >= 3) return null

  interface Cand { tk: Tok; strong: boolean; weekday: number | null }
  const cands: Cand[] = []
  for (const tk of toks) {
    const before30 = t.slice(Math.max(0, tk.start - 30), tk.start)
    const after30 = t.slice(tk.end, tk.end + 30)
    // 閉店/周年（回顧）文脈: この日付は開業日ではない
    if (OPEN_CLOSE_CONTEXT_RE.test(before30) || OPEN_CLOSE_CONTEXT_RE.test(after30)) continue
    // 期限表現: 「7月31日まで」「12月28日をもって」はセール終期/閉店日であって開業日ではない
    if (/^\s*(?:を?もって|までに?|迄)/.test(after30)) continue
    // 括弧曜日（例: (火) / (火・祝)）。年推定の検証に使う
    const wd = after30.match(/^\s*\(\s*([日月火水木金土])(?:曜日?)?(?:[・,、/]\s*祝日?)?\s*\)/)
    const weekday = wd ? OPEN_WEEKDAY_JA.indexOf(wd[1]) : null
    // アンカー1: 日付→語（日付の後20字以内・。を跨がない）
    let word = ''
    const afterSeg = t.slice(tk.end, tk.end + 20).split('。')[0]
    const am = afterSeg.match(OPEN_ANCHOR_RE)
    if (am && am.index != null) {
      const wordEndAbs = tk.end + am.index + am[0].length
      if (!OPEN_EXCLUDE_AFTER_RE.test(t.slice(wordEndAbs, wordEndAbs + 10))) word = am[0]
    }
    // アンカー2: 語→日付（日付の前20字以内・。を跨がない。語の直後が除外文脈なら不採用）
    if (!word) {
      const beforeSeg = t.slice(Math.max(0, tk.start - 20), tk.start)
      const seg = beforeSeg.split('。').pop() || ''
      const segStartAbs = tk.start - seg.length
      const re = new RegExp(OPEN_ANCHOR_RE.source, 'gi')
      let last: RegExpExecArray | null = null
      for (let mm = re.exec(seg); mm; mm = re.exec(seg)) last = mm
      if (last) {
        const wordEndAbs = segStartAbs + last.index + last[0].length
        if (!OPEN_EXCLUDE_AFTER_RE.test(t.slice(wordEndAbs, wordEndAbs + 10))) word = last[0]
      }
    }
    if (!word) continue
    cands.push({ tk, strong: OPEN_STRONG_RE.test(word), weekday })
  }
  if (!cands.length) return null

  const resolve = (c: Cand): TextOpeningDate | null => {
    const day = c.tk.day ?? (c.tk.part === '上旬' ? 5 : c.tk.part === '中旬' ? 15 : c.tk.part === '下旬' ? 25 : 1)
    const precision: TextOpeningDate['precision'] = c.tk.day != null ? 'day' : c.tk.part ? 'part' : 'month'
    // 実在日チェック（2月30日等はDateが繰り上がるため月日一致で検証）
    const valid = (y: number): Date | null => {
      const d = new Date(y, c.tk.month - 1, day)
      return d.getFullYear() === y && d.getMonth() === c.tk.month - 1 && d.getDate() === day ? d : null
    }
    let year: number
    let yearInferred = false
    let weekdayMatched = false
    if (c.tk.year != null) {
      const d = valid(c.tk.year)
      if (!d) return null
      if (c.weekday != null && precision === 'day') {
        // 明示年でも括弧曜日と不一致なら誤記/誤抽出の可能性が高く破棄
        if (d.getDay() !== c.weekday) return null
        weekdayMatched = true
      }
      year = c.tk.year
    } else {
      yearInferred = true
      let best: { y: number; dist: number } | null = null
      for (const y of [baseYear - 1, baseYear, baseYear + 1]) {
        const d = valid(y)
        if (!d) continue
        if (c.weekday != null && precision === 'day' && d.getDay() !== c.weekday) continue
        const dist = Math.abs(d.getTime() - refMs)
        if (!best || dist < best.dist) best = { y, dist }
      }
      if (!best) return null // 曜日一致年なし → 誤抽出とみなし破棄
      year = best.y
      if (c.weekday != null && precision === 'day') weekdayMatched = true
    }
    const dt = new Date(year, c.tk.month - 1, day)
    const diff = Math.round((dt.getTime() - nowMs) / 86400000)
    if (Math.abs(diff) > 400) return null // 現在±400日超は開業日として不自然（回顧記事・年ズレの防御）
    let confidence = 50
    if (c.tk.year != null) confidence += 20
    if (precision === 'day') confidence += 15
    else if (precision === 'month') confidence -= 10
    if (c.strong) confidence += 10
    if (weekdayMatched) confidence += 15
    if (yearInferred) confidence -= 10
    confidence = Math.max(0, Math.min(100, confidence))
    const iso = `${year}-${String(c.tk.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return {
      iso, raw: c.tk.raw, year, month: c.tk.month, day, precision, confidence,
      daysUntil: diff >= 0 ? diff : null, daysSince: diff < 0 ? -diff : null, yearInferred,
    }
  }

  const resolved: TextOpeningDate[] = []
  for (const c of cands) { const r = resolve(c); if (r) resolved.push(r) }
  if (!resolved.length) return null
  // 複数候補拮抗: アンカー付きの相異なる日付が並存（プレ/グランド両告知等）→ どれが開業日か断定しづらいので55キャップ
  const cap = new Set(resolved.map((r) => r.iso)).size >= 2 ? 55 : 100
  let bestR = resolved[0]
  for (const r of resolved) { if (r.confidence > bestR.confidence) bestR = r }
  if (bestR.confidence > cap) bestR = { ...bestR, confidence: cap }
  return bestR
}

export interface DirectoryLink { url: string; title: string; open: OpenDate }

/** 一覧ページから店舗詳細リンクを抽出（media_family の detailPattern で判定）。 */
export function extractDirectoryListingLinks(html: string, base: URL, mediaFamily?: string | null): {
  links: DirectoryLink[]; totalLinks: number; detailLinks: number; openTagged: number
} {
  const cfg = directoryConfig(mediaFamily)
  const out: DirectoryLink[] = []
  const seen = new Set<string>()
  let totalLinks = 0, openTagged = 0
  for (const mt of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    totalLinks++
    const href = mt[1]
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue
    let abs: URL
    try { abs = new URL(href, base) } catch { continue }
    if (abs.host !== base.host) continue
    const pathAndSearch = abs.pathname + (abs.search || '')
    if (!cfg.detailPattern.test(pathAndSearch)) continue
    if (cfg.excludePattern?.test(pathAndSearch)) continue // 一覧/絞込/クーポン等は店舗詳細ではない
    const key = abs.toString()
    if (seen.has(key)) continue
    seen.add(key)
    const title = stripTags(mt[2]).slice(0, 140)
    const open = extractOpenDateFromTitle(title)
    if (open.confidence !== 'none') openTagged++
    out.push({ url: key, title, open })
  }
  return { links: out, totalLinks, detailLinks: out.length, openTagged }
}

export interface DirectoryShopInfo {
  shop_name: string; phone: string; address: string; industry: string
  hours: string; holiday: string; official_url: string; instagram_url: string; map_url: string
  open: OpenDate; excerpt: string
}

/** テキストから正規の業種を推定（フォーム選択肢と一致する値のみ返す）。店名＋記事タイトル等の店舗固有テキストに使うこと。 */
export function detectIndustryFromText(text: string): string {
  return classifyIndustry(text)
}

const CHAIN_HINT = /(マクドナルド|スターバックス|スタバ|ケンタッキー|モスバーガー|ガスト|サイゼリヤ|吉野家|すき家|松屋|ドトール|タリーズ|コメダ|丸亀製麺|ユニクロ|\bGU\b|ＧＵ|セブンイレブン|ファミリーマート|ローソン|QBハウス|ライザップ|チョコザップ|カーブス|ほっともっと|大戸屋|やよい軒|ニトリ|業務スーパー|ドン・?キホーテ|マツモトキヨシ|ウエルシア|スギ薬局)/i

function pickUrl(html: string, re: RegExp): string {
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) { if (re.test(m[1])) return m[1] }
  return ''
}

/** 店舗詳細ページHTMLから店名・電話・住所・業種・OPEN日などを抽出。 */
export function extractDirectoryShopInfo(html: string, fallbackTitle = '', mediaFamily?: string | null): DirectoryShopInfo {
  const body = stripTags(html)
  const PREF = '北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県'
  // 店名: h2(店名表示) → og:title/h1から『地名のカテゴリ』パンくず＆サイト名を除去した実店名。ナビ/カテゴリは採用しない
  const og = stripTags(html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || '')
  const h1 = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
  const h2 = stripTags(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || '')
  const tt = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
  // パンくずカテゴリ判定（例: 千葉市中央区のレジャー・観光スポット / 船橋市のグルメ）
  const isCrumb = (s: string) => /^[^\s]{1,12}[都道府県市区町村][^\s]{0,10}の(グルメ|カフェ|レジャー|観光|スポット|公共施設|施設|美容|サロン|ショップ|お店|ニュース|エンタメ|ホテル|宿|温泉|病院|クリニック|教室|サービス|ショッピング|買い物)/.test(s.trim())
  const cleanCand = (raw: string): string => {
    let s = String(raw || '').replace(/\s*[|｜].*$/, '').trim()  // サイト名(| 以降)除去
    if (s.includes(' - ') || s.includes(' – ') || s.includes('｜')) {
      // 「カテゴリ - 店名」型: パンくずでないセグメントの最後を店名に
      const parts = s.split(/\s*[-–]\s*/).map((x) => x.trim()).filter(Boolean)
      const nonCrumb = parts.filter((p) => !isCrumb(p))
      s = (nonCrumb.length ? nonCrumb[nonCrumb.length - 1] : parts[parts.length - 1]) || s
    }
    if (isCrumb(s)) s = s.replace(/^[^\s]{1,12}[都道府県市区町村][^\s]{0,10}の[^\s]{1,16}?(スポット|グルメ|カフェ|公共施設|施設|美容室|サロン|お店|ニュース|エンタメ|ショップ|教室|サービス)\s*/, '').trim()
    // 末尾の「[地域/ジャンル]」「【…】」「（…）」カテゴリタグを除去（例: そば処 大吉[古河市/和食] → そば処 大吉）
    return s.replace(/[[【（][^\]】）]*[\]】）]\s*$/, '').replace(/（[^）]*）\s*$/, '').trim().slice(0, 50)
  }
  // 既定は h2（実店名のことが多い）→ og:title整形 → h1整形 → title → 一覧タイトル。
  // サイト設定 nameOrder があればそれに従う（h2がタブ見出し等のサイト向け）。
  const nameCands: Record<'h1' | 'h2' | 'og' | 'title' | 'fallback', string> = {
    h1: cleanCand(h1), h2, og: cleanCand(og), title: cleanCand(tt), fallback: stripTags(fallbackTitle),
  }
  // タブ見出し/ナビ語は店名ではない（例: 彩北なびの最初のh2はタブの「基本情報」）
  const isNavLabel = (s: string) =>
    /^(ニュース|メニュー|HOME|アクセス|クチコミ|口コミ|お気に入り|TOP|基本情報|店舗情報|スポット情報|詳細情報|クーポン|写真|地図|MAP)/.test(s)
  let shop_name = ''
  for (const k of directoryConfig(mediaFamily).nameOrder ?? ['h2', 'og', 'h1', 'title', 'fallback']) {
    const s = (nameCands[k] || '').trim()
    if (s && !isCrumb(s) && s.length >= 2 && !isNavLabel(s)) { shop_name = s.slice(0, 50); break }
  }
  if (!shop_name) shop_name = cleanCand(og) || cleanCand(h1) || stripTags(fallbackTitle).slice(0, 40)

  // 電話: tel:リンク → TEL/電話ラベル → 本文中の日本の番号
  let phone = (html.match(/href=["']tel:(\+?[\d-]{9,15})["']/i)?.[1] || '').replace(/^\+81/, '0')
  if (!phone) { const telLabel = body.match(/(?:TEL|ＴＥＬ|電話|でんわ|お問い合わせ)[^\d+]{0,6}(0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4})/i); if (telLabel) phone = telLabel[1] }
  // 素の本文スキャンは最後の手段。区切りに空白を許すと郵便番号をまたいで誤マッチするため、
  // ハイフン/括弧区切り or 区切りなしの正準形だけを拾う。
  // 例: TEL欄が「-」（電話なし）の店で「Saitama 360-0816 360-0816 熊谷市…」から "0816 360-0816" を拾い、
  //     数字だけ見ると0始まり11桁で isJapanPhone を通過し、電話が無い店に偽番号が付いていた。
  if (!phone) { for (const m of body.matchAll(/0\d{1,3}[-(]?\d{2,4}[-)]?\d{3,4}/g)) { if (isJapanPhone(m[0])) { phone = m[0]; break } } }
  phone = phone.trim()

  // 住所: 都道府県アンカー最優先（『アクセス』ラベルはナビ誤爆するので使わない）。住所/所在地ラベル＋都道府県 → 都道府県アンカー → 市区町村+番地
  let address = ''
  const labelPref = body.match(new RegExp(`(?:住所|所在地)[:：\\s]{0,4}(〒?\\s*\\d{0,3}-?\\d{0,4}\\s*)?((?:${PREF})[^\\n。、）)]{3,50})`))
  const addrPref = body.match(new RegExp(`(?:${PREF})[一-龥ぁ-んァ-ヶ0-9０-９]{2,30}[-－0-9０-９]{1,12}`))
  const addr2 = body.match(/[一-龥ぁ-んァ-ヶ]{1,8}[市区町村][一-龥ぁ-んァ-ヶ0-9０-９]{1,20}[-－0-9０-９]{1,10}/)
  if (labelPref) address = ((labelPref[1] || '') + labelPref[2])
  else if (addrPref) address = addrPref[0]
  else if (addr2) address = addr2[0]
  // 末尾に続くナビ/付帯情報を切る（アクセス/営業時間/交通/地図/TEL等）
  address = address.replace(/(アクセス|営業時間|交通|地図|ＭＡＰ|MAP|TEL|ＴＥＬ|電話|定休|駐車|お問い?合わせ|ホームページ|公式|クチコミ|ニュース|メニュー|最寄り?駅).*$/i, '').replace(/\s+/g, '').slice(0, 60)

  // 業種は「店名＋記事タイトル」の店舗固有テキストを最優先（ページ全体だと関連記事のパン屋等を誤検出するため）。
  const industry = detectIndustryFromText(`${shop_name} ${fallbackTitle}`) || detectIndustryFromText(body.slice(0, 400)) || ''
  const hours = (body.match(/(?:営業時間|営業)[:：]?\s*([0-9０-９:：~〜\-\s]{4,30})/)?.[1] || '').trim().slice(0, 40)
  const holiday = (body.match(/(?:定休日|店休日|休み)[:：]?\s*([^\n。]{1,20})/)?.[1] || '').trim().slice(0, 30)
  const instagram_url = pickUrl(html, /instagram\.com/i)
  const map_url = pickUrl(html, /google\.[^/]*\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i)
  const official_url = pickUrl(html, /^https?:\/\//i) && (() => {
    for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
      const u = m[1]
      if (/instagram\.com|twitter\.com|x\.com|facebook\.com|line\.me|google\.|goo\.gl|saikohkunavi|saihokunavi/i.test(u)) continue
      return u
    }
    return ''
  })() || ''

  const open = extractOpenDateFromTitle(`${shop_name} ${fallbackTitle} ${body.slice(0, 600)}`)
  const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i)
  const excerpt = stripTags(desc?.[1] || body.slice(0, 200)).slice(0, 200)

  return { shop_name, phone, address, industry, hours, holiday, official_url, instagram_url, map_url, open, excerpt }
}

export interface DirectoryClassify { temperature: string; hot_tier: 'A' | 'B' | null; tier: HotTier; score: number; reason: string; priority: 'high' | 'normal' | null; isChain: boolean; isForeign: boolean }

/** ディレクトリ/マーケットプレイス候補の判定（新規掲載＝新店根拠。営業向きならHOT_A/HOT_B）。 */
export function classifyDirectoryCandidate(info: { shop_name: string; phone: string; address: string; open: OpenDate; isJapan: boolean }, mode: InjectMode = 'standard'): DirectoryClassify {
  const ch = detectChain(info.shop_name)
  const isChain = CHAIN_HINT.test(info.shop_name) || ch.definite
  const isForeign = isForeignAddress(info.address)
  const hasPhone = !!info.phone && isJapanPhone(info.phone)
  const hasAddr = !!info.address
  const hasOpen = info.open.confidence === 'high' || info.open.confidence === 'mid'
  // 大手/公共/大型施設/道の駅/産直/JA等は営業対象外（ターゲット=個人事業主・小規模店）
  const big = detectBigOrPublic(`${info.shop_name} ${info.address}`)
  const sc = scoreCandidate({
    source: 'regional_media', isJapan: info.isJapan, hasShopName: !!info.shop_name, hasPhone, hasArea: hasAddr,
    hasOpeningDate: hasOpen, isFuture: false, igNew: false, regionalNew: false, newListing: true,
    placesMatched: false, hasOfficial: false,
    isChain, chainSuspect: ch.suspect && !ch.definite, isOrg: isOrgNonStore(info.shop_name) || big.exclude, isEventRecruit: false, isForeign, isDup: false, reviewMany: false,
  }, mode)
  let { temperature, hot_tier } = tierToTemperature(sc.tier)
  let reason = sc.reason
  if (big.exclude) { temperature = 'EXCLUDED'; hot_tier = null; reason = `${big.reason}${reason}` }
  return { temperature, hot_tier, tier: sc.tier, score: sc.score, reason, priority: sc.priority, isChain: isChain || big.exclude, isForeign }
}

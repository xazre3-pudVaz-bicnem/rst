// ============================================================
// 汎用SERPディスカバリ・エンジン（Google/Serper検索駆動）。サーバー専用。
// query-based の複数 source_type を1エンジンで処理: source実行→candidate抽出→詳細取得→
// 店名/電話/住所/URL/新規根拠抽出→Places/公式補完→検証→重複判定→HOT/HOLD/EXCLUDED→
// lead_candidates保存→HOTならcases投入→lead_signals保存→営業優先度→架電前メモ→ログ。
// 件数より質。電話/住所なしはHOT禁止。日本国内のみ。大手/公共/閉店/重複は除外。差分(既読URLスキップ)対応。
// ============================================================
import { webSearch, enrichCandidate } from './instagramWebRun.js'
import { sanitizeShopName, isValidJpPhone, extractJpPhone, isTollFreeJp } from './regionalParsers.js'
import { hardExcludeReason } from './excludeGate.js'
import { isJapanPhone, isJapanAddress, isForeignAddress } from './japanFilter.js'
import { detectBigOrPublic, detectMultiStore } from './targetFilter.js'
import { classifyIndustry, normalizeIndustry } from './industry.js'
import { detectChain } from './chainFilter.js'
import { computeQuality, detectNegative, isRealStoreAddress, phoneAddressMatch } from './leadQuality.js'
import { addSignals, applySalesScore } from './leadSignals.js'
import { getSourceDef, pastDates } from './discoverySources.js'
import { autoImportAllowed, type InjectMode } from './hotTier.js'
import { findCaseIdByPhone } from './caseDedup.js'
import { placesEstablishmentSignal, BIG_GOOGLE_REVIEWS } from './importHot.js'
import { ingestExtractedStores } from './newSourceEngines.js'
import { extractOpeningDateFromText } from './directoryParser.js'
import { caseImportGate, applyGateDowngrade } from './importGate.js'
import { DEFAULT_STATUS } from './constants.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 RST-CRM-bot/1.0'

/**
 * 検索APIの「継続不能」エラーか（残高切れ/クォータ/レート超過/認証失敗）。
 * これらは残高やキーが直るまで全クエリが失敗するため、0件を「正常0件」と扱ってはいけない。
 * （実際に Serper が "Not enough credits" を返す状態でも status='success' で記録され続け、
 *   SERP由来のソースが全滅しているのに気づけない事故があったため必ずrunをerrorにする。）
 */
export function isProviderFatalError(msg?: string | null): boolean {
  return /not enough credits|insufficient|quota|rate limit|too many requests|unauthorized|forbidden|invalid api key|api key|HTTP 4(01|03|29)/i.test(String(msg || ''))
}
const PREF_RE = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)[一-龥ぁ-んァ-ヶ0-9０-９丁目番地号－−\-]{2,40}/
// 新店根拠（HOT必須）: クエリが新店系でも着地ページが古い既存店のことがあるため、本文/タイトルで実際の新店文脈を確認する。
const NEW_OPEN_RE = /(新規オープン|ニューオープン|グランドオープン|プレオープン|オープンしました|オープンいたしました|オープン予定|オープンいたします|近日オープン|まもなくオープン|もうすぐオープン|本日オープン|明日オープン|移転オープン|リニューアルオープン|開店しました|開店いたしました|開業しました|開業いたしました|開院しました|開院いたしました|開設しました|新規開業|新規開店|開業予定|開院予定|開院のお知らせ|開業のお知らせ|オープンのお知らせ|オープニング|グランドオープン|プレオープン|new[\s_]?open|grand[\s_]?open|now[\s_]?open|coming[\s_]?soon)/i
// 開業日/オープン日 表記（YYYY年M月/M月D日 OPEN 等）。新店の裏取りを補強。
const OPEN_DATE_RE = /(20\d{2}年\s?\d{1,2}月|(0?[1-9]|1[0-2])月\s?([0-3]?\d)日)\s?(グランド|ニュー|プレ)?オープン|オープン日|開店日|開業日|開院日/i
// 新HP公開の根拠語（新規HP公開7日以内 取得元で使用）
const HP_PUBLISH_RE = /(ホームページを公開しました|ホームページを開設しました|公式(?:ホームページ|サイト)を公開しました|公式サイトを開設しました|Web\s?サイトを公開しました|Web\s?サイトを開設しました|ホームページ開設のお知らせ|公式サイト開設のお知らせ|サイト公開のお知らせ|ホームページをリニューアル(?:しました|オープン)?|サイトをリニューアル(?:しました)?|ホームページができました|ホームページ完成しました|新しいホームページ|ホームページ(?:を)?公開|公式サイト(?:を)?公開|公式サイト開設|サイトを公開しました|ホームページを新しく|新規サイトを公開)/i
// 取得元別の新規性シグナル（新入会員/新規掲載/制作実績/施工事例/開業準備/内覧会/キャンペーン/予約受付開始 等、
// 新店ワード以外の正当な根拠）。これが無いと該当取得元が全てHOLDになり投入されないため、汎用の新店根拠に含める。
const BIZ_SIGNAL_RE = /(新規掲載|新規加盟|新入会員|新規会員|入会のお知らせ|新規登録店舗|制作実績|お客様のホームページ|看板が(?:つきました|完成しました)|内装工事中|店舗準備中|開店準備中|プレオープン準備|物件(?:決まりました|契約|が決まりました)|オープンに向けて|新装開店|開設いたしました|内覧会|オープンキャンペーン|OPEN記念|オープン記念|開業記念|グランドオープンキャンペーン|無料体験|体験会|体験レッスン|初回体験|予約受付開始|予約開始|受付開始|初回予約|スタッフ募集開始|採用開始|オープニングスタッフ|掲載開始|掲載されました|メニュー(?:公開|ができました)|料金表(?:を公開|公開)|価格表公開|予約ページを公開|独立(?:しました|開業)|退職して開業|脱サラ|屋号が決まりました|店名が決まりました|営業許可(?:取得|が下りました)|保健所の許可|開業届|開業祝い|開店祝い|開院祝い|レセプション|プレ営業|ソフトオープン|オープン研修|開業前研修|近日OPEN|OPEN予定|オープン予定|開業準備中|創業(?:者紹介|支援事例)|開業支援事例|導入事例|活用事例)/i

// 記事/お知らせの公開日を推定（meta/time優先→日本語/スラッシュ日付）。未来日・2年超は無視。
// mode='newest'（既定）: 最も新しい妥当日を返す（記事の鮮度検証用）。
// mode='launch'      : サイトが「最初に立った日」を返す（新規HP公開の判定用）。
//   最新日で判定すると、そば入荷のお知らせ等で更新頻度の高い“既存サイト”が全て新規扱いになるため
//   （実例: 松村製粉所は 2025-05-21 にHP公開済みだが最新お知らせ 2026-07 で「6日前公開」と誤判定）、
//   ①「ホームページを公開しました」等の公開告知に付く日付を最優先、②無ければ本文の最古日を採る。
function extractPublishDate(html: string, bodyStrip: string, nowMs: number, mode: 'newest' | 'launch' = 'newest'): { iso: string | null; daysAgo: number | null } {
  const inRange = (t: number) => !Number.isNaN(t) && t <= nowMs + 86400000 && t >= nowMs - 730 * 86400000
  const asResult = (t: number) => ({ iso: new Date(t).toISOString().slice(0, 10), daysAgo: Math.floor((nowMs - t) / 86400000) })
  const parseYmd = (y: string, mo: string, d: string) => Date.parse(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+09:00`)

  if (mode === 'launch') {
    // ① 公開/開設/リニューアル告知の近傍にある日付（＝サイト立ち上げ日そのもの。最も確実）。
    //    「2025.05.21 …ホームページを公開しました」「ホームページを公開しました 2025/5/21」の双方向を見る。
    const launch: number[] = []
    const dateStr = '(20\\d{2})[年./\\-]\\s?(\\d{1,2})[月./\\-]\\s?(\\d{1,2})'
    const near = new RegExp(`${dateStr}[^\\n]{0,40}?${HP_PUBLISH_RE.source}|${HP_PUBLISH_RE.source}[^\\n]{0,40}?${dateStr}`, 'ig')
    let mm: RegExpExecArray | null; let g0 = 0
    while ((mm = near.exec(bodyStrip)) && g0++ < 40) {
      // 前方一致(1-3)か後方一致(4-6)のどちらかに数値が入る
      const y = mm[1] || mm[4], mo = mm[2] || mm[5], d = mm[3] || mm[6]
      if (y && mo && d) { const t = parseYmd(y, mo, d); if (inRange(t)) launch.push(t) }
    }
    if (launch.length) return asResult(Math.min(...launch)) // 告知が複数なら最初の公開＝最古
    // ② 本文中の全日付の最古（サイトの“お知らせ”アーカイブの最初＝サイト年齢の代理）。
    const cand: number[] = []
    const re = /(20\d{2})[年./\-]\s?(\d{1,2})[月./\-]\s?(\d{1,2})/g
    let m: RegExpExecArray | null; let g = 0
    while ((m = re.exec(bodyStrip)) && g++ < 80) { const t = parseYmd(m[1], m[2], m[3]); if (inRange(t)) cand.push(t) }
    if (cand.length) return asResult(Math.min(...cand))
    return { iso: null, daysAgo: null }
  }

  // mode='newest'
  // 1) meta / <time datetime>（信頼度高）
  const strong: number[] = []
  const meta = html.match(/<meta[^>]+(?:article:published_time|og:updated_time|itemprop=["']datePublished["'])[^>]*content=["']([^"']+)/i)?.[1]
  const timeAttr = html.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1]
  for (const s of [meta, timeAttr]) { if (s) { const t = Date.parse(s); if (inRange(t)) strong.push(t) } }
  if (strong.length) return asResult(Math.max(...strong))
  // 2) 本文中の日付（YYYY年M月D日 / YYYY/M/D / YYYY-M-D）
  const cand: number[] = []
  const re = /(20\d{2})[年./\-]\s?(\d{1,2})[月./\-]\s?(\d{1,2})/g
  let m: RegExpExecArray | null; let guard = 0
  while ((m = re.exec(bodyStrip)) && guard++ < 60) { const t = parseYmd(m[1], m[2], m[3]); if (inRange(t)) cand.push(t) }
  if (!cand.length) return { iso: null, daysAgo: null }
  return asResult(Math.max(...cand))
}

// 簡易Web品質チェック（title/meta/h1/リンク/構造化データ/導線）。重いクロールはせずHTMLの静的解析のみ。
function analyzeWebQuality(html: string, url: string): { score: number; type: string; builder: boolean; seoWeak: string; meoWeak: string; aioWeak: string } {
  const builderName = /wixsite\.com|\.wix\.com/i.test(url + html) ? 'Wix'
    : /jimdo/i.test(url) ? 'Jimdo' : /peraichi/i.test(url) ? 'ペライチ' : /studio\.site/i.test(url) ? 'STUDIO'
    : /amebaownd/i.test(url) ? 'Ameba Ownd' : /sites\.google\.com/i.test(url) ? 'Google Sites' : /goope\.jp|crayonsite|localinfo\.jp/i.test(url) ? '簡易HP' : null
  const metaDesc = /<meta[^>]+name=["']description["'][^>]*content=["']\s*\S/i.test(html)
  const h1 = /<h1[\s>]/i.test(html)
  const structured = /application\/ld\+json/i.test(html)
  const tel = /href=["']tel:/i.test(html)
  const map = /google\.[^"']*\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(html)
  const links = (html.match(/<a\s/gi) || []).length
  const ssl = /^https:/i.test(url)
  let score = 100
  if (builderName) score -= 20
  if (!metaDesc) score -= 15
  if (!h1) score -= 12
  if (!structured) score -= 12
  if (links < 8) score -= 12
  if (!tel) score -= 10
  if (!map) score -= 8
  if (!ssl) score -= 15
  score = Math.max(0, Math.min(100, score))
  const seoWeak = [!metaDesc && 'meta description無', !h1 && 'H1無', !structured && '構造化データ無', links < 8 && '下層/内部リンク少'].filter(Boolean).join('・') || '大きな欠点なし'
  const meoWeak = [!map && 'Googleマップ/GBP導線無', !tel && '電話ボタン無'].filter(Boolean).join('・') || 'GBP連携要確認'
  const aioWeak = [!structured && '構造化データ(JSON-LD)無', !metaDesc && '要約メタ無'].filter(Boolean).join('・') || 'AI検索向け整備の余地'
  return { score, type: builderName || '独自サイト', builder: !!builderName, seoWeak, meoWeak, aioWeak }
}

// HOT-A/HOT-B向けの営業角度メモ（新規HP公開）。ルールベースで生成（追加のAI呼び出しはしない）。
function buildHpSalesAngle(pubDate: string | null, daysAgo: number | null, wq: ReturnType<typeof analyzeWebQuality> | null, official: string): string {
  return [
    '【新規HP公開7日以内 / 営業角度】',
    `HP公開根拠日: ${pubDate || '直近（検索は過去1週間に限定）'}${daysAgo != null ? `（${daysAgo}日前）` : ''}`,
    `公式サイト: ${official || '未取得'}`,
    wq ? `サイト種別: ${wq.type} / Web品質スコア ${wq.score}/100` : '',
    '直近にHPを公開しており集客強化に動いている可能性が高い候補です。公開直後はSEO・MEO・AIO・運用が未整備なことが多く、提案余地が大きいです。',
    wq ? `SEO弱点: ${wq.seoWeak}` : '',
    wq ? `MEO弱点: ${wq.meoWeak}（GBP整備・地域キーワード設計）` : '',
    wq ? `AIO弱点: ${wq.aioWeak}（AI検索に拾われる構造化・要約整備）` : '',
    wq?.builder ? `簡易HP(${wq.type})のため、作り込み・独自ドメイン移行の提案余地あり。` : '',
    '初回トーク例:「先日ホームページを公開されたのを拝見しました。公開直後はGoogle検索やマップに出にくい時期なので、地域での見つかりやすさを整える無料診断をご案内しています」',
    '注意点: 制作会社が運用も担っている場合あり。既契約の有無を確認。',
  ].filter(Boolean).join('\n')
}

function urlHash(u: string): string { let h = 0; const s = String(u); for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 } return String(h >>> 0) }
// 外部呼び出し(enrich/Places)の最悪時間を頭打ちにするハード上限（各内部fetchのタイムアウト総和で数十秒になり得るため）
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([Promise.resolve(p).catch(() => fallback), new Promise<T>((res) => setTimeout(() => res(fallback), ms))])
}
const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()

async function fetchPage(url: string, timeoutMs = 9000): Promise<string> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: ctrl.signal, redirect: 'follow' })
    clearTimeout(t); if (!r.ok) return ''
    return await r.text()
  } catch { return '' }
}
// 詳細ページから 店名/電話/住所/公式 を抽出
function extractDetail(html: string): { name: string; phone: string; address: string; official: string } {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] || ''
  const h1 = strip(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
  let name = (h1 || og || title).replace(/\s*[|｜-].*$/, '').replace(/\s*[（(][^）)]*[)）]\s*$/, '').trim().slice(0, 60)
  const body = strip(html)
  let phone = (html.match(/href=["']tel:(\+?[\d-]{9,15})/i)?.[1] || '').replace(/^\+81/, '0')
  if (!phone) phone = extractJpPhone(body)
  const address = (body.match(PREF_RE)?.[0] || '').replace(/(地図|アクセス|MAP|電話|TEL|営業時間).*$/i, '').slice(0, 70)
  const official = html.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*(?:公式|ホームページ|オフィシャル)/i)?.[1] || ''
  return { name, phone, address, official }
}

async function readCost(admin: any): Promise<any> {
  const today = new Date().toISOString().slice(0, 10)
  try { const { data } = await admin.from('app_config').select('value').eq('key', 'discovery_cost').maybeSingle(); const v = data?.value || {}; return v.date === today ? v : { date: today, serper: 0, scrapingbee: 0, aiMemo: 0 } } catch { return { date: today, serper: 0, scrapingbee: 0, aiMemo: 0 } }
}
async function writeCost(admin: any, cost: any): Promise<void> { try { await admin.from('app_config').upsert({ key: 'discovery_cost', value: cost, updated_date: new Date().toISOString() }, { onConflict: 'key' }) } catch { /* noop */ } }

export interface SerpOpts { perQuery?: number; maxQueriesPerRun?: number; maxDetails?: number; runBudgetMs?: number; serperDailyCap?: number; autoImportPerRun?: number; aiInjectMode?: InjectMode; recrawlAll?: boolean }

/** 1つの source_type をSERP駆動で巡回。 */
export async function runSerpDiscovery(admin: any, sourceType: string, mapsKey: string | null, opts: SerpOpts, userId: string | null): Promise<any> {
  const def = getSourceDef(sourceType)
  if (!def) return { ok: false, error: `未知のsource_type: ${sourceType}` }
  if (def.mode === 'foundation') return { ok: true, skipped: true, reason: `${def.label} は土台のみ（外部API/対象確認後に有効化）`, sourceType }
  if (def.mode !== 'serp' || !def.queries?.length) return { ok: true, skipped: true, reason: `${def.label} はSERP対象外`, sourceType }

  const perQuery = Math.max(1, Math.min(15, opts.perQuery || 8))
  const maxQ = Math.max(1, Math.min(20, opts.maxQueriesPerRun || 6))
  const maxDetails = Math.max(1, Math.min(40, opts.maxDetails || 14))
  const budgetMs = Math.max(15000, Math.min(280000, opts.runBudgetMs || 90000))
  const serperCap = Math.max(0, opts.serperDailyCap ?? 400)
  const autoImportPerRun = Math.max(0, opts.autoImportPerRun ?? 30)
  const mode: InjectMode = (opts.aiInjectMode === 'strict' || opts.aiInjectMode === 'aggressive') ? opts.aiInjectMode : 'standard'
  const nowIso = new Date().toISOString()
  const startMs = Date.now()
  const cost = await readCost(admin)

  // クエリ生成: 日付プレースホルダ（{date}=YYYY/MM/DD・{jp}=YYYY年M月D日・{md}=M月D日）を過去7日で展開。
  // ※以前は type名に portal を含むだけで展開され、プレースホルダの無いクエリが7重複していた（Serper浪費）。
  //   プレースホルダを含むクエリだけ展開し、重複は除去する。
  let queries = [...def.queries]
  if (def.queries.some((q) => /\{(date|jp|md)\}/.test(q))) {
    const ds = pastDates(7)
    queries = Array.from(new Set(def.queries.flatMap((q) =>
      /\{(date|jp|md)\}/.test(q) ? ds.map((d) => q.replace(/\{date\}/g, d.slash).replace(/\{jp\}/g, d.jp).replace(/\{md\}/g, d.md)) : [q],
    )))
  }
  // クエリ学習（成功クエリ優先）: 実行結果を app_config('discovery_query_stats') に蓄積し、
  // 未実行 > 2週間未実行(再探索) > HOT率が高い順 > 実行が古い順 で選ぶ。0件続きのクエリは自然に後回しになる。
  let qstats: Record<string, { r: number; h: number; t: number }> = {}
  try { const { data: qsRow } = await admin.from('app_config').select('value').eq('key', 'discovery_query_stats').maybeSingle(); qstats = (qsRow?.value as any) || {} } catch { qstats = {} }
  const qKey = (q: string) => `${sourceType}|${q}`
  const persistQueryStats = async () => {
    try {
      const { data: cur } = await admin.from('app_config').select('value').eq('key', 'discovery_query_stats').maybeSingle()
      const merged: any = (cur?.value as any) || {}
      for (const [k, v] of Object.entries(qstats)) { if (k.startsWith(`${sourceType}|`)) merged[k] = v }  // 並行実行の他取得元の統計を消さない
      const es = Object.entries(merged)
      const trimmed = es.length > 1500 ? Object.fromEntries(es.sort((a: any, b: any) => ((b[1]?.t || 0) - (a[1]?.t || 0))).slice(0, 1500)) : merged
      await admin.from('app_config').upsert({ key: 'discovery_query_stats', value: trimmed, updated_date: new Date().toISOString() }, { onConflict: 'key' })
    } catch { /* noop */ }
  }
  const allQ = queries
  if (allQ.length > maxQ) {
    const qScore = (q: string) => {
      const s = qstats[qKey(q)]
      if (!s || !s.r) return 3                                        // 未実行 = 最優先（探索）
      if (Date.now() - (s.t || 0) > 14 * 86400000) return 2           // 2週間未実行 = 再探索
      return s.h > 0 ? 1 + Math.min(1, s.h / s.r) : 0                 // HOT実績あり = 優先 / 0件続き = 後回し
    }
    queries = [...allQ].sort((a, b) => (qScore(b) - qScore(a)) || ((qstats[qKey(a)]?.t ?? 0) - (qstats[qKey(b)]?.t ?? 0))).slice(0, maxQ)
  } else {
    queries = allQ.slice(0, maxQ)
  }

  const counts: any = { sourceType, label: def.label, queries: 0, results: 0, newUrls: 0, seenSkipped: 0, detailFetched: 0, phoneYes: 0, addrYes: 0, hot: 0, hotB: 0, hold: 0, excluded: 0, saved: 0, imported: 0, dup: 0, error: 0, serperUsed: 0 }
  const debug: any = { samples: [] as any[] }
  const { data: runRow } = await admin.from('auto_lead_runs').insert({ source: sourceType, status: 'running', created_by_id: userId }).select('id').single()
  const runId: string | null = runRow?.id ?? null
  const seen = new Set<string>()
  const importedCases: { id: string; name: string; phone: string; address: string }[] = []
  let importedThisRun = 0
  let establishmentLookups = 0
  const MAX_ESTABLISHMENT_LOOKUPS = 40 // 既存店ガードのPlaces確認は1実行あたり上限（60秒枠を守る）
  // 取得元別ゲート
  const isHp = !!def.hpPublish
  const recencyDays = Number(def.recencyDays) || 0
  const requireOfficial = !!def.requireOfficialUrl
  const timeOpts = def.freshness ? { tbs: def.freshness === 'week' ? 'qdr:w' : 'qdr:m', freshness: def.freshness === 'week' ? 'Week' : 'Month' } : undefined
  let qualityChecks = 0
  const MAX_QUALITY = 30 // 公式サイトの簡易品質チェック（別ドメインfetch）の上限
  if (isHp) { counts.hpRecent = 0; counts.hpOldExcluded = 0; counts.holdNoOfficial = 0; counts.holdDateUnknown = 0 }
  // 残り時間（ms）。1回の詳細/補完fetchは最大~8-9秒かかるため、残りが少なければ新規fetchを打ち切って60秒枠を死守する。
  const remain = () => budgetMs - (Date.now() - startMs)
  let stopAll = false
  // 検索APIの継続不能エラー（残高切れ/クォータ/認証）。1件でも出れば以降のクエリも必ず失敗するため
  // 即中断し、runを success ではなく error で記録する。
  let providerFatal = ''

  try {
    for (const q of queries) {
      if (stopAll || remain() < 3500) { debug.stoppedEarly = true; break }
      if (counts.detailFetched >= maxDetails) break
      if (serperCap > 0 && cost.serper >= serperCap) { debug.serperCapReached = true; break }
      const hotBefore = counts.hot
      const { results, error } = await webSearch(q, perQuery, undefined, timeOpts)
      cost.serper++; counts.serperUsed++; counts.queries++
      if (error) {
        counts.error++
        // 「Not enough credits」等は残高が戻るまで全クエリが失敗する。0件を「正常0件」と誤認すると
        // SERP由来のソースが全滅しているのに status=success で記録され誰も気づけないため、ここで打ち切る。
        if (isProviderFatalError(error)) { providerFatal = error; debug.providerFatal = error; stopAll = true; break }
      }
      counts.results += results.length
      for (const rr of results) {
        if (counts.detailFetched >= maxDetails) break
        // 詳細ページ取得の前に残り時間を確認。残りが極少なら打ち切り、そうでなければfetchのタイムアウトを残り時間に合わせて
        // クランプする（残りを超えて走らない＝60秒関数上限を確実に守る。小さいbudgetの自動巡回でも1件は処理できる）。
        if (remain() < 3500) { debug.stoppedEarly = true; stopAll = true; break }
        const url = String(rr.url || '').split('#')[0]
        if (!/^https?:\/\//.test(url)) continue
        const h = urlHash(url)
        if (seen.has(h)) continue; seen.add(h)
        // 差分: 既読URL or 既存候補はスキップ
        if (!opts.recrawlAll) {
          const { data: su } = await admin.from('discovery_seen_urls').select('id').eq('source_type', sourceType).eq('url_hash', h).limit(1)
          const { data: ec } = await admin.from('lead_candidates').select('id').eq('source_detail_url', url).limit(1)
          if (su?.[0] || ec?.[0]) { counts.seenSkipped++; continue }
        }
        counts.newUrls++
        await admin.from('discovery_seen_urls').upsert({ source_type: sourceType, url_hash: h, url }, { onConflict: 'source_type,url_hash' }).then(() => {}, () => {})

        const html = await fetchPage(url, Math.min(8000, Math.max(2500, remain() - 3000)))
        counts.detailFetched++
        await new Promise((rs) => setTimeout(rs, 120))
        if (!html) { counts.error++; continue }
        const bodyStrip = strip(html)
        const closed = detectNegative(bodyStrip.slice(0, 3000))
        const d = extractDetail(html)
        // プレスリリース/記事タイトルの断片が店名に紛れるのを防ぐ: 「◯◯店が2026年8月25日（火）…」→「◯◯店」
        d.name = d.name.replace(/(?:が|は|を|、)?\s*20\d{2}年.*$/, '').replace(/（[月火水木金土日祝・]{1,3}）.*$/, '').trim()
        // 新店根拠: 着地ページ本文＋タイトル＋スニペットに新規性の文脈があるか（クエリ由来だけを信用しない）。
        // 新店ワード＋開業日＋新HP公開＋取得元別シグナル（新入会員/制作実績/施工中 等）を広くカバーし、
        // 各取得元が正当な根拠でHOTになれるようにする（狭すぎると全部HOLDで投入ゼロになる）。
        const newnessText = `${d.name} ${bodyStrip.slice(0, 4000)} ${rr.title || ''} ${rr.snippet || ''}`
        const hasNewness = NEW_OPEN_RE.test(newnessText) || OPEN_DATE_RE.test(newnessText) || HP_PUBLISH_RE.test(newnessText) || BIZ_SIGNAL_RE.test(newnessText)
        // 補完: 電話 or 住所が欠ければ Places/検索で補完（コスト節約のため不足時のみ・両方欠けは2クエリまで）
        let enrich: any = null
        const sn0 = sanitizeShopName(d.name, { placesMatched: false })
        // 補完は最大~10秒かかるため残り12秒以上のときだけ実行（1クエリに制限して暴走を防ぐ）。
        const needEnrich = (!d.phone || !d.address) && sn0.valid && !!mapsKey && remain() > 12000
        if (needEnrich) enrich = await withTimeout(enrichCandidate(mapsKey, { shop: sn0.name, username: '', areaHint: d.address || '', industry: '', havePhone: d.phone || '', haveAddress: d.address || '' }, { maxQueries: 1, perQuery: 5 }), 11000, null)
        const phone = d.phone || enrich?.phone || ''
        const address = d.address || enrich?.address || ''
        const official = d.official || enrich?.official || (/(instagram\.com|prtimes\.jp|ekiten|camp-fire|makuake)/i.test(url) ? '' : url)
        const matchedPlaceId = enrich?.place_id || null
        const sn = sanitizeShopName(enrich?.place_name || d.name, { placesMatched: !!matchedPlaceId })
        const name = sn.valid ? sn.name : '店名未確定'
        const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
        if (phoneOk) counts.phoneYes++; if (address) counts.addrYes++
        const isJapan = !isForeignAddress(address) && (isJapanAddress(address) || isJapanPhone(phone) || !!enrich?.prefecture)
        const big = detectBigOrPublic(`${name} ${address}`)
        const chain = detectChain(name)
        const multi = detectMultiStore(`${name} ${d.name}`)

        // 記事/告知の公開日を全ページで抽出（新店根拠の鮮度検証・signal日付・スコアの実鮮度に使用）。
        // 新規HP公開エンジンは「サイトが最初に立った日」を判定に使う（最新お知らせ日ではない）。
        let hpEvidence = false
        const hpPub: { iso: string | null; daysAgo: number | null } = extractPublishDate(html, bodyStrip, Date.now(), isHp ? 'launch' : 'newest')
        // 開業日そのものをテキストから抽出（記事公開日≠開業日。「7月15日グランドオープン」等 → 開業予定キュー/再コールへ接続）
        const od = extractOpeningDateFromText(`${rr.title || ''} ${rr.snippet || ''} ${d.name} ${bodyStrip.slice(0, 6000)}`, { publishedIso: hpPub.iso })
        let wq: ReturnType<typeof analyzeWebQuality> | null = null
        const hasOfficialUrl = !!official && /^https?:\/\//.test(official) && !/instagram\.com|facebook\.com|twitter\.com|x\.com|prtimes\.jp|tiktok\.com|threads\.net/i.test(official)
        if (isHp) {
          hpEvidence = HP_PUBLISH_RE.test(newnessText)
          // 簡易Web品質: 公式URLあり→着地ページ＝公式ならhtml流用、別ドメインは予算内で1回だけfetch（上限あり）
          if (hasOfficialUrl) {
            let ohtml = ''
            const sameHost = (() => { try { return new URL(official).host === new URL(url).host } catch { return false } })()
            if (sameHost) ohtml = html
            else if (qualityChecks < MAX_QUALITY && remain() > 10000) { qualityChecks++; try { ohtml = await fetchPage(official, 6000) } catch { ohtml = '' } }
            if (ohtml) wq = analyzeWebQuality(ohtml, official)
          }
        }

        // HOT/HOLD/EXCLUDED 判定（質優先）。電話+住所必須・大手/閉店/外国/多店舗/ポータル・ツール・まとめ系は除外。
        // SERPはノイズが多いため、HOTは「実店舗名が確定 or Google Places一致」を要件に追加（店名未確定だけのノイズはHOLD）。
        const noiseText = `${name} ${rr.title || ''} ${rr.snippet || ''}`
        const portalNoise = closed.portal || /ツール|まとめ記事|ランキング|比較サイト|一覧表|収集|代行業者|料金表|求人サイト|ポータル|事業者様|業者向け|toB|BtoB|システム|アプリ/.test(noiseText)
        const genericName = !sn.valid || /^(店舗|お店|新規オープン|ショップ|サロン|クリニック|会社|お知らせ|ニュース)$/.test(name) || /20\d{2}年|\d{1,2}月\d{1,2}日/.test(name)
        const shopConfirmed = (sn.valid && !genericName) || !!matchedPlaceId
        // 共通ハード除外（フリーダイヤル/○○店支店/大手量販モール/2店舗以上FC/大手チェーン/記事まとめ）を全ソース一貫適用
        const hardEx = hardExcludeReason({ name, phone, text: `${d.name} ${rr.title || ''} ${rr.snippet || ''}` })
        // 取得元別: 新店/新HP根拠・鮮度(7日以内)・公式URL必須 を切り替え
        const newnessOk = isHp ? hpEvidence : hasNewness
        const recencyOk = recencyDays > 0 ? (hpPub.daysAgo != null && hpPub.daysAgo <= recencyDays) : true
        const dateUnknown = isHp && recencyDays > 0 && hpPub.daysAgo == null
        const dateHardOld = isHp && hpPub.daysAgo != null && hpPub.daysAgo > 30  // 公開30日超＝明確に古い→EXCLUDED
        const officialOk = requireOfficial ? hasOfficialUrl : true
        // 記事日付ゲート（isHp以外の全SERP共通）: 「オープンしました」記事が古い＝もう新店ではない。1年超はEXCLUDED・90日超はHOLD。
        const pageAgeVeryOld = !isHp && hpPub.daysAgo != null && hpPub.daysAgo > 365
        const pageAgeOld = !isHp && hpPub.daysAgo != null && hpPub.daysAgo > 90
        // 開業日ベースの鮮度ガード: 記事は新しくても開業自体が90日超前（回顧/紹介記事）はもう新店ではない
        const openStale = !isHp && !!od && od.confidence >= 70 && od.daysSince != null && od.daysSince > 90
        // 電話×住所の地域整合: 固定電話の市外局番が住所の都道府県と不一致＝別店舗/本社番号の誤抽出の疑い（HOT禁止）
        const pmMismatch = phoneAddressMatch(phone, address) === 'mismatch'
        // プレスリリース配信サイトは掲載住所/電話が「発行元(本社)」であることが多い → Google Places裏取りが無ければHOTにしない
        const prSource = /prtimes.jp|atpress.ne.jp|value-press.com|dreamnews.jp|kyodonewsprwire/i.test(url)

        // ===== 新店まとめ記事の一括展開 =====
        // 「◯月オープンの新店10選」等のまとめ記事は従来EXCLUDEDで捨てていたが、1ページに複数の新店
        // （店名/電話/住所）が載っている宝庫。見出し(h2/h3)単位で店舗ブロックを抽出し、それぞれ候補化する。
        const matomeTitle = /まとめ|ランキング|特集|\d+選|新店(?:情報|ラッシュ|続々)/.test(`${rr.title || ''} ${d.name}`)
        const uniqPhones = Array.from(new Set((bodyStrip.match(/0\d{1,3}[-(]?\d{2,4}[-)]?\d{3,4}/g) || []).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 10)))
        const matomeWorthy = matomeTitle && hasNewness && uniqPhones.length >= 2 && !pageAgeVeryOld && !pageAgeOld
        if (matomeWorthy && remain() <= 22000) {
          // 予算不足で展開できない: 既読マークを取り消して次回（手動/ブースト等の大予算実行）で展開する。
          // ※自動巡回はrunBudgetMs=22sのため常にここに入る。stopAll/breakにするとmatomeページ1枚で
          //   ソース全体が毎回中断→無限リトライになる（実績あり）ので、このページだけスキップして続行する。
          await admin.from('discovery_seen_urls').delete().eq('source_type', sourceType).eq('url_hash', h).then(() => {}, () => {})
          counts.matomeDeferred = (counts.matomeDeferred || 0) + 1
          continue
        }
        if (matomeWorthy && remain() > 22000) {
          const sections = html.split(/<h[23][^>]*>/i).slice(1, 14).map((sec) => {
            const end = sec.search(/<\/h[23]>/i)
            const heading = strip(end >= 0 ? sec.slice(0, end) : sec.slice(0, 120)).slice(0, 50)
            const body2 = strip(end >= 0 ? sec.slice(end) : sec).slice(0, 700)
            return { heading, body2 }
          })
          const stores = sections
            .map((sec) => ({ name: sec.heading.replace(/^[\d①-⑳．.、,\s]+/, '').trim(), phone: extractJpPhone(sec.body2), address: (sec.body2.match(PREF_RE)?.[0] || '').slice(0, 70), snippet: sec.body2.slice(0, 200) }))
            .filter((s2) => s2.phone && s2.name.length >= 2)
            .slice(0, 6)
          if (stores.length >= 2) {
            const exp = await ingestExtractedStores(admin, mapsKey, stores, { sourceType, label: `${def.label}(まとめ展開)`, signalType: def.signalType, sourceUrl: url, evidenceIso: hpPub.iso, userId, runId, budgetEndMs: startMs + budgetMs, maxImports: Math.max(0, autoImportPerRun - importedThisRun) })
            counts.matomeExpanded = (counts.matomeExpanded || 0) + (exp.processed || 0)
            counts.hot += exp.hot || 0; counts.hotB += exp.hotB || 0; counts.hold += exp.hold || 0; counts.excluded += exp.excluded || 0; counts.imported += exp.imported || 0; counts.saved += exp.saved || 0
            importedThisRun += exp.imported || 0
            if (exp.importedCases?.length) importedCases.push(...exp.importedCases)
            // 予算切れで展開しきれなかった場合は既読マークを取り消し、次回このページを再展開できるようにする（残り店舗の永久喪失防止）
            if (!exp.processedAll) await admin.from('discovery_seen_urls').delete().eq('source_type', sourceType).eq('url_hash', h).then(() => {}, () => {})
            if (debug.samples.length < 12) debug.samples.push({ url, name: `まとめ展開×${stores.length}`, phone: '', address: '', temperature: `HOT${exp.hot || 0}/投入${exp.imported || 0}` })
            continue
          }
        }

        let temperature = 'HOLD'; let hotTier: 'A' | 'B' | null = null
        let holdReason = ''
        if (closed.closed || big.exclude || chain.definite || multi.exclude || isForeignAddress(address) || portalNoise || hardEx) temperature = 'EXCLUDED'
        else if (dateHardOld || pageAgeVeryOld) { temperature = 'EXCLUDED'; counts.hpOldExcluded = (counts.hpOldExcluded || 0) + 1 }
        // HOT要件: 電話+実店舗住所+日本+実店舗名確定+新店(新HP)根拠+記事鮮度+電話地域整合。HP取得元はさらに公式URL＋公開7日以内が必須。
        else if (phoneOk && address && isRealStoreAddress(address) && isJapan && shopConfirmed && newnessOk && officialOk && recencyOk && !pageAgeOld && !openStale && !pmMismatch && (!prSource || matchedPlaceId)) {
          temperature = 'HOT'; hotTier = 'B'; if (isHp) counts.hpRecent = (counts.hpRecent || 0) + 1
          // Places裏取り＋「直近30日以内の記事 or HP7日以内 or 高確度の開業日（開業前/開業30日以内）」= 確度が高い → HOT-A（優先架電）
          if (matchedPlaceId && ((hpPub.daysAgo != null && hpPub.daysAgo <= 30) || (isHp && recencyOk) || (od && od.confidence >= 75 && (od.daysUntil != null || (od.daysSince != null && od.daysSince <= 30))))) hotTier = 'A'
        }
        else {
          temperature = 'HOLD'
          holdReason = !phoneOk ? '電話番号なし/無効'
            : (!address || !isRealStoreAddress(address)) ? '実店舗住所なし'
            : pmMismatch ? `電話(${phone})の市外局番と住所の都道府県が不一致（別店舗/本社番号の誤抽出の疑い）`
            : pageAgeOld ? `新店記事が${hpPub.daysAgo}日前（90日超=新店鮮度切れ）`
            : openStale ? `開業日が${od!.daysSince}日前（90日超=新店鮮度切れ。記事日付でなく開業日基準）`
            : (prSource && !matchedPlaceId) ? 'プレスリリース由来はGoogle Places裏取り必須（掲載住所/電話が発行元の可能性）'
            : (requireOfficial && !hasOfficialUrl) ? '公式サイトURL未確定'
            : !newnessOk ? (isHp ? '新HP公開の根拠が本文で確認できず' : '新店根拠が本文で確認できず')
            : !shopConfirmed ? '実店舗名が未確定'
            : (recencyDays > 0 && !recencyOk) ? (dateUnknown ? `HP公開日が${recencyDays}日以内か不明` : `HP公開が${hpPub.daysAgo}日前（${recencyDays}日超）`)
            : '要確認'
          if (isHp) { if (requireOfficial && !hasOfficialUrl) counts.holdNoOfficial = (counts.holdNoOfficial || 0) + 1; if (dateUnknown) counts.holdDateUnknown = (counts.holdDateUnknown || 0) + 1 }
          if (pmMismatch) counts.phonePrefMismatch = (counts.phonePrefMismatch || 0) + 1
          if (pageAgeOld) counts.staleArticleHold = (counts.staleArticleHold || 0) + 1
          if (openStale) counts.openStaleHold = (counts.openStaleHold || 0) + 1
        }
        if (temperature === 'HOT') counts.hot++
        else if (temperature === 'EXCLUDED') counts.excluded++
        else { counts.hold++; if (!newnessOk && phoneOk && address) counts.holdNoNewness = (counts.holdNoNewness || 0) + 1 }

        const hpInfo = isHp ? ` / HP公開日:${hpPub.iso || '不明'}${hpPub.daysAgo != null ? `(${hpPub.daysAgo}日前)` : ''}${wq ? ` / Web品質${wq.score}/100(${wq.type})` : ''}` : (hpPub.iso ? ` / 記事日付:${hpPub.iso}(${hpPub.daysAgo}日前)` : '')
        const reason = `${def.label}: 「${rr.title || name}」${newnessOk ? (isHp ? ' / 新HP公開根拠あり' : ' / 新店根拠あり') : ''}${hpInfo}${holdReason ? `（HOLD理由: ${holdReason}）` : ''}${closed.closed ? `（${closed.reason}）` : ''}${enrich?.status ? ` / 補完[${enrich.status}]` : ''}`
        const payload: any = {
          name, address: address || null, phone_number: phone || null, website_url: official || null, official_url: official || null, instagram_url: enrich?.instagram || null,
          source: sourceType, lead_source: sourceType, discovery_source_type: sourceType, source_type: `AI自動投入(${def.label})`, source_site_name: def.label, parser_used: 'serp_discovery',
          source_detail_url: url, source_list_url: null, search_title: (rr.title || name).slice(0, 300), search_snippet: (rr.snippet || '').slice(0, 300),
          newness_type: def.signalType, regional_media_newness_reason: reason, regional_media_detected_at: hpPub.iso || nowIso, first_discovered_at: nowIso,
          lead_temperature: temperature, hot_tier: hotTier, recommended_status: temperature === 'HOT' ? (hotTier === 'A' ? 'HOT_A' : 'HOT_B') : temperature, should_exclude_from_call_list: temperature === 'EXCLUDED',
          name_unconfirmed_hot: temperature === 'HOT' && !sn.valid, phone_source: phone ? (matchedPlaceId ? 'google_places' : 'detail_page') : null,
          matched_google_place_id: matchedPlaceId, extracted_shop_name: name, extracted_address: address || null, extracted_phone: phone || null, extracted_official_url: official || null,
          owner_reachability_score: phone ? 65 : 30, auto_import_reason: temperature === 'HOT' ? reason : null, ai_comment: reason, last_seen_at: nowIso, source_run_id: runId,
          auto_insert_skipped_reason: temperature === 'HOLD' && holdReason ? holdReason : null,
          // 新HP公開: HOT/HOLDには営業角度メモを付与（案件投入時にcaseメモへ転記される）
          ...(isHp && (temperature === 'HOT' || temperature === 'HOLD') ? { call_memo: buildHpSalesAngle(hpPub.iso, hpPub.daysAgo, wq, official) } : {}),
          // 開業日: Google補完(enrich)由来を最優先、無ければ記事テキスト抽出。テキスト由来は精度をsourceに符号化
          // （article_text_day/part/month）→ 開業予定キューが確度/精度ゲートに使う
          ...(enrich?.has_opening ? {
            opening_date: (enrich.opening_year && enrich.opening_month) ? `${enrich.opening_year}-${String(enrich.opening_month).padStart(2, '0')}-${String(enrich.opening_day || 1).padStart(2, '0')}` : null,
            opening_date_source: 'external_enrichment', opening_date_confidence: enrich.opening_confidence ?? null,
            days_until_opening: enrich.days_until_opening ?? null, days_since_opening: enrich.days_since_opening ?? null,
            has_google_opening_date: true, google_business_status: enrich.business_status || null,
          } : od ? {
            opening_date: od.iso, opening_date_source: `article_text_${od.precision}`, opening_date_confidence: od.confidence,
            days_until_opening: od.daysUntil, days_since_opening: od.daysSince,
          } : {}),
        }
        const qr = computeQuality(payload)
        Object.assign(payload, { quality_score: qr.score, quality_grade: qr.grade, industry_category: qr.category, dedup_key: qr.dedupKey, quality_flags: qr.flags, phone_pref_match: qr.phoneMatch, quality_computed_at: nowIso })

        // 重複判定（source_detail_url / 電話）
        const { data: exC } = await admin.from('lead_candidates').select('id,imported_to_cases').eq('source_detail_url', url).limit(1)
        let candidateId: string | null = exC?.[0]?.id || null
        if (!candidateId && phone) {
          const { data: bp } = await admin.from('lead_candidates').select('id,discovery_source_type,lead_source').eq('phone_number', phone).limit(1)
          candidateId = bp?.[0]?.id || null
          if (candidateId) {
            counts.dup++
            // クロスソース確証: 別の取得元でも同じ電話の候補が検出済み＝新店の確度が非常に高い → HOT-Aへ昇格
            const prevSrc = bp![0].discovery_source_type || bp![0].lead_source
            if (temperature === 'HOT' && prevSrc && prevSrc !== sourceType) {
              hotTier = 'A'; payload.hot_tier = 'A'; payload.recommended_status = 'HOT_A'
              payload.auto_import_reason = `${payload.auto_import_reason || reason} / 複数取得元で確証（${prevSrc}でも検出）`
              counts.corroboratedA = (counts.corroboratedA || 0) + 1
            }
          }
        }
        if (temperature === 'HOT') { if (hotTier === 'A') counts.hotA = (counts.hotA || 0) + 1; else counts.hotB++ }
        const already = !!exC?.[0]?.imported_to_cases
        if (candidateId) { await admin.from('lead_candidates').update(payload).eq('id', candidateId).then(() => {}, () => {}) }
        else { const { data: ins } = await admin.from('lead_candidates').insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId }).select('id').single(); candidateId = ins?.id || null; counts.saved++ }

        if (candidateId) {
          await addSignals(admin, candidateId, [{ type: def.signalType, source: def.label, url, date: od?.iso || hpPub.iso, text: (isHp && hpEvidence ? `新HP公開根拠: ${(newnessText.match(HP_PUBLISH_RE) || [''])[0]} / ` : '') + (rr.title || '').slice(0, 180), confidence: (hpPub.daysAgo != null && hpPub.daysAgo <= 30) ? 0.8 : isHp ? 0.5 : 0.6 }])
          const { data: full } = await admin.from('lead_candidates').select('*').eq('id', candidateId).single()
          const { data: sigs } = await admin.from('lead_signals').select('signal_type').eq('lead_candidate_id', candidateId)
          if (full) await applySalesScore(admin, full, Array.from(new Set((sigs || []).map((s: any) => s.signal_type))))
          // HOT-B自動投入（電話必須・重複なし）
          if (temperature === 'HOT' && phoneOk && address && !already && importedThisRun < autoImportPerRun && autoImportAllowed('HOT_B' as any, mode)) {
            // 確立済みガード: Google口コミ30件以上 or 最古クチコミ1ヶ月超 = 既存店。投入前にPlacesで確認し、該当なら降格して架電しない。
            // （SERP自動投入は一括投入スイープを経由しないため、ここでスイープ相当の既存店チェックを行う）
            // ※新規HP公開(isHp)取得元は「既存店でも新しくHPを公開した」候補が正当なターゲットのため、既存店ガードは適用しない。
            // 時間予算・回数上限を守る（Places確認が積み重なって60秒枠を超えないよう、残り10秒未満/上限到達なら確認せず投入）。
            let established: { count: number | null; oldestDays: number | null } | null = null
            if (!isHp && mapsKey && sn.valid && name !== '店名未確定' && establishmentLookups < MAX_ESTABLISHMENT_LOOKUPS && remain() > 8000) {
              establishmentLookups++
              established = await withTimeout(placesEstablishmentSignal(mapsKey, name, address), 7000, null)
            }
            const isEstablished = !!established && ((established.count != null && established.count >= BIG_GOOGLE_REVIEWS) || (established.oldestDays != null && established.oldestDays > 30))
            if (isEstablished) {
              const why = (established!.count != null && established!.count >= BIG_GOOGLE_REVIEWS)
                ? `Google口コミ${established!.count}件(30件以上=確立済み)のため投入せず`
                : `Google最古クチコミ${established!.oldestDays}日前(1ヶ月超=既存店)のため投入せず`
              await admin.from('lead_candidates').update({
                lead_temperature: (established!.count != null && established!.count >= BIG_GOOGLE_REVIEWS) ? 'EXCLUDED' : 'HOLD', hot_tier: null,
                should_exclude_from_call_list: (established!.count != null && established!.count >= BIG_GOOGLE_REVIEWS),
                user_rating_count: established!.count ?? null, google_user_rating_count: established!.count ?? null,
                oldest_review_days_ago: established!.oldestDays ?? null, auto_insert_skipped_reason: why, auto_import_reason: null,
              }).eq('id', candidateId).then(() => {}, () => {})
              counts.hot = Math.max(0, counts.hot - 1)
              if (hotTier === 'A') counts.hotA = Math.max(0, (counts.hotA || 0) - 1); else counts.hotB = Math.max(0, counts.hotB - 1)
              counts.establishedSkipped = (counts.establishedSkipped || 0) + 1
              if (debug.samples.length < 12) debug.samples.push({ url, name, phone, address, temperature: 'DOWNGRADED(既存店)', why })
              continue
            }
            const dupCaseId = await findCaseIdByPhone(admin, phone)
            if (dupCaseId) {
              await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: dupCaseId, auto_insert_skipped_reason: '既存案件と電話重複のためリンク' }).eq('id', candidateId)
            } else {
              // 統一投入前ゲート（共有番号/同名同市/チェーン等。既存店チェックは上で実施済みのためskip）
              const gate = await caseImportGate(admin, { name, phone, address, text: `${rr.title || ''} ${rr.snippet || ''}`.slice(0, 300), mapsKey, skipEstablishment: true, budgetEndMs: startMs + budgetMs })
              if (!gate.ok) { await applyGateDowngrade(admin, candidateId, gate); counts.gateBlocked = (counts.gateBlocked || 0) + 1; continue }
              const memo = (full as any)?.call_memo ? `\n\n${(full as any).call_memo}` : ''
              const { data: created } = await admin.from('cases').insert({ name, address: address || '', phone1: phone, industry: classifyIndustry(name) || normalizeIndustry(qr.category) || null, status: DEFAULT_STATUS, priority: hotTier === 'A' ? '高' : '中', hp1: official || null, source_urls: url, memo: `【AI自動投入 / ${def.label} / HOT-${hotTier || 'B'}】${reason}\n電話: ${phone}\n住所: ${address}\nURL: ${url}${memo}`, created_by_id: userId }).select('id').single().then((x: any) => x, () => ({ data: null }))
              if (created?.id) { await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso, imported_case_id: created.id }).eq('id', candidateId); counts.imported++; importedThisRun++; importedCases.push({ id: created.id, name, phone, address }) }
            }
          }
        }
        if (debug.samples.length < 12) debug.samples.push({ url, name, phone, address, temperature })
      }
      // クエリ学習: このクエリのHOT実績を記録（次回の優先順位に反映。0件続きは自然に後回し）
      { const st = qstats[qKey(q)] || { r: 0, h: 0, t: 0 }; qstats[qKey(q)] = { r: st.r + 1, h: st.h + (counts.hot - hotBefore), t: Date.now() } }
    }
    await writeCost(admin, cost)
    await persistQueryStats()
    // 検索APIが継続不能（残高切れ等）、または全クエリが失敗した実行は「正常0件」ではないので error で残す。
    // successで記録するとSERP由来のソースが全滅していても運用側が気づけない。
    const allQueriesFailed = counts.queries > 0 && counts.error >= counts.queries
    const runFailed = !!providerFatal || allQueriesFailed
    const failMsg = providerFatal
      ? `検索API継続不能のため中断（${String(providerFatal).slice(0, 120)}）。残高/APIキーを確認してください`
      : allQueriesFailed ? `全${counts.queries}クエリが失敗（検索API異常の可能性）` : null
    await admin.from('auto_lead_runs').update({ status: runFailed ? 'error' : 'success', error_message: failMsg, finished_at: new Date().toISOString(), search_queries_count: counts.queries, fetched_count: counts.detailFetched, hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded, imported_count: counts.imported }).eq('id', runId).then(() => {}, () => {})
    return { ok: !runFailed, runId, ...counts, providerFatal: providerFatal || undefined, error: failMsg || undefined, importedCases, debug }
  } catch (e: any) {
    await writeCost(admin, cost)
    await persistQueryStats()
    await admin.from('auto_lead_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: String(e?.message || e) }).eq('id', runId).then(() => {}, () => {})
    return { ok: false, error: String(e?.message || e), ...counts, debug }
  }
}

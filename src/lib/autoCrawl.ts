// ============================================================
// 全取得元 自動巡回オーケストレータ（Cron / 手動 共通）。サーバー専用。
// UIの個別実行と同じ run 関数を呼ぶため、ロジックは二重化しない。
//   1. Google Places 新規GBP  2. 地域メディア全サイト巡回  3. Instagram Web検索  4. 連番URL探索
// 各取得元は時間予算内でできるだけ処理し、残りは各自のカーソル(last_crawled_at / current_probe_id /
// place_id 30日スキップ)で次回継続。1取得元が失敗しても全体は止めない。二重実行はロックで防止。
// ============================================================
import { runGooglePlaces, getDefaultSettings } from './googlePlacesRun.js'
import { runRegionalMedia, getDefaultRegionalSettings } from './regionalMediaRun.js'
import { runInstagramWeb, getDefaultIwSettings } from './instagramWebRun.js'
import { runAllSequentialProbes } from './sequentialProbe.js'
import { runSerpDiscovery } from './serpDiscovery.js'
import { DISCOVERY_SOURCES, defaultSourceToggles } from './discoverySources.js'
import { sweepHotToCases } from './importHot.js'

const LOCK_KEY = 'auto_lead_crawl'
const num = (v: any, d = 0) => (typeof v === 'number' && !Number.isNaN(v) ? v : d)

export type CrawlOnly = 'all' | 'places' | 'regional' | 'instagram' | 'sequential' | 'discovery' | 'failed'
export interface CrawlOpts { trigger?: 'cron' | 'manual'; only?: CrawlOnly; userId?: string | null; budgetMs?: number }

/** ロック取得。実行中(未失効かつ開始から100秒以内)なら false。古い/失効ロックは上書き（自己修復）。 */
async function acquireLock(admin: any, ttlMs: number, runId: string | null): Promise<boolean> {
  const nowMs = Date.now()
  const { data: cur } = await admin.from('auto_crawl_lock').select('*').eq('lock_key', LOCK_KEY).maybeSingle()
  // 実行中でも、失効済み or 開始から100秒超（=60s上限で強制終了された残骸）は奪取可能
  const stillFresh = cur && cur.status === 'running' && cur.expires_at && Date.parse(cur.expires_at) > nowMs && cur.started_at && (nowMs - Date.parse(cur.started_at)) < 100000
  if (stillFresh) return false
  const row = { lock_key: LOCK_KEY, started_at: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + ttlMs).toISOString(), status: 'running', run_id: runId }
  const { error } = await admin.from('auto_crawl_lock').upsert(row, { onConflict: 'lock_key' })
  return !error
}
async function releaseLock(admin: any, status: string): Promise<void> {
  await admin.from('auto_crawl_lock').update({ status, expires_at: new Date().toISOString() }).eq('lock_key', LOCK_KEY).then(() => {}, () => {})
}

async function readCfg(admin: any, key: string): Promise<any> {
  try { const { data } = await admin.from('app_config').select('value').eq('key', key).maybeSingle(); return data?.value || {} } catch { return {} }
}

// run関数の戻り値 → 明細カウントへ正規化
function mapCounts(r: any) {
  return {
    fetched: num(r?.fetched ?? r?.probed ?? r?.detailFetched ?? r?.candidates ?? r?.newArticles),
    valid: num(r?.valid ?? r?.placeMatched ?? r?.candidates),
    hot: num(r?.hot), hotA: num(r?.hotA), hotB: num(r?.hotB ?? (num(r?.hot) - num(r?.hotA))),
    hold: num(r?.hold), excluded: num(r?.excluded),
    saved: num(r?.saved ?? r?.candidates ?? r?.fetched), inserted: num(r?.imported ?? r?.importedCases ?? r?.cases_inserted_count),
  }
}

/**
 * 全取得元を時間予算内で順番に巡回。1取得元の失敗は他を止めない。
 * 取得元の処理順は「最後に成功してから時間が経っている順（=未実行/失敗を優先）」。
 */
export async function runAutoCrawl(admin: any, env: NodeJS.ProcessEnv, opts: CrawlOpts = {}): Promise<any> {
  const only = opts.only || 'all'
  const trigger = opts.trigger || 'cron'
  // Vercel maxDuration=60s。最終書き込み＋ロック解放の余白を確保するため48sで打ち切る。
  const budgetMs = Math.max(20000, Math.min(50000, opts.budgetMs || 48000))
  const startMs = Date.now()
  const mapsKey = env.GOOGLE_MAPS_API_KEY || null

  // ゾンビrun掃除（60s上限で強制終了され status='running' のまま残った過去runをerror化）
  await admin.from('auto_crawl_runs').update({ status: 'error', finished_at: new Date().toISOString(), error_message: 'タイムアウト/強制終了(60s上限)の可能性' }).eq('status', 'running').lt('started_at', new Date(startMs - 150000).toISOString()).then(() => {}, () => {})

  // マスタ設定（ON/OFF＋取得元別の上限）
  const master = await readCfg(admin, 'auto_crawl')
  if (trigger === 'cron' && master.enabled === false) {
    return { ok: true, skipped: true, reason: '自動巡回がOFFです（設定）' }
  }

  // 実行ログ作成
  const { data: runRow } = await admin.from('auto_crawl_runs').insert({ trigger_type: trigger, only_filter: only, status: 'running', created_by_id: opts.userId || null }).select('id').single()
  const runId: string | null = runRow?.id ?? null

  // 二重実行防止（TTL=110秒。60s上限で強制終了されても約2分で自己解放）
  const locked = await acquireLock(admin, 110 * 1000, runId)
  if (!locked) {
    await admin.from('auto_crawl_runs').update({ status: 'skipped', finished_at: new Date().toISOString(), error_message: 'ロック中のためスキップ（別の巡回が実行中）' }).eq('id', runId).then(() => {}, () => {})
    return { ok: true, skipped: true, reason: 'ロック中のためスキップ（別の巡回が実行中）', runId }
  }

  // 単一取得元の指定実行（only!=='all'）は1フェーズだけなので予算を大きく取れる。全取得元は各フェーズを小さく。
  const focused = only !== 'all'
  const pb = (small: number, big: number) => (focused ? big : small)
  const agg = { hot_a_count: 0, hot_b_count: 0, hold_count: 0, excluded_count: 0, cases_inserted_count: 0, lead_saved_count: 0, google_places_count: 0, regional_media_count: 0, instagram_count: 0, sequential_count: 0 }
  let success = 0, failed = 0
  const items: any[] = []

  // 取得元定義
  const wantType = (t: CrawlOnly) => only === 'all' || only === t || (only === 'failed' && (t === 'regional' || t === 'sequential'))
  const types: { key: CrawlOnly; type: string; name: string; minMs: number; run: () => Promise<any> }[] = []
  if (wantType('places')) types.push({ key: 'places', type: 'google_places', name: 'Google Places 新規GBP', minMs: 9000, run: async () => {
    if (!mapsKey) throw new Error('GOOGLE_MAPS_API_KEY未設定')
    const cfg = await readCfg(admin, 'lead_auto')
    if (cfg.autoFetch === false) return { skipped: true }
    // 全取得元巡回では10s/5クエリに制限し他フェーズへ譲る。Places単独実行(only=places)は42s/設定値で本格実行。
    return runGooglePlaces(admin, mapsKey, { ...getDefaultSettings(), ...cfg, ...(master.places || {}), runBudgetMs: pb(10000, 42000), placesMaxQueriesPerDay: focused ? (Number(cfg.placesMaxQueriesPerDay) || 30) : 5 }, opts.userId || null)
  } })
  if (wantType('regional')) types.push({ key: 'regional', type: 'regional_media', name: '地域メディア全サイト巡回', minMs: 8000, run: async () => {
    const cfg = await readCfg(admin, 'regional_auto')
    if (cfg.regionalEnabled === false) return { skipped: true }
    // 全サイト対象（last_crawled_at 昇順=長く巡回していないサイトから）。全巡回時は13s、地域メディア単独実行時は40s（時間予算は設定より優先）
    return runRegionalMedia(admin, mapsKey, { ...getDefaultRegionalSettings(), ...cfg, ...(master.regional || {}), runMode: 'all', batchSites: focused ? 50 : 12, maxSitesPerDay: focused ? 50 : 12, runBudgetMs: pb(13000, 40000), maxDetailFetchesPerRun: pb(10, 25) }, opts.userId || null)
  } })
  if (wantType('instagram')) types.push({ key: 'instagram', type: 'instagram_web', name: 'Instagram Web検索', minMs: 8000, run: async () => {
    const cfg = await readCfg(admin, 'instagram_web_auto')
    if (cfg.iwEnabled === false) return { skipped: true }
    return runInstagramWeb(admin, mapsKey, { ...getDefaultIwSettings(), maxQueries: 4, perQuery: 8, ...cfg, ...(master.instagram || {}) }, opts.userId || null)
  } })
  if (wantType('sequential')) types.push({ key: 'sequential', type: 'sequential_probe', name: '連番URL探索（全有効ソース）', minMs: 8000, run: async () => {
    const cfg = await readCfg(admin, 'sequential_auto')
    if (cfg.sequentialEnabled === false) return { skipped: true }
    // 全巡回時は forwardCount/cap を小さく（~10s）。連番単独実行時は設定値で本格実行（バウンドは設定より優先）
    return runAllSequentialProbes(admin, mapsKey, { aiInjectMode: 'standard', autoImportPerRun: 50, ...cfg, ...(master.sequential || {}), probeDailyCap: focused ? (Number(cfg.probeDailyCap) || 300) : 80, ...(focused ? {} : { forwardCount: 10 }) }, opts.userId || null)
  } })
  if (wantType('discovery')) types.push({ key: 'discovery', type: 'serp_discovery', name: '新規取得元 SERPディスカバリ', minMs: 8000, run: async () => {
    const toggles = { ...defaultSourceToggles(), ...(await readCfg(admin, 'discovery_sources')) }
    const enabled = DISCOVERY_SOURCES.filter((s) => s.mode === 'serp' && toggles[s.type] !== false).map((s) => s.type)
    if (!enabled.length) return { skipped: true, reason: '有効なSERP取得元なし' }
    // 最後に実行してから古い順（未実行/失敗を優先）に並べ、残り時間内で回す
    const { data: last } = await admin.from('auto_lead_runs').select('source,created_date').in('source', enabled).order('created_date', { ascending: false }).limit(200)
    const lastBy = new Map<string, number>()
    for (const r of (last || []) as any[]) { if (!lastBy.has(r.source)) lastBy.set(r.source, Date.parse(r.created_date || 0)) }
    enabled.sort((a, b) => (lastBy.get(a) ?? 0) - (lastBy.get(b) ?? 0))
    const agg: any = { hot: 0, hotB: 0, hold: 0, excluded: 0, saved: 0, imported: 0, detailFetched: 0, ran: [] as string[] }
    // 1回の巡回ではSERP取得元を最大2件だけ（60s枠を超えないため）。残りは次回（古い順ローテ）。
    for (const st of enabled.slice(0, 2)) {
      if (Date.now() - startMs > budgetMs - 11000) break
      const r = await runSerpDiscovery(admin, st, mapsKey, { maxQueriesPerRun: 2, perQuery: 6, maxDetails: 6, runBudgetMs: 9000, serperDailyCap: master.serperDailyCap ?? 50, aiInjectMode: 'standard' }, opts.userId || null)
      if (r?.ok && !r.skipped) { agg.hot += r.hot || 0; agg.hotB += r.hotB || 0; agg.hold += r.hold || 0; agg.excluded += r.excluded || 0; agg.saved += r.saved || 0; agg.imported += r.imported || 0; agg.detailFetched += r.detailFetched || 0; agg.ran.push(st) }
    }
    return agg
  } })

  // 「最後に成功してから時間が経っている順」に並べ替え（未実行/失敗を優先）。
  // ただし SERPディスカバリ（ノイズ多め）は常に最後に回し、実績ある取得元を先に処理する。
  if (only === 'all') {
    const { data: lastOk } = await admin.from('auto_crawl_run_items').select('source_type,finished_at').eq('status', 'success').order('finished_at', { ascending: false }).limit(200)
    const lastByType = new Map<string, number>()
    for (const r of (lastOk || []) as any[]) { if (!lastByType.has(r.source_type)) lastByType.set(r.source_type, Date.parse(r.finished_at || 0)) }
    types.sort((a, b) => {
      if (a.key === 'discovery') return 1
      if (b.key === 'discovery') return -1
      return (lastByType.get(a.type) ?? 0) - (lastByType.get(b.type) ?? 0)
    })
  }

  for (const t of types) {
    const elapsed = Date.now() - startMs
    const itemStart = new Date().toISOString()
    if (elapsed > budgetMs - t.minMs) {
      // 時間切れ → 次回継続
      items.push({ run_id: runId, source_type: t.type, source_name: t.name, status: 'skipped', error_kind: 'timeout', error_message: '時間予算切れのため次回継続', started_at: itemStart, finished_at: new Date().toISOString() })
      continue
    }
    try {
      const r = await t.run()
      if (r?.skipped) { items.push({ run_id: runId, source_type: t.type, source_name: t.name, status: 'skipped', error_message: r.reason || 'OFF/上限', started_at: itemStart, finished_at: new Date().toISOString() }); continue }
      const c = mapCounts(r)
      agg.hot_a_count += c.hotA; agg.hot_b_count += c.hotB; agg.hold_count += c.hold; agg.excluded_count += c.excluded; agg.cases_inserted_count += c.inserted; agg.lead_saved_count += c.saved
      if (t.type === 'google_places') agg.google_places_count += c.fetched
      else if (t.type === 'regional_media') agg.regional_media_count += c.fetched
      else if (t.type === 'instagram_web') agg.instagram_count += c.fetched
      else if (t.type === 'sequential_probe') agg.sequential_count += c.fetched
      success++
      items.push({ run_id: runId, source_type: t.type, source_name: t.name, status: 'success', fetched_count: c.fetched, valid_count: c.valid, hot_count: c.hot, hold_count: c.hold, excluded_count: c.excluded, saved_count: c.saved, inserted_count: c.inserted, started_at: itemStart, finished_at: new Date().toISOString() })
    } catch (e: any) {
      failed++
      const msg = String(e?.message || e)
      const kind = /timeout|ETIMEDOUT|aborted/i.test(msg) ? 'timeout' : /429|rate/i.test(msg) ? 'rate_limit' : /40\d|50\d|fetch/i.test(msg) ? 'api_error' : 'error'
      items.push({ run_id: runId, source_type: t.type, source_name: t.name, status: 'error', error_kind: kind, error_message: msg.slice(0, 500), started_at: itemStart, finished_at: new Date().toISOString() })
    }
  }

  // 巡回末尾: 未投入HOTを cases へスイープ（電話/住所なしHOTはHOLD降格）。時間が残っていれば実行。
  let swept: any = null
  if (Date.now() - startMs < budgetMs - 4000) { try { swept = await sweepHotToCases(admin, { limit: 100, userId: opts.userId || null }); agg.cases_inserted_count += swept.imported || 0 } catch { /* noop */ } }

  // 明細を保存
  if (items.length) await admin.from('auto_crawl_run_items').insert(items).then(() => {}, () => {})

  // 重複整理は重い（全候補スキャン）ため自動巡回の60s枠では実行しない。トリアージの「品質を再計算」で実施。
  const dup: any = null
  const status = failed === 0 ? 'success' : success > 0 ? 'partial' : 'error'
  await admin.from('auto_crawl_runs').update({
    status, finished_at: new Date().toISOString(),
    total_sources: types.length, success_sources: success, failed_sources: failed,
    ...agg,
  }).eq('id', runId).then(() => {}, () => {})

  await releaseLock(admin, 'done')
  return { ok: true, runId, trigger, only, status, success, failed, items, ...agg, dup, elapsedMs: Date.now() - startMs }
}

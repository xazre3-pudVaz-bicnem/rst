import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import {
  Sparkles, Play, Settings2, CheckCircle2, Flame, PhoneOff, Copy as CopyIcon,
  Store, Building2, MapPin, Phone, Upload,
} from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { useAuth } from '@/context/AuthContext'
import { CaseApi, LeadCandidateApi, ImportBatchApi, AuditApi, AppConfigApi, LeadQueryLogApi } from '@/lib/api'
import { classifyLead, generateMockLeads } from '@/lib/leadScoring'
import {
  DEFAULT_STATUS, LEAD_TEMP_COLORS, LS_LEAD_SETTINGS, DEFAULT_LEAD_SETTINGS, parseList,
} from '@/lib/constants'
import { AREA_PRESET_OPTIONS, AREA_PRESETS, prefectureAreaTotals, presetLabel } from '@/lib/areaPresets'
import { isSupabaseConfigured, supabase } from '@/lib/supabaseClient'
import { cn, jpError, copyToClipboard, mapUrl } from '@/lib/utils'
import type { Case, LeadCandidate, LeadImportSettings, LeadRun, LeadTemperature } from '@/lib/types'

type Filter = 'ALL' | LeadTemperature
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'ALL', label: 'すべて' },
  { key: 'HOT', label: 'HOT' },
  { key: 'WARM', label: 'WARM' },
  { key: 'HOLD', label: '保留' },
  { key: 'EXCLUDED', label: '除外' },
]

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const m = moment(s)
  return m.isValid() ? m.format('YYYY/MM/DD') : '—'
}

/** 架電優先スコア（0-100）: 全ソース横断で「今すぐ架電すべき」順に並べるための統一ランク。
 *  openingDate(未来/直近) > 新規GBP優先 > HOT > 電話+住所 > 新店根拠 > 新しさ の重み付け。電話なし・EXCLUDEDは大きく減点。 */
function callPriority(c: any): number {
  if (!c) return 0
  if (c.lead_temperature === 'EXCLUDED' || c.should_exclude_from_call_list) return 0
  let s = 0
  const temp = c.lead_temperature
  if (temp === 'HOT') s += 55; else if (temp === 'HOLD') s += 22
  if (c.hot_tier === 'A') s += 25; else if (c.hot_tier === 'B') s += 12
  const band = c.opening_date_band
  if (band === 'future') s += 32; else if (band === 'd0_90') s += 30; else if (band === 'd91_180') s += 18; else if (band === 'd181_365') s += 6
  if (c.is_new_gbp_priority) s += 22
  if (c.has_opening_date_badge || c.has_google_opening_date) s += 8
  const hasPhone = !!(c.phone_number || c.extracted_phone)
  const hasAddr = !!(c.address || c.extracted_address)
  if (hasPhone) s += 16; else s -= 30  // 電話なしは架電できない＝大幅減点
  if (hasAddr) s += 8; else s -= 6
  if (c.name_unconfirmed_hot) s -= 6  // 店名未確定は要確認のため微減
  // 新しさ（初回発見/検出日が直近）
  const seen = c.first_seen_at || c.regional_media_detected_at || c.first_discovered_at || c.last_seen_at
  if (seen) { const d = (Date.now() - Date.parse(seen)) / 86400000; if (d <= 3) s += 8; else if (d <= 7) s += 4 }
  // 新店根拠
  if (c.newness_reason || c.regional_media_newness_reason || c.matched_keywords?.length) s += 4
  // 品質スコア（地域整合・店名確定・ネガティブ検出を反映）を加味
  if (typeof c.quality_score === 'number') { s += Math.round((c.quality_score - 50) * 0.2) } // 品質50を基準に±10
  if (c.phone_pref_match === 'mismatch') s -= 8  // 電話の市外局番が住所と不一致＝誤データ/本社番号疑い
  if (Array.isArray(c.quality_flags) && c.quality_flags.some((f: string) => /閉店|移転|廃業/.test(f))) s -= 40  // 閉店/移転疑いは大幅減点
  return Math.max(0, Math.min(100, Math.round(s)))
}

function loadSettings(): LeadImportSettings {
  try {
    const raw = localStorage.getItem(LS_LEAD_SETTINGS)
    if (raw) return { ...DEFAULT_LEAD_SETTINGS, ...JSON.parse(raw) }
  } catch (_) { /* noop */ }
  return { ...DEFAULT_LEAD_SETTINGS }
}

export default function Leads() {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [candidates, setCandidates] = useState<LeadCandidate[]>([])
  const [cases, setCases] = useState<Case[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [settings, setSettings] = useState<LeadImportSettings>(loadSettings)
  const [showSettings, setShowSettings] = useState(false)
  // Google Places
  const [gpConfigured, setGpConfigured] = useState<boolean | null>(null)
  const [gpReachable, setGpReachable] = useState<boolean | null>(null)
  const [gpDiag, setGpDiag] = useState<{ keyLength?: number; hasSupabaseUrl?: boolean; hasServiceRole?: boolean } | null>(null)
  const [gpRunning, setGpRunning] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [gpResult, setGpResult] = useState<any>(null)
  const [lastRun, setLastRun] = useState<LeadRun | null>(null)
  // 自動取得（Cron）巡回状況
  const [qlog, setQlog] = useState<{ query: string; prefecture: string | null; area: string | null; last_run_at: string; hot_count: number; places_count: number }[]>([])
  const [savingCfg, setSavingCfg] = useState(false)
  // Instagram
  const [igConfigured, setIgConfigured] = useState<boolean | null>(null)
  const [igRunning, setIgRunning] = useState(false)
  const [igResult, setIgResult] = useState<any>(null)
  const [sourceTab, setSourceTab] = useState<'places' | 'instagram' | 'regional' | 'iw' | 'probe'>('places')
  // メインビュー（架電対象リスト / 取得・投入 / 取得元管理 / 連番URL探索 / エラー・ログ / 設定）
  const [mainView, setMainView] = useState<'list' | 'triage' | 'get' | 'manage' | 'probe' | 'errors' | 'settings'>('list')
  const [devMode, setDevMode] = useState(false)
  const [drawerCand, setDrawerCand] = useState<LeadCandidate | null>(null)
  const [probeTests, setProbeTests] = useState<Record<string, any>>({})
  const [probeFormOpen, setProbeFormOpen] = useState(false)
  const [probeForm, setProbeForm] = useState<any>(null)
  const [probeFormEditId, setProbeFormEditId] = useState<string | null>(null)
  const [probeFormTest, setProbeFormTest] = useState<any>(null)
  const [probeResult, setProbeResult] = useState<any>(null)
  const [probeView, setProbeView] = useState<'all' | 'active' | 'inactive'>('all')
  const [probeSites, setProbeSites] = useState<any[]>([])
  const [probing, setProbing] = useState(false)
  const [iwConfigured, setIwConfigured] = useState<boolean | null>(null)
  const [iwDiag, setIwDiag] = useState<any>(null)
  const [iwRunning, setIwRunning] = useState(false)
  const [iwResult, setIwResult] = useState<any>(null)
  const [rmConfigured, setRmConfigured] = useState<boolean | null>(null)
  const [rmDiag, setRmDiag] = useState<any>(null)
  const [rmRunning, setRmRunning] = useState(false)
  const [rmResult, setRmResult] = useState<any>(null)
  const [rmProgress, setRmProgress] = useState<any>(null)  // 全サイト巡回の進捗
  const [rmFailedSites, setRmFailedSites] = useState<any[]>([])  // 失敗サイト（再巡回用）
  const [discovering, setDiscovering] = useState(false)
  const [discoveryResult, setDiscoveryResult] = useState<any>(null)
  const [siteCandidates, setSiteCandidates] = useState<any[]>([])
  // 巡回サイト管理
  const [rmSites, setRmSites] = useState<any[]>([])
  const [rmCounts, setRmCounts] = useState<{ total: number; active: number; inactive: number }>({ total: 0, active: 0, inactive: 0 })
  const [rmSitesErr, setRmSitesErr] = useState<string | null>(null)
  const [siteFilter, setSiteFilter] = useState<{ status: string; q: string; sourceType: string; parserType: string }>({ status: 'all', q: '', sourceType: '', parserType: '' })
  const [siteShown, setSiteShown] = useState(50)
  const [rmBusy, setRmBusy] = useState(false)
  const [siteForm, setSiteForm] = useState<any>(null) // {id?, name, base_url, list_url, media_family, source_type, category_label, is_active, reliability_score, crawl_interval_hours}
  const [siteTests, setSiteTests] = useState<Record<string, any>>({})
  const [allTest, setAllTest] = useState<any>(null)
  const [shown, setShown] = useState(50)  // 一覧の表示件数
  const [subFilter, setSubFilter] = useState<'all' | 'named_hot' | 'unconfirmed_hot' | 'has_phone' | 'has_addr' | 'opening_date' | 'new_gbp'>('all')  // HOT絞り込み
  const [rankMode, setRankMode] = useState<'priority' | 'newest'>('newest')  // 並び順: 架電優先 / 新着（既定=最新順・HOTを上に出さない）
  // ===== 統合トリアージ =====
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [tGrade, setTGrade] = useState<'all' | 'S' | 'A' | 'B' | 'C' | 'D'>('all')
  const [tCat, setTCat] = useState<string>('all')
  const [tPref, setTPref] = useState<string>('all')
  const [tPhone, setTPhone] = useState<'all' | 'yes' | 'no' | 'fixed'>('yes')
  const [tTemp, setTTemp] = useState<'all' | 'HOT' | 'HOLD' | 'EXCLUDED'>('HOT')
  const [tNotImported, setTNotImported] = useState(true)
  const [tDup, setTDup] = useState(false)
  const [tFlagged, setTFlagged] = useState(false)
  const [tSearch, setTSearch] = useState('')
  const [tSort, setTSort] = useState<'sales' | 'quality' | 'priority' | 'newest'>('sales')
  const [tShown, setTShown] = useState(60)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [qualityRunning, setQualityRunning] = useState(false)
  // ===== 自動巡回 =====
  const [crawlLast, setCrawlLast] = useState<any>(null)
  const [crawlItems, setCrawlItems] = useState<any[]>([])
  const [crawlToday, setCrawlToday] = useState<any>({ runs: 0, hotA: 0, hotB: 0, hold: 0, inserted: 0, errors: 0 })
  const [crawlFailedSites, setCrawlFailedSites] = useState<any[]>([])
  const [crawlBusy, setCrawlBusy] = useState<string>('')
  const [autoCrawlOn, setAutoCrawlOn] = useState<boolean>(true)
  // ===== 新規取得元レジストリ（27 source_type） =====
  const [discovery, setDiscovery] = useState<{ sources: any[]; toggles: Record<string, boolean>; excluded: string[]; cost: any } | null>(null)
  const [discoveryBusy, setDiscoveryBusy] = useState<string>('')
  const [recentImported, setRecentImported] = useState<{ caseId: string; importedAt: string; name: string; phone: string; address: string; source: string; temperature: string; hotTier: string | null }[]>([])
  // ===== トリアージ拡張フィルタ =====
  const [tSalesGrade, setTSalesGrade] = useState<'all' | 'S' | 'A' | 'B' | 'C'>('all')
  const [tSource, setTSource] = useState<string>('all')
  const [tWebsite, setTWebsite] = useState<string>('all')

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    try {
      const [lc, cs] = await Promise.all([LeadCandidateApi.list(800), CaseApi.listAll()])
      setCandidates(lc); setCases(cs)
    } catch (e) {
      console.error('[Leads]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRuns = useCallback(async () => {
    if (!isSupabaseConfigured) return
    const { data } = await supabase.from('auto_lead_runs').select('*').order('created_date', { ascending: false }).limit(1)
    setLastRun(data && data[0] ? (data[0] as LeadRun) : null)
  }, [])

  const loadQlog = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try { setQlog(await LeadQueryLogApi.recent(7)) } catch { /* テーブル未作成等は無視 */ }
  }, [])

  useEffect(() => { load(); loadRuns(); loadQlog() }, [load, loadRuns, loadQlog])

  // Google Places API 接続状態
  const checkGpStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/leads/google-places/run', { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setGpReachable(r.ok)
      setGpConfigured(!!j.configured)
      setGpDiag(j)
    } catch {
      setGpReachable(false)
      setGpConfigured(false)
      setGpDiag(null)
    }
  }, [])

  useEffect(() => { checkGpStatus() }, [checkGpStatus])

  // Instagram API 接続状態
  const checkIgStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/leads/instagram/run', { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setIgConfigured(r.ok ? !!j.configured : false)
    } catch { setIgConfigured(false) }
  }, [])
  useEffect(() => { checkIgStatus() }, [checkIgStatus])

  // 地域メディア 接続状態
  const checkRmStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/leads/regional-media/run', { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setRmConfigured(r.ok ? !!j.configured : false)
      setRmDiag(r.ok ? j : { error: `HTTP ${r.status}（関数未デプロイの可能性）` })
    } catch (e) { setRmConfigured(false); setRmDiag({ error: jpError(e) }) }
  }, [])
  useEffect(() => { checkRmStatus() }, [checkRmStatus])

  async function callRegional(extra: any) {
    const { data: sess } = await supabase.auth.getSession()
    const token = sess.session?.access_token
    if (!token) { toast.error('ログインが必要です'); return null }
    const res = await fetch('/api/leads/regional-media/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        settings: {
          regionalEnabled: settings.regionalEnabled,
          maxArticlesPerSite: settings.regionalMaxArticles, periodDays: settings.regionalPeriodDays, dailyCap: settings.dailyCap,
          regionalEnrichEnabled: settings.regionalEnrichEnabled, regionalEnrichMaxQueries: settings.regionalEnrichMaxQueries,
          regionalEnrichPerQuery: settings.regionalEnrichPerQuery, regionalEnrichDailyCap: settings.regionalEnrichDailyCap,
          aiInjectMode: settings.aiInjectMode, autoImportPerRun: settings.autoImportPerRun, autoImportPerDay: settings.autoImportPerDay,
          batchSites: settings.regionalBatchSites || 8, horbyMaxDetails: settings.horbyMaxDetails ?? 2,
          ...extra,
        },
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { toast.error(json.error || '地域メディア取得に失敗しました'); return { error: json.error } }
    return json
  }

  // 単発（テスト/選択/前回継続）
  async function runRegional(mode: 'test' | 'selected' | 'all-once' = 'test', selectedSiteIds?: string[]) {
    if (!settings.regionalEnabled) { toast.error('設定で地域メディア取得がOFFです'); return }
    setRmRunning(true); setRmResult(null); setRmProgress(null)
    try {
      const runMode = mode === 'selected' ? 'selected' : mode === 'test' ? 'test' : 'all'
      const json = await callRegional({ runMode, selectedSiteIds: selectedSiteIds || [] })
      if (!json || json.error) { setRmResult({ error: json?.error }); return }
      setRmResult(json); setRmFailedSites(json.failedSites || [])
      toast.success(`完了: サイト${json.processedSiteCount ?? 0} / HOT${json.hot ?? 0} / 投入${json.imported ?? 0}`)
      load(); loadRuns()
    } catch (e) { toast.error('実行に失敗しました: ' + jpError(e)) } finally { setRmRunning(false) }
  }

  // 全サイト巡回: 有効サイトをバッチ分割で最後まで自動継続
  async function runRegionalAll(priority = false) {
    if (!settings.regionalEnabled) { toast.error('設定で地域メディア取得がOFFです'); return }
    setRmRunning(true); setRmResult(null); setRmFailedSites([])
    const processed = new Set<string>()
    const failed: any[] = []
    const agg: any = { hot: 0, hotA: 0, hotB: 0, hold: 0, excluded: 0, imported: 0, newArticles: 0, candidates: 0, error: 0 }
    let total = 0, batches = 0, success = 0
    setRmProgress({ running: true, total: 0, processed: 0, success: 0, failed: 0, ...agg })
    try {
      while (batches < 200) {  // 安全上限（最大200バッチ）
        batches++
        const json = await callRegional({ runMode: priority ? 'priority' : 'all', excludeSiteIds: Array.from(processed) })
        if (!json || json.error) { toast.error(json?.error || 'バッチ実行に失敗'); break }
        total = json.totalActiveSites || total
        for (const id of (json.processedSiteIds || [])) processed.add(id)
        for (const f of (json.failedSites || [])) { if (!failed.find((x) => x.id === f.id)) failed.push(f) }
        success = processed.size - failed.length
        for (const k of Object.keys(agg)) agg[k] += Number(json[k] || 0)
        setRmProgress({ running: true, total, processed: processed.size, success, failed: failed.length, remaining: Math.max(0, total - processed.size), ...agg })
        load()
        if ((json.processedSiteCount || 0) === 0 || processed.size >= total) break
      }
      setRmFailedSites(failed)
      setRmProgress({ running: false, total, processed: processed.size, success, failed: failed.length, remaining: Math.max(0, total - processed.size), ...agg })
      setRmResult({ ...agg, processedSiteCount: processed.size, totalActiveSites: total, failedSites: failed, allDone: true })
      toast.success(`全サイト巡回完了: ${processed.size}/${total}サイト / HOT${agg.hot} / 投入${agg.imported}`)
      load(); loadRuns()
    } catch (e) { toast.error('実行に失敗しました: ' + jpError(e)) } finally { setRmRunning(false) }
  }
  // 失敗サイトだけ再巡回
  async function runRegionalFailed() {
    const ids = rmFailedSites.map((f) => f.id).filter(Boolean)
    if (!ids.length) { toast.info('再巡回する失敗サイトがありません'); return }
    await runRegional('selected', ids)
  }

  // 巡回サイト自動発見
  async function regionalApi(payload: any): Promise<any> {
    const { data: sess } = await supabase.auth.getSession()
    const token = sess.session?.access_token
    if (!token) { toast.error('ログインが必要です'); return null }
    let res: Response
    try {
      res = await fetch('/api/leads/regional-media/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) })
    } catch (e) {
      return { ok: false, error: `通信に失敗しました（ネットワーク/タイムアウト）: ${jpError(e)}` }
    }
    // レスポンス本文を一度テキストで受け、JSONでなければHTTPステータス＋本文抜粋をエラーとして返す
    // （関数クラッシュ/タイムアウト時のVercelエラーページはJSONでないため、従来は握りつぶされて原因不明だった）
    const text = await res.text().catch(() => '')
    try {
      const json = text ? JSON.parse(text) : {}
      if (!res.ok && json && json.ok === undefined && !json.error) return { ...json, ok: false, error: `サーバーエラー(HTTP ${res.status})` }
      return json
    } catch {
      const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
      const hint = res.status === 504 ? '（処理が60秒を超過＝タイムアウト。対象件数を減らすか時間をおいて再実行）'
        : res.status >= 500 ? '（サーバー関数がクラッシュ。Vercelのログを確認してください）' : ''
      return { ok: false, error: `サーバーエラー(HTTP ${res.status})${hint}${snippet ? ': ' + snippet : ''}` }
    }
  }
  async function runDiscovery() {
    setDiscovering(true)
    try {
      const json = await regionalApi({ discover: { maxQueries: 20, perQuery: 10, maxTests: 50, maxAutoRegister: 10 } })
      if (json?.ok) { setDiscoveryResult(json); toast.success(`自動発見: 診断${json.tested} / 自動登録${json.autoRegistered} / 要確認${json.review}`); loadCandidates() }
      else toast.error(json?.error || '自動発見に失敗しました')
    } finally { setDiscovering(false) }
  }
  async function loadCandidates() {
    const json = await regionalApi({ listCandidates: true })
    if (json?.ok) setSiteCandidates(json.candidates || [])
  }
  async function registerCandidate(id: string) {
    const json = await regionalApi({ registerCandidate: { id } })
    if (json?.ok) { toast.success('source_sitesへ登録しました'); loadCandidates() } else toast.error(json?.error || '登録に失敗しました')
  }
  // 連番URL探索
  async function loadProbeSites() { const json = await regionalApi({ listProbeSites: true }); if (json?.ok) setProbeSites(json.sites || []) }
  async function runProbeAll() {
    const activeCount = probeSites.filter((x: any) => x.is_active).length
    if (activeCount === 0) { toast.error('有効な連番URL探索ソースがありません。先にソースを有効化してください。'); return }
    setProbing(true)
    try { const json = await regionalApi({ probe: {}, settings: { aiInjectMode: settings.aiInjectMode, autoImportPerRun: settings.autoImportPerRun, autoImportPerDay: settings.autoImportPerDay, probeDailyCap: settings.probeDailyCap ?? 500 } })
      if (json?.ok && !json.noActiveSources) { setProbeResult(json); toast.success(`連番探索: valid${json.valid} / HOT-A${json.hotA}/HOT-B${json.hotB} / 投入${json.imported}`); loadProbeSites(); load() }
      else if (json?.noActiveSources) { toast.error('有効な連番URL探索ソースがありません。') }
      else toast.error(json?.error || '連番探索に失敗しました')
    } finally { setProbing(false) }
  }
  async function bulkProbeActive(filter: 'all' | 'tabelog' | 'jalan' | 'selected', active = true, ids?: string[]) {
    const json = await regionalApi({ bulkProbeActive: { filter, active, ids } })
    if (json?.ok) { toast.success(`${active ? '有効化' : '無効化'}しました（有効ソース ${json.activeCount}件）`); loadProbeSites() } else toast.error(json?.error || '一括更新に失敗しました')
  }
  async function probeSiteAction(id: string, o: { forwardCount?: number; backfillCount?: number; startId?: number; force?: boolean; probeMode?: 'safe' | 'advance' }) {
    setProbing(true)
    try { const json = await regionalApi({ probeSite: { id, ...o }, settings: { aiInjectMode: settings.aiInjectMode, probeDailyCap: settings.probeDailyCap ?? 500 } })
      if (json?.ok) { setProbeResult({ ...json, single: true }); toast.success(`探索: ${json.fromId}〜${json.toId} valid${json.valid}/invalid${json.invalid} 次回${json.nextId}`); loadProbeSites(); load() } else toast.error(json?.error || '探索に失敗しました')
    } finally { setProbing(false) }
  }
  async function updateProbeSite(id: string, u: any) { const json = await regionalApi({ updateProbeSite: { id, ...u } }); if (json?.ok) { toast.success('更新しました'); loadProbeSites() } }
  async function retryFailed(id: string, kind: 'fetch' | 'parser' | 'all') {
    setProbing(true)
    try { const json = await regionalApi({ retryProbeFailed: { id, kind }, settings: { aiInjectMode: settings.aiInjectMode, probeDailyCap: settings.probeDailyCap ?? 500 } })
      if (json?.ok) { if (json.retried === 0) toast.info(json.reason || '再試行対象なし'); else { setProbeResult({ ...json, single: true }); toast.success(`${kind}再試行(${json.retriedRange}): valid${json.valid}/fetch失敗${json.fetchFail}/parser失敗${json.parserFail} lead保存${json.saved}`) } loadProbeSites(); load() } else toast.error(json?.error || '再試行に失敗しました')
    } finally { setProbing(false) }
  }
  // 地域メディア: 差分巡回カーソルのリセット（既読URL or 前回最新記事）
  async function resetCrawlCursor(id: string, mode: 'latest' | 'seen') {
    if (mode === 'seen' && !window.confirm('このサイトの既読URL履歴をリセットします（次回、過去記事も再度読みに行きます）。よろしいですか？')) return
    const json = await regionalApi({ resetCrawlCursor: { id, mode } })
    if (json?.ok) { toast.success(mode === 'latest' ? '前回最新記事をリセットしました' : `既読URLをリセットしました（${json.deleted ?? 0}件）`); loadSites() } else toast.error(json?.error || 'リセットに失敗しました')
  }
  async function runRegionalOne(id: string, recrawlAll: boolean) {
    setRmRunning(true)
    try {
      const j = await callRegional({ runMode: 'selected', selectedSiteIds: [id], recrawlAll, differential: true })
      if (j && !j.error) { toast.success(`${recrawlAll ? '過去分も再' : '差分'}巡回: 新規${j.newArticles ?? 0}/既読skip${j.seenSkipped ?? 0}/古記事skip${j.oldSkipped ?? 0} HOT${j.hot ?? 0}/HOLD${j.hold ?? 0}`); loadSites(); load() }
    } finally { setRmRunning(false) }
  }
  const [ekitenRunning, setEkitenRunning] = useState(false)
  const [ekitenResult, setEkitenResult] = useState<any>(null)
  async function runEkiten() {
    if (!window.confirm('エキテンの「公開日が直近7日以内」の新規掲載候補を探索します（Serper/Bingで過去7日の公開日を検索→詳細ページで公開日・電話・住所を再確認→7日以内のみHOT-B）。※公開日は開業日ではなく掲載公開日です。実行しますか？')) return
    setEkitenRunning(true); setEkitenResult(null)
    try { const json = await regionalApi({ ekitenDiscover: {}, settings: { aiInjectMode: settings.aiInjectMode, autoImportPerRun: settings.autoImportPerRun } })
      if (json?.ok) { setEkitenResult(json); toast.success(`エキテン: 検索${json.queries}q / 詳細${json.detailFetched} / 公開日7日内${json.pub7} / HOT-B${json.hotB} / 投入${json.imported}`); load() }
      else { setEkitenResult(json); toast.error(json?.error || 'エキテン探索に失敗しました') }
    } finally { setEkitenRunning(false) }
  }
  const [recorrecting, setRecorrecting] = useState(false)
  async function recorrectNames() {
    if (!window.confirm('既存の地域メディア/Instagram候補の店名を再判定します。\nサイト名/カテゴリ/記事タイトルのままの候補は「店名未確定」にしてHOLDへ下げます。実行しますか？')) return
    setRecorrecting(true)
    try { const json = await regionalApi({ recorrectNames: { limit: 1000 } }); if (json?.ok) { toast.success(`再補正: ${json.scanned}件中 修正${json.fixed} / 店名未確定HOT-B昇格${json.promotedHotB ?? 0} / HOLD${json.held}`); load() } else toast.error(json?.error || '再補正に失敗しました') }
    finally { setRecorrecting(false) }
  }
  const [excludingBig, setExcludingBig] = useState(false)
  async function excludeBigPublic() {
    if (!window.confirm('道の駅・産直・JA・大型商業施設・公共施設・大手チェーン等を一覧から除外します（ターゲット=個人事業主・5人以下の小規模店）。実行しますか？')) return
    setExcludingBig(true)
    try { const json = await regionalApi({ excludeBigPublic: { limit: 3000 } }); if (json?.ok) { toast.success(`ターゲット絞り込み: ${json.scanned}件中 ${json.excluded}件を除外（大手/公共/大型施設）`); load() } else toast.error(json?.error || '除外に失敗しました') }
    finally { setExcludingBig(false) }
  }
  const [rescuing, setRescuing] = useState(false)
  async function rescueHolds() {
    if (!window.confirm('電話番号が無いHOLD候補に対し、Google Places・公式サイト・検索で電話番号を補完し、取れたらHOTへ昇格します（架電リストを増やす）。地域が矛盾する電話は採用しません。実行しますか？')) return
    setRescuing(true)
    try { const json = await regionalApi({ rescueHolds: { limit: 80 } }); if (json?.ok) { toast.success(`HOLD救済: ${json.scanned}件走査 / 補完試行${json.enriched} / 電話取得${json.phoneFound} / HOT昇格${json.promotedHot}`); load() } else toast.error(json?.error || '救済に失敗しました') }
    finally { setRescuing(false) }
  }
  async function recorrectProbe() {
    if (!window.confirm('連番探索（食べログ/じゃらん）由来で「連番探索候補」「店名未確定」のままの候補を、元URLから再取得して正式店名・電話・住所を再抽出します。\ncases投入済みなら案件側の店名も更新します。実行しますか？')) return
    setRecorrecting(true)
    try { const json = await regionalApi({ recorrectProbe: { limit: 200 } }); if (json?.ok) { toast.success(`連番再取得: ${json.scanned}件中 更新${json.updated} / HOLD${json.held} / 案件更新${json.caseUpdated}`); load() } else toast.error(json?.error || '再取得に失敗しました') }
    finally { setRecorrecting(false) }
  }
  const DEFAULT_PROBE_FORM = { name: '', url_template: '', region_label: '', prefecture: '', start_probe_id: '', id_padding: 12, scan_direction: 'forward', forward_scan_count: 20, max_probe_per_run: 20, parser_type: 'generic_detail_page', probe_mode: 'safe', valid_page_pattern: '', invalid_page_pattern: '', is_active: false }
  function openAddProbe() { setProbeFormEditId(null); setProbeForm({ ...DEFAULT_PROBE_FORM }); setProbeFormTest(null); setProbeFormOpen(true) }
  function openEditProbe(st: any) { setProbeFormEditId(st.id); setProbeForm({ name: st.name || '', url_template: st.url_template || '', region_label: st.region_label || '', prefecture: st.prefecture || '', start_probe_id: String(st.start_probe_id ?? st.current_probe_id ?? ''), id_padding: st.id_padding ?? 12, scan_direction: st.scan_direction || 'forward', forward_scan_count: st.forward_scan_count ?? 20, max_probe_per_run: st.max_probe_per_run ?? 20, parser_type: st.parser_type || 'generic_detail_page', probe_mode: st.probe_mode || 'safe', valid_page_pattern: st.valid_page_pattern || '', invalid_page_pattern: st.invalid_page_pattern || '', is_active: !!st.is_active, current_probe_id: st.current_probe_id, last_checked_id: st.last_checked_id, last_valid_id: st.last_valid_id }); setProbeFormTest(null); setProbeFormOpen(true) }
  function probePreviewUrl() { const f = probeForm; if (!f?.url_template?.includes('{ID}')) return ''; const id = String(f.start_probe_id || '0'); const padded = Number(f.id_padding) > 0 ? id.padStart(Number(f.id_padding), '0') : id; return f.url_template.replace('{ID}', padded) }
  async function testProbeForm() {
    const f = probeForm
    const json = await regionalApi({ probeTestUrl: { url_template: f.url_template, id_padding: f.id_padding, parser_type: f.parser_type, valid_page_pattern: f.valid_page_pattern, invalid_page_pattern: f.invalid_page_pattern, id: Number(f.start_probe_id) || undefined } })
    if (json?.ok) { setProbeFormTest(json); toast[json.summary?.parserOk ? 'success' : 'error'](`テスト: ${json.summary?.parserOk ? '保存可能' : '抽出NG'}`) } else toast.error(json?.error || 'テストに失敗しました')
  }
  async function saveProbeForm(forceAdd = false) {
    const f = probeForm
    if (!f.name?.trim() || !f.url_template?.includes('{ID}')) { toast.error('サイト名・URLテンプレート（{ID}を含む）は必須です'); return }
    const payload: any = { name: f.name, url_template: f.url_template, region_label: f.region_label || null, prefecture: f.prefecture || null, parser_type: f.parser_type, id_padding: Number(f.id_padding) || 0, scan_direction: f.scan_direction, forward_scan_count: Number(f.forward_scan_count) || 20, max_probe_per_run: Number(f.max_probe_per_run) || 20, probe_mode: f.probe_mode, valid_page_pattern: f.valid_page_pattern || null, invalid_page_pattern: f.invalid_page_pattern || null, is_active: f.is_active, start_probe_id: Number(f.start_probe_id) || 1 }
    if (probeFormEditId) {
      const json = await regionalApi({ updateProbeSite: { id: probeFormEditId, ...payload } })
      if (json?.ok) { toast.success('更新しました'); setProbeFormOpen(false); loadProbeSites() } else toast.error(json?.error || '更新に失敗しました')
      return
    }
    const json = await regionalApi({ createProbeSite: { ...payload, force_add: forceAdd } })
    if (json?.ok) { toast.success('連番ソースを追加しました'); setProbeFormOpen(false); loadProbeSites() }
    else if (json?.duplicate) {
      if (window.confirm(`同じURLテンプレートのソース「${json.existingName}」が既に存在します。\nOK＝それでも別ソースとして追加 / キャンセル＝中止（編集する場合は一覧の編集ボタンから）`)) saveProbeForm(true)
    }
    else toast.error(json?.error || '保存に失敗しました')
  }
  async function testProbe(id: string, ids?: number[]) {
    setProbing(true)
    try { const json = await regionalApi({ probeTest: { id, ids } })
      if (json?.ok) { setProbeTests((p) => ({ ...p, [id]: json })); toast[json.summary?.parserOk ? 'success' : 'error'](`parserテスト: ${json.summary?.parserOk ? 'OK' : 'NG'} / 住所${json.summary?.addressOk ? 'OK' : 'NG'} / 電話${json.summary?.phoneOk ? 'OK' : 'NG'}`) }
      else toast.error(json?.error || 'テストに失敗しました')
    } finally { setProbing(false) }
  }

  // 地域メディア候補の再補完（AI再判定とは別）
  async function reenrichRegional(c: LeadCandidate) {
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      toast.info('外部情報を補完中…')
      const res = await fetch('/api/leads/regional-media/run', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ reenrich: { id: c.id } }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.ok === false) throw new Error(j.error || 'failed')
      toast.success(`再補完: 電話${j.phone || 'なし'} / ${j.area || '地域不明'}`); load()
    } catch (e) { toast.error('再補完に失敗: ' + jpError(e)) }
  }

  // Instagram Web検索
  const checkIwStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/cron/instagram-web-leads', { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setIwConfigured(r.ok ? !!j.configured : false); setIwDiag(r.ok ? j : { error: `HTTP ${r.status}` })
    } catch (e) { setIwConfigured(false); setIwDiag({ error: jpError(e) }) }
  }, [])
  useEffect(() => { checkIwStatus() }, [checkIwStatus])

  async function runIw() {
    if (!settings.iwEnabled) { toast.error('設定でInstagram Web検索がOFFです'); return }
    if (iwConfigured === false) { toast.error('検索APIキー/Supabaseが未設定です（診断を確認）'); return }
    setIwRunning(true); setIwResult(null)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      if (!token) { toast.error('ログインが必要です'); return }
      const res = await fetch('/api/cron/instagram-web-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            // 全国検索: 地域・業種はクエリに入れない（areaPreset/industriesは送らない）
            iwAutoImport: settings.iwAutoImport, iwSearchMode: settings.iwSearchMode, iwAllowNoPhone: settings.iwAllowNoPhone, iwRequirePhone: settings.iwRequirePhone, iwPlacesRequired: settings.iwPlacesRequired,
            iwAnthropic: settings.iwAnthropic, iwMaxQueriesPerDay: settings.iwMaxQueriesPerDay, iwPerQuery: settings.iwPerQuery,
            iwMaxQueriesPerRun: settings.iwMaxQueriesPerRun, iwProvider: settings.iwProvider, iwSameQuerySkipDays: settings.iwSameQuerySkipDays, iwSameUrlSkipDays: settings.iwSameUrlSkipDays,
            iwMaxRunsPerDay: settings.iwMaxRunsPerDay, iwPerRun: settings.iwPerRun, iwAnthropicDailyCap: settings.iwAnthropicDailyCap,
            iwEnrichEnabled: settings.iwEnrichEnabled, iwEnrichMaxQueries: settings.iwEnrichMaxQueries, iwEnrichPerQuery: settings.iwEnrichPerQuery, iwEnrichDailyCap: settings.iwEnrichDailyCap,
            dailyCap: settings.dailyCap,
          },
        }),
      })
      // 504タイムアウト等ではJSONではなくHTML/空が返る。res.json()の失敗を
      // {}（＝全ゼロ表示）にせず、HTTPステータス付きの明確なエラーとして表示する。
      const raw = await res.text()
      let json: any
      try { json = JSON.parse(raw) } catch {
        json = { ok: false, error: res.status === 504 || res.status === 408
          ? `処理がタイムアウトしました（HTTP ${res.status}）。設定でクエリ数/補完を減らすか、少し待って再実行してください。`
          : `サーバーエラー（HTTP ${res.status}）。${raw.slice(0, 200) || '応答なし'}`, failed_step: 'http', error_message: raw.slice(0, 300) }
      }
      setIwResult(json)
      if (!res.ok || json.ok === false) { toast.error(typeof json.error === 'string' ? json.error : 'Instagram Web検索に失敗しました'); return }
      toast.success(`完了: 取得${json.results ?? 0} / HOT${json.hot ?? 0} / HOLD${json.hold ?? 0}`)
      load(); loadRuns()
    } catch (e) { toast.error('実行に失敗しました: ' + jpError(e)) } finally { setIwRunning(false) }
  }

  async function rejudgeCandidate(c: LeadCandidate) {
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      const res = await fetch('/api/cron/instagram-web-leads', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ rejudge: { id: c.id } }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.ok === false) throw new Error(j.error || 'failed')
      toast.success(`再判定: ${j.temperature}`); load()
    } catch (e) { toast.error('再判定に失敗: ' + jpError(e)) }
  }

  async function excludeCandidate(c: LeadCandidate) {
    try { await LeadCandidateApi.update(c.id, { lead_temperature: 'EXCLUDED', should_exclude_from_call_list: true }); toast.success('除外にしました'); load() }
    catch (e) { toast.error('除外に失敗: ' + jpError(e)) }
  }

  // 再補完: 外部サイト/予約サイト/Placesから電話・住所を探索（AI判定とは別）
  async function reenrichCandidate(c: LeadCandidate) {
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      toast.info('外部情報を補完中…')
      const res = await fetch('/api/cron/instagram-web-leads', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ reenrich: { id: c.id } }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.ok === false) throw new Error(j.error || 'failed')
      toast.success(`再補完: 電話${j.phone || 'なし'} / ${j.area || '地域不明'}`); load()
    } catch (e) { toast.error('再補完に失敗: ' + jpError(e)) }
  }

  // 管理API（ログインJWTで認可・service roleはサーバー側のみ）
  const adminFetch = useCallback(async (path: string, method: string, body?: any) => {
    const { data: sess } = await supabase.auth.getSession()
    const token = sess.session?.access_token
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${res.status}`)
    return json
  }, [])

  const loadSites = useCallback(async () => {
    try {
      const j = await adminFetch('/api/admin/regional-media/sources', 'GET')
      setRmSites(j.sites || [])
      setRmCounts({ total: j.total || 0, active: j.active || 0, inactive: j.inactive || 0 })
      setRmSitesErr(null)
    } catch (e) { setRmSitesErr(jpError(e)) }
  }, [adminFetch])
  useEffect(() => { if (sourceTab === 'regional') loadSites() }, [sourceTab, loadSites])

  const emptySite = { name: '', base_url: '', list_url: '', media_family: 'other', source_type: 'html_list', category_label: '開店閉店', is_active: true, reliability_score: 50, crawl_interval_hours: 24, rendering_mode: 'auto' }

  async function seedInitial() {
    setRmBusy(true)
    try { const j = await adminFetch('/api/admin/regional-media/sources', 'POST', { action: 'seed' }); toast.success(`初期ソースを登録しました（${j.seeded}件）`); loadSites(); checkRmStatus() }
    catch (e) { toast.error('登録に失敗: ' + jpError(e)) } finally { setRmBusy(false) }
  }

  async function saveSite() {
    if (!siteForm) return
    setRmBusy(true)
    try {
      if (siteForm.id) await adminFetch(`/api/admin/regional-media/sources/${siteForm.id}`, 'PATCH', siteForm)
      else await adminFetch('/api/admin/regional-media/sources', 'POST', siteForm)
      toast.success(siteForm.id ? 'サイトを更新しました' : 'サイトを登録しました（base_url重複時は更新）')
      setSiteForm(null); loadSites(); checkRmStatus()
    } catch (e) { toast.error('保存に失敗: ' + jpError(e)) } finally { setRmBusy(false) }
  }

  async function toggleSiteActive(s: any) {
    try { await adminFetch(`/api/admin/regional-media/sources/${s.id}`, 'PATCH', { is_active: !s.is_active }); loadSites(); checkRmStatus() }
    catch (e) { toast.error('切替に失敗: ' + jpError(e)) }
  }

  async function testSite(s: any) {
    setSiteTests((p) => ({ ...p, [s.id]: { loading: true } }))
    try { const j = await adminFetch(`/api/admin/regional-media/sources/${s.id}/test`, 'POST'); setSiteTests((p) => ({ ...p, [s.id]: j })) }
    catch (e) { setSiteTests((p) => ({ ...p, [s.id]: { error: jpError(e) } })) }
  }

  async function testAllSites() {
    setRmBusy(true); setAllTest({ loading: true })
    try { const j = await adminFetch('/api/admin/regional-media/test-all', 'POST'); setAllTest(j) }
    catch (e) { setAllTest({ error: jpError(e) }) } finally { setRmBusy(false) }
  }

  async function dedupeSites() {
    setRmBusy(true)
    try { const j = await adminFetch('/api/admin/regional-media/sources', 'POST', { action: 'dedupe' }); toast.success(`重複を整理しました（無効化 ${j.deactivated}件）`); loadSites(); checkRmStatus() }
    catch (e) { toast.error('整理に失敗: ' + jpError(e)) } finally { setRmBusy(false) }
  }

  async function runInstagram() {
    if (!settings.igEnabled) { toast.error('設定でInstagram取得がOFFです'); return }
    if (igConfigured === false) {
      // 公式Meta APIは未設定。設定不要で同等の「Instagram Web検索」への切替を提案。
      if (window.confirm('ハッシュタグ検索は公式Instagram API（Meta）の IG_ACCESS_TOKEN / IG_USER_ID が必要で、現在未設定です。\n\n設定不要で同じ「新店候補」を探せる Instagram Web検索（稼働中）を代わりに実行しますか？')) { runIw() }
      return
    }
    setIgRunning(true); setIgResult(null)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      if (!token) { toast.error('ログインが必要です'); return }
      const res = await fetch('/api/leads/instagram/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            igAutoImport: settings.igAutoImport, igRequirePhone: settings.igRequirePhone,
            igAllowWithoutPlace: settings.igAllowWithoutPlace, igRequireOpenWord: settings.igRequireOpenWord,
            igRequireArea: settings.igRequireArea, igPeriodDays: settings.igPeriodDays,
            igMaxHashtagsPerDay: settings.igMaxHashtagsPerDay, dailyCap: settings.dailyCap,
          },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(json.error || 'Instagram取得に失敗しました'); setIgResult({ error: json.error }); return }
      setIgResult(json)
      toast.success(`Instagram完了: 投稿${json.recent ?? 0} / HOT候補${(json.googleHot ?? 0) + (json.igOnlyHot ?? 0)} / 投入${json.imported ?? 0}`)
      load(); loadRuns()
    } catch (e) {
      toast.error('実行に失敗しました: ' + jpError(e))
    } finally { setIgRunning(false) }
  }

  async function rejudgePlaces() {
    if (gpConfigured === false) { toast.error('GOOGLE_MAPS_API_KEYが未設定です'); return }
    if (!window.confirm('既存のGoogle Places候補をPlace Details(New)で再取得し、openingDate最優先で再判定します（最大100件・APIコストあり）。実行しますか？')) return
    setGpRunning(true)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      if (!token) { toast.error('ログインが必要です'); return }
      const res = await fetch('/api/leads/google-places/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ rejudge: { limit: 100 } }) })
      const json = await res.json().catch(() => ({}))
      if (json?.ok) { toast.success(`再判定: ${json.scanned}件走査 / 詳細${json.detailed} / openingDate取得${json.openingFound} / HOT-B${json.hotB} / 除外${json.excluded} / 案件更新${json.caseUpdated}`); load() }
      else toast.error(json?.error || '再判定に失敗しました')
    } catch (e) { toast.error('再判定に失敗しました: ' + jpError(e)) } finally { setGpRunning(false) }
  }
  async function runPlaces(testFixed = false) {
    if (!testFixed && !settings.placesEnabled) { toast.error('設定でGoogle Places実行がOFFです'); return }
    if (gpConfigured === false) { toast.error('GOOGLE_MAPS_API_KEYが未設定です'); return }
    setGpRunning(true); setGpResult(null)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      if (!token) { toast.error('ログインが必要です'); return }
      const res = await fetch('/api/leads/google-places/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            testFixed,
            autoImport: settings.autoImport,
            dailyCap: settings.dailyCap,
            areaPreset: settings.areaPreset,
            areas: parseList(settings.areas),
            industries: parseList(settings.industries),
            maxPerQuery: settings.maxPerQuery,
            maxQueriesPerDay: settings.maxQueriesPerDay,
            rotation: settings.rotation,
            placesNationwide: settings.placesNationwide,
            placesMaxQueriesPerDay: settings.placesMaxQueriesPerDay,
            placesPerQuery: settings.placesPerQuery,
            placesMaxDetailsPerDay: settings.placesMaxDetailsPerDay,
            placesDetailsLimitPerRun: settings.placesDetailsLimitPerRun ?? 100,
            placesSkipDetailsIfReviewsOver: settings.placesSkipDetailsIfReviewsOver ?? 100,
            placesOpeningDatePriority: settings.placesOpeningDatePriority !== false,
            placesPagesPerQuery: settings.placesPagesPerQuery ?? 3,
            placesResultsPerQueryLimit: settings.placesResultsPerQueryLimit ?? 60,
            aiInjectMode: settings.aiInjectMode, autoImportPerRun: settings.autoImportPerRun, autoImportPerDay: settings.autoImportPerDay,
            hotMaxReviews: settings.hotMaxReviews,
            warmMaxReviews: settings.warmMaxReviews,
            exclude100: settings.exclude100,
            unknownHold: settings.unknownHold,
          },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || 'Google Places実行に失敗しました')
        setGpResult({ error: json.error })
        return
      }
      setGpResult(json)
      toast.success(`Google Places完了: 取得${json.fetched ?? 0} / HOT${json.hot ?? 0} / 投入${json.imported ?? 0}`)
      load(); loadRuns(); loadQlog()
    } catch (e) {
      toast.error('実行に失敗しました: ' + jpError(e))
    } finally {
      setGpRunning(false)
    }
  }

  // Realtime
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let t: ReturnType<typeof setTimeout> | null = null
    const reload = () => { if (t) clearTimeout(t); t = setTimeout(load, 500) }
    const ch = supabase
      .channel('leads_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lead_candidates' }, reload)
      .subscribe()
    return () => { if (t) clearTimeout(t); supabase.removeChannel(ch) }
  }, [load])

  function saveSettings(s: LeadImportSettings) {
    setSettings(s)
    localStorage.setItem(LS_LEAD_SETTINGS, JSON.stringify(s))
  }

  // 自動取得設定をサーバー(app_config)へ保存 → 毎朝6:00のCronが参照
  async function saveAutoConfig() {
    setSavingCfg(true)
    try {
      await AppConfigApi.set('lead_auto', {
        autoFetch: settings.autoFetch,
        autoImport: settings.autoImport,
        areaPreset: settings.areaPreset,
        areas: parseList(settings.areas),
        industries: parseList(settings.industries),
        maxPerQuery: settings.maxPerQuery,
        maxQueriesPerDay: settings.maxQueriesPerDay,
        dailyCap: settings.dailyCap,
        rotation: settings.rotation,
        placesNationwide: settings.placesNationwide,
        placesMaxQueriesPerDay: settings.placesMaxQueriesPerDay,
        placesPerQuery: settings.placesPerQuery,
        placesMaxDetailsPerDay: settings.placesMaxDetailsPerDay,
        hotMaxReviews: settings.hotMaxReviews,
        warmMaxReviews: settings.warmMaxReviews,
        exclude100: settings.exclude100,
        unknownHold: settings.unknownHold,
      })
      await AppConfigApi.set('instagram_auto', {
        igEnabled: settings.igEnabled,
        igAutoImport: settings.igAutoImport,
        igRequirePhone: settings.igRequirePhone,
        igAllowWithoutPlace: settings.igAllowWithoutPlace,
        igRequireOpenWord: settings.igRequireOpenWord,
        igRequireArea: settings.igRequireArea,
        igPeriodDays: settings.igPeriodDays,
        igMaxHashtagsPerDay: settings.igMaxHashtagsPerDay,
        dailyCap: settings.dailyCap,
      })
      await AppConfigApi.set('regional_auto', {
        regionalEnabled: settings.regionalEnabled,
        maxSitesPerDay: settings.regionalMaxSites,
        maxArticlesPerSite: settings.regionalMaxArticles,
        periodDays: settings.regionalPeriodDays,
        dailyCap: settings.dailyCap,
        regionalEnrichEnabled: settings.regionalEnrichEnabled,
        regionalEnrichMaxQueries: settings.regionalEnrichMaxQueries,
        regionalEnrichPerQuery: settings.regionalEnrichPerQuery,
        regionalEnrichDailyCap: settings.regionalEnrichDailyCap,
      })
      await AppConfigApi.set('instagram_web_auto', {
        iwEnabled: settings.iwEnabled, iwSearchMode: settings.iwSearchMode, iwAllowNoPhone: settings.iwAllowNoPhone, iwAutoImport: settings.iwAutoImport, iwRequirePhone: settings.iwRequirePhone,
        iwPlacesRequired: settings.iwPlacesRequired, iwAnthropic: settings.iwAnthropic,
        iwMaxQueriesPerDay: settings.iwMaxQueriesPerDay, iwPerQuery: settings.iwPerQuery,
        iwMaxQueriesPerRun: settings.iwMaxQueriesPerRun, iwProvider: settings.iwProvider, iwSameQuerySkipDays: settings.iwSameQuerySkipDays, iwSameUrlSkipDays: settings.iwSameUrlSkipDays,
        iwMaxRunsPerDay: settings.iwMaxRunsPerDay, iwPerRun: settings.iwPerRun, iwAnthropicDailyCap: settings.iwAnthropicDailyCap,
        iwEnrichEnabled: settings.iwEnrichEnabled, iwEnrichMaxQueries: settings.iwEnrichMaxQueries, iwEnrichPerQuery: settings.iwEnrichPerQuery, iwEnrichDailyCap: settings.iwEnrichDailyCap,
        dailyCap: settings.dailyCap,
      })
      await AppConfigApi.set('sequential_auto', {
        sequentialEnabled: (settings as any).sequentialEnabled !== false,
        probeDailyCap: settings.probeDailyCap ?? 500,
        autoImportPerRun: settings.autoImportPerRun ?? 50,
        autoImportPerDay: settings.autoImportPerDay ?? 200,
        aiInjectMode: settings.aiInjectMode,
      })
      toast.success('自動取得設定を保存しました（自動巡回Cron: Places/地域メディア/Instagram Web/連番URL に反映）')
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setSavingCfg(false)
    }
  }

  // 都県別の巡回進捗（直近7日に実行済みのエリア数 / 全市区町村数）
  const rotationProgress = useMemo(() => {
    const totals = prefectureAreaTotals()
    const runByPref = new Map<string, Set<string>>()
    let todayQueries = 0
    const startToday = moment().startOf('day')
    for (const r of qlog) {
      if (r.area) {
        const set = runByPref.get(r.prefecture || 'その他') || new Set<string>()
        set.add(r.area)
        runByPref.set(r.prefecture || 'その他', set)
      }
      if (moment(r.last_run_at).isSameOrAfter(startToday)) todayQueries++
    }
    const perPref = totals.map((t) => ({ ...t, done: runByPref.get(t.label)?.size || 0 }))
    const allAreas = AREA_PRESETS.ittokensanken.areas.length
    const doneAreas = perPref.reduce((s, p) => s + p.done, 0)
    return { perPref, allAreas, doneAreas, remainingAreas: Math.max(0, allAreas - doneAreas), todayQueries, skipped7d: qlog.length }
  }, [qlog])

  // 案件へ投入
  async function importToCase(c: LeadCandidate): Promise<boolean> {
    const memo = [
      `【AI自動投入 / ${c.lead_temperature}】`,
      `投入理由: ${c.auto_import_reason ?? ''}`,
      `AIコメント: ${c.ai_comment ?? ''}`,
      `オーナー到達スコア: ${c.owner_reachability_score}`,
    ].join('\n')
    const created = await CaseApi.create({
      name: c.name,
      address: c.address ?? '',
      phone1: c.phone_number ?? '',
      industry: c.industry ?? null,
      status: DEFAULT_STATUS,
      hp1: c.website_url ?? null,
      instagram: c.instagram_url ?? null,
      source_urls: c.source_type ?? 'AI自動投入',
      memo,
      created_by_id: user?.id ?? null,
    })
    await LeadCandidateApi.update(c.id, { imported_to_cases: true, imported_at: new Date().toISOString() })
    AuditApi.log({ action: 'create', entity: 'case', entity_id: created.id, entity_name: created.name, detail: 'AI自動投入', actor_id: user?.id ?? null })
    return true
  }

  // ===== 統合トリアージ: 絞り込み・並び替え =====
  const qScore = (c: any): number => (typeof c.quality_score === 'number' ? c.quality_score : -1)
  const triageList = useMemo(() => {
    const digits = tSearch.replace(/[^0-9]/g, '')
    let arr = candidates.filter((c: any) => {
      if (tTemp !== 'all' && c.lead_temperature !== tTemp) return false
      if (tGrade !== 'all' && c.quality_grade !== tGrade) return false
      if (tCat !== 'all' && (c.industry_category || 'その他') !== tCat) return false
      if (tPref !== 'all') { const p = (c.address || c.extracted_address || ''); if (!String(p).includes(tPref)) return false }
      const hasPhone = !!(c.phone_number || c.extracted_phone)
      if (tPhone === 'yes' && !hasPhone) return false
      if (tPhone === 'no' && hasPhone) return false
      if (tPhone === 'fixed') { const d = String(c.phone_number || c.extracted_phone || '').replace(/[^\d]/g, ''); if (!(d && /^0/.test(d) && !/^0[789]0/.test(d) && !/^050/.test(d))) return false }
      if (tNotImported && c.imported_to_cases) return false
      if (tDup && !(c.dup_group_size > 1)) return false
      if (tFlagged && !(Array.isArray(c.quality_flags) && c.quality_flags.length)) return false
      if (tSalesGrade !== 'all' && c.sales_priority_grade !== tSalesGrade) return false
      if (tSource !== 'all' && (c.discovery_source_type || c.source || c.lead_source) !== tSource) return false
      if (tWebsite !== 'all' && (c.website_status || 'unknown') !== tWebsite) return false
      if (tSearch) { const hay = `${c.name || ''} ${c.address || ''} ${c.extracted_address || ''} ${c.industry || ''}`; if (!hay.includes(tSearch) && !(digits && String(c.phone_number || '').replace(/[^\d]/g, '').includes(digits))) return false }
      return true
    })
    arr = [...arr]
    if (tSort === 'sales') arr.sort((a: any, b: any) => (b.sales_priority_score ?? -1) - (a.sales_priority_score ?? -1) || qScore(b) - qScore(a))
    else if (tSort === 'quality') arr.sort((a: any, b: any) => qScore(b) - qScore(a) || callPriority(b) - callPriority(a))
    else if (tSort === 'priority') arr.sort((a: any, b: any) => callPriority(b) - callPriority(a))
    else arr.sort((a: any, b: any) => Date.parse(b.first_seen_at || b.last_seen_at || 0) - Date.parse(a.first_seen_at || a.last_seen_at || 0))
    return arr
  }, [candidates, tTemp, tGrade, tCat, tPref, tPhone, tNotImported, tDup, tFlagged, tSalesGrade, tSource, tWebsite, tSearch, tSort])
  const triageVisible = useMemo(() => triageList.slice(0, tShown), [triageList, tShown])
  const prefList = useMemo(() => Array.from(new Set(candidates.map((c: any) => (String(c.address || c.extracted_address || '').match(/(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/) || [])[1]).filter(Boolean))).sort() as string[], [candidates])
  // 取得元別の歩留まり
  const sourceYield = useMemo(() => {
    const m = new Map<string, { total: number; hot: number; imported: number; avgQ: number; sumQ: number; qN: number }>()
    for (const c of candidates as any[]) {
      const k = c.source || c.lead_source || c.source_type || '(不明)'
      const e = m.get(k) || { total: 0, hot: 0, imported: 0, avgQ: 0, sumQ: 0, qN: 0 }
      e.total++; if (c.lead_temperature === 'HOT') e.hot++; if (c.imported_to_cases) e.imported++
      if (typeof c.quality_score === 'number') { e.sumQ += c.quality_score; e.qN++ }
      m.set(k, e)
    }
    return Array.from(m.entries()).map(([k, e]) => ({ source: k, ...e, avgQ: e.qN ? Math.round(e.sumQ / e.qN) : 0 })).sort((a, b) => b.total - a.total)
  }, [candidates])

  function toggleSel(id: string) { setSelectedIds((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n }) }
  function selectAllVisible() { setSelectedIds(new Set(triageVisible.map((c: any) => c.id))) }
  function clearSel() { setSelectedIds(new Set()) }
  const selectedCands = useMemo(() => candidates.filter((c: any) => selectedIds.has(c.id)), [candidates, selectedIds])

  async function bulkInject() {
    const targets = selectedCands.filter((c: any) => !c.imported_to_cases && c.lead_temperature !== 'EXCLUDED')
    if (!targets.length) { toast.error('投入できる候補がありません（EXCLUDED/投入済を除く）'); return }
    if (!window.confirm(`選択した ${targets.length} 件を案件(cases)に投入します。よろしいですか？\n※電話番号のある候補を優先してください。`)) return
    setBulkBusy(true)
    let ok = 0, ng = 0
    for (const c of targets) { try { await importToCase(c as LeadCandidate); ok++ } catch { ng++ } }
    setBulkBusy(false); clearSel(); toast.success(`投入完了: 成功${ok} / 失敗${ng}`); load()
  }
  async function bulkSetTemp(temp: 'EXCLUDED' | 'HOLD' | 'HOT') {
    if (!selectedCands.length) return
    const label = temp === 'EXCLUDED' ? '除外' : temp === 'HOLD' ? '保留' : 'HOT'
    if (!window.confirm(`選択した ${selectedCands.length} 件を「${label}」に変更します。よろしいですか？`)) return
    setBulkBusy(true)
    let ok = 0
    for (const c of selectedCands as any[]) { try { await LeadCandidateApi.update(c.id, { lead_temperature: temp, should_exclude_from_call_list: temp === 'EXCLUDED' }); ok++ } catch { /* noop */ } }
    setBulkBusy(false); clearSel(); toast.success(`${label}に変更: ${ok}件`); load()
  }
  // 今日の架電リスト: 電話あり・未投入・重複除去（dedup_keyごと最高品質1件）・高品質順 上位N
  function buildCallList(n = 30) {
    const pool = (candidates as any[]).filter((c) => c.lead_temperature === 'HOT' && (c.phone_number || c.extracted_phone) && !c.imported_to_cases)
    const best = new Map<string, any>()
    for (const c of pool) { const k = c.dedup_key || c.id; const cur = best.get(k); if (!cur || qScore(c) > qScore(cur)) best.set(k, c) }
    const list = Array.from(best.values()).sort((a, b) => qScore(b) - qScore(a) || callPriority(b) - callPriority(a)).slice(0, n)
    setSelectedIds(new Set(list.map((c) => c.id)))
    setTTemp('HOT'); setTPhone('yes'); setTNotImported(true); setTSort('quality')
    toast.success(`今日の架電リスト: 重複除去後の高品質HOT ${list.length}件を選択しました（CSV出力・一括投入できます）`)
    return list
  }
  function exportCsv(rows: any[], filename: string) {
    if (!rows.length) { toast.error('出力対象がありません'); return }
    const cols = [['品質', 'quality_score'], ['グレード', 'quality_grade'], ['温度', 'lead_temperature'], ['店名', 'name'], ['電話', 'phone_number'], ['住所', 'address'], ['業種', 'industry_category'], ['市外局番整合', 'phone_pref_match'], ['公式', 'website_url'], ['ソース', 'source'], ['詳細URL', 'source_detail_url'], ['注意', 'quality_flags']]
    const esc = (v: any) => { const s = Array.isArray(v) ? v.join(' / ') : (v == null ? '' : String(v)); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const head = cols.map((c) => c[0]).join(',')
    const body = rows.map((r) => cols.map((c) => esc((r as any)[c[1]])).join(',')).join('\n')
    const blob = new Blob(['﻿' + head + '\n' + body], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
    toast.success(`${rows.length}件をCSV出力しました`)
  }
  async function runQualityRecompute() {
    if (!window.confirm('全候補の品質スコア・グレード・業種・重複を再計算します。実行しますか？')) return
    setQualityRunning(true)
    try {
      const json = await regionalApi({ recomputeQuality: { mode: 'all', limit: 2000, withDups: true } })
      if (json?.ok) { toast.success(`品質再計算: ${json.quality?.updated ?? 0}件更新 / 重複${json.dup?.dupGroups ?? 0}グループ`); load() }
      else toast.error(json?.error || '再計算に失敗しました')
    } finally { setQualityRunning(false) }
  }
  // ===== 自動巡回: 状態読み込み・実行・ON/OFF =====
  const loadAutoCrawl = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try {
      const { data: runs } = await supabase.from('auto_crawl_runs').select('*').order('started_at', { ascending: false }).limit(30)
      const last = runs && runs[0] ? runs[0] : null
      setCrawlLast(last)
      if (last?.id) { const { data: items } = await supabase.from('auto_crawl_run_items').select('*').eq('run_id', last.id); setCrawlItems(items || []) }
      const startToday = moment().startOf('day').toISOString()
      const today = (runs || []).filter((r: any) => r.started_at >= startToday)
      setCrawlToday({
        runs: today.length,
        hotA: today.reduce((s: number, r: any) => s + (r.hot_a_count || 0), 0),
        hotB: today.reduce((s: number, r: any) => s + (r.hot_b_count || 0), 0),
        hold: today.reduce((s: number, r: any) => s + (r.hold_count || 0), 0),
        inserted: today.reduce((s: number, r: any) => s + (r.cases_inserted_count || 0), 0),
        errors: today.reduce((s: number, r: any) => s + (r.failed_sources || 0), 0),
      })
      const { data: failed } = await supabase.from('source_sites').select('name,source_type,last_error_type,last_error_message,last_crawl_result,last_crawled_at').or('last_crawl_result.eq.error,error_count.gt.0').limit(20)
      setCrawlFailedSites(failed || [])
      const cfg = await AppConfigApi.get('auto_crawl'); setAutoCrawlOn(cfg?.enabled !== false)
    } catch { /* テーブル未作成等は無視 */ }
  }, [])
  useEffect(() => { loadAutoCrawl() }, [loadAutoCrawl])

  async function runCrawl(only: string) {
    const { data: sess } = await supabase.auth.getSession()
    const token = sess.session?.access_token
    if (!token) { toast.error('ログインが必要です'); return }
    setCrawlBusy(only)
    try {
      const res = await fetch('/api/cron/auto-lead-crawl', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ only }) })
      const json = await res.json().catch(() => null)
      // 504等でJSONが返らない場合: 全取得元巡回は1回2取得元ずつ処理し裏で継続するため「失敗」ではなく「継続中」を案内
      if (!json) {
        if (res.status === 504 || res.status === 408 || res.status === 0) toast.info('時間切れで一部のみ実行しました（残りは次回ローテーションで自動継続）。数十秒後にもう一度押すと続きを処理します。')
        else toast.error(`巡回に失敗しました（HTTP ${res.status}）`)
      } else if (json.skipped) toast.info(json.reason || 'スキップされました')
      else if (json.ok) {
        const label = json.status === 'error' ? '巡回エラー' : json.status === 'partial' ? '一部完了' : '巡回完了'
        toast.success(`${label}(${only}): HOT-A${json.hot_a_count ?? 0}/HOT-B${json.hot_b_count ?? 0} 投入${json.cases_inserted_count ?? 0} 成功${json.success}/失敗${json.failed} (${Math.round((json.elapsedMs || 0) / 1000)}秒)`)
      } else toast.error(json.error || '巡回に失敗しました')
      loadAutoCrawl(); load()
    } catch (e) { toast.info('通信が中断しました（巡回は裏で継続します）。数十秒後に再度お試しください。' + (jpError(e) ? ` [${jpError(e)}]` : '')); loadAutoCrawl() } finally { setCrawlBusy('') }
  }
  async function toggleAutoCrawl() {
    const next = !autoCrawlOn
    try { const cur = (await AppConfigApi.get('auto_crawl')) || {}; await AppConfigApi.set('auto_crawl', { ...cur, enabled: next }); setAutoCrawlOn(next); toast.success(`自動巡回を${next ? 'ON' : 'OFF'}にしました`) } catch (e) { toast.error('変更に失敗: ' + jpError(e)) }
  }
  async function sweepHot() {
    if (!window.confirm('未投入のHOTを案件(cases)へ一括投入します。電話/住所が無いHOTはルール上HOLDへ降格、既存案件と電話重複はリンクします。実行しますか？')) return
    setCrawlBusy('sweep')
    try { const j = await regionalApi({ sweepHot: { limit: 200 } }); if (j?.ok) { toast.success(`HOT一括投入: ${j.imported}件投入 / 重複リンク${j.linkedDup} / HOLD降格${j.downgraded}（電話・住所なし）`); load(); loadAutoCrawl() } else toast.error(j?.error || '失敗') } finally { setCrawlBusy('') }
  }

  // ===== 新規取得元レジストリ =====
  const loadDiscovery = useCallback(async () => {
    const j = await regionalApi({ discoveryStatus: true })
    if (j?.ok) setDiscovery({ sources: j.sources || [], toggles: j.toggles || {}, excluded: j.excluded || [], cost: j.cost })
  }, [])
  const loadRecentImported = useCallback(async () => {
    const j = await regionalApi({ recentImported: { limit: 60 } })
    if (j?.ok) setRecentImported(j.items || [])
  }, [])
  useEffect(() => { if (mainView === 'get') { loadDiscovery(); loadRecentImported() } }, [mainView, loadDiscovery, loadRecentImported])
  async function toggleDiscovery(type: string, enabled: boolean) {
    const j = await regionalApi({ discoveryToggle: { type, enabled } })
    if (j?.ok) { setDiscovery((p) => p ? { ...p, toggles: j.toggles } : p); toast.success(`${enabled ? 'ON' : 'OFF'}にしました`) }
  }
  async function runDiscoveryOne(type: string, label: string) {
    setDiscoveryBusy(type)
    try {
      const j = await regionalApi({ runDiscovery: { sourceType: type }, settings: { aiInjectMode: settings.aiInjectMode, serperDailyCap: (settings as any).serperDailyCap ?? 50 } })
      if (j?.skipped) toast.info(`${label}: ${j.reason || '未実装（土台）のためスキップ'}`)
      else if (j?.ok) {
        const imp = j.imported ?? 0, hotB = j.hotB ?? j.hot ?? 0, det = j.detailFetched ?? j.newUrls ?? 0
        const names: string[] = Array.isArray(j.importedCases) ? j.importedCases.map((c: any) => c.name).filter(Boolean) : []
        const namePart = names.length ? `｜追加: ${names.slice(0, 5).join('、')}${names.length > 5 ? ` 他${names.length - 5}件` : ''}` : ''
        const head = imp > 0 ? `✅ ${imp}件を案件へ投入` : hotB > 0 ? `HOT-B ${hotB}件検出（電話/住所の確定待ち・未投入）` : det > 0 ? `${det}件確認したが投入条件を満たす新店なし` : '新規ヒットなし'
        toast.success(`${label}: ${head}｜詳細${det} HOT-B${hotB} HOLD${j.hold ?? 0} 除外${j.excluded ?? 0} 投入${imp}${namePart}`)
        load(); loadDiscovery(); loadRecentImported()
      }
      else toast.error(`${label}: ${j?.error || '実行に失敗しました'}`)
    } finally { setDiscoveryBusy('') }
  }
  async function recomputeSales() {
    setDiscoveryBusy('sales')
    try { const j = await regionalApi({ recomputeSales: { limit: 800, onlyHot: true } }); if (j?.ok) { toast.success(`営業優先度再計算: ${j.updated}件 / メモ${j.memos}件`); load() } else toast.error(j?.error || '失敗') } finally { setDiscoveryBusy('') }
  }

  async function autoExcludeBad() {
    if (!window.confirm('閉店/移転/廃業の疑いがある候補（投入済・HOTを除く）を一括で除外します。実行しますか？')) return
    setQualityRunning(true)
    try { const json = await regionalApi({ autoExcludeBad: { limit: 3000 } }); if (json?.ok) { toast.success(`自動除外: ${json.scanned}件走査 / ${json.excluded}件を除外（閉店/移転疑い）`); load() } else toast.error(json?.error || '除外に失敗しました') }
    finally { setQualityRunning(false) }
  }

  async function handleManualImport(c: LeadCandidate, force = false) {
    if (c.imported_to_cases) return
    const ok = await confirm({
      title: force ? '除外判定を解除して投入しますか？' : 'この候補をcasesへ投入しますか？',
      body: `${c.name}\n${c.phone_number ?? '電話番号なし'}`,
      confirmLabel: '投入する',
    })
    if (!ok) return
    try {
      await importToCase(c)
      toast.success(`「${c.name}」を案件に投入しました`)
      load()
    } catch (e) {
      toast.error('投入に失敗しました: ' + jpError(e))
    }
  }

  // モック手動実行
  async function runMock() {
    if (!isSupabaseConfigured) { toast.error('Supabase未設定です'); return }
    setRunning(true)
    try {
      const raws = generateMockLeads()
      const existingPhones = new Set(candidates.map((c) => c.phone_normalized).filter(Boolean) as string[])
      const todayImports = candidates.filter((c) => c.imported_at && moment(c.imported_at).isSame(moment(), 'day')).length

      let saved = 0, hot = 0, imported = todayImports, dup = 0, excluded = 0, hold = 0
      const createdHot: LeadCandidate[] = []

      for (const raw of raws) {
        const classified = classifyLead(raw, cases)
        // lead_candidates 内の電話重複はスキップ（再実行時の二重登録防止）
        if (classified.phone_normalized && existingPhones.has(classified.phone_normalized)) continue
        const row = await LeadCandidateApi.create({
          ...classified,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          imported_to_cases: false,
          created_by_id: user?.id ?? null,
        })
        if (!row) continue
        saved++
        if (classified.phone_normalized) existingPhones.add(classified.phone_normalized)
        if (row.lead_temperature === 'HOT') { hot++; createdHot.push(row) }
        if (row.lead_temperature === 'EXCLUDED') excluded++
        if (row.lead_temperature === 'HOLD') hold++
        if (row.duplicate_of_case_id) dup++
      }

      // HOT自動投入（設定ON＋日次上限まで）
      let autoImported = 0
      if (settings.autoImport) {
        for (const c of createdHot) {
          if (imported >= settings.dailyCap) break
          try {
            await importToCase(c)
            imported++; autoImported++
          } catch (e) {
            console.warn('[Lead import]', e)
          }
        }
      }

      await ImportBatchApi.create({
        source: 'ai_auto',
        file_name: 'AI自動投入（モック）',
        total_rows: raws.length,
        added_count: autoImported,
        duplicate_count: dup,
        error_count: excluded,
        detail: `保存${saved} / HOT${hot} / 自動投入${autoImported} / 保留${hold} / 除外${excluded}`,
        created_by_id: user?.id ?? null,
      })

      toast.success(`実行完了: 候補${saved}件保存 / HOT${hot}件 / casesへ${autoImported}件投入`)
      load()
    } catch (e) {
      toast.error('実行に失敗しました: ' + jpError(e))
    } finally {
      setRunning(false)
    }
  }

  const summary = useMemo(() => {
    const today = (c: LeadCandidate) => c.imported_at && moment(c.imported_at).isSame(moment(), 'day')
    return {
      todayImported: candidates.filter(today).length,
      hot: candidates.filter((c) => c.lead_temperature === 'HOT').length,
      hotA: candidates.filter((c) => c.lead_temperature === 'HOT' && c.hot_tier === 'A').length,
      hotB: candidates.filter((c) => c.lead_temperature === 'HOT' && c.hot_tier === 'B').length,
      hold: candidates.filter((c) => c.lead_temperature === 'HOLD').length,
      excluded: candidates.filter((c) => c.lead_temperature === 'EXCLUDED').length,
      phone: candidates.filter((c) => !!c.phone_number).length,
      address: candidates.filter((c) => !!c.address).length,
      notImported: candidates.filter((c) => !c.imported_to_cases && c.lead_temperature === 'HOT').length,
      noPhone: candidates.filter((c) => !c.phone_normalized).length,
      dup: candidates.filter((c) => c.duplicate_of_case_id).length,
      gbp: candidates.filter((c) => c.is_new_gbp).length,
      instagram: candidates.filter((c) => c.is_new_instagram).length,
      website: candidates.filter((c) => c.is_new_website).length,
      ad: candidates.filter((c) => c.is_new_ad_listing).length,
    }
  }, [candidates])
  // 取得元エラーの集計（赤アラート用）
  const sourceErrors = useMemo(() => {
    const errs: { label: string; msg: string }[] = []
    const add = (label: string, r: any) => { if (r && (r.error || r.ok === false)) errs.push({ label, msg: typeof r.error === 'string' ? r.error : 'エラーが発生しました' }) }
    add('Google Places', gpResult); add('Instagram', igResult); add('地域メディア', rmResult); add('Instagram Web検索', iwResult); add('連番URL探索', probeResult)
    return errs
  }, [gpResult, igResult, rmResult, iwResult, probeResult])

  const inSource = useCallback((c: LeadCandidate, tab: 'places' | 'instagram' | 'regional' | 'iw' | 'probe') => {
    if (tab === 'instagram') return c.lead_source === 'instagram_hashtag'
    if (tab === 'regional') return c.lead_source === 'regional_media'
    if (tab === 'iw') return c.lead_source === 'instagram_web'
    if (tab === 'probe') return c.lead_source === 'sequential_id_probe'
    return !['instagram_hashtag', 'regional_media', 'instagram_web', 'sequential_id_probe'].includes(c.lead_source || '')
  }, [])
  const sourceCandidates = useMemo(
    () => candidates.filter((c) => inSource(c, sourceTab)),
    [candidates, sourceTab, inSource],
  )
  const filtered = useMemo(
    () => (filter === 'ALL' ? sourceCandidates : sourceCandidates.filter((c) => c.lead_temperature === filter)),
    [sourceCandidates, filter],
  )
  const subFiltered = useMemo(() => {
    if (subFilter === 'all') return filtered
    return filtered.filter((c: any) => {
      if (subFilter === 'unconfirmed_hot') return c.name_unconfirmed_hot === true
      if (subFilter === 'named_hot') return c.lead_temperature === 'HOT' && !c.name_unconfirmed_hot
      if (subFilter === 'has_phone') return !!c.phone_number
      if (subFilter === 'has_addr') return !!c.address
      if (subFilter === 'opening_date') return !!c.has_opening_date_badge || !!c.has_google_opening_date
      if (subFilter === 'new_gbp') return !!c.is_new_gbp_priority || !!c.is_new_gbp
      return true
    })
  }, [filtered, subFilter])
  // 並び替え: 架電優先（callPriority降順）/ 新着（発見日降順）
  const subSorted = useMemo(() => {
    const arr = [...subFiltered]
    // 最新日時: 開店日/公開日/検出日 のうち最も新しいものでソート（HOTを上に出さず純粋に最新順）
    const newestTs = (c: any) => Math.max(
      ...[c.source_published_date, c.opening_date, c.extracted_open_date, c.regional_media_detected_at, c.first_discovered_at, c.first_seen_at, c.last_seen_at, c.created_date]
        .map((v: any) => { const t = v ? Date.parse(String(v).replace(/\//g, '-')) : NaN; return Number.isNaN(t) ? 0 : t }),
    )
    if (rankMode === 'priority') arr.sort((a: any, b: any) => callPriority(b) - callPriority(a))
    else arr.sort((a: any, b: any) => newestTs(b) - newestTs(a))
    return arr
  }, [subFiltered, rankMode])
  const visible = useMemo(() => (shown >= subSorted.length ? subSorted : subSorted.slice(0, shown)), [subSorted, shown])
  const rmSitesFiltered = useMemo(() => {
    const q = siteFilter.q.trim().toLowerCase()
    return rmSites.filter((s) => {
      if (siteFilter.status === 'active' && !s.is_active) return false
      if (siteFilter.status === 'inactive' && s.is_active) return false
      if (siteFilter.sourceType && s.source_type !== siteFilter.sourceType) return false
      if (siteFilter.parserType && (s.parser_type || '') !== siteFilter.parserType) return false
      if (q && !(`${s.name || ''} ${s.base_url || ''} ${s.list_url || ''} ${s.url_template || ''}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [rmSites, siteFilter])
  const rmSitesVisible = useMemo(() => (siteShown >= rmSitesFiltered.length ? rmSitesFiltered : rmSitesFiltered.slice(0, siteShown)), [rmSitesFiltered, siteShown])

  const card = (icon: React.ReactNode, label: string, value: number, color: string) => (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card p-2.5">
      <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', color)}>{icon}</div>
      <div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold">{value}</div>
      </div>
    </div>
  )

  const sigBadge = (on: boolean, label: string) =>
    on ? <span className="rounded-sm bg-primary/10 px-1 text-[9px] text-primary">{label}</span> : null

  // 自動投入の状態バッジ（HOT件数と投入数の整合性）
  function importStatusBadge(c: LeadCandidate) {
    if (c.imported_to_cases) return <span className="inline-flex items-center gap-0.5 text-green-600"><CheckCircle2 className="h-3 w-3" />{(c as any).imported_case_id ? '投入済' : '投入済'}</span>
    if ((c as any).auto_insert_error) return <span className="text-red-600" title={(c as any).auto_insert_error}>投入失敗</span>
    if ((c as any).auto_insert_skipped_reason) return <span className="text-amber-600" title={(c as any).auto_insert_skipped_reason}>{String((c as any).auto_insert_skipped_reason).startsWith('手動') ? '手動投入待ち' : (c as any).auto_insert_skipped_reason}</span>
    if (c.lead_temperature === 'HOT') return <span className="text-amber-600">手動投入待ち</span>
    if (c.lead_temperature === 'EXCLUDED') return <span className="text-zinc-500">EXCLUDED</span>
    return <span className="text-muted-foreground">HOLD</span>
  }

  // 補完の取得元ラベル（住所/電話をどこから取ったか）
  const enrSrcLabel = (s?: string | null): string => ({ google_places: 'Google Places', google_maps_url: 'Google Mapsリンク', official_site: '公式サイト', instagram_profile: 'IGプロフィール', snippet: '検索スニペット' } as Record<string, string>)[s || ''] || (s || '')

  // 補完結果の詳細表示（プロフィール/Maps/Places/取得元/信頼度/失敗理由）
  function renderEnrichInfo(c: LeadCandidate) {
    return (
      <>
        {c.enrichment_profile_fetched != null && <span className={cn('w-fit rounded px-1 text-[9px]', c.enrichment_profile_fetched ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700')}>プロフ{c.enrichment_profile_fetched ? '取得✓' : '取得✗'}</span>}
        {c.enriched_google_maps_url && <a href={c.enriched_google_maps_url} target="_blank" rel="noreferrer" className="w-fit rounded bg-sky-100 px-1 text-[9px] text-sky-700 hover:underline dark:bg-sky-500/20 dark:text-sky-300">Mapsリンク</a>}
        {c.enriched_phone_source && <span className="text-[9px] text-muted-foreground">電話元: {enrSrcLabel(c.enriched_phone_source)}</span>}
        {c.enriched_address_source && <span className="text-[9px] text-muted-foreground">住所元: {enrSrcLabel(c.enriched_address_source)}</span>}
        {c.enrichment_fail_reason && c.lead_temperature !== 'HOT' && <span className="line-clamp-2 text-[9px] text-amber-600 dark:text-amber-300" title={c.enrichment_fail_reason}>未取得理由: {c.enrichment_fail_reason}</span>}
      </>
    )
  }

  // HOTチェック項目のラベル（hot_check_result のキー → 日本語）
  const HOT_CHECK_LABELS: Record<string, string> = {
    has_japan: '日本国内', has_shop_name: '店名', has_industry: '業種推定', has_area: '住所/市区町村',
    has_phone: '日本の電話番号', has_newness: '新規オープン根拠', has_opening_date: 'openingDate/開業予定',
    not_chain: '非チェーン/大手/施設内', not_org: '非法人/団体', not_duplicate: '重複なし',
    review_not_many: 'Google口コミが多くない', oldest_review_recent: '最古口コミが新しい',
    has_official: '公式/Places裏取り', places_matched: 'Google Places一致',
  }
  const triMark = (v: any) => v === true ? '✅' : v === false ? '❌' : '❓'

  // HOT未達理由セル（HOLD/EXCLUDED 候補に「なぜHOTではないか」を表示）
  function renderHotReject(c: LeadCandidate) {
    if (c.lead_temperature === 'HOT') return null
    const cr: any = c.hot_check_result || {}
    const conf = cr.confidence ?? c.match_confidence ?? c.owner_reachability_score ?? null
    const req = c.hot_required_score ?? cr.hot_required_score ?? 75
    const missing: string[] = Array.isArray(c.hot_missing_requirements) ? c.hot_missing_requirements : []
    const summary = c.hot_reject_summary
    const hasData = !!summary || missing.length > 0 || Object.keys(cr).length > 0
    if (!hasData) {
      return <div className="mt-0.5 text-[9px] text-muted-foreground">理由未生成：再判定するとHOT未達理由を生成できます</div>
    }
    return (
      <div className="mt-0.5 space-y-0.5">
        <div className="flex flex-wrap items-center gap-0.5">
          <span className="rounded-sm bg-amber-100 px-1 text-[9px] font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">HOLD理由</span>
          {cr.has_phone === true && <span className="rounded-sm bg-green-100 px-1 text-[9px] text-green-700 dark:bg-green-500/20 dark:text-green-300">電話あり</span>}
          {(cr.has_area === true || cr.has_address === true) && <span className="rounded-sm bg-green-100 px-1 text-[9px] text-green-700 dark:bg-green-500/20 dark:text-green-300">住所あり</span>}
          {cr.has_opening_date === false && <span className="rounded-sm bg-rose-100 px-1 text-[9px] text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">開業日なし</span>}
          {cr.confidence_ok === false && <span className="rounded-sm bg-rose-100 px-1 text-[9px] text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">確度不足</span>}
          {cr.not_chain === null && <span className="rounded-sm bg-orange-100 px-1 text-[9px] text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">チェーン未確認</span>}
          {cr.has_official === null && <span className="rounded-sm bg-orange-100 px-1 text-[9px] text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">裏取り不足</span>}
          {conf != null && <span className="rounded-sm bg-muted px-1 text-[9px] text-muted-foreground">確度{conf} / HOT基準{req}</span>}
        </div>
        {summary && <div className="line-clamp-2 text-[10px] text-amber-700 dark:text-amber-300" title={summary}>{summary}</div>}
        {Object.keys(cr).length > 0 && (
          <details className="text-[10px]">
            <summary className="cursor-pointer text-muted-foreground">HOT判定の内訳を見る</summary>
            <div className="mt-1 grid grid-cols-1 gap-0.5 rounded border bg-muted/30 p-1.5">
              {Object.keys(HOT_CHECK_LABELS).filter((k) => k in cr).map((k) => (
                <div key={k} className="flex justify-between gap-2"><span>{triMark(cr[k])} {HOT_CHECK_LABELS[k]}</span></div>
              ))}
              <div className="mt-0.5 border-t pt-0.5 text-muted-foreground">
                確度 {conf ?? '-'} / HOT基準 {req}（{cr.confidence_ok ? '基準以上' : '基準未満'}）・最終判定: {c.lead_temperature}
              </div>
              {missing.length > 0 && <div className="text-rose-600 dark:text-rose-300">不足: {missing.join(' / ')}</div>}
              {(c.instagram_url || (c as any).source_article_url || c.official_url) && (
                <div className="truncate text-muted-foreground">元/補完: {[c.instagram_url, (c as any).source_article_url, c.official_url].filter(Boolean)[0]}</div>
              )}
              {c.ai_comment && <div className="line-clamp-2 text-muted-foreground" title={c.ai_comment}>判定: {c.ai_comment}</div>}
            </div>
          </details>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-[1400px] space-y-3">
          {/* ヘッダ */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="flex items-center gap-1.5 text-lg font-bold"><Sparkles className="h-4 w-4 text-primary" />AI投入リスト</h1>
              <p className="text-2xs text-muted-foreground">電話番号あり＋新規シグナル＋オーナー到達スコア80以上の「HOT」のみ案件へ自動投入</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowSettings((v) => !v)}>
                <Settings2 className="h-3.5 w-3.5" />設定
              </Button>
              <Button size="sm" onClick={runMock} disabled={running}>
                <Play className="h-3.5 w-3.5" />{running ? '実行中...' : '手動実行（モック）'}
              </Button>
            </div>
          </div>

          {/* エラーアラート（取得元にエラーがある時だけ） */}
          {sourceErrors.length > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
              <div className="flex items-center justify-between">
                <div className="font-bold">⚠ 取得処理でエラーがあります（{sourceErrors.length}件）</div>
                <button onClick={() => setMainView('errors')} className="rounded border border-red-400 px-2 py-0.5 text-[11px] hover:bg-red-100 dark:hover:bg-red-500/20">詳細を見る</button>
              </div>
              {sourceErrors.slice(0, 2).map((e, i) => (
                <div key={i} className="mt-0.5 line-clamp-1"><b>{e.label}</b>：{e.msg}</div>
              ))}
            </div>
          )}

          {/* ダッシュボード（営業上の主要数字のみ） */}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {[
              { label: '本日の新規投入', v: summary.todayImported, cls: 'text-green-600' },
              { label: 'HOT-A 優先架電', v: summary.hotA, cls: 'text-red-600' },
              { label: 'HOT-B 通常架電', v: summary.hotB, cls: 'text-orange-600' },
              { label: 'HOLD 確認待ち', v: summary.hold, cls: 'text-slate-600 dark:text-slate-300' },
              { label: '未投入(HOT)', v: summary.notImported, cls: 'text-amber-600' },
              { label: '電話番号あり', v: summary.phone, cls: 'text-sky-600' },
              { label: '住所あり', v: summary.address, cls: 'text-sky-600' },
              { label: 'エラー', v: sourceErrors.length, cls: sourceErrors.length ? 'text-red-600' : 'text-muted-foreground' },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border bg-card p-2 text-center">
                <div className={cn('text-xl font-bold', c.cls)}>{c.v}</div>
                <div className="text-[10px] text-muted-foreground">{c.label}</div>
              </div>
            ))}
          </div>

          {/* メインタブ */}
          <div className="flex flex-wrap gap-1 border-b pb-1">
            {([['list', '架電対象リスト'], ['triage', '統合トリアージ★'], ['get', '取得・投入'], ['manage', '取得元管理'], ['probe', '連番URL探索'], ['errors', 'エラー/ログ'], ['settings', '設定']] as const).map(([k, lbl]) => (
              <button key={k} onClick={() => { setMainView(k); if (k === 'probe') loadProbeSites() }} className={cn('rounded-t-md border-b-2 px-3 py-1.5 text-sm font-medium', mainView === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                {lbl}{k === 'errors' && sourceErrors.length > 0 ? <span className="ml-1 rounded-full bg-red-500 px-1.5 text-[10px] text-white">{sourceErrors.length}</span> : ''}
              </button>
            ))}
          </div>
          {/* タブ説明 */}
          <div className="rounded-md bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            {mainView === 'list' && '営業電話できる可能性が高い候補です。HOT-A / HOT-B を優先して確認してください。行をクリックすると詳細が開きます。'}
            {mainView === 'triage' && '全ソース横断のトリアージ画面。品質スコア/グレード・業種・都道府県・電話・重複で絞り込み、まとめて投入/除外できます。「今日の架電リスト」で重複を除いた高品質候補を即作成。CSV出力可。'}
            {mainView === 'get' && '新しい候補を各取得元（Google Places / Instagram Web / 地域メディア）から集めて、自動でHOT判定します。'}
            {mainView === 'manage' && '巡回サイト（source_sites）の管理と、新店情報サイトの自動発見・登録を行います。'}
            {mainView === 'probe' && 'じゃらん等の連番URLを確認し、新しく存在する掲載ページ（新規掲載候補）を探します。新規オープン確定ではありません。'}
            {mainView === 'errors' && '取得処理の失敗理由・APIエラー・保存失敗・文字化け・SKIP理由などを確認します。'}
            {mainView === 'settings' && 'HOT判定基準・自動投入モード/上限・API設定などを変更します。'}
          </div>

          {/* 設定パネル（設定タブ または 設定ボタン押下時） */}
          {(showSettings || mainView === 'settings') && (
            <div className="grid gap-3 rounded-xl border bg-card p-3 md:grid-cols-2 lg:grid-cols-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.placesEnabled} onChange={(e) => saveSettings({ ...settings, placesEnabled: e.target.checked })} />
                Google Places実行を有効化
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.autoImport} onChange={(e) => saveSettings({ ...settings, autoImport: e.target.checked })} />
                HOTを自動でcasesへ投入
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.autoFetch} onChange={(e) => saveSettings({ ...settings, autoFetch: e.target.checked })} />
                毎朝6:00に自動取得（Cron）
              </label>
              <div className="flex items-center md:col-span-2 lg:col-span-2">
                <Button size="sm" variant="outline" onClick={saveAutoConfig} disabled={savingCfg}>
                  {savingCfg ? '保存中...' : '自動取得設定を保存（Cronに反映）'}
                </Button>
                <span className="ml-2 text-[10px] text-muted-foreground">この設定を毎朝6:00のCronに反映します（手動実行はこの保存に関係なく即時実行）。</span>
              </div>
              {/* Google Places 全国検索モード */}
              <div className="lg:col-span-4">
                <div className="mb-1 flex items-center gap-2 text-xs font-bold text-emerald-600 dark:text-emerald-300">
                  Google Places（全国・新店系ワード検索）
                  {settings.placesNationwide && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">全国検索モード ON</span>}
                  <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-[9px] text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">openingDate重視 / FUTURE_OPENING取得 ON</span>
                </div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.placesNationwide} onChange={(e) => saveSettings({ ...settings, placesNationwide: e.target.checked })} />全国検索モード（地域/業種で絞らない）</label>
                  <div className="space-y-1"><Label>1日最大検索クエリ数</Label><Input type="number" min={1} value={settings.placesMaxQueriesPerDay} onChange={(e) => saveSettings({ ...settings, placesMaxQueriesPerDay: Math.max(1, Number(e.target.value) || 30) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1クエリ取得件数（最大20）</Label><Input type="number" min={1} max={20} value={settings.placesPerQuery} onChange={(e) => saveSettings({ ...settings, placesPerQuery: Math.max(1, Math.min(20, Number(e.target.value) || 20)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1クエリのページ取得数（最大5・nextPageToken）</Label><Input type="number" min={1} max={5} value={settings.placesPagesPerQuery ?? 3} onChange={(e) => saveSettings({ ...settings, placesPagesPerQuery: Math.max(1, Math.min(5, Number(e.target.value) || 3)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1クエリ最大件数</Label><Input type="number" min={1} max={100} value={settings.placesResultsPerQueryLimit ?? 60} onChange={(e) => saveSettings({ ...settings, placesResultsPerQueryLimit: Math.max(1, Math.min(100, Number(e.target.value) || 60)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日最大Place Details件数</Label><Input type="number" min={1} value={settings.placesMaxDetailsPerDay} onChange={(e) => saveSettings({ ...settings, placesMaxDetailsPerDay: Math.max(1, Number(e.target.value) || 100) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日あたりの投入上限</Label><Input type="number" min={1} value={settings.dailyCap} onChange={(e) => saveSettings({ ...settings, dailyCap: Math.max(1, Number(e.target.value) || 1) })} className="h-8" /></div>
                </div>
                {/* 自動投入モード（HOT_A/HOT_B）＋投入上限 */}
                <div className="mt-2 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1">
                    <Label>自動投入モード</Label>
                    <select value={settings.aiInjectMode} onChange={(e) => saveSettings({ ...settings, aiInjectMode: e.target.value as any })} className="h-8 w-full rounded border border-input bg-card px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring">
                      <option value="strict">厳格（HOT-Aのみ投入）</option>
                      <option value="standard">標準（HOT-A + HOT-B 投入）</option>
                      <option value="aggressive">攻め（HOT-A + HOT-B 投入・HOLDを上位表示）</option>
                    </select>
                  </div>
                  <div className="space-y-1"><Label>1回の自動投入上限</Label><Input type="number" min={1} value={settings.autoImportPerRun} onChange={(e) => saveSettings({ ...settings, autoImportPerRun: Math.max(1, Number(e.target.value) || 50) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日の自動投入上限</Label><Input type="number" min={1} value={settings.autoImportPerDay} onChange={(e) => saveSettings({ ...settings, autoImportPerDay: Math.max(1, Number(e.target.value) || 200) })} className="h-8" /></div>
                  <div className="flex items-end text-[10px] text-muted-foreground">自動投入は HOT-A（優先架電）+ HOT-B（通常架電）。EXCLUDEDは投入しません。電話＋住所＋新店根拠＋日本国内なら原則HOT-B以上。</div>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">※検索クエリに地域名・業種名を入れません（新店系ワードのみ全国横断）。エリア・業種は取得後に formattedAddress / primaryType から抽出。同一place_idは30日以内再取得しない。</div>
                {/* GBP登録日は取得できない旨の注意書き */}
                <div className="mt-1 rounded border border-amber-200 bg-amber-50 p-2 text-[10px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  <b>注意:</b> Google Places APIでは<b>GBP登録日そのものは取得できません</b>。openingDate・businessStatus・口コミ数・RST初回発見日などから「新店らしさ」を推定します（「GBPを作っただけ」の店舗は検索クエリだけでは拾えません）。新規GBPはInstagram Web検索・地域メディア巡回・外部補完・Google Places照合を組み合わせて補います。
                </div>
                <div className="mt-1 grid gap-2 text-[10px] md:grid-cols-2">
                  <div className="rounded border bg-green-50 p-2 dark:bg-green-500/10">
                    <div className="font-bold text-green-700 dark:text-green-300">このクエリで拾えるもの</div>
                    <ul className="ml-3 list-disc text-muted-foreground">
                      <li>開業日(openingDate)がGoogleにある店舗</li>
                      <li>オープン予定店舗（businessStatus=FUTURE_OPENING）</li>
                      <li>新店系ワードに反応する店舗</li>
                      <li>口コミが少ない店舗（0〜5件）</li>
                    </ul>
                  </div>
                  <div className="rounded border bg-zinc-50 p-2 dark:bg-zinc-800/40">
                    <div className="font-bold text-zinc-600 dark:text-zinc-300">拾えない / 弱いもの</div>
                    <ul className="ml-3 list-disc text-muted-foreground">
                      <li>GBPを作っただけの店舗（openingDate未登録）</li>
                      <li>新店文言がない店舗</li>
                      <li>投稿/口コミ/外部情報がない店舗</li>
                    </ul>
                  </div>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">判定軸: openingDateあり / FUTURE_OPENING / 口コミ0〜5件 / 電話番号あり / 住所あり / 公式サイト弱い / 新店系クエリ反応 / RST初回発見日。<b>HOT自動投入は openingDate または FUTURE_OPENING がある場合のみ</b>（無い場合は電話・住所があってもHOLD）。</div>
              </div>

              {/* 旧モード（エリア×業種）: 全国検索OFFのときのみ表示 */}
              {!settings.placesNationwide && (<>
              <div className="space-y-1">
                <Label>エリアプリセット</Label>
                <select
                  value={settings.areaPreset}
                  onChange={(e) => saveSettings({ ...settings, areaPreset: e.target.value })}
                  className="h-8 w-full rounded border border-input bg-card px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {AREA_PRESET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>1日あたり最大クエリ数</Label>
                <Input type="number" min={1} value={settings.maxQueriesPerDay} onChange={(e) => saveSettings({ ...settings, maxQueriesPerDay: Math.max(1, Number(e.target.value) || 1) })} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label>1クエリ最大取得件数（最大20）</Label>
                <Input type="number" min={1} max={20} value={settings.maxPerQuery} onChange={(e) => saveSettings({ ...settings, maxPerQuery: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} className="h-8" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.rotation} onChange={(e) => saveSettings({ ...settings, rotation: e.target.checked })} />
                ローテーション（7日以内の同一クエリは再実行しない）
              </label>
              </>)}
              <div className="space-y-1">
                <Label>HOT判定の最大口コミ数</Label>
                <Input type="number" min={0} value={settings.hotMaxReviews} onChange={(e) => saveSettings({ ...settings, hotMaxReviews: Math.max(0, Number(e.target.value) || 0) })} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label>WARM判定の最大口コミ数</Label>
                <Input type="number" min={0} value={settings.warmMaxReviews} onChange={(e) => saveSettings({ ...settings, warmMaxReviews: Math.max(0, Number(e.target.value) || 0) })} className="h-8" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.exclude100} onChange={(e) => saveSettings({ ...settings, exclude100: e.target.checked })} />
                口コミ100件以上は自動除外
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.unknownHold} onChange={(e) => saveSettings({ ...settings, unknownHold: e.target.checked })} />
                口コミ件数不明はHOLD
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground lg:col-span-2">
                <input type="checkbox" checked readOnly />
                first_seen_at だけで新規扱いしない（常時ON）
              </label>
              {!settings.placesNationwide && (<>
              <div className="space-y-1 lg:col-span-2">
                <Label>対象エリア{settings.areaPreset === 'custom' ? '（1行に1つ）' : '（プリセットで自動展開）'}</Label>
                {settings.areaPreset === 'custom' ? (
                  <Textarea value={settings.areas} onChange={(e) => saveSettings({ ...settings, areas: e.target.value })} rows={4} />
                ) : (
                  <div className="rounded border bg-muted/30 p-2 text-[10px] text-muted-foreground">
                    「{AREA_PRESET_OPTIONS.find((o) => o.value === settings.areaPreset)?.label}」の主要市区町村＋主要駅を自動展開します（毎日ローテーションで巡回）。細かいエリアの手入力は不要です。
                  </div>
                )}
              </div>
              <div className="space-y-1 lg:col-span-2">
                <Label>対象業種（1行に1つ）</Label>
                <Textarea value={settings.industries} onChange={(e) => saveSettings({ ...settings, industries: e.target.value })} rows={4} />
              </div>
              <div className="text-[10px] text-muted-foreground lg:col-span-4">
                ※（旧モード）検索クエリは「エリア × 業種」で生成されます。全国検索モードONでは新店系ワードのみで全国横断します。
              </div>
              </>)}

              {/* Instagram 設定 */}
              <div className="mt-1 border-t pt-2 lg:col-span-4">
                <div className="mb-1 text-xs font-bold text-pink-600 dark:text-pink-300">Instagram新店取得（ハッシュタグ）</div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.igEnabled} onChange={(e) => saveSettings({ ...settings, igEnabled: e.target.checked })} />
                    Instagram取得を有効化
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.igAutoImport} onChange={(e) => saveSettings({ ...settings, igAutoImport: e.target.checked })} />
                    IG単体HOT候補を自動投入（初期OFF）
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.igRequirePhone} onChange={(e) => saveSettings({ ...settings, igRequirePhone: e.target.checked })} />
                    自動投入は電話番号必須
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.igAllowWithoutPlace} onChange={(e) => saveSettings({ ...settings, igAllowWithoutPlace: e.target.checked })} />
                    Places未照合でも投入可
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.igRequireOpenWord} onChange={(e) => saveSettings({ ...settings, igRequireOpenWord: e.target.checked })} />
                    新規オープン文言必須
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.igRequireArea} onChange={(e) => saveSettings({ ...settings, igRequireArea: e.target.checked })} />
                    一都三県エリア必須
                  </label>
                  <div className="space-y-1">
                    <Label>対象投稿期間（日）</Label>
                    <Input type="number" min={1} value={settings.igPeriodDays} onChange={(e) => saveSettings({ ...settings, igPeriodDays: Math.max(1, Number(e.target.value) || 14) })} className="h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label>1日のタグ検索数（7日30まで）</Label>
                    <Input type="number" min={1} max={30} value={settings.igMaxHashtagsPerDay} onChange={(e) => saveSettings({ ...settings, igMaxHashtagsPerDay: Math.max(1, Math.min(30, Number(e.target.value) || 5)) })} className="h-8" />
                  </div>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  ※Instagramは新規シグナルとして使用。Google Places照合は必須にせず、A:Places一致HOT / B:Instagram単体HOT候補（初期は自動投入せずHOLD扱い）/ C:HOLD に分類します。自動取得はInstagram Web検索（全サイト巡回）に統合されています。
                </div>
              </div>

              {/* 地域メディア設定 */}
              <div className="mt-1 border-t pt-2 lg:col-span-4">
                <div className="mb-1 text-xs font-bold text-orange-600 dark:text-orange-300">地域メディア巡回（号外NET・埼北つうしん 等）</div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.regionalEnabled} onChange={(e) => saveSettings({ ...settings, regionalEnabled: e.target.checked })} />
                    地域メディア取得を有効化
                  </label>
                  <div className="space-y-1">
                    <Label>テスト巡回のサイト数</Label>
                    <Input type="number" min={1} value={settings.regionalMaxSites} onChange={(e) => saveSettings({ ...settings, regionalMaxSites: Math.max(1, Number(e.target.value) || 3) })} className="h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label>全サイト巡回の1バッチ数（Vercel対策）</Label>
                    <Input type="number" min={1} max={20} value={settings.regionalBatchSites ?? 8} onChange={(e) => saveSettings({ ...settings, regionalBatchSites: Math.max(1, Math.min(20, Number(e.target.value) || 8)) })} className="h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label>1サイト最大記事数</Label>
                    <Input type="number" min={1} value={settings.regionalMaxArticles} onChange={(e) => saveSettings({ ...settings, regionalMaxArticles: Math.max(1, Number(e.target.value) || 5) })} className="h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label>記事の対象期間（日）</Label>
                    <Input type="number" min={1} value={settings.regionalPeriodDays} onChange={(e) => saveSettings({ ...settings, regionalPeriodDays: Math.max(1, Number(e.target.value) || 30) })} className="h-8" />
                  </div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.regionalEnrichEnabled} onChange={(e) => saveSettings({ ...settings, regionalEnrichEnabled: e.target.checked })} />外部情報補完（電話/住所探索）</label>
                  <div className="space-y-1"><Label>1候補の補完検索数</Label><Input type="number" min={0} value={settings.regionalEnrichMaxQueries} onChange={(e) => saveSettings({ ...settings, regionalEnrichMaxQueries: Math.max(0, Number(e.target.value) || 3) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>補完1クエリ取得件数</Label><Input type="number" min={1} max={10} value={settings.regionalEnrichPerQuery} onChange={(e) => saveSettings({ ...settings, regionalEnrichPerQuery: Math.max(1, Math.min(10, Number(e.target.value) || 5)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日最大補完候補数</Label><Input type="number" min={0} value={settings.regionalEnrichDailyCap} onChange={(e) => saveSettings({ ...settings, regionalEnrichDailyCap: Math.max(0, Number(e.target.value) || 100) })} className="h-8" /></div>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  ※記事本文は保存せず、URL・タイトル・公開日・短い抜粋・抽出結果のみ保存。記事だけで電話なし/エリア不明を確定せず、店名・エリアで外部サイト/予約/公式/Instagram/Google Placesを追加調査して電話・住所を補完（IW検索と共通ロジック・1候補最大{settings.regionalEnrichMaxQueries}クエリ・1日{settings.regionalEnrichDailyCap}件）。robots.txt尊重・同一URL再取得回避。巡回対象は <code>source_sites</code> で管理。自動実行は毎朝のCron。
                </div>
              </div>

              {/* Instagram Web検索 設定（全国検索・地域/業種をクエリに入れない） */}
              <div className="mt-1 border-t pt-2 lg:col-span-4">
                <div className="mb-1 flex items-center gap-2 text-xs font-bold text-fuchsia-600 dark:text-fuchsia-300">
                  Instagram Web検索（全国・新店ハッシュタグのみ）
                  <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-[9px] text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">全国検索モード ON</span>
                </div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwEnabled} onChange={(e) => saveSettings({ ...settings, iwEnabled: e.target.checked })} />Instagram Web検索を有効化</label>
                  <div className="space-y-1">
                    <Label>検索モード</Label>
                    <select value={settings.iwSearchMode} onChange={(e) => saveSettings({ ...settings, iwSearchMode: e.target.value as any })} className="h-8 w-full rounded border border-input bg-card px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring">
                      <option value="serper_free">Serper無料向け：簡易検索のみ（推奨）</option>
                      <option value="bing_advanced">Bing向け：site:検索あり</option>
                      <option value="serper_paid">有料Serper向け：高度検索あり</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground">Serper無料枠は site:instagram.com や "完全一致" が使えません。簡易検索（例: Instagram 開業しました / #新規オープン Instagram）に自動でフォールバックします。</div>
                  </div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwAnthropic} onChange={(e) => saveSettings({ ...settings, iwAnthropic: e.target.checked })} />Anthropic判定（初期ON）</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwAutoImport} onChange={(e) => saveSettings({ ...settings, iwAutoImport: e.target.checked })} />HOT自動投入（初期ON：電話+住所+新店根拠+日本のHOT-A/HOT-Bのみ）</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwAllowNoPhone} onChange={(e) => saveSettings({ ...settings, iwAllowNoPhone: e.target.checked })} />電話番号なしでもHOT許可（初期OFF・通常は電話番号なしはHOLD）</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwRequirePhone} onChange={(e) => saveSettings({ ...settings, iwRequirePhone: e.target.checked })} />電話番号必須（初期OFF）</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwPlacesRequired} onChange={(e) => saveSettings({ ...settings, iwPlacesRequired: e.target.checked })} />Places照合必須（初期OFF）</label>
                  <div className="space-y-1"><Label>1日最大実行回数</Label><Input type="number" min={1} value={settings.iwMaxRunsPerDay} onChange={(e) => saveSettings({ ...settings, iwMaxRunsPerDay: Math.max(1, Number(e.target.value) || 4) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1回最大クエリ数（30〜50推奨）</Label><Input type="number" min={1} max={50} value={settings.iwMaxQueriesPerRun ?? 40} onChange={(e) => saveSettings({ ...settings, iwMaxQueriesPerRun: Math.max(1, Math.min(50, Number(e.target.value) || 40)), iwPerRun: Math.max(1, Math.min(50, Number(e.target.value) || 40)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日最大クエリ数（最大150）</Label><Input type="number" min={1} max={150} value={settings.iwMaxQueriesPerDay} onChange={(e) => saveSettings({ ...settings, iwMaxQueriesPerDay: Math.max(1, Math.min(150, Number(e.target.value) || 150)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1クエリ取得件数（最大20）</Label><Input type="number" min={1} max={20} value={settings.iwPerQuery} onChange={(e) => saveSettings({ ...settings, iwPerQuery: Math.max(1, Math.min(20, Number(e.target.value) || 10)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>検索プロバイダ</Label>
                    <select value={settings.iwProvider || 'serper'} onChange={(e) => saveSettings({ ...settings, iwProvider: e.target.value as any })} className="h-8 w-full rounded border border-input bg-card px-2 text-sm">
                      <option value="serper">Serper（簡易クエリ）</option><option value="bing">Bing</option><option value="both">both（簡易＋site:・重複除外）</option>
                    </select></div>
                  <div className="space-y-1"><Label>同一クエリのスキップ日数（0=毎日OK）</Label><Input type="number" min={0} value={settings.iwSameQuerySkipDays ?? 0} onChange={(e) => saveSettings({ ...settings, iwSameQuerySkipDays: Math.max(0, Number(e.target.value) || 0) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>同一URLのスキップ日数</Label><Input type="number" min={0} value={settings.iwSameUrlSkipDays ?? 7} onChange={(e) => saveSettings({ ...settings, iwSameUrlSkipDays: Math.max(0, Number(e.target.value) || 7) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日最大AI判定件数</Label><Input type="number" min={0} value={settings.iwAnthropicDailyCap} onChange={(e) => saveSettings({ ...settings, iwAnthropicDailyCap: Math.max(0, Number(e.target.value) || 100) })} className="h-8" /></div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwEnrichEnabled} onChange={(e) => saveSettings({ ...settings, iwEnrichEnabled: e.target.checked })} />外部情報補完（電話/住所探索）</label>
                  <div className="space-y-1"><Label>1候補の補完検索数</Label><Input type="number" min={0} value={settings.iwEnrichMaxQueries} onChange={(e) => saveSettings({ ...settings, iwEnrichMaxQueries: Math.max(0, Number(e.target.value) || 3) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>補完1クエリ取得件数</Label><Input type="number" min={1} max={10} value={settings.iwEnrichPerQuery} onChange={(e) => saveSettings({ ...settings, iwEnrichPerQuery: Math.max(1, Math.min(10, Number(e.target.value) || 5)) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日最大補完候補数</Label><Input type="number" min={0} value={settings.iwEnrichDailyCap} onChange={(e) => saveSettings({ ...settings, iwEnrichDailyCap: Math.max(0, Number(e.target.value) || 100) })} className="h-8" /></div>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  ※全国検索。検索クエリに<b>地域名・業種名を入れません</b>（新店系ハッシュタグ/語のみ）。地域・業種は title/snippet/url から後段で抽出（取れなければ「不明」）。Serper取得後にルールで粗選別し、新店っぽい候補のみAI判定（1日{settings.iwAnthropicDailyCap}件まで）。同一URL重複・同一クエリ7日はスキップ。HOTは初期OFFでHOLD中心に保存→画面で手動投入。自動実行は毎朝6:30 Cron。
                </div>
              </div>
            </div>
          )}

          {/* ===== 取得・投入タブ ===== */}
          {mainView === 'get' && (<>
          {/* ===== 自動巡回パネル ===== */}
          <div className="rounded-xl border-2 border-primary/40 bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">🔁 自動巡回（毎朝8時に自動＋手動でいつでも・全取得元）</span>
                <button onClick={toggleAutoCrawl} className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-bold', autoCrawlOn ? 'bg-green-500 text-white' : 'bg-zinc-300 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300')}>
                  自動巡回: {autoCrawlOn ? 'ON' : 'OFF'}
                </button>
                <button onClick={loadAutoCrawl} className="text-[10px] text-primary hover:underline">再読込</button>
              </div>
              <div className="text-[10px] text-muted-foreground">自動: JST 08:00（1日1回・Vercel Cron）／ 日中は下のボタンで手動巡回</div>
            </div>

            {/* 本日サマリー */}
            <div className="mt-2 grid grid-cols-3 gap-1.5 text-[11px] sm:grid-cols-6">
              {[['本日実行', crawlToday.runs], ['HOT-A', crawlToday.hotA], ['HOT-B', crawlToday.hotB], ['HOLD', crawlToday.hold], ['cases投入', crawlToday.inserted], ['失敗', crawlToday.errors]].map(([l, v]: any) => (
                <div key={l} className="rounded-lg bg-muted/50 px-2 py-1 text-center"><div className="text-base font-bold">{v}</div><div className="text-muted-foreground">{l}</div></div>
              ))}
            </div>

            {/* 最終/次回 */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span>最終実行: <b className="text-foreground">{crawlLast?.started_at ? moment(crawlLast.started_at).format('M/D HH:mm') : '—'}</b>{crawlLast?.status && <span className={cn('ml-1 rounded px-1', crawlLast.status === 'success' ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : crawlLast.status === 'partial' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : crawlLast.status === 'skipped' ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300' : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300')}>{crawlLast.status}</span>}</span>
              <span>取得元: 成功{crawlLast?.success_sources ?? 0}/失敗{crawlLast?.failed_sources ?? 0}</span>
              {crawlLast?.error_message && <span className="text-red-500">{String(crawlLast.error_message).slice(0, 60)}</span>}
            </div>

            {/* 取得元別の結果 */}
            {crawlItems.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                {crawlItems.map((it) => (
                  <span key={it.id} className={cn('rounded border px-1.5 py-0.5', it.status === 'success' ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-300' : it.status === 'skipped' ? 'border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' : 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300')} title={it.error_message || ''}>
                    {it.source_name}: {it.status}{it.status === 'success' ? `（取得${it.fetched_count}/HOT${it.hot_count}/投入${it.inserted_count}）` : it.error_kind ? `（${it.error_kind}）` : ''}
                  </span>
                ))}
              </div>
            )}

            {/* 実行ボタン */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => runCrawl('all')} disabled={!!crawlBusy} className="bg-primary">{crawlBusy === 'all' ? '巡回中...' : '今すぐ全サイト巡回'}</Button>
              <Button size="sm" variant="outline" onClick={() => runCrawl('failed')} disabled={!!crawlBusy}>{crawlBusy === 'failed' ? '実行中...' : '失敗分だけ再実行'}</Button>
              <Button size="sm" variant="outline" onClick={sweepHot} disabled={!!crawlBusy} className="border-emerald-500 text-emerald-700 dark:text-emerald-300">{crawlBusy === 'sweep' ? '投入中...' : '未投入HOTを一括投入'}</Button>
              <Button size="sm" variant="outline" onClick={() => runCrawl('places')} disabled={!!crawlBusy}>Google Placesだけ</Button>
              <Button size="sm" variant="outline" onClick={() => runCrawl('regional')} disabled={!!crawlBusy}>地域メディアだけ</Button>
              <Button size="sm" variant="outline" onClick={() => runCrawl('instagram')} disabled={!!crawlBusy}>Instagramだけ</Button>
              <Button size="sm" variant="outline" onClick={() => runCrawl('sequential')} disabled={!!crawlBusy}>連番URLだけ</Button>
            </div>

            {/* 失敗サイト一覧 */}
            {crawlFailedSites.length > 0 && (
              <details className="mt-2 text-[10px]">
                <summary className="cursor-pointer text-red-600">失敗サイト一覧（{crawlFailedSites.length}）— 次回巡回で優先再実行</summary>
                <ul className="mt-1 space-y-0.5">
                  {crawlFailedSites.map((s, i) => <li key={i} className="text-muted-foreground">・{s.name}（{s.source_type}）{s.last_error_type ? `: ${s.last_error_type}` : ''} {s.last_error_message ? String(s.last_error_message).slice(0, 50) : ''}</li>)}
                </ul>
              </details>
            )}
            <div className="mt-1.5 text-[10px] text-muted-foreground">※現在Hobbyプランのため自動巡回は1日1回（毎朝8時）です。日中の補充は上の手動ボタンで実行してください。2時間おきの全自動化はVercel Pro、または外部スケジューラ(cron-job.org等)から /api/cron/auto-lead-crawl?secret=CRON_SECRET を叩けば可能です。</div>
          </div>

          {/* ===== 新規取得元レジストリ（27 source_type） ===== */}
          {discovery && (
            <div className="rounded-xl border-2 border-emerald-500/40 bg-card p-3">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-bold">🧭 新規取得元（{discovery.sources.length}種）— 質の高い新規リスト自動作成</span>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  {discovery.cost && <span>本日Serper {discovery.cost.serper ?? 0}/{(settings as any).serperDailyCap ?? 50}クエリ</span>}
                  <Button size="sm" variant="outline" onClick={recomputeSales} disabled={!!discoveryBusy}>{discoveryBusy === 'sales' ? '計算中...' : '営業優先度を再計算'}</Button>
                </div>
              </div>
              <div className="mb-1 text-[10px] text-muted-foreground">電話/住所なしはHOT禁止・店名未確定でも電話+住所+新規根拠でHOT-B・日本国内のみ・大手/公共/閉店/重複は除外。検索駆動(SERP)はその場で実行、土台は外部API確認後に有効化。</div>
              {Array.from(new Set(discovery.sources.map((s: any) => s.group))).map((grp) => (
                <div key={grp} className="mt-1.5">
                  <div className="text-[10px] font-bold text-muted-foreground">{grp}</div>
                  <div className="mt-0.5 grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {discovery.sources.filter((s: any) => s.group === grp).map((s: any) => {
                      const on = discovery.toggles[s.type] !== false
                      return (
                        <div key={s.type} className="flex items-center gap-1.5 rounded border border-border/60 bg-background px-1.5 py-1 text-[10px]">
                          <button onClick={() => toggleDiscovery(s.type, !on)} className={cn('rounded-full px-1.5 py-0.5 font-bold', on ? 'bg-green-500 text-white' : 'bg-zinc-300 text-zinc-600 dark:bg-zinc-700')}>{on ? 'ON' : 'OFF'}</button>
                          <span className="flex-1 truncate" title={s.note || s.label}>{s.label}{s.mode === 'foundation' && <span className="ml-1 rounded bg-amber-100 px-1 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">土台</span>}{s.mode === 'existing' && <span className="ml-1 rounded bg-blue-100 px-1 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">既存</span>}{s.mode === 'places' && <span className="ml-1 rounded bg-emerald-100 px-1 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">Places</span>}</span>
                          {(s.mode === 'serp' || s.mode === 'places' || s.mode === 'foundation') && <button onClick={() => runDiscoveryOne(s.type, s.label)} disabled={discoveryBusy === s.type} className="rounded border border-primary px-1.5 py-0.5 text-primary hover:bg-primary/10 disabled:opacity-50">{discoveryBusy === s.type ? '実行中' : '実行'}</button>}
                          {s.type === 'portal_published_date_search' && <button onClick={runEkiten} disabled={ekitenRunning} className="rounded border border-pink-500 px-1.5 py-0.5 text-pink-700 dark:text-pink-300 disabled:opacity-50">{ekitenRunning ? '実行中' : '実行'}</button>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {discovery.excluded?.length > 0 && <div className="mt-1.5 text-[9px] text-muted-foreground">追加しない（除外指定）: {discovery.excluded.join(', ')}</div>}
            </div>
          )}

          {/* ===== 最近AI投入された案件（取得元横断・どの案件が追加されたか） ===== */}
          <div className="rounded-xl border-2 border-primary/30 bg-card p-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-bold">🆕 最近AI投入された案件（{recentImported.length}件・新しい順）</span>
              <button className="rounded border border-primary px-2 py-0.5 text-[10px] text-primary hover:bg-primary/10" onClick={loadRecentImported}>更新</button>
            </div>
            <div className="mb-1 text-[10px] text-muted-foreground">各取得元の「実行」や自動巡回で案件へ投入された店舗です。行をクリックすると案件一覧で開きます。</div>
            {recentImported.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-muted-foreground">まだ投入された案件がありません（取得元の「実行」を押すと、投入された案件がここに表示されます）</div>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded border border-border/60">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-muted/80 text-muted-foreground">
                    <tr><th className="px-1.5 py-1 text-left">店名</th><th className="px-1.5 py-1 text-left">電話</th><th className="px-1.5 py-1 text-left">住所</th><th className="px-1.5 py-1 text-left">取得元</th><th className="px-1.5 py-1 text-left">投入日時</th></tr>
                  </thead>
                  <tbody>
                    {recentImported.map((r) => (
                      <tr key={r.caseId} className="cursor-pointer border-t border-border/40 hover:bg-accent" onClick={() => { window.location.href = `/?case=${r.caseId}` }} title="案件一覧で開く">
                        <td className="px-1.5 py-1"><span className="font-medium">{r.name}</span>{r.hotTier && <span className="ml-1 rounded bg-red-200 px-1 font-bold text-red-800 dark:bg-red-500/30 dark:text-red-200">HOT-{r.hotTier}</span>}</td>
                        <td className="px-1.5 py-1 whitespace-nowrap">{r.phone || '—'}</td>
                        <td className="px-1.5 py-1 max-w-[220px] truncate" title={r.address}>{r.address || '—'}</td>
                        <td className="px-1.5 py-1 whitespace-nowrap text-muted-foreground">{r.source}</td>
                        <td className="px-1.5 py-1 whitespace-nowrap text-muted-foreground">{r.importedAt ? moment(r.importedAt).format('MM/DD HH:mm') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Google Places API パネル */}
          <div className="rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">Google Places API 連携（新規GBP）</span>
                {gpReachable === null ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">確認中…</span>
                ) : gpReachable === false ? (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-600">API未到達（関数未デプロイ?）</span>
                ) : gpConfigured ? (
                  <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-600">接続OK（キー設定済み）</span>
                ) : (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-600">未設定（GOOGLE_MAPS_API_KEY）</span>
                )}
                <button className="text-[10px] text-primary underline" onClick={checkGpStatus}>再確認</button>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => runPlaces(true)} disabled={gpRunning || gpConfigured === false} title="葛飾区×整体×5件で動作確認">
                  <Play className="h-3.5 w-3.5" />{gpRunning ? '実行中…' : 'テスト実行(葛飾区×整体×5)'}
                </Button>
                <Button size="sm" onClick={() => runPlaces(false)} disabled={gpRunning || gpConfigured !== true}>
                  <Play className="h-3.5 w-3.5" />{gpRunning ? '取得中…' : '取得・投入'}
                </Button>
                <Button size="sm" variant="outline" onClick={rejudgePlaces} disabled={gpRunning || gpConfigured !== true} title="既存Google Places候補をPlace Detailsで再取得し、openingDate最優先で再判定">
                  {gpRunning ? '再判定中…' : 'openingDate再判定（既存）'}
                </Button>
              </div>
            </div>
            {gpReachable === false && (
              <div className="mt-2 rounded-md bg-amber-50 p-2 text-2xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                <span className="font-mono">/api/leads/google-places/run</span> に到達できません。Vercelに <span className="font-mono">api/</span> の関数がデプロイされているか（最新デプロイ・本番URLか）を確認してください。ローカル(<span className="font-mono">npm run dev</span>)では関数が無いため常にこの表示になります。
              </div>
            )}
            {gpReachable === true && gpConfigured === false && (
              <div className="mt-2 rounded-md bg-amber-50 p-2 text-2xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                関数は動作していますが、サーバーに <span className="font-mono">GOOGLE_MAPS_API_KEY</span> が見えていません（長さ {gpDiag?.keyLength ?? 0}）。Vercelの Environment Variables で <b>Production</b> に <span className="font-mono">GOOGLE_MAPS_API_KEY</span> を追加し（<span className="font-mono">VITE_</span>は付けない）、<b>本番デプロイをRedeploy</b>してから「再確認」を押してください。表示中のURLが本番ドメインか（プレビューでないか）もご確認ください。
              </div>
            )}
            {gpReachable === true && (
              <div className="mt-1.5 flex flex-wrap gap-2 text-[9px] text-muted-foreground">
                <span>診断:</span>
                <span>GOOGLE_MAPS_API_KEY 長さ {gpDiag?.keyLength ?? 0}</span>
                <span>SUPABASE_URL {gpDiag?.hasSupabaseUrl ? 'あり' : 'なし'}</span>
                <span>SERVICE_ROLE {gpDiag?.hasServiceRole ? 'あり' : 'なし'}</span>
              </div>
            )}
            {gpResult && !gpResult.ok && gpResult.error && (
              <div className="mt-2 rounded-md bg-red-50 p-2 text-2xs text-red-700 dark:bg-red-500/15 dark:text-red-300">
                実行エラー: {String(gpResult.error)}
              </div>
            )}
            {gpResult && gpResult.ok && (
              <div className="mt-2 space-y-2">
                {/* 探索の内訳（item9: 175を検索クエリ数として扱わない） */}
                <div className="rounded border bg-muted/40 p-1.5 text-[10px]">
                  実行クエリ {gpResult.queries ?? 0} ・ 取得ページ {gpResult.pages ?? 0} ・ API返却 {gpResult.apiReturned ?? gpResult.fetched ?? 0}件 ・ ユニークPlaceID {gpResult.uniquePlaceIds ?? '-'} ・ 既存PlaceID {gpResult.existingPlaceIds ?? 0} ・ 再評価対象 {gpResult.reEvaluated ?? 0}
                  <span className="ml-1">／ openingDate取得 {gpResult.openingDateCount ?? 0}（開業予定{gpResult.openFuture ?? 0}/90日内{gpResult.openWithin90 ?? 0}/180日内{gpResult.openWithin180 ?? 0}）・電話あり {gpResult.phoneYes ?? 0}・新規GBP優先 {gpResult.newGbpPriority ?? 0}</span>
                  {Number(gpResult.hot ?? 0) === 0 && (
                    <div className="mt-0.5 font-bold text-amber-700 dark:text-amber-300">HOT 0件の理由: {[
                      (gpResult.openingDateCount ?? 0) === 0 ? 'openingDateあり候補が0件' : null,
                      (gpResult.reEvaluated ?? 0) === 0 && (gpResult.existingPlaceIds ?? 0) > 0 ? `既存place_idが${gpResult.existingPlaceIds}件で再評価対象外` : null,
                      Number(gpResult.detailCapped ?? 0) > 0 ? `Details上限で${gpResult.detailCapped}件後回し` : null,
                      Number(gpResult.phoneYes ?? 0) <= 1 ? `電話番号あり候補が${gpResult.phoneYes ?? 0}件のみ` : null,
                    ].filter(Boolean).join(' / ') || '電話+住所+openingDate/新店根拠を満たす候補なし'}</div>
                  )}
                </div>
                {/* 段階別カウント */}
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded bg-muted px-1.5 py-0.5">クエリ {gpResult.queries ?? 0}</span>
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">API返却 {gpResult.apiReturned ?? gpResult.fetched ?? 0}</span>
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT {gpResult.hot ?? 0}</span>
                  <span className="rounded bg-red-200 px-1.5 py-0.5 font-bold text-red-800 dark:bg-red-500/30 dark:text-red-200">HOT-A {gpResult.hotA ?? 0}</span>
                  <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">HOT-B {gpResult.hotB ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {gpResult.hold ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {gpResult.excluded ?? 0}</span>
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">DB保存 {gpResult.saved ?? 0}</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">案件投入 {gpResult.imported ?? 0}</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">重複 {gpResult.duplicate ?? 0}</span>
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話あり {gpResult.phoneYes ?? 0}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">Place Details 今回{gpResult.detailCalls ?? 0} / 本日{gpResult.debug?.reconcile?.detailToday ?? gpResult.debug?.detailsToday ?? 0}</span>
                  {Number(gpResult.skipped ?? 0) > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">SKIPPED {gpResult.skipped}</span>}
                  <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">Google開業日 {gpResult.openingDateCount ?? 0}</span>
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">開業予定 {gpResult.openFuture ?? gpResult.futureOpeningCount ?? 0}</span>
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">90日以内 {gpResult.openWithin90 ?? 0}</span>
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">180日以内 {gpResult.openWithin180 ?? 0}</span>
                  {Number(gpResult.newGbpPriority ?? 0) > 0 && <span className="rounded bg-pink-100 px-1.5 py-0.5 font-bold text-pink-700 dark:bg-pink-500/20 dark:text-pink-300">新規GBP優先 {gpResult.newGbpPriority}</span>}
                  {Number(gpResult.reviews100Excluded ?? 0) > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">口コミ100+除外 {gpResult.reviews100Excluded}</span>}
                  {Number(gpResult.reviews31Excluded ?? 0) > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">口コミ31+除外 {gpResult.reviews31Excluded}</span>}
                  {Number(gpResult.closedPermExcluded ?? 0) > 0 && <span className="rounded bg-zinc-300 px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">閉業除外 {gpResult.closedPermExcluded}</span>}
                  {Number(gpResult.dupSkip ?? 0) > 0 && <span className="rounded bg-muted px-1.5 py-0.5">30日内skip {gpResult.dupSkip}</span>}
                  {Number(gpResult.detailCapped ?? 0) > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">詳細上限skip {gpResult.detailCapped}</span>}
                  {Number(gpResult.foreignSkipped ?? 0) > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">日本国外除外 {gpResult.foreignSkipped}</span>}
                  {Number(gpResult.orgFiltered ?? 0) > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">法人/団体除外 {gpResult.orgFiltered}</span>}
                  {gpResult.debug?.stoppedEarly && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">実行時間上限で打ち切り・次回継続（残り{gpResult.debug?.deferredQueries ?? 0}クエリ）</span>}
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">最古口コミ30日内 {gpResult.oldestRecent ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">電話なし {gpResult.noPhone ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">チェーン/施設内(深掘りせず除外) {gpResult.chainExcluded ?? 0}</span>
                  {Number(gpResult.error ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">APIエラー {gpResult.error}</span>}
                  {Number(gpResult.saveError ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">保存エラー {gpResult.saveError}</span>}
                </div>

                {/* 口コミ件数の内訳 */}
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="text-muted-foreground">口コミ内訳:</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">0〜5件 {gpResult.review0_5 ?? 0}</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">6〜15件 {gpResult.review6_15 ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">16〜99件 {gpResult.review16_99 ?? 0}</span>
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">100件以上(除外) {gpResult.review100 ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">不明 {gpResult.reviewUnknown ?? 0}</span>
                </div>

                {Array.isArray(gpResult.debug?.saveErrors) && gpResult.debug.saveErrors.length > 0 && (
                  <div className="rounded-md bg-red-50 p-2 text-[10px] text-red-700 dark:bg-red-500/15 dark:text-red-300">
                    <div className="font-bold">DB書き込みエラー（投入0の原因）:</div>
                    {gpResult.debug.saveErrors.map((m: string, i: number) => <div key={i} className="truncate" title={m}>・{m}</div>)}
                    <div className="mt-0.5">→ 多くは <span className="font-mono">migrations/2026-06-27_google_places.sql</span> 未実行（google_place_id / raw_payload 等の列不足）。SQLを実行してください。</div>
                  </div>
                )}

                {/* 使用した条件・ローテーション状況 */}
                {gpResult.debug && (
                  <div className="rounded-md border bg-muted/30 p-2 text-[10px]">
                    {gpResult.debug.searchMode === 'nationwide_new_open_query'
                      ? <div>
                          <div><b>検索モード:</b> 全国・新店系ワード検索（地域/業種/「日本」をクエリに入れない） ・ 本日Place Details {gpResult.debug.detailsToday ?? 0}件</div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">languageCode: ja</span>
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">regionCode: JP</span>
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">locationRestriction: {gpResult.debug.locationRestriction ? 'ON' : 'OFF'}</span>
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">Japan country filter: {gpResult.debug.japanCountryFilter ? 'ON' : 'OFF'}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5">country=JP {gpResult.debug.japanStats?.countryJP ?? 0}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5">country≠JP {gpResult.debug.japanStats?.countryNonJP ?? 0}</span>
                            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">日本国外除外 {gpResult.debug.japanStats?.foreignSkipped ?? 0}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5">addressComponents未取得 {gpResult.debug.japanStats?.addressCompMissing ?? 0}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5">住所のみで日本判定 {gpResult.debug.japanStats?.japanByAddrOnly ?? 0}</span>
                          </div>
                        </div>
                      : <div><b>エリアプリセット:</b> {AREA_PRESET_OPTIONS.find((o) => o.value === gpResult.debug.preset)?.label || gpResult.debug.preset}（エリア {(gpResult.debug.areas || []).length} / 業種 {(gpResult.debug.industries || []).length}）</div>}
                    <div className="text-muted-foreground">
                      実行クエリ {gpResult.debug.ranQueries ?? 0}（新規オープン系 {gpResult.newOpenRan ?? 0} / 通常 {gpResult.normalRan ?? 0}）・
                      生成総数 {gpResult.debug.totalQueries ?? 0} ・ 7日内スキップ {gpResult.debug.recentSkipped ?? 0} ・ 残り {gpResult.debug.remaining ?? 0}
                    </div>
                    <div className="text-muted-foreground">
                      1クエリ{gpResult.debug.perQuery ?? '—'}件 ・ 推定API呼び出し {gpResult.debug.estApiCalls ?? '—'}回（検索{gpResult.debug.ranQueries ?? 0}＋詳細{gpResult.detailCalls ?? 0}）
                    </div>
                    {Array.isArray(gpResult.debug.queries) && (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-primary">実行クエリ一覧（{gpResult.debug.queries.length}）</summary>
                        <div className="mt-1 max-h-32 overflow-y-auto">
                          {gpResult.debug.queries.map((q: string, i: number) => <div key={i}>{i + 1}. {q}</div>)}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                {/* クエリ別の取得状況（0件の切り分け・クエリ別HOT/HOLD/EXCLUDED） */}
                {/* 集計整合性（places数 = SKIPPED + 判定対象 / 判定対象 = HOT+HOLD+EXCLUDED）*/}
                {gpResult.debug?.reconcile && (
                  <div className={cn('rounded-md border p-2 text-[10px]', gpResult.debug.reconcile.ok ? 'bg-green-50 dark:bg-green-500/10' : 'bg-amber-50 dark:bg-amber-500/10')}>
                    <div className="font-bold">集計整合性 {gpResult.debug.reconcile.ok ? '✅ 一致' : '⚠ 不一致'}</div>
                    <div className="text-muted-foreground">
                      places {gpResult.debug.reconcile.places} = SKIPPED {gpResult.debug.reconcile.skipped} + 判定対象 {gpResult.debug.reconcile.judged}　/
                      判定対象 = HOT {gpResult.debug.reconcile.hot} + HOLD {gpResult.debug.reconcile.hold} + EXCLUDED {gpResult.debug.reconcile.excluded}　/
                      DB保存 {gpResult.debug.reconcile.saved}（失敗 {gpResult.debug.reconcile.saveError}）
                    </div>
                    <div className="text-muted-foreground">
                      Place Details: 今回 {gpResult.debug.reconcile.detailThisRun} / 本日累計 {gpResult.debug.reconcile.detailToday} / 取得失敗 {gpResult.debug.reconcile.detailFailed} / 30日内skip {gpResult.dupSkip ?? 0}
                    </div>
                    <div className="font-bold text-amber-700 dark:text-amber-300">自動投入0件の理由: {gpResult.debug.autoImportDiag}</div>
                  </div>
                )}

                {/* スキップ理由の集計 */}
                {gpResult.debug?.skipReasons && Object.keys(gpResult.debug.skipReasons).length > 0 && (
                  <div className="flex flex-wrap gap-1 text-[10px]">
                    <span className="text-muted-foreground">スキップ/除外理由:</span>
                    {Object.entries(gpResult.debug.skipReasons).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]: any) => (
                      <span key={k} className="rounded bg-muted px-1.5 py-0.5">{k} {v}</span>
                    ))}
                  </div>
                )}

                {/* DB保存失敗の詳細 */}
                {Array.isArray(gpResult.debug?.saveErrorDetails) && gpResult.debug.saveErrorDetails.length > 0 && (
                  <div className="rounded-md bg-red-50 p-2 text-[10px] text-red-700 dark:bg-red-500/15 dark:text-red-300">
                    <div className="font-bold">DB保存失敗 {gpResult.debug.saveErrorDetails.length}件</div>
                    {gpResult.debug.saveErrorDetails.map((d: any, i: number) => (
                      <div key={i} className="truncate" title={d.message}>・{d.name || d.placeId || ''}: {d.message}</div>
                    ))}
                  </div>
                )}

                {Array.isArray(gpResult.debug?.queryResults) && gpResult.debug.queryResults.length > 0 && (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full min-w-[720px] text-[10px]">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="p-1 text-left">検索クエリ</th>
                          <th className="p-1 text-center">HTTP</th>
                          <th className="p-1 text-center">places</th>
                          <th className="p-1 text-center">Details</th>
                          <th className="p-1 text-center">判定</th>
                          <th className="p-1 text-center">HOT</th>
                          <th className="p-1 text-center">HOLD</th>
                          <th className="p-1 text-center">除外</th>
                          <th className="p-1 text-center">SKIP</th>
                          <th className="p-1 text-center">保存</th>
                          <th className="p-1 text-center">失敗</th>
                          <th className="p-1 text-left">主な理由</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gpResult.debug.queryResults.map((q: any, i: number) => (
                          <Fragment key={i}>
                          <tr className="border-t">
                            <td className="p-1">{q.query}</td>
                            <td className={cn('p-1 text-center font-bold', q.status === 200 ? 'text-green-600' : 'text-red-600')}>{q.status}</td>
                            <td className="p-1 text-center">{q.placesLength}</td>
                            <td className="p-1 text-center">{q.detail ?? 0}</td>
                            <td className="p-1 text-center">{q.judged ?? 0}</td>
                            <td className="p-1 text-center font-bold text-red-600">{q.hot ?? 0}</td>
                            <td className="p-1 text-center">{q.hold ?? 0}</td>
                            <td className="p-1 text-center text-muted-foreground">{q.excluded ?? 0}</td>
                            <td className="p-1 text-center text-muted-foreground">{q.skipped ?? 0}</td>
                            <td className="p-1 text-center text-green-600">{q.saved ?? 0}</td>
                            <td className={cn('p-1 text-center', q.saveError ? 'text-red-600 font-bold' : 'text-muted-foreground')}>{q.saveError ?? 0}</td>
                            <td className="max-w-[200px] truncate p-1 text-muted-foreground" title={(q.topReasons || []).join(' / ')}>{q.error ? <span className="text-red-600">{q.error}</span> : (q.topReasons || []).join(' / ') || '—'}</td>
                          </tr>
                          {Array.isArray(q.items) && q.items.length > 0 && (
                            <tr><td colSpan={12} className="p-0">
                              <details className="px-2 py-1">
                                <summary className="cursor-pointer text-[10px] text-primary">place明細を見る（{q.items.length}）</summary>
                                <div className="mt-1 overflow-x-auto">
                                  <table className="w-full min-w-[700px] text-[9px]">
                                    <thead className="text-muted-foreground"><tr>
                                      <th className="p-0.5 text-left">店名</th><th className="p-0.5 text-left">住所</th><th className="p-0.5 text-center">country</th><th className="p-0.5 text-center">日本</th><th className="p-0.5 text-left">電話</th>
                                      <th className="p-0.5 text-left">status</th><th className="p-0.5 text-left">開業日</th><th className="p-0.5 text-center">口コミ</th>
                                      <th className="p-0.5 text-center">判定</th><th className="p-0.5 text-center">保存</th><th className="p-0.5 text-left">理由/エラー</th>
                                    </tr></thead>
                                    <tbody>
                                      {q.items.map((it: any, j: number) => (
                                        <tr key={j} className="border-t">
                                          <td className="max-w-[120px] truncate p-0.5" title={it.name}>{it.name || '—'}</td>
                                          <td className="max-w-[140px] truncate p-0.5" title={it.address}>{it.address || '—'}</td>
                                          <td className={cn('p-0.5 text-center', it.isJapanPlace === false ? 'text-red-600 font-bold' : '')}>{it.country || '—'}</td>
                                          <td className="p-0.5 text-center">{it.isJapanPlace === false ? '✗' : it.isJapanPlace === true ? '✓' : '—'}</td>
                                          <td className="p-0.5">{it.phone || '—'}</td>
                                          <td className="p-0.5">{it.businessStatus || '—'}</td>
                                          <td className="p-0.5">{it.openingDate || '—'}</td>
                                          <td className="p-0.5 text-center">{it.userRatingCount ?? '—'}</td>
                                          <td className={cn('p-0.5 text-center font-bold', it.result === 'HOT' ? 'text-red-600' : it.result === 'HOLD' ? 'text-amber-600' : it.result === 'SKIPPED' ? 'text-muted-foreground' : 'text-zinc-500')}>{it.result}</td>
                                          <td className="p-0.5 text-center">{it.saved ? '✓' : (it.skip ? '—' : (it.saveError ? '✗' : '—'))}</td>
                                          <td className="max-w-[160px] truncate p-0.5 text-muted-foreground" title={it.saveError || it.skip || it.exclusion || ''}>{it.saveError ? <span className="text-red-600">{it.saveError}</span> : (it.skip || it.exclusion || '—')}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </details>
                            </td></tr>
                          )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 先頭1件のサンプル（なぜHOTにならないか） */}
                {gpResult.debug?.sample && (
                  <div className="rounded-md border bg-muted/30 p-2 text-[10px]">
                    <div className="font-bold">先頭サンプルの判定</div>
                    <div className="mt-0.5 grid gap-x-3 gap-y-0.5 md:grid-cols-2">
                      <div>店名: {gpResult.debug.sample.place?.name || '—'}</div>
                      <div>住所: {gpResult.debug.sample.place?.address || '—'}</div>
                      <div>電話: {gpResult.debug.sample.place?.nationalPhoneNumber || gpResult.debug.sample.place?.internationalPhoneNumber || '（なし）'}</div>
                      <div>primaryType: {gpResult.debug.sample.place?.primaryType || '—'}</div>
                      <div className="font-bold">口コミ数: {gpResult.debug.sample.place?.userRatingCount ?? '不明'}</div>
                      <div>最新口コミ日: {fmtDate(gpResult.debug.sample.classified?.latest_review_publish_time)}</div>
                      <div className="font-bold">一番古い口コミ日: {fmtDate(gpResult.debug.sample.classified?.oldest_review_publish_time)}</div>
                      <div className="font-bold">最古口コミから: {gpResult.debug.sample.classified?.oldest_review_days_ago ?? '—'}日前</div>
                      <div className="md:col-span-2">口コミ日付判定: {gpResult.debug.sample.classified?.review_newness_reason || '—'}</div>
                      <div>開店日(openingDate): {gpResult.debug.sample.place?.openingDate || gpResult.debug.sample.classified?.opening_date || '取得不可'}</div>
                      <div>RST初回発見からの日数: {gpResult.debug.sample.classified?.days_since_first_seen ?? 0}日</div>
                      <div>新規オープン系クエリ: <b>{String(gpResult.debug.sample.classified?.from_new_open_query)}</b></div>
                      <div>新規開業候補: <b>{String(gpResult.debug.sample.classified?.is_new_opening_candidate)}</b></div>
                      <div>温度: <b>{gpResult.debug.sample.classified?.lead_temperature}</b></div>
                      <div>到達スコア: {gpResult.debug.sample.classified?.owner_reachability_score}</div>
                      <div className="md:col-span-2">新規判定理由（HOT理由）: {gpResult.debug.sample.classified?.newness_reason || '—'}</div>
                      <div className="md:col-span-2">HOTにしなかった理由 / 除外理由: {gpResult.debug.sample.classified?.exclusion_reason || '—'}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* 自動取得（毎朝6:00 Cron）の巡回状況 */}
            <div className="mt-2 rounded-lg border bg-card p-3 text-[11px]">
              <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold">自動取得（毎朝6:00）</span>
                <span className={cn('rounded px-1.5 py-0.5 text-[10px]', settings.autoFetch ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-700')}>
                  {settings.autoFetch ? 'ON' : 'OFF'}
                </span>
                <span className="text-muted-foreground">次回実行予定: 毎朝6:00（JST）</span>
                {settings.placesNationwide ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">Places: 全国・新店系ワード検索</span> : <span className="text-muted-foreground">プリセット: {presetLabel(settings.areaPreset)}</span>}
                {lastRun && <span className="text-muted-foreground">最終実行: {moment(lastRun.created_date).format('MM/DD HH:mm')}（{lastRun.status}）</span>}
              </div>
              <div className="mb-1 flex flex-wrap gap-1.5 text-[10px]">
                <span className="rounded bg-muted px-1.5 py-0.5">今日の実行クエリ {rotationProgress.todayQueries}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">直近7日 実行クエリ {rotationProgress.skipped7d}</span>
                {!settings.placesNationwide && <span className="rounded bg-muted px-1.5 py-0.5">巡回済みエリア {rotationProgress.doneAreas} / {rotationProgress.allAreas}</span>}
                {!settings.placesNationwide && <span className="rounded bg-muted px-1.5 py-0.5">残り未巡回エリア {rotationProgress.remainingAreas}</span>}
                {lastRun && <span className="rounded bg-muted px-1.5 py-0.5">前回 取得{lastRun.fetched_count}/HOT{lastRun.hot_count}/投入{lastRun.imported_count}/除外{lastRun.excluded_count}</span>}
              </div>
              <div className={cn('grid grid-cols-2 gap-1 md:grid-cols-4', settings.placesNationwide && 'hidden')}>
                {rotationProgress.perPref.map((p) => {
                  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
                  return (
                    <div key={p.key} className="rounded border bg-muted/30 p-1.5">
                      <div className="flex justify-between"><span>{p.label}</span><span className="text-muted-foreground">{p.done}/{p.total}</span></div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted">
                        <div className="h-full rounded bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
              {lastRun?.error_message && <div className="mt-1 text-red-600">エラー: {lastRun.error_message}</div>}
              <div className="mt-1 text-[10px] text-muted-foreground">
                {settings.placesNationwide
                  ? `※ 全国・新店系ワードのみで横断検索（地域/業種をクエリに入れない）。1日最大${settings.placesMaxQueriesPerDay}クエリ・Place Details最大${settings.placesMaxDetailsPerDay}件。openingDate/businessStatusを最重視。HOTが0件の日もあります（厳格判定のため）。`
                  : `※ 一都三県の全${rotationProgress.allAreas}市区町村を、1日最大${settings.maxQueriesPerDay}クエリでローテーション巡回（7日以内の同一クエリはスキップ）。HOTが0件の日もあります（厳格判定のため）。`}
              </div>
            </div>
          </div>

          {/* Instagram新店取得 パネル */}
          <div className="rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-pink-600 dark:text-pink-300">Instagram新店取得（ハッシュタグ）</span>
                {igConfigured === null ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">確認中…</span>
                ) : igConfigured ? (
                  <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-600">接続OK（IGトークン設定済み）</span>
                ) : (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">未設定（任意）— 下の「Instagram Web検索」で代替可</span>
                )}
              </div>
              {igConfigured === false ? (
                <Button size="sm" variant="outline" onClick={runIw} disabled={iwRunning}>{iwRunning ? '検索中...' : '代わりにWeb検索を実行'}</Button>
              ) : (
                <Button size="sm" onClick={runInstagram} disabled={igRunning || !settings.igEnabled}>
                  <Sparkles className="h-3.5 w-3.5" />{igRunning ? '取得中...' : 'Instagram取得・実行'}
                </Button>
              )}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              新規オープン系ハッシュタグを毎朝6:30に巡回（7日30ユニーク制限内）。Places照合は任意。Instagram単体HOT候補は初期は自動投入せずHOLD扱い（このタブの一覧から手動投入できます）。
              {igConfigured === false && <span className="mt-0.5 block text-amber-700 dark:text-amber-300">※ハッシュタグ検索は公式Instagram API（Meta）の設定が必要です（Metaアプリ＋ビジネスアカウント＋審査）。設定不要で同等の新店候補を探すには、下の「Instagram Web検索（新店候補）」をお使いください（稼働中）。</span>}
            </div>
            {igResult && (
              <div className="mt-2 space-y-1">
                {igResult.error ? (
                  <div className="rounded bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{igResult.error}</div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-muted px-1.5 py-0.5">タグ {igResult.hashtags ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">投稿 {igResult.posts ?? 0}</span>
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">14日以内 {igResult.recent ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">抽出 {igResult.extracted ?? 0}</span>
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">Places一致 {igResult.placeMatched ?? 0}</span>
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話あり {igResult.phoneYes ?? 0}</span>
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">Google照合HOT {igResult.googleHot ?? 0}</span>
                      <span className="rounded bg-pink-100 px-1.5 py-0.5 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300">IG単体HOT候補 {igResult.igOnlyHot ?? 0}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {igResult.hold ?? 0}</span>
                      <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {igResult.excluded ?? 0}</span>
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">cases投入 {igResult.imported ?? 0}</span>
                      {Number(igResult.saveError ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">保存エラー {igResult.saveError}</span>}
                    </div>
                    {Array.isArray(igResult.debug?.hashtagResults) && (
                      <details className="rounded border bg-muted/30 p-2 text-[10px]">
                        <summary className="cursor-pointer text-primary">ハッシュタグ別取得数（{igResult.debug.hashtagResults.length}）</summary>
                        <div className="mt-1 max-h-40 overflow-y-auto">
                          {igResult.debug.hashtagResults.map((h: any, i: number) => (
                            <div key={i}>#{h.hashtag}: 投稿{h.media}/採用{h.used} ・ Google照合HOT{h.googleHot}/IG単体{h.igOnlyHot}/HOLD{h.hold}/除外{h.excluded}{h.error ? ` ・ ${h.error}` : ''}</div>
                          ))}
                        </div>
                      </details>
                    )}
                    {igResult.debug?.sample && (
                      <div className="rounded border bg-muted/30 p-2 text-[10px]">
                        <div className="font-semibold">サンプル: #{igResult.debug.sample.hashtag}（{fmtDate(igResult.debug.sample.timestamp)}）</div>
                        <div>店名: {igResult.debug.sample.extracted?.shop_name || '—'} / 業種: {igResult.debug.sample.extracted?.industry || '—'} / エリア: {igResult.debug.sample.extracted?.area || '—'}</div>
                        <div>電話: {igResult.debug.sample.extracted?.phone || '—'} / 新規文言: {igResult.debug.sample.extracted?.open_word || '—'} / Places: {igResult.debug.sample.matchedPlaceId ? `一致(${igResult.debug.sample.matchConfidence})` : '未照合'}</div>
                        <div>判定: <b>{igResult.debug.sample.verdict?.classification}</b> ・ {igResult.debug.sample.verdict?.reason}</div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* 地域メディア巡回 パネル */}
          <div className="rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-orange-600 dark:text-orange-300">地域メディア巡回（新店記事）</span>
                {rmConfigured === null ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">確認中…</span>
                ) : rmConfigured ? (
                  <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-600">有効サイト {rmDiag?.activeSites ?? 0}件</span>
                ) : (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600">有効サイトなし</span>
                )}
                <button onClick={checkRmStatus} className="text-[10px] text-primary hover:underline">再確認</button>
                {rmDiag && (rmDiag.renderConfigured
                  ? <span className="rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] text-purple-600 dark:text-purple-300">JSレンダリング: {rmDiag.renderProvider || 'ON'}</span>
                  : <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] text-zinc-500" title="SCRAPINGBEE_API_KEY 未設定">JSレンダリング: 未設定</span>)}
              </div>
              <Button size="sm" onClick={() => runRegionalAll(false)} disabled={rmRunning || !settings.regionalEnabled}>
                <Store className="h-3.5 w-3.5" />{rmRunning ? '巡回中...' : '全サイト巡回'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => runRegionalAll(true)} disabled={rmRunning || !settings.regionalEnabled}>優先サイト巡回</Button>
              <Button size="sm" variant="outline" onClick={() => runRegional('test')} disabled={rmRunning || !settings.regionalEnabled}>テスト巡回（3件）</Button>
              <Button size="sm" variant="outline" onClick={runRegionalFailed} disabled={rmRunning || rmFailedSites.length === 0}>失敗サイトだけ再巡回{rmFailedSites.length ? `（${rmFailedSites.length}）` : ''}</Button>
              <Button size="sm" variant="outline" onClick={runDiscovery} disabled={discovering}>{discovering ? '発見中...' : '巡回サイトを自動発見'}</Button>
              <Button size="sm" variant="outline" onClick={loadCandidates}>発見候補を確認</Button>
            </div>
            {/* 全サイト巡回 進捗 */}
            {rmProgress && (
              <div className="mt-2 rounded-lg border bg-card p-2 text-[11px]">
                <div className="mb-1 font-semibold">{rmProgress.running ? `全サイト巡回中：${rmProgress.processed} / ${rmProgress.total}サイト完了` : `全サイト巡回完了：${rmProgress.processed} / ${rmProgress.total}サイト`}</div>
                <div className="mb-1 h-1.5 w-full overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${rmProgress.total ? Math.min(100, Math.round((rmProgress.processed / rmProgress.total) * 100)) : 0}%` }} /></div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">成功 {rmProgress.success}</span>
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">失敗 {rmProgress.failed}</span>
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">HOT {rmProgress.hot}（A{rmProgress.hotA}/B{rmProgress.hotB}）</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {rmProgress.hold}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {rmProgress.excluded}</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">案件投入 {rmProgress.imported}</span>
                  {rmProgress.running && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">残り {rmProgress.remaining ?? 0}サイト</span>}
                </div>
                {rmFailedSites.length > 0 && !rmProgress.running && (
                  <div className="mt-1 text-[10px] text-muted-foreground">失敗: {rmFailedSites.map((f) => `${f.name}(${f.reason})`).join(' / ').slice(0, 200)}</div>
                )}
              </div>
            )}
            {/* 巡回サイト自動発見 結果＋候補 */}
            {(discoveryResult || siteCandidates.length > 0) && (
              <div className="mt-2 rounded-lg border bg-card p-2 text-[10px]">
                <div className="mb-1 font-semibold">巡回サイト自動発見</div>
                {discoveryResult && (
                  <div className="mb-1 flex flex-wrap gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5">クエリ {discoveryResult.queries}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5">URL {discoveryResult.urls}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5">診断 {discoveryResult.tested}</span>
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">自動登録 {discoveryResult.autoRegistered}</span>
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">要確認 {discoveryResult.review}</span>
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">無視 {discoveryResult.ignore}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5">登録済 {discoveryResult.alreadyRegistered}</span>
                  </div>
                )}
                {siteCandidates.length > 0 && (
                  <div className="max-h-72 space-y-1 overflow-y-auto">
                    {siteCandidates.map((c: any) => (
                      <div key={c.id} className="flex items-start justify-between gap-2 border-b pb-0.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className={cn('rounded px-1 text-[9px] font-bold', c.recommended_action === 'auto_register' ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : c.recommended_action === 'review' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700')}>{c.recommended_action}</span>
                            <span className="rounded bg-indigo-100 px-1 text-[9px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">{c.detected_parser_type}</span>
                            <span className="font-medium">スコア{c.confidence_score}</span>
                            <span className="truncate text-muted-foreground" title={c.discovered_url}>{c.domain}</span>
                            {c.already_registered && <span className="text-[9px] text-muted-foreground">登録済</span>}
                          </div>
                          <div className="truncate text-muted-foreground" title={c.title}>{c.title}</div>
                          <div className="text-muted-foreground">新店語{c.newness_keyword_count} ・ 記事{c.article_link_count} ・ カード{c.shop_card_count} ・ 電話{c.phone_found_count} ・ 住所{c.address_found_count}{c.invalid_reason ? ` ・ ${c.invalid_reason}` : ''}</div>
                        </div>
                        {!c.is_registered && !c.already_registered && c.recommended_action !== 'ignore' && (
                          <button onClick={() => registerCandidate(c.id)} className="shrink-0 rounded border border-primary px-1.5 py-0.5 text-[9px] text-primary hover:bg-primary/10">登録</button>
                        )}
                        {c.is_registered && <span className="shrink-0 text-[9px] text-green-600">登録済</span>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-muted-foreground">※ 検索APIで新店情報サイトを自動発見し診断。スコア80以上は自動登録（信頼度70以上で有効化）、50〜79は要確認、49以下は無視。海外/求人/EC/ログイン必須/本文空は除外。</div>
              </div>
            )}
            <div className="mt-1 text-[10px] text-muted-foreground">
              号外NET・埼北つうしん等の開店記事を巡回。記事本文は保存しません（URL/タイトル/公開日/抜粋/抽出のみ）。電話が取れHOT条件を満たすものだけ自動投入、他はHOLD/EXCLUDED。
            </div>
            {rmDiag && (
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                <span className="rounded bg-muted px-1.5 py-0.5">source_sites 総数 {rmDiag.totalSites ?? '—'}</span>
                <span className={cn('rounded px-1.5 py-0.5', (rmDiag.activeSites ?? 0) > 0 ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300')}>有効 {rmDiag.activeSites ?? '—'}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">DB: {rmDiag.projectRef ?? '不明'}</span>
                <span className={cn('rounded px-1.5 py-0.5', rmDiag.hasRole ? 'bg-muted' : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300')}>ServiceRole {rmDiag.hasRole ? 'OK' : '未設定'}</span>
                <span className={cn('rounded px-1.5 py-0.5', rmDiag.hasMapsKey ? 'bg-muted' : 'bg-amber-100 text-amber-700')}>Mapsキー {rmDiag.hasMapsKey ? 'OK' : 'なし(照合不可)'}</span>
                {rmDiag.error && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">エラー: {String(rmDiag.error).slice(0, 160)}</span>}
                {(rmDiag.totalSites ?? 0) > 0 && (rmDiag.activeSites ?? 0) === 0 && <span className="text-muted-foreground">→ source_sites に is_active=true の行がありません（または別Supabaseプロジェクト）。</span>}
                {rmDiag.totalSites === 0 && <span className="text-muted-foreground">→ このDBに source_sites の行が0件です。migrations/2026-06-28_regional_media.sql の実行先プロジェクトと、Vercelの SUPABASE_URL（{rmDiag.projectRef ?? '不明'}）が一致しているか確認してください。</span>}
              </div>
            )}
            {rmResult && (
              <div className="mt-2 space-y-1">
                {rmResult.error ? (
                  <div className="rounded bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{rmResult.error}</div>
                ) : (
                  <>
                    <div className="rounded border border-amber-200 bg-amber-50 p-1.5 text-[10px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                      ※ 連番URL探索は各サイト上で新しく存在を確認できた掲載ページ（<b>新規掲載候補</b>）を検出します。<b>新規オープンを保証するものではありません</b>。営業前に電話番号・住所・業種・新規性を確認してください。
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-muted px-1.5 py-0.5">巡回サイト {rmResult.sites ?? 0}</span>
                      {(Number(rmResult.hotA ?? 0) > 0 || Number(rmResult.hotB ?? 0) > 0) && <span className="rounded bg-red-200 px-1.5 py-0.5 font-bold text-red-800 dark:bg-red-500/30 dark:text-red-200">HOT-A {rmResult.hotA ?? 0} / HOT-B {rmResult.hotB ?? 0}</span>}
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">新規記事 {rmResult.newArticles ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">候補 {rmResult.candidates ?? 0}</span>
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">Places一致 {rmResult.placeMatched ?? 0}</span>
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話あり {rmResult.phoneYes ?? 0}</span>
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT {rmResult.hot ?? 0}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {rmResult.hold ?? 0}</span>
                      <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {rmResult.excluded ?? 0}</span>
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">cases新規投入 {rmResult.imported ?? 0}</span>
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">既存投入済 {rmResult.alreadyImported ?? 0}</span>
                      {Number(rmResult.manualPending ?? 0) > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">手動投入待ち {rmResult.manualPending}</span>}
                      {Number(rmResult.importFailed ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">投入失敗 {rmResult.importFailed}</span>}
                      {Number(rmResult.saveError ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">保存エラー {rmResult.saveError}</span>}
                      <span className="rounded bg-muted px-1.5 py-0.5">詳細取得 {rmResult.detailFetches ?? 0}/{rmResult.debug?.maxDetailFetches ?? 20}</span>
                      {Number(rmResult.timeouts ?? 0) > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">タイムアウト {rmResult.timeouts}</span>}
                      {(Number(rmResult.deferredSites ?? 0) > 0 || Number(rmResult.deferredDetails ?? 0) > 0) && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">次回継続 サイト{rmResult.deferredSites ?? 0}/詳細{rmResult.deferredDetails ?? 0}</span>}
                    </div>
                    {/* HOT件数と案件投入の整合性 */}
                    {rmResult.debug?.importReconcile && (
                      <div className={cn('rounded-md border p-2 text-[10px]', rmResult.debug.importReconcile.ok ? 'bg-green-50 dark:bg-green-500/10' : 'bg-amber-50 dark:bg-amber-500/10')}>
                        <div className="font-bold">HOT判定と案件投入の整合性 {rmResult.debug.importReconcile.ok ? '✅ 一致' : '⚠ 不一致'}</div>
                        <div className="text-muted-foreground">
                          今回HOT判定 {rmResult.debug.importReconcile.hot}（HOT-A {rmResult.hotA ?? 0} / HOT-B {rmResult.hotB ?? 0}） =
                          新規投入 {rmResult.debug.importReconcile.newImport} + 既存投入済 {rmResult.debug.importReconcile.alreadyImported} + 手動投入待ち {rmResult.debug.importReconcile.manualPending} + 投入失敗 {rmResult.debug.importReconcile.importFailed}
                        </div>
                        <div className="text-muted-foreground">※「cases新規投入」は今回新しく作成された案件数です（既存投入済は前回までに案件化済み）。</div>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">補完検索 {rmResult.enrichQueries ?? 0}回</span>
                      <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">補完実行 {rmResult.enrichTried ?? 0}</span>
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">補完成功 {rmResult.enrichSucceeded ?? 0}</span>
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話取得 {rmResult.enrichPhone ?? 0}</span>
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">住所取得 {rmResult.enrichAddress ?? 0}</span>
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">補完残枠 {rmResult.debug?.enrichBudget ?? '-'}</span>
                      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">推定Serper ¥{rmResult.debug?.estSerperCost ?? 0}</span>
                    </div>
                    {Array.isArray(rmResult.debug?.siteResults) && (
                      <details className="rounded border bg-muted/30 p-2 text-[10px]" open>
                        <summary className="cursor-pointer text-primary">サイト別診断（{rmResult.debug.siteResults.length}）</summary>
                        <div className="mt-1 max-h-56 space-y-1 overflow-y-auto">
                          {rmResult.debug.siteResults.map((h: any, i: number) => (
                            <div key={i} className="border-b pb-0.5">
                              <div className="font-medium">{h.site}{' '}
                                {h.deferred && <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">次回継続</span>}{' '}
                                {!h.deferred && <span className="rounded bg-indigo-100 px-1 text-[9px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">{h.parserType === 'local_directory_new_listing' ? '店舗ディレクトリ型' : h.parserType === 'marketplace_listing' ? 'マーケットプレイス型' : h.parserType === 'sequential_id_probe' ? '連番URL探索型' : h.parserType === 'generic_page_text_scan' ? '汎用本文スキャン' : '記事型'}{h.parser_used ? `（${h.parser_used}）` : ''}</span>}{' '}
                                {!h.deferred && <span className={cn(h.fetchOk ? 'text-green-600' : 'text-red-600')}>{h.fetchOk ? 'fetch✓' : 'fetch✗'} HTTP{h.status ?? '-'}</span>}
                                {Number(h.timeouts ?? 0) > 0 && <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">timeout{h.timeouts}</span>}</div>
                              {!h.deferred && (h.siteType === 'sequential_id_probe' ? (
                                <div className="text-muted-foreground">連番探索 ID{h.idRange ?? '-'} ・ probed{h.probed ?? 0} ・ <b>valid{h.valid ?? 0}</b>/invalid{h.invalid ?? 0} ・ 最終found ID{h.lastFoundId ?? '-'} ・ 連続not_found{h.consecutiveNotFound ?? 0} ・ 保存{h.saved ?? 0} ・ HOT-A{h.hotA ?? 0}/HOT-B{h.hotB ?? 0}/HOLD{h.hold ?? 0}/除外{h.excluded ?? 0}</div>
                              ) : h.siteType === 'local_directory_new_listing' ? (
                                <div className="text-muted-foreground">HTML{h.htmlLength ?? 0}字 ・ 全リンク{h.totalLinks ?? 0} ・ <b>店舗詳細リンク{h.detailLinks ?? 0}</b> ・ OPEN表記{h.openTagged ?? 0} ・ 詳細取得{h.detailFetched ?? 0} ・ 電話取得{h.phoneYes ?? 0} ・ 住所取得{h.addressYes ?? 0} ・ OPEN日{h.openYes ?? 0} ・ 保存{h.saved ?? 0} ・ HOT{h.hot ?? 0}/HOLD{h.hold ?? 0}/除外{h.excluded ?? 0}</div>
                              ) : (h.siteType === 'marketplace_listing' || h.siteType === 'generic_page_text_scan') ? (
                                <div className="text-muted-foreground">HTML{h.htmlLength ?? 0}字 ・ 本文{h.bodyTextLen ?? 0}字 ・ 全リンク{h.totalLinks ?? 0} ・ ブロック{h.blockCount ?? 0} ・ <b>店舗カード候補{h.cardCandidates ?? 0}</b> ・ 新店語一致{h.keywordBlocks ?? 0} ・ 新規バッジ{h.newBadge ?? 0} ・ 詳細リンク{h.detailLinks ?? 0} ・ 詳細取得{h.detailFetched ?? 0} ・ 電話{h.phoneYes ?? 0}/住所{h.addressYes ?? 0}/OPEN{h.openYes ?? 0} ・ 保存{h.saved ?? 0} ・ HOT{h.hot ?? 0}/HOLD{h.hold ?? 0}/除外{h.excluded ?? 0}{h.jsLikely ? ' ・ ⚠JSレンダリングの可能性' : ''}</div>
                              ) : (
                                <div className="text-muted-foreground">HTML{h.htmlLength ?? 0}字 ・ 全リンク{h.totalLinks ?? 0} ・ 記事候補{h.candidateLinks ?? 0} ・ 新店語一致{h.keywordHits ?? 0} ・ 新着{h.newArticles ?? 0} ・ 3日内{h.recent ?? 0} ・ 保存{h.saved ?? 0} ・ HOT{h.hot ?? 0}/HOLD{h.hold ?? 0}/除外{h.excluded ?? 0}</div>
                              ))}
                              {h.reason && h.reason !== 'OK' && <div className="text-amber-600">理由: {h.reason}</div>}
                              {h.error && <div className="text-red-600">エラー: {h.error}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {rmResult.debug?.sample && (
                      <div className="rounded border bg-muted/30 p-2 text-[10px]">
                        <div className="font-semibold">サンプル: {rmResult.debug.sample.site}</div>
                        {rmResult.debug.sample.siteType === 'local_directory_new_listing' ? (
                          <>
                            <div className="truncate">店舗: <b>{rmResult.debug.sample.shop_name}</b>{rmResult.debug.sample.open_date ? `（${rmResult.debug.sample.open_date}）` : ''}</div>
                            <div>電話: {rmResult.debug.sample.phone || '—'} / 住所: {rmResult.debug.sample.address || '—'} / 業種: {rmResult.debug.sample.industry || '—'}</div>
                            <div className="truncate">詳細URL: {rmResult.debug.sample.detailUrl}</div>
                            <div>判定: <b>{rmResult.debug.sample.temperature}</b> ・ {rmResult.debug.sample.reason}</div>
                          </>
                        ) : (
                          <>
                            <div className="truncate">{rmResult.debug.sample.title}（{fmtDate(rmResult.debug.sample.published_at)}）</div>
                            <div>店名: {rmResult.debug.sample.extracted?.shop_name || '—'} / エリア: {rmResult.debug.sample.extracted?.area || '—'} / 業種: {rmResult.debug.sample.extracted?.industry || '—'} / 電話: {rmResult.debug.sample.extracted?.phone || '—'}</div>
                            <div>判定: <b>{rmResult.debug.sample.temperature}</b> ・ {rmResult.debug.sample.reason}</div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Instagram Web検索 パネル */}
          <div className="rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-fuchsia-600 dark:text-fuchsia-300">Instagram Web検索（新店候補）</span>
                {iwConfigured === null ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">確認中…</span>
                  : iwConfigured ? <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-600">接続OK（{iwDiag?.provider || '検索'}）</span>
                  : <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-600">未設定（検索APIキー/Supabase）</span>}
                <button onClick={checkIwStatus} className="text-[10px] text-primary hover:underline">再確認</button>
              </div>
              <Button size="sm" onClick={runIw} disabled={iwRunning || !settings.iwEnabled}>
                <Sparkles className="h-3.5 w-3.5" />{iwRunning ? '検索中...' : 'Instagram Web検索・実行'}
              </Button>
            </div>
            {iwDiag && (
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                <span className="rounded bg-muted px-1.5 py-0.5">検索: {iwDiag.provider || 'なし'}</span>
                <span className={cn('rounded px-1.5 py-0.5', iwDiag.serper?.hasKey || iwDiag.bing?.hasKey ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300')}>Serper{iwDiag.serper?.hasKey ? `✓(${iwDiag.serper.keyLength})` : '✗'}/Bing{iwDiag.bing?.hasKey ? '✓' : '✗'}</span>
                <span className={cn('rounded px-1.5 py-0.5', iwDiag.anthropic?.hasKey ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-amber-100 text-amber-700')}>Anthropic{iwDiag.anthropic?.hasKey ? `✓(${iwDiag.anthropic.prefix}…)` : '✗→ルール判定'}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">Maps {iwDiag.googleMaps?.hasKey ? '✓' : '—'}</span>
                {iwDiag.error && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">{iwDiag.error}</span>}
              </div>
            )}
            <div className="mt-1 text-[10px] text-muted-foreground">全国・新店ハッシュタグのみ（地域/業種をクエリに入れない）。ルール粗選別→新店候補のみAI判定。HOTは初期OFFでHOLD中心保存→手動投入。同一URL重複・同一クエリ7日はスキップ。</div>
            {iwResult && (
              <div className="mt-2 space-y-1">
                {(iwResult.queryReport || iwResult.debug?.queryReport) && (
                  <div className="rounded border bg-muted/40 p-1.5 text-[10px] text-muted-foreground">クエリ実行状況: {iwResult.queryReport || iwResult.debug?.queryReport}</div>
                )}
                {iwResult.ok === false ? (
                  <div className="rounded bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                    <div className="font-bold">Instagram Web検索でエラーが発生しました</div>
                    <div>{String(iwResult.error || 'エラー詳細が取得できませんでした')}</div>
                    <div className="mt-1 text-[10px] opacity-80">
                      {iwResult.failed_step && <div>failed_step: {iwResult.failed_step}</div>}
                      {iwResult.api_endpoint && <div>api_endpoint: {iwResult.api_endpoint}</div>}
                      {iwResult.error_message && <div className="line-clamp-3">error_message: {iwResult.error_message}</div>}
                      {Array.isArray(iwResult.debug?.searchErrors) && iwResult.debug.searchErrors.length > 0 && (
                        <div>検索エラー: {iwResult.debug.searchErrors.map((s: any) => `${s.provider} ${s.detail}`).join(' / ').slice(0, 200)}</div>
                      )}
                    </div>
                  </div>
                )
                : iwResult.skipped ? <div className="rounded bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{iwResult.reason}</div> : (
                  <>
                    {Number(iwResult.fallback ?? 0) > 0 && (
                      <div className="rounded bg-sky-50 p-1.5 text-[10px] text-sky-800 dark:bg-sky-500/10 dark:text-sky-300">
                        Serper無料枠では高度な検索式が使えないため、簡易検索に切り替えました（{iwResult.fallback}件）。
                        {Array.isArray(iwResult.debug?.searchFallbacks) && iwResult.debug.searchFallbacks[0] && <div className="opacity-80">例）元: {iwResult.debug.searchFallbacks[0].from} → 再実行: {iwResult.debug.searchFallbacks[0].to}</div>}
                      </div>
                    )}
                    {iwResult.error && <div className="rounded bg-amber-50 p-1.5 text-[10px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">一部の検索でエラー（{iwResult.errorCount ?? 0}件）: {String(iwResult.error)}</div>}
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-muted px-1.5 py-0.5">クエリ {iwResult.queries ?? 0}</span>
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">Serper取得 {iwResult.results ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">IG URL {iwResult.igUrls ?? 0}</span>
                      <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">ルール通過 {iwResult.rulePassed ?? 0}</span>
                      <span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">AI判定 {iwResult.judged ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">ルール判定 {iwResult.heuristicUsed ?? 0}</span>
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT {iwResult.hot ?? 0}</span>
                      <span className="rounded bg-red-200 px-1.5 py-0.5 font-bold text-red-800 dark:bg-red-500/30 dark:text-red-200">HOT-A {iwResult.hotA ?? 0}</span>
                      <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">HOT-B {iwResult.hotB ?? 0}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {iwResult.hold ?? 0}</span>
                      <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {iwResult.excluded ?? 0}</span>
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">投入 {iwResult.imported ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">重複skip {iwResult.dup ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">事前除外 {iwResult.preExcluded ?? 0}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">地域抽出 {iwResult.areaKnown ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">地域不明 {iwResult.areaUnknown ?? 0}</span>
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">業種抽出 {iwResult.industryKnown ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">業種不明 {iwResult.industryUnknown ?? 0}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">補完検索 {iwResult.enrichQueries ?? 0}回</span>
                      <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">補完実行 {iwResult.enrichTried ?? 0}</span>
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">補完成功 {iwResult.enrichSucceeded ?? 0}</span>
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話取得 {iwResult.enrichPhone ?? 0}</span>
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">住所取得 {iwResult.enrichAddress ?? 0}</span>
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">補完残枠 {iwResult.debug?.enrichBudget ?? '-'}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">本日実行 {iwResult.debug?.runsToday ?? '-'}回</span>
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">本日クエリ {iwResult.debug?.queriesToday ?? 0}</span>
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">クエリ定義 {iwResult.debug?.querySetSize ?? 0}件</span>
                      {iwResult.debug?.pickedTiers && (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300" title="今回実行クエリの優先度内訳（S:新規オープン確定 / A:開業前兆 / B:業種別 / C:前兆シグナル）">優先度 S{iwResult.debug.pickedTiers.S ?? 0}/A{iwResult.debug.pickedTiers.A ?? 0}/B{iwResult.debug.pickedTiers.B ?? 0}/C{iwResult.debug.pickedTiers.C ?? 0}</span>
                      )}
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">AI残枠 {iwResult.debug?.anthropicBudget ?? '-'}</span>
                      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">推定Serper ¥{iwResult.debug?.estSerperCost ?? 0}</span>
                      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">推定AI ¥{iwResult.debug?.estAnthropicCost ?? 0}</span>
                      <span className="rounded bg-rose-200 px-1.5 py-0.5 font-bold text-rose-800 dark:bg-rose-500/30 dark:text-rose-200">推定合計 ¥{iwResult.debug?.estTotalCost ?? 0}</span>
                    </div>
                    {Array.isArray(iwResult.debug?.queryResults) && (
                      <details className="rounded border bg-muted/30 p-2 text-[10px]" open>
                        <summary className="cursor-pointer text-primary">実行クエリ別（{iwResult.debug.queryResults.length}）※地域名・業種名は入っていません</summary>
                        <div className="mt-1 max-h-48 overflow-y-auto">
                          {iwResult.debug.queryResults.map((q: any, i: number) => (
                            <div key={i} className="border-b py-0.5">
                              <div className="truncate font-mono">{q.query}</div>
                              <div className="text-muted-foreground">取得{q.results}/IG{q.igUrls}/ルール通過{q.rulePassed}/AI{q.judged}/ルール{q.heuristic} ・ HOT{q.hot}/HOLD{q.hold}/除外{q.excluded} ・ 地域{q.areaKnown}(不明{q.areaUnknown})/業種{q.industryKnown}(不明{q.industryUnknown}){q.error ? ` ・ ${q.error}` : ''}</div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          </>)}

          {/* ===== 架電対象リストタブ（集計カード〜サブタブ） ===== */}
          {mainView === 'list' && (<>
          {/* 集計カード */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
            {card(<Upload className="h-4 w-4 text-white" />, '本日の自動投入', summary.todayImported, 'bg-primary')}
            {card(<Flame className="h-4 w-4 text-white" />, 'HOT件数', summary.hot, 'bg-red-500')}
            {card(<PhoneOff className="h-4 w-4 text-white" />, '電話なし保留', summary.noPhone, 'bg-slate-500')}
            {card(<CopyIcon className="h-4 w-4 text-white" />, '重複除外', summary.dup, 'bg-zinc-500')}
            {card(<MapPin className="h-4 w-4 text-white" />, '新規GBP', summary.gbp, 'bg-emerald-500')}
            {card(<Sparkles className="h-4 w-4 text-white" />, '新規Instagram', summary.instagram, 'bg-pink-500')}
            {card(<Building2 className="h-4 w-4 text-white" />, '新規HP', summary.website, 'bg-sky-500')}
            {card(<Store className="h-4 w-4 text-white" />, '新規広告', summary.ad, 'bg-amber-500')}
          </div>

          {/* ソース切替（Google Places / Instagram / 地域メディア） */}
          <div className="flex gap-1">
            {([['places', 'Google Places'], ['instagram', 'Instagram'], ['regional', '地域メディア'], ['iw', 'Instagram Web検索'], ['probe', '連番URL探索']] as const).map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => { setSourceTab(k); if (k === 'probe') loadProbeSites() }}
                className={cn('rounded-md border px-3 py-1 text-xs font-medium', sourceTab === k ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent')}
              >
                {lbl}（{candidates.filter((c) => inSource(c, k)).length}）
              </button>
            ))}
          </div>
          </>)}

          {/* ===== 連番URL探索タブ ===== */}
          {mainView === 'probe' && (
            <div className="mt-2 space-y-2 rounded-lg border bg-card p-3 text-xs">
              <div className="rounded border border-amber-200 bg-amber-50 p-1.5 text-[10px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                ※ 連番URL探索は、各サイト上で新しく存在確認できた掲載ページ（<b>新規掲載候補</b>）を検出する機能です。<b>実際の開業日を保証するものではありません</b>。営業投入前に電話番号・住所・業種・新規性を確認してください。
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={runProbeAll} disabled={probing}>{probing ? '探索中...' : '全ソースを探索（前回の続きから）'}</Button>
                <Button size="sm" variant="outline" onClick={openAddProbe}>＋ 連番ソースを追加</Button>
                <Button size="sm" variant="outline" onClick={runEkiten} disabled={ekitenRunning} className="border-pink-500 text-pink-700 dark:text-pink-300">{ekitenRunning ? 'エキテン探索中...' : 'エキテン新規掲載候補（公開日7日内）'}</Button>
                <button onClick={loadProbeSites} className="text-[10px] text-primary hover:underline">再読込</button>
                <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground"><input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />開発者モード（source_id等を表示）</label>
              </div>
              {/* 有効ソース0件の警告 */}
              {probeSites.length > 0 && probeSites.filter((x: any) => x.is_active).length === 0 && (
                <div className="rounded border border-red-300 bg-red-50 p-2 text-[11px] text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
                  <div className="font-bold">連番URL探索の有効ソースが0件です。</div>
                  <div>探索を実行するには、各ソースを有効化してください。</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <button onClick={() => bulkProbeActive('all', true)} className="rounded border border-red-400 bg-white px-2 py-0.5 font-bold text-red-700 hover:bg-red-100 dark:bg-transparent dark:text-red-200">全ソースを有効化</button>
                    <button onClick={() => setProbeView('inactive')} className="rounded border border-red-400 px-2 py-0.5">無効理由を見る</button>
                  </div>
                </div>
              )}
              {/* 一括有効化＋状態フィルタ */}
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <label className="flex items-center gap-1 text-muted-foreground">1日最大探索件数<input type="number" min={20} max={5000} value={settings.probeDailyCap ?? 500} onChange={(e) => saveSettings({ ...settings, probeDailyCap: Math.max(20, Math.min(5000, Number(e.target.value) || 500)) })} className="h-6 w-16 rounded border border-input bg-card px-1" /></label>
                <span className="text-muted-foreground">有効 {probeSites.filter((x: any) => x.is_active && !x.review_flag).length} / 要確認 {probeSites.filter((x: any) => x.is_active && x.review_flag).length} / 無効 {probeSites.filter((x: any) => !x.is_active).length}</span>
                <span className="ml-1">一括:</span>
                <button onClick={() => bulkProbeActive('all', true)} className="rounded border border-green-500 px-2 py-0.5 text-green-700 hover:bg-green-50 dark:text-green-300 dark:hover:bg-green-500/10">全ソースを有効化</button>
                <button onClick={() => bulkProbeActive('tabelog', true)} className="rounded border px-2 py-0.5 hover:bg-accent">食べログ系を有効化</button>
                <button onClick={() => bulkProbeActive('jalan', true)} className="rounded border px-2 py-0.5 hover:bg-accent">じゃらん系を有効化</button>
                <span className="ml-1">表示:</span>
                {([['all', '全'], ['active', '有効のみ'], ['inactive', '無効のみ']] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setProbeView(k)} className={cn('rounded border px-2 py-0.5', probeView === k ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent')}>{label}</button>
                ))}
              </div>
              {ekitenResult && (
                <div className="rounded-lg border border-pink-300 bg-pink-50/50 p-2 text-[10px] dark:border-pink-500/30 dark:bg-pink-500/10">
                  <div className="mb-1 font-bold text-pink-700 dark:text-pink-300">エキテン新規掲載候補（公開日7日以内）{ekitenResult.ok === false && <span className="ml-1 text-red-600">エラー: {String(ekitenResult.error).slice(0, 80)}</span>}</div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5">検索対象 {ekitenResult.dateRange}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5">クエリ {ekitenResult.queries}</span>
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">詳細取得 {ekitenResult.detailFetched}</span>
                    <span className="rounded bg-rose-100 px-1.5 py-0.5 font-bold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">公開日7日内 {ekitenResult.pub7}</span>
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">8日以上前 {ekitenResult.pubOld}</span>
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">公開日取得不可 {ekitenResult.noPub}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5">電話あり {ekitenResult.phoneYes}・住所あり {ekitenResult.addrYes}</span>
                    <span className="rounded bg-red-200 px-1.5 py-0.5 font-bold text-red-800 dark:bg-red-500/30 dark:text-red-200">HOT-B {ekitenResult.hotB}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {ekitenResult.hold}</span>
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED/SKIP {ekitenResult.excluded}</span>
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">lead保存 {ekitenResult.saved}・cases投入 {ekitenResult.imported}</span>
                  </div>
                  <div className="mt-0.5 text-muted-foreground">※公開日は店舗の開業日ではなく、エキテン上の掲載公開日です。新店確定ではなく新規掲載候補として扱っています（site:検索のためBing推奨。Serper無料は site: が弾かれ簡易検索にfallback）。</div>
                </div>
              )}
              {probeResult && (
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  {probeResult.single
                    ? <><span className="rounded bg-muted px-1.5 py-0.5">探索 {probeResult.fromId}〜{probeResult.toId}</span><span className="rounded bg-muted px-1.5 py-0.5">次回開始 {probeResult.nextId}</span>{probeResult.backfillFrom && <span className="rounded bg-muted px-1.5 py-0.5">戻り確認 {probeResult.backfillFrom}〜{probeResult.backfillTo}</span>}</>
                    : <span className="rounded bg-muted px-1.5 py-0.5">有効ソース {probeResult.sources ?? 0}</span>}
                  <span className="rounded bg-muted px-1.5 py-0.5">探索URL {probeResult.probed ?? 0}</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">有効 {probeResult.valid ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">無効 {probeResult.invalid ?? 0}</span>
                  {probeResult.invalidTopReason && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">主理由: {probeResult.invalidTopReason}</span>}
                  {probeResult.lastFoundId != null && <span className="rounded bg-muted px-1.5 py-0.5">最後にvalid ID {probeResult.lastFoundId}</span>}
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話 {probeResult.phoneYes ?? '-'}</span>
                  <span className="rounded bg-red-200 px-1.5 py-0.5 font-bold text-red-800 dark:bg-red-500/30 dark:text-red-200">HOT-A {probeResult.hotA ?? 0}</span>
                  <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">HOT-B {probeResult.hotB ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {probeResult.hold ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {probeResult.excluded ?? 0}</span>
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">lead保存 {probeResult.saved ?? 0}</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">cases新規投入 {probeResult.imported ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">invalid {probeResult.invalid ?? 0}</span>
                  {Number(probeResult.fetchFail ?? 0) > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">fetch失敗 {probeResult.fetchFail}（要再試行）</span>}
                  {Number(probeResult.parserFail ?? 0) > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">parser失敗 {probeResult.parserFail}（要確認）</span>}
                  {Number(probeResult.probed ?? 0) === 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 font-bold text-red-700 dark:bg-red-500/20 dark:text-red-300">探索0件: {String(probeResult.reason || (probeResult.debug?.siteResults?.[0]?.reason) || '1日の探索上限に到達の可能性（上の「1日最大探索件数」を増やしてください）')}</span>}
                  {Number(probeResult.alreadyImported ?? 0) > 0 && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">既存投入済 {probeResult.alreadyImported}</span>}
                  {(Number(probeResult.saveError ?? 0) > 0 || Number(probeResult.importFailed ?? 0) > 0) && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">保存失敗 {(probeResult.saveError ?? 0)} / 投入失敗 {(probeResult.importFailed ?? 0)}</span>}
                  {Number(probeResult.mojibake ?? 0) > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">文字化け {probeResult.mojibake}</span>}
                  {Number(probeResult.fetchFail ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">fetch失敗 {probeResult.fetchFail}</span>}
                  {Number(probeResult.dupSkip ?? 0) > 0 && <span className="rounded bg-muted px-1.5 py-0.5">30日内skip {probeResult.dupSkip}</span>}
                </div>
              )}
              {/* ソース別 */}
              <div className="space-y-1">
                {probeSites.length === 0 && <div className="text-[10px] text-muted-foreground">連番探索ソースがありません。地域メディアの巡回サイト管理で source_type=sequential_id_probe を追加するか、じゃらん（既定OFF）を有効化してください。</div>}
                {probeSites.filter((st: any) => probeView === 'all' ? true : probeView === 'active' ? st.is_active : !st.is_active).map((st: any) => (
                  <div key={st.id} className="rounded border bg-muted/30 p-2 text-[10px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{st.name}</span>
                      {st.region_label && <span className="rounded bg-sky-100 px-1 text-[9px] text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">{st.region_label}</span>}
                      {/* 3状態: 有効 / 要確認 / 無効 */}
                      {!st.is_active
                        ? <span className="rounded bg-zinc-200 px-1 text-[9px] text-zinc-600 dark:bg-zinc-700">無効</span>
                        : st.review_flag
                        ? <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">要確認</span>
                        : <span className="rounded bg-green-100 px-1 text-[9px] text-green-700 dark:bg-green-500/20 dark:text-green-300">有効</span>}
                      <span className="rounded bg-indigo-100 px-1 text-[9px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">{st.parser_type || 'generic_detail_page'}</span>
                      <span className="truncate text-muted-foreground" title={st.url_template}>{st.url_template}</span>
                    </div>
                    {!st.is_active && <div className="text-[9px] text-zinc-500">無効理由: {st.disabled_reason || '無効理由不明'}{st.disabled_at ? `（${moment(st.disabled_at).format('MM/DD HH:mm')}）` : ''}</div>}
                    {st.is_active && st.review_flag && <div className="text-[9px] text-amber-600 dark:text-amber-300">要確認: {st.last_error_message || 'エラーあり（探索対象のまま・再試行可）'}{st.last_error_type ? `（${st.last_error_type}）` : ''}</div>}
                    <div className="mt-0.5 text-muted-foreground">
                      <b className="text-foreground">最後に有効だったID {st.last_valid_id ?? st.last_found_id ?? '-'}</b> ・ 前回最終確認 {st.last_checked_id ?? '-'} ・ <b className="text-foreground">次回開始ID {st.current_probe_id ?? st.start_probe_id ?? '-'}</b> ・ モード {st.probe_mode === 'advance' ? '先行探索' : '安全確認'} ・ padding{st.id_padding ?? 0} ・ 連続not_found {st.consecutive_not_found_count ?? 0} ・ 累計 valid{st.total_valid_count ?? 0}/invalid{st.total_invalid_count ?? 0}
                    </div>
                    <div className="text-[9px] text-muted-foreground">基準: {st.probe_mode === 'advance' ? '最後に確認したIDの次から（先行）' : '最後に有効だったIDの次から再確認（安全・invalid範囲も再確認）'}{(st.last_valid_id != null && st.last_checked_id != null && st.last_checked_id > st.last_valid_id) ? ` ・ invalid再確認対象: ${Number(st.last_valid_id) + 1}〜${st.last_checked_id}` : ''}</div>
                    {devMode && <div className="mt-0.5 rounded bg-muted/40 p-1 text-[9px] text-muted-foreground"><div>source_id: {st.id}</div><div className="break-all">source_key: {st.source_key || '—'}</div><div className="break-all">normalized: {st.normalized_url_template || '—'}</div><div>created: {st.created_at ? moment(st.created_at).format('MM/DD HH:mm') : '—'} / updated: {st.updated_at ? moment(st.updated_at).format('MM/DD HH:mm') : '—'}</div></div>}
                    {st.probe_result_summary && <div className="text-muted-foreground">最終結果: {st.probe_result_summary}</div>}
                    {/* parser テスト結果（既知URL） */}
                    {probeTests[st.id] && (
                      <div className="mt-1 rounded border bg-muted/40 p-1.5">
                        <div className="flex flex-wrap gap-1.5">
                          <span className={cn('rounded px-1 text-[9px] font-bold', probeTests[st.id].summary?.parserOk ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300')}>parserテスト {probeTests[st.id].summary?.parserOk ? 'OK' : 'NG'}</span>
                          <span className={cn('rounded px-1 text-[9px]', probeTests[st.id].summary?.addressOk ? 'text-green-700 dark:text-green-300' : 'text-red-600')}>既知URL住所取得 {probeTests[st.id].summary?.addressOk ? 'OK' : 'NG'}</span>
                          <span className={cn('rounded px-1 text-[9px]', probeTests[st.id].summary?.phoneOk ? 'text-green-700 dark:text-green-300' : 'text-red-600')}>電話取得 {probeTests[st.id].summary?.phoneOk ? 'OK' : 'NG'}</span>
                        </div>
                        {(probeTests[st.id].items || []).map((it: any, i: number) => (
                          <div key={i} className="mt-0.5 border-t pt-0.5 text-[9px] text-muted-foreground">
                            <span className={cn('font-mono', it.valid ? 'text-green-600' : 'text-zinc-500')}>{it.valid ? 'valid' : 'invalid'}</span> HTTP{it.status} charset:{it.charset || '-'}{it.mojibake ? ' 文字化けあり' : ''} ・ <a href={it.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{it.url.replace('https://www.jalan.net', '')}</a>
                            <div>名称: {it.name || '—'} / 住所: {it.address || '—'} / 電話: {it.phone || '—'} / カテゴリ: {it.category || '—'}{it.invalidReason ? ` / 理由: ${it.invalidReason}` : ''}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <button onClick={() => testProbe(st.id)} disabled={probing} className="rounded border border-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10">既知URLでテスト</button>
                      <button onClick={() => { const v = prompt('テストするIDを入力（保存なし・valid/invalid/fetch_failed/parser_failed＋抽出結果を確認）', String(st.last_valid_id != null ? Number(st.last_valid_id) + 1 : st.current_probe_id ?? st.start_probe_id ?? '')); if (v) testProbe(st.id, [Number(v)]) }} disabled={probing} className="rounded border border-emerald-500 px-1.5 py-0.5 text-[9px] text-emerald-700 dark:text-emerald-300">指定IDでテスト</button>
                      <button onClick={() => probeSiteAction(st.id, { forwardCount: 20, backfillCount: 5, probeMode: 'safe' })} disabled={probing} className="rounded border border-primary px-1.5 py-0.5 text-[9px] text-primary hover:bg-primary/10">次の20件（有効IDの次から）</button>
                      <button onClick={() => probeSiteAction(st.id, { forwardCount: 100, backfillCount: 5, probeMode: 'safe' })} disabled={probing} className="rounded border px-1.5 py-0.5 text-[9px]">次の100件</button>
                      <button onClick={() => probeSiteAction(st.id, { forwardCount: 20, backfillCount: 0, probeMode: 'advance', startId: ((st.last_checked_id ?? st.current_probe_id ?? 0) + 1) })} disabled={probing} className="rounded border px-1.5 py-0.5 text-[9px]">前回確認の続きから（先行）</button>
                      <button onClick={() => { const from = (st.last_valid_id != null ? Number(st.last_valid_id) + 1 : st.current_probe_id); probeSiteAction(st.id, { startId: from, forwardCount: Math.max(1, (st.last_checked_id ?? from) - from + 1), backfillCount: 0, force: true, probeMode: 'safe' }) }} disabled={probing} className="rounded border border-amber-500 px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300">invalid範囲を再確認</button>
                      <button onClick={() => { const v = prompt('開始IDを入力（その位置から本番探索＝保存あり・強制再取得）', String(st.last_found_id ?? st.current_probe_id ?? st.start_probe_id ?? '')); if (v) probeSiteAction(st.id, { startId: Number(v), forwardCount: 20, backfillCount: 0, force: true }) }} disabled={probing} className="rounded border px-1.5 py-0.5 text-[9px]">指定IDから本番探索（保存）</button>
                      {Array.isArray(st.fetch_failed_ids) && st.fetch_failed_ids.length > 0 && <button onClick={() => retryFailed(st.id, 'fetch')} disabled={probing} className="rounded border border-amber-500 px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300">fetch失敗だけ再試行（{st.fetch_failed_ids.length}）</button>}
                      {Array.isArray(st.parser_failed_ids) && st.parser_failed_ids.length > 0 && <button onClick={() => retryFailed(st.id, 'parser')} disabled={probing} className="rounded border border-amber-500 px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300">parser失敗だけ再試行（{st.parser_failed_ids.length}）</button>}
                      <button onClick={() => { const v = prompt('current_probe_id を編集', String(st.current_probe_id ?? '')); if (v) updateProbeSite(st.id, { current_probe_id: Number(v) }) }} className="rounded border px-1.5 py-0.5 text-[9px]">current_id編集</button>
                      <button onClick={() => openEditProbe(st)} className="rounded border border-primary px-1.5 py-0.5 text-[9px] text-primary">編集</button>
                      <button onClick={() => updateProbeSite(st.id, { is_active: !st.is_active })} className="rounded border px-1.5 py-0.5 text-[9px]">{st.is_active ? '無効化' : '有効化'}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ===== 取得元管理タブ（巡回サイト管理 / 自動発見） ===== */}
          {mainView === 'manage' && (
            <div className="rounded-xl border bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-bold">
                  巡回サイト管理
                  <span className="text-[10px] font-normal text-muted-foreground">総数 {rmCounts.total} ・ 有効 {rmCounts.active} ・ 無効 {rmCounts.inactive}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={seedInitial} disabled={rmBusy}>初期ソースを登録</Button>
                  <Button size="sm" variant="outline" onClick={() => setSiteForm({ ...emptySite })}>巡回サイトを追加</Button>
                  <Button size="sm" variant="outline" onClick={dedupeSites} disabled={rmBusy}>重複を整理</Button>
                  <Button size="sm" onClick={testAllSites} disabled={rmBusy}>全有効サイトをテスト巡回</Button>
                </div>
              </div>
              {rmSitesErr && <div className="mt-1 rounded bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">サイト一覧の取得に失敗: {rmSitesErr}</div>}

              {/* 追加/編集フォーム */}
              {siteForm && (
                <div className="mt-2 grid gap-2 rounded-lg border bg-muted/30 p-2 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-0.5"><Label className="text-[10px]">サイト名</Label><Input className="h-8" value={siteForm.name} onChange={(e) => setSiteForm({ ...siteForm, name: e.target.value })} /></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">base_url</Label><Input className="h-8" value={siteForm.base_url} onChange={(e) => setSiteForm({ ...siteForm, base_url: e.target.value })} placeholder="https://example.com/" /></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">list_url（空ならbase_url）</Label><Input className="h-8" value={siteForm.list_url} onChange={(e) => setSiteForm({ ...siteForm, list_url: e.target.value })} /></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">メディア種別</Label>
                    <select className="h-8 w-full rounded border border-input bg-card px-2 text-sm" value={siteForm.media_family} onChange={(e) => setSiteForm({ ...siteForm, media_family: e.target.value })}>
                      {['goguynet', 'kaitenheiten', 'tsushin', 'local_blog', 'local_news', 'local_directory', 'other'].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">source_type</Label>
                    <select className="h-8 w-full rounded border border-input bg-card px-2 text-sm" value={siteForm.source_type} onChange={(e) => setSiteForm({ ...siteForm, source_type: e.target.value })}>
                      {['html_list', 'rss', 'sitemap', 'category_page'].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">カテゴリラベル</Label>
                    <select className="h-8 w-full rounded border border-input bg-card px-2 text-sm" value={siteForm.category_label} onChange={(e) => setSiteForm({ ...siteForm, category_label: e.target.value })}>
                      {['開店閉店', '新店情報', '地域ニュース', '店舗情報'].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">信頼度スコア(0-100)</Label><Input type="number" min={0} max={100} className="h-8" value={siteForm.reliability_score} onChange={(e) => setSiteForm({ ...siteForm, reliability_score: Number(e.target.value) })} /></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">巡回間隔(時間)</Label><Input type="number" min={1} className="h-8" value={siteForm.crawl_interval_hours} onChange={(e) => setSiteForm({ ...siteForm, crawl_interval_hours: Number(e.target.value) })} /></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">一覧レンダリング</Label>
                    <select className="h-8 w-full rounded border border-input bg-card px-2 text-sm" value={siteForm.rendering_mode || 'auto'} onChange={(e) => setSiteForm({ ...siteForm, rendering_mode: e.target.value })}>
                      <option value="static">static（通常fetchのみ）</option><option value="auto">auto（候補0かつJS疑いでbrowser）</option><option value="browser">browser（最初からレンダリング）</option>
                    </select></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">詳細ページ取得</Label>
                    <select className="h-8 w-full rounded border border-input bg-card px-2 text-sm" value={siteForm.detail_fetch_enabled === false ? 'off' : 'on'} onChange={(e) => setSiteForm({ ...siteForm, detail_fetch_enabled: e.target.value === 'on' })}>
                      <option value="on">取得する</option><option value="off">取得しない</option>
                    </select></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">詳細レンダリング</Label>
                    <select className="h-8 w-full rounded border border-input bg-card px-2 text-sm" value={siteForm.detail_rendering_mode || 'auto'} onChange={(e) => setSiteForm({ ...siteForm, detail_rendering_mode: e.target.value })}>
                      <option value="static">static</option><option value="auto">auto（薄い/失敗でrender）</option><option value="browser">browser</option>
                    </select></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">詳細parser</Label>
                    <select className="h-8 w-full rounded border border-input bg-card px-2 text-sm" value={siteForm.detail_parser_type || ''} onChange={(e) => setSiteForm({ ...siteForm, detail_parser_type: e.target.value })}>
                      <option value="">汎用（generic）</option><option value="horby_detail">horby_detail</option><option value="tabelog_detail">tabelog_detail</option><option value="mypl_detail">mypl_detail</option>
                    </select></div>
                  <div className="space-y-0.5"><Label className="text-[10px]">詳細最大件数/回</Label><Input type="number" min={0} max={50} className="h-8" value={siteForm.max_detail_pages_per_run ?? 20} onChange={(e) => setSiteForm({ ...siteForm, max_detail_pages_per_run: Number(e.target.value) })} /></div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!siteForm.click_required} onChange={(e) => setSiteForm({ ...siteForm, click_required: e.target.checked })} />クリック遷移必須（href無しJSサイト）</label>
                  {siteForm.click_required && <>
                    <div className="space-y-0.5"><Label className="text-[10px]">card_selector</Label><Input className="h-8 font-mono text-2xs" value={siteForm.card_selector || ''} onChange={(e) => setSiteForm({ ...siteForm, card_selector: e.target.value })} placeholder=".new_salon_list .new_salon_item" /></div>
                    <div className="space-y-0.5"><Label className="text-[10px]">detail_click_selector</Label><Input className="h-8 font-mono text-2xs" value={siteForm.detail_click_selector || ''} onChange={(e) => setSiteForm({ ...siteForm, detail_click_selector: e.target.value })} placeholder="a" /></div>
                  </>}
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={siteForm.is_active} onChange={(e) => setSiteForm({ ...siteForm, is_active: e.target.checked })} />有効化する</label>
                  <div className="flex items-end gap-1.5 lg:col-span-2">
                    <Button size="sm" onClick={saveSite} disabled={rmBusy}>{siteForm.id ? '更新' : '登録'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSiteForm(null)}>キャンセル</Button>
                  </div>
                </div>
              )}

              {/* サイト一覧 フィルタ */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
                {[['all', '全'], ['active', '有効'], ['inactive', '無効']].map(([k, label]) => (
                  <button key={k} onClick={() => setSiteFilter({ ...siteFilter, status: k })} className={cn('rounded border px-2 py-0.5', siteFilter.status === k ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent')}>{label}</button>
                ))}
                <Input className="h-7 w-44 text-2xs" placeholder="サイト名/URL検索" value={siteFilter.q} onChange={(e) => setSiteFilter({ ...siteFilter, q: e.target.value })} />
                <select className="h-7 rounded border border-input bg-card px-1 text-2xs" value={siteFilter.sourceType} onChange={(e) => setSiteFilter({ ...siteFilter, sourceType: e.target.value })}>
                  <option value="">source_type:全</option>{Array.from(new Set(rmSites.map((s) => s.source_type).filter(Boolean))).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="h-7 rounded border border-input bg-card px-1 text-2xs" value={siteFilter.parserType} onChange={(e) => setSiteFilter({ ...siteFilter, parserType: e.target.value })}>
                  <option value="">parser_type:全</option>{Array.from(new Set(rmSites.map((s) => s.parser_type).filter(Boolean))).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <span className="text-muted-foreground">全{rmSitesFiltered.length}件中 {Math.min(siteShown, rmSitesFiltered.length)}件</span>
                {[20, 50, 100].map((n) => <button key={n} onClick={() => setSiteShown(n)} className={cn('rounded border px-1.5 py-0.5', siteShown === n ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent')}>{n}</button>)}
                <button onClick={() => setSiteShown(rmSitesFiltered.length || 1)} className={cn('rounded border px-1.5 py-0.5', siteShown >= rmSitesFiltered.length ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent')}>全部見れる</button>
                {(siteFilter.q || siteFilter.status !== 'all' || siteFilter.sourceType || siteFilter.parserType) && <button onClick={() => setSiteFilter({ status: 'all', q: '', sourceType: '', parserType: '' })} className="rounded border border-input px-1.5 py-0.5 hover:bg-accent">クリア</button>}
              </div>
              {/* サイト一覧 */}
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[1000px] text-2xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="p-1.5 text-left">サイト名</th><th className="p-1.5 text-left">URL</th><th className="p-1.5 text-left">種別/カテゴリ</th>
                      <th className="p-1.5 text-center">信頼度</th><th className="p-1.5 text-center">間隔</th><th className="p-1.5 text-center">最終巡回</th>
                      <th className="p-1.5 text-left">最終結果</th><th className="p-1.5 text-center">有効</th><th className="p-1.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rmSitesFiltered.length === 0 ? (
                      <tr><td colSpan={9} className="p-3 text-center text-muted-foreground">{rmSites.length === 0 ? '巡回サイトがありません。「初期ソースを登録」または「巡回サイトを追加」してください。' : '条件に一致するサイトがありません。'}</td></tr>
                    ) : rmSitesVisible.map((s) => (
                      <tr key={s.id} className="border-t align-top">
                        <td className="p-1.5 font-medium">{s.name}
                          {s.rendering_mode && s.rendering_mode !== 'static' && <span className={cn('ml-1 rounded px-1 text-[8px]', s.rendering_mode === 'browser' ? 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700')}>{s.rendering_mode === 'browser' ? 'JS描画' : 'auto'}</span>}
                          {s.last_rendering_result && <div className="text-[8px] text-purple-600 dark:text-purple-300">{s.last_rendering_result}</div>}
                          {s.last_rendering_error && <div className="text-[8px] text-red-500">{s.last_rendering_error}</div>}
                        </td>
                        <td className="max-w-[200px] p-1.5"><a href={s.list_url || s.base_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s.list_url || s.base_url}</a></td>
                        <td className="p-1.5">{s.media_family} / {s.source_type}<div className="text-muted-foreground">{s.parser_type || s.category_label}</div></td>
                        <td className="p-1.5 text-center">{s.reliability_score}</td>
                        <td className="p-1.5 text-center">{s.crawl_interval_hours}h</td>
                        <td className="p-1.5 text-center">{s.last_crawled_at ? moment(s.last_crawled_at).format('MM/DD HH:mm') : '—'}{(s.last_new_count != null || s.last_seen_skipped != null) && <div className="text-[8px] text-muted-foreground">新規{s.last_new_count ?? 0}/既読skip{s.last_seen_skipped ?? 0}</div>}{s.latest_item_url && <div className="max-w-[120px] truncate text-[8px] text-muted-foreground" title={s.latest_item_url}>前回最新: {s.latest_item_url}</div>}</td>
                        <td className="max-w-[140px] p-1.5 text-muted-foreground">{s.last_crawl_result || '—'}
                          {s.source_type !== 'sequential_id_probe' && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              <button onClick={() => runRegionalOne(s.id, false)} disabled={rmRunning} className="rounded border border-primary px-1 py-0.5 text-[8px] text-primary hover:bg-primary/10">差分巡回</button>
                              <button onClick={() => runRegionalOne(s.id, true)} disabled={rmRunning} className="rounded border px-1 py-0.5 text-[8px]">過去分も再巡回</button>
                              <button onClick={() => resetCrawlCursor(s.id, 'latest')} className="rounded border px-1 py-0.5 text-[8px]">前回最新をリセット</button>
                              <button onClick={() => resetCrawlCursor(s.id, 'seen')} className="rounded border border-amber-500 px-1 py-0.5 text-[8px] text-amber-700 dark:text-amber-300">既読URLリセット</button>
                            </div>
                          )}
                        </td>
                        <td className="p-1.5 text-center">
                          <button onClick={() => toggleSiteActive(s)} className={cn('rounded px-1.5 py-0.5 font-bold', s.is_active ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-700')}>{s.is_active ? 'ON' : 'OFF'}</button>
                        </td>
                        <td className="p-1.5 text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => setSiteForm({ id: s.id, name: s.name, base_url: s.base_url, list_url: s.list_url || '', media_family: s.media_family || 'other', source_type: s.source_type || 'html_list', category_label: s.category_label || '開店閉店', is_active: s.is_active, reliability_score: s.reliability_score ?? 50, crawl_interval_hours: s.crawl_interval_hours ?? 24, rendering_mode: s.rendering_mode || 'auto', parser_type: s.parser_type || '', detail_fetch_enabled: s.detail_fetch_enabled !== false, detail_rendering_mode: s.detail_rendering_mode || 'auto', detail_parser_type: s.detail_parser_type || '', click_required: !!s.click_required, card_selector: s.card_selector || '', detail_click_selector: s.detail_click_selector || '', max_detail_pages_per_run: s.max_detail_pages_per_run ?? 20 })}>編集</Button>
                            <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => testSite(s)}>テスト</Button>
                          </div>
                          {siteTests[s.id] && (
                            <div className="mt-1 max-w-[320px] rounded border bg-muted/30 p-1 text-left text-[9px]">
                              {siteTests[s.id].loading ? 'テスト中…' : (
                                <>
                                  <div className={cn(siteTests[s.id].diag?.fetchOk ? 'text-green-600' : 'text-red-600')}>
                                    {siteTests[s.id].diag?.fetchOk ? 'fetch✓' : 'fetch✗'} HTTP{siteTests[s.id].diag?.status ?? '-'} ・ HTML{siteTests[s.id].diag?.htmlLength ?? 0}字 ・ 全リンク{siteTests[s.id].diag?.totalLinks ?? 0} ・ 記事候補{siteTests[s.id].diag?.candidateLinks ?? 0}
                                  </div>
                                  <div className="text-muted-foreground">取得記事{siteTests[s.id].counts?.articles ?? 0} / 3日内{siteTests[s.id].counts?.recent ?? 0} / 新店{siteTests[s.id].counts?.open ?? 0} / HOT候補{siteTests[s.id].counts?.hotLike ?? 0}</div>
                                  {(siteTests[s.id].diag?.reason && siteTests[s.id].diag.reason !== 'OK') && <div className="text-amber-600">{siteTests[s.id].diag.reason}</div>}
                                  {siteTests[s.id].error && <div className="text-red-600">{siteTests[s.id].error}</div>}
                                  {(siteTests[s.id].articles || []).slice(0, 10).map((a: any, i: number) => (
                                    <div key={i} className="truncate"><a href={a.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{a.estimate}・{a.title || a.url}</a> {a.within_recent ? '🟢3日内' : ''}{a.published_at ? `(${fmtDate(a.published_at)})` : '(日付不明)'}</div>
                                  ))}
                                </>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 全サイトテスト結果 */}
              {allTest && (
                <div className="mt-2 rounded border bg-muted/30 p-2 text-[11px]">
                  {allTest.loading ? '全サイトテスト中…' : allTest.error ? <span className="text-red-600">{allTest.error}</span> : (
                    <>
                      <div className="flex flex-wrap gap-1.5 text-[10px]">
                        <span className="rounded bg-muted px-1.5 py-0.5">有効{allTest.activeSites}</span>
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">成功{allTest.success}</span>
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">失敗{allTest.fail}</span>
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">記事{allTest.articles}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5">3日内{allTest.recent}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5">新店候補{allTest.candidates}</span>
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT{allTest.hot}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD{allTest.hold}</span>
                        <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED{allTest.excluded}</span>
                      </div>
                      {(allTest.results || []).map((r: any, i: number) => (
                        <div key={i} className={cn('mt-0.5', r.ok ? '' : 'text-red-600')}>{r.site}: {r.ok ? `HTTP${r.status} HTML${r.htmlLength ?? 0}字 記事候補${r.candidateLinks ?? 0}/取得${r.articles}/3日内${r.recent}/新店${r.open}/HOT候補${r.hotLike}${r.reason && r.reason !== 'OK' ? ` ・ ${r.reason}` : ''}` : `失敗 ${r.error || ''}`}</div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ===== 架電対象リストタブ（フィルタ＋一覧） ===== */}
          {mainView === 'list' && (<>
          {/* フィルタ */}
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn('rounded-full border px-3 py-0.5 text-2xs', filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent')}
              >
                {f.label}{f.key !== 'ALL' && ` (${sourceCandidates.filter((c) => c.lead_temperature === f.key).length})`}
              </button>
            ))}
          </div>

          {/* HOT絞り込み（営業担当が店名未確定HOTだけ確認できる） */}
          <div className="flex flex-wrap items-center gap-1 text-2xs">
            {([['all', 'すべて'], ['named_hot', '店名ありHOT'], ['unconfirmed_hot', '店名未確定HOT(要確認)'], ['opening_date', 'Google開業日あり'], ['new_gbp', '新規GBP優先'], ['has_phone', '電話あり'], ['has_addr', '住所あり']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setSubFilter(k)} className={cn('rounded-full border px-2 py-0.5', subFilter === k ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-accent')}>{label}{k === 'unconfirmed_hot' ? ` (${sourceCandidates.filter((c: any) => c.name_unconfirmed_hot).length})` : k === 'new_gbp' ? ` (${sourceCandidates.filter((c: any) => c.is_new_gbp_priority).length})` : k === 'opening_date' ? ` (${sourceCandidates.filter((c: any) => c.has_opening_date_badge || c.has_google_opening_date).length})` : ''}</button>
            ))}
            <span className="ml-2 text-muted-foreground">並び順:</span>
            <button onClick={() => setRankMode('priority')} className={cn('rounded-full border px-2 py-0.5', rankMode === 'priority' ? 'border-rose-500 bg-rose-500 text-white' : 'border-input text-muted-foreground hover:bg-accent')}>🔥架電優先</button>
            <button onClick={() => setRankMode('newest')} className={cn('rounded-full border px-2 py-0.5', rankMode === 'newest' ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-accent')}>新着順</button>
            <span className="rounded-full bg-rose-100 px-2 py-0.5 font-bold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">今すぐ架電 {sourceCandidates.filter((c: any) => callPriority(c) >= 70).length}件（優先度70+）</span>
          </div>
          {/* 表示件数 */}
          <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
            <span>全{subFiltered.length}件中 {Math.min(shown, subFiltered.length)}件表示</span>
            <span className="ml-1">表示件数:</span>
            {[20, 50, 100, 200].map((n) => (
              <button key={n} onClick={() => setShown(n)} className={cn('rounded border px-2 py-0.5', shown === n ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent')}>{n}</button>
            ))}
            <button onClick={() => setShown(subFiltered.length || 1)} className={cn('rounded border px-2 py-0.5', shown >= subFiltered.length ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent')}>すべて</button>
            {shown < subFiltered.length && <button onClick={() => setShown((s) => s + 50)} className="rounded border border-input px-2 py-0.5 hover:bg-accent">もっと見る (+50)</button>}
            <button onClick={recorrectNames} disabled={recorrecting} className="ml-auto rounded border border-amber-500 px-2 py-0.5 text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10">{recorrecting ? '再補正中...' : '既存の店名を再補正（サイト名/カテゴリをHOLDへ）'}</button>
            <button onClick={recorrectProbe} disabled={recorrecting} className="rounded border border-indigo-500 px-2 py-0.5 text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10">{recorrecting ? '再取得中...' : '連番候補を再取得（食べログ正式店名へ）'}</button>
            <button onClick={rescueHolds} disabled={rescuing} className="rounded border border-rose-500 px-2 py-0.5 font-bold text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10">{rescuing ? '救済中...' : '🔥HOLD救済（電話補完→HOT昇格）'}</button>
            <button onClick={excludeBigPublic} disabled={excludingBig} className="rounded border border-zinc-500 px-2 py-0.5 text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-700/30">{excludingBig ? '除外中...' : '大手/公共/道の駅を除外（個人事業主に絞る）'}</button>
          </div>

          {/* テーブル */}
          {loading ? (
            <SkeletonRows count={8} />
          ) : !isSupabaseConfigured ? (
            <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">Supabase が未設定です。</div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
              {sourceTab === 'instagram'
                ? 'Instagram候補がありません。設定でInstagram取得を有効化し、「Instagram取得・実行」を押してください。'
                : sourceTab === 'regional'
                ? '地域メディア候補がありません。source_sites の base_url を実URLに設定して is_active=true にし、「地域メディア巡回・実行」を押してください。'
                : sourceTab === 'iw'
                ? 'Instagram Web検索の候補がありません。SERPER_API_KEY（またはBing）と ANTHROPIC_API_KEY を設定し、「Instagram Web検索・実行」を押してください。'
                : '候補がありません。「手動実行（モック）」を押すとサンプル候補を判定して取り込みます。'}
            </div>
          ) : sourceTab === 'iw' ? (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full min-w-[1300px] text-2xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">温度</th>
                    <th className="p-2 text-left">店名 / 業種 / 種別</th>
                    <th className="p-2 text-left">エリア</th>
                    <th className="p-2 text-left">電話</th>
                    <th className="p-2 text-left">LINE/予約/公式</th>
                    <th className="p-2 text-left">Instagram / タイトル</th>
                    <th className="p-2 text-left">スニペット / 判定理由</th>
                    <th className="p-2 text-left">補完</th>
                    <th className="p-2 text-center">確度</th>
                    <th className="p-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.id} className="cursor-pointer border-t align-top hover:bg-accent/40" onClick={() => setDrawerCand(c)}>
                      <td className="p-2"><span className={cn('rounded px-1.5 py-0.5 font-bold', LEAD_TEMP_COLORS[c.lead_temperature])}>{c.lead_temperature === 'HOT' && c.hot_tier ? `HOT-` : c.lead_temperature}</span>{callPriority(c) >= 70 && <span className="ml-1 rounded bg-rose-500 px-1 text-[8px] font-bold text-white">🔥{callPriority(c)}</span>}</td>
                      <td className="max-w-[150px] p-2">
                        <div className="font-medium">{c.extracted_shop_name || c.name}</div>
                        <div className="text-[9px] text-muted-foreground">{c.extracted_industry || '—'}{c.newness_type ? ` / ${c.newness_type}` : ''}</div>
                      </td>
                      <td className="p-2">
                        <div>{c.extracted_area || c.extracted_prefecture || <span className="text-amber-600">不明</span>}</div>
                        {(c.extracted_prefecture || c.extracted_city) && <div className="text-[9px] text-muted-foreground">{c.extracted_prefecture || ''}{c.extracted_city || ''}</div>}
                      </td>
                      <td className="p-2">{c.phone_number ? <span className="inline-flex items-center gap-1"><Phone className="h-2.5 w-2.5 text-muted-foreground" />{c.phone_number}</span> : <span className="text-red-500">なし</span>}</td>
                      <td className="max-w-[120px] p-2">
                        <div className="flex flex-col gap-0.5">
                          {c.line_url && <span className="text-green-600">LINE</span>}
                          {c.reservation_url && <a href={c.reservation_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">予約</a>}
                          {c.official_url && <a href={c.official_url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">公式</a>}
                          {!c.line_url && !c.reservation_url && !c.official_url && '—'}
                        </div>
                      </td>
                      <td className="max-w-[180px] p-2">
                        {c.instagram_url ? <a href={c.instagram_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Instagram投稿</a> : '—'}
                        <div className="line-clamp-2 text-[9px] text-muted-foreground" title={c.search_title ?? ''}>{c.search_title}</div>
                      </td>
                      <td className="max-w-[260px] p-2">
                        <div className="line-clamp-2 text-[9px] text-muted-foreground" title={c.search_snippet ?? ''}>{c.search_snippet}</div>
                        <div className="mt-0.5 line-clamp-2 text-fuchsia-700 dark:text-fuchsia-300" title={c.instagram_newness_reason ?? c.ai_comment ?? ''}>{c.instagram_newness_reason || c.ai_comment}</div>
                        {renderHotReject(c)}
                      </td>
                      <td className="max-w-[160px] p-2">
                        {(() => {
                          const st = c.enrichment_status
                          const cls = st === 'enriched' ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : st === 'searched' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : st === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300' : 'bg-muted'
                          const srcCount = Array.isArray(c.enrichment_sources) ? (c.enrichment_sources as any[]).length : 0
                          return (
                            <div className="flex flex-col gap-0.5">
                              <span className={cn('w-fit rounded px-1 text-[9px]', cls)}>{st || '未補完'}{c.enrichment_confidence != null ? ` ${c.enrichment_confidence}` : ''}</span>
                              {c.google_business_status === 'FUTURE_OPENING' && <span className="w-fit rounded bg-rose-100 px-1 text-[9px] font-bold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">開業予定</span>}
                              {c.has_google_opening_date && c.google_opening_date_raw && <span className="w-fit rounded bg-fuchsia-100 px-1 text-[9px] text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">Google開業{c.google_opening_date_raw}</span>}
                              {c.enriched_phone && <span className="text-[9px] text-green-700 dark:text-green-300">📞{c.enriched_phone}</span>}
                              {c.enriched_address && <span className="line-clamp-1 text-[9px] text-muted-foreground" title={c.enriched_address}>{c.enriched_address}</span>}
                              {c.enriched_google_place_id && <a href={`https://www.google.com/maps/place/?q=place_id:${c.enriched_google_place_id}`} target="_blank" rel="noreferrer" className="text-[9px] text-primary hover:underline">Places</a>}
                              {renderEnrichInfo(c)}
                              {srcCount > 0 && <span className="text-[9px] text-muted-foreground">補完元 {srcCount}件</span>}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="p-2 text-center">{c.match_confidence ?? '—'}</td>
                      <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col items-end gap-1">
                          {!c.imported_to_cases && c.lead_temperature !== 'EXCLUDED' && <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => importToCase(c).then((ok) => ok && toast.success('投入しました'))}>投入</Button>}
                          {c.imported_to_cases && <span className="text-green-600">投入済</span>}
                          <Button size="sm" variant="ghost" className="h-6 text-2xs text-fuchsia-700 dark:text-fuchsia-300" onClick={() => reenrichCandidate(c)}>再補完</Button>
                          <Button size="sm" variant="ghost" className="h-6 text-2xs" onClick={() => rejudgeCandidate(c)}>再判定</Button>
                          {c.lead_temperature !== 'EXCLUDED' && <Button size="sm" variant="ghost" className="h-6 text-2xs text-red-600" onClick={() => excludeCandidate(c)}>除外</Button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : sourceTab === 'regional' ? (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full min-w-[1200px] text-2xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">温度</th>
                    <th className="p-2 text-left">店名 / 業種</th>
                    <th className="p-2 text-left">エリア / 住所</th>
                    <th className="p-2 text-left">電話</th>
                    <th className="p-2 text-left">開店日</th>
                    <th className="p-2 text-left">ソース / 記事</th>
                    <th className="p-2 text-center">公開日</th>
                    <th className="p-2 text-center">Places照合</th>
                    <th className="p-2 text-left">補完</th>
                    <th className="p-2 text-left">判定理由</th>
                    <th className="p-2 text-center">状態</th>
                    <th className="p-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.id} className="cursor-pointer border-t align-top hover:bg-accent/40" onClick={() => setDrawerCand(c)}>
                      <td className="p-2"><span className={cn('rounded px-1.5 py-0.5 font-bold', LEAD_TEMP_COLORS[c.lead_temperature])}>{c.lead_temperature === 'HOT' && c.hot_tier ? `HOT-` : c.lead_temperature}</span>{callPriority(c) >= 70 && <span className="ml-1 rounded bg-rose-500 px-1 text-[8px] font-bold text-white">🔥{callPriority(c)}</span>}</td>
                      <td className="max-w-[160px] p-2">
                        <div className="font-medium">{c.extracted_shop_name || c.name}</div>
                        {c.extracted_industry && <div className="text-[9px] text-muted-foreground">{c.extracted_industry}</div>}
                      </td>
                      <td className="max-w-[180px] p-2">
                        <div>{c.extracted_area || '—'}</div>
                        {c.address && <a href={mapUrl(c.address, c.name)} target="_blank" rel="noreferrer" className="text-[9px] text-primary hover:underline">{c.address}</a>}
                      </td>
                      <td className="p-2">{c.phone_number ? <span className="inline-flex items-center gap-1"><Phone className="h-2.5 w-2.5 text-muted-foreground" />{c.phone_number}</span> : <span className="text-red-500">なし</span>}</td>
                      <td className="p-2">{c.extracted_open_date || '—'}</td>
                      <td className="max-w-[200px] p-2">
                        <div className="font-medium text-orange-600 dark:text-orange-300">{c.source_site_name}</div>
                        {c.source_article_url ? <a href={c.source_article_url} target="_blank" rel="noreferrer" className="line-clamp-2 text-primary hover:underline" title={c.source_article_title ?? ''}>{c.source_article_title || '記事を開く'}</a> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="p-2 text-center">{fmtDate(c.regional_media_detected_at)}</td>
                      <td className="p-2 text-center">{c.matched_google_place_id ? <span className="text-green-600">一致{c.match_confidence ? `(${c.match_confidence})` : ''}</span> : <span className="text-amber-600">未照合</span>}</td>
                      <td className="max-w-[150px] p-2">
                        {(() => {
                          const st = c.enrichment_status
                          const cls = st === 'enriched' ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : st === 'searched' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : st === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300' : 'bg-muted'
                          const srcCount = Array.isArray(c.enrichment_sources) ? (c.enrichment_sources as any[]).length : 0
                          return (
                            <div className="flex flex-col gap-0.5">
                              <span className={cn('w-fit rounded px-1 text-[9px]', cls)}>{st || '未補完'}{c.enrichment_confidence != null ? ` ${c.enrichment_confidence}` : ''}</span>
                              {c.google_business_status === 'FUTURE_OPENING' && <span className="w-fit rounded bg-rose-100 px-1 text-[9px] font-bold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">開業予定</span>}
                              {c.has_google_opening_date && c.google_opening_date_raw && <span className="w-fit rounded bg-fuchsia-100 px-1 text-[9px] text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">Google開業{c.google_opening_date_raw}</span>}
                              {c.enriched_phone && <span className="text-[9px] text-green-700 dark:text-green-300">📞{c.enriched_phone}</span>}
                              {c.enriched_address && <span className="line-clamp-1 text-[9px] text-muted-foreground" title={c.enriched_address}>{c.enriched_address}</span>}
                              {c.enriched_instagram_url && <a href={c.enriched_instagram_url} target="_blank" rel="noreferrer" className="text-[9px] text-primary hover:underline">IG</a>}
                              {c.enriched_google_place_id && <a href={`https://www.google.com/maps/place/?q=place_id:${c.enriched_google_place_id}`} target="_blank" rel="noreferrer" className="text-[9px] text-primary hover:underline">Places</a>}
                              {renderEnrichInfo(c)}
                              {srcCount > 0 && <span className="text-[9px] text-muted-foreground">補完元 {srcCount}件</span>}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="max-w-[260px] p-2"><div className="line-clamp-3 text-muted-foreground" title={c.regional_media_newness_reason ?? ''}>{c.regional_media_newness_reason || c.ai_comment}</div></td>
                      <td className="p-2 text-center">{importStatusBadge(c)}</td>
                      <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col items-end gap-1">
                          {!c.imported_to_cases && <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => importToCase(c).then((ok) => ok && toast.success('casesへ投入しました'))}>投入</Button>}
                          <Button size="sm" variant="ghost" className="h-6 text-2xs text-fuchsia-700 dark:text-fuchsia-300" onClick={() => reenrichRegional(c)}>再補完</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : sourceTab === 'instagram' ? (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full min-w-[1200px] text-2xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">判定</th>
                    <th className="p-2 text-left">店名候補 / 業種</th>
                    <th className="p-2 text-left">エリア</th>
                    <th className="p-2 text-left">電話</th>
                    <th className="p-2 text-left">LINE/予約/URL</th>
                    <th className="p-2 text-left">新規文言 / 投稿日</th>
                    <th className="p-2 text-center">Places照合</th>
                    <th className="p-2 text-center">投入可否</th>
                    <th className="p-2 text-left">理由</th>
                    <th className="p-2 text-center">リンク</th>
                    <th className="p-2 text-center">状態</th>
                    <th className="p-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const klass = c.ig_classification
                    const badge = klass === 'google_match_hot' ? ['Google照合HOT', 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300']
                      : klass === 'ig_only_hot' ? ['IG単体HOT候補', 'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300']
                      : klass === 'excluded' ? ['EXCLUDED', 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700']
                      : ['HOLD', 'bg-slate-100 text-slate-600 dark:bg-slate-700']
                    return (
                      <tr key={c.id} className="cursor-pointer border-t align-top hover:bg-accent/40" onClick={() => setDrawerCand(c)}>
                        <td className="p-2"><span className={cn('rounded px-1.5 py-0.5 font-bold', badge[1])}>{badge[0]}</span></td>
                        <td className="max-w-[160px] p-2">
                          <div className="font-medium">{c.extracted_shop_name || c.name}</div>
                          {c.extracted_industry && <div className="text-[9px] text-muted-foreground">{c.extracted_industry}</div>}
                        </td>
                        <td className="p-2">{c.extracted_area || '—'}</td>
                        <td className="p-2">{c.extracted_phone ? <span className="inline-flex items-center gap-1"><Phone className="h-2.5 w-2.5 text-muted-foreground" />{c.extracted_phone}</span> : <span className="text-red-500">なし</span>}</td>
                        <td className="max-w-[150px] p-2">
                          <div className="flex flex-col gap-0.5">
                            {c.extracted_line_url && <span className="text-green-600">LINE</span>}
                            {c.extracted_reservation_url && <a href={c.extracted_reservation_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">予約URL</a>}
                            {c.extracted_url && <a href={c.extracted_url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">{c.extracted_url}</a>}
                            {!c.extracted_line_url && !c.extracted_reservation_url && !c.extracted_url && '—'}
                          </div>
                        </td>
                        <td className="p-2">
                          <div>{c.instagram_caption ? <span className="rounded bg-pink-50 px-1 text-pink-700 dark:bg-pink-500/10 dark:text-pink-300">#{c.source_hashtag}</span> : '—'}</div>
                          <div className="text-[9px] text-muted-foreground">{fmtDate(c.instagram_timestamp)}</div>
                        </td>
                        <td className="p-2 text-center">
                          {c.matched_google_place_id
                            ? <span className="text-green-600">一致{c.match_confidence ? `(${c.match_confidence})` : ''}</span>
                            : <span className="text-amber-600">未照合{c.gbp_unregistered_candidate ? '/GBP未登録?' : ''}</span>}
                        </td>
                        <td className="p-2 text-center">{c.ig_auto_importable ? <span className="text-green-600">可</span> : <span className="text-muted-foreground">不可</span>}</td>
                        <td className="max-w-[260px] p-2"><div className="line-clamp-3 text-muted-foreground" title={c.instagram_newness_reason ?? ''}>{c.instagram_newness_reason || c.ai_comment}</div>{renderHotReject(c)}</td>
                        <td className="p-2 text-center">{c.instagram_permalink ? <a href={c.instagram_permalink} target="_blank" rel="noreferrer" className="text-primary hover:underline">投稿</a> : '—'}{c.instagram_account_url && <> / <a href={c.instagram_account_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">アカ</a></>}</td>
                        <td className="p-2 text-center">{importStatusBadge(c)}</td>
                        <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
                          {!c.imported_to_cases && (
                            <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => importToCase(c).then((ok) => ok && toast.success('casesへ投入しました'))}>投入</Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full min-w-[1100px] text-2xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">温度</th>
                    <th className="p-2 text-left">店名 / 業種</th>
                    <th className="p-2 text-left">電話番号</th>
                    <th className="p-2 text-left">住所</th>
                    <th className="p-2 text-left">検出シグナル</th>
                    <th className="p-2 text-center">口コミ</th>
                    <th className="p-2 text-center">到達<br />スコア</th>
                    <th className="p-2 text-left">判定</th>
                    <th className="p-2 text-left">投入理由 / AIコメント</th>
                    <th className="p-2 text-center">検出日</th>
                    <th className="p-2 text-center">状態</th>
                    <th className="p-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.id} className="cursor-pointer border-t align-top hover:bg-accent/40" onClick={() => setDrawerCand(c)}>
                      <td className="p-2">
                        <span className={cn('rounded px-1.5 py-0.5 font-bold', LEAD_TEMP_COLORS[c.lead_temperature])}>{c.lead_temperature === 'HOT' && c.hot_tier ? `HOT-${c.hot_tier}` : c.lead_temperature}</span>
                        {callPriority(c) >= 70 && <span className="ml-1 rounded bg-rose-500 px-1 text-[8px] font-bold text-white">🔥{callPriority(c)}</span>}
                      </td>
                      <td className="p-2">
                        <div className="font-medium">{c.name}</div>
                        {c.industry && <div className="text-[9px] text-muted-foreground">{c.industry}</div>}
                      </td>
                      <td className="p-2">
                        {c.phone_number ? (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-2.5 w-2.5 text-muted-foreground" />{c.phone_number}
                            <button className="text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(c.phone_number!).then((ok) => ok && toast.success('コピーしました'))}><CopyIcon className="h-2.5 w-2.5" /></button>
                          </span>
                        ) : <span className="text-red-500">なし</span>}
                      </td>
                      <td className="max-w-[160px] p-2">
                        {c.address ? <a href={mapUrl(c.address, c.name)} target="_blank" rel="noreferrer" className="text-primary hover:underline">{c.address}</a> : '—'}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-0.5">
                          {sigBadge(c.is_new_gbp, 'GBP')}
                          {sigBadge(c.is_new_instagram, 'IG')}
                          {sigBadge(c.is_new_website, 'HP')}
                          {sigBadge(c.is_new_ad_listing, '広告')}
                          {c.is_new_corporation && <span className="rounded-sm bg-indigo-100 px-1 text-[9px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">新設法人</span>}
                          {!c.is_new_gbp && !c.is_new_instagram && !c.is_new_website && !c.is_new_ad_listing && !c.is_new_corporation && <span className="text-muted-foreground">—</span>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-0.5">
                          {c.is_new_opening_candidate && <span className="rounded-sm bg-green-100 px-1 text-[9px] text-green-700 dark:bg-green-500/20 dark:text-green-300">新規開業候補</span>}
                          {c.google_business_status === 'FUTURE_OPENING' && <span className="rounded-sm bg-rose-100 px-1 text-[9px] font-bold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">開業予定</span>}
                          {c.has_google_opening_date && c.google_opening_date_raw && <span className="rounded-sm bg-fuchsia-100 px-1 text-[9px] text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300" title={`確度${c.opening_date_confidence ?? '-'}`}>Google開業{c.google_opening_date_raw}</span>}
                          {c.days_until_opening != null && <span className="rounded-sm bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">開業まで{c.days_until_opening}日</span>}
                          {c.days_since_opening != null && c.days_since_opening <= 60 && <span className="rounded-sm bg-emerald-100 px-1 text-[9px] text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">開業{c.days_since_opening}日</span>}
                          {c.from_new_open_query && <span className="rounded-sm bg-sky-100 px-1 text-[9px] text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">新規Q</span>}
                          {c.days_since_first_seen != null && <span className="text-[9px] text-muted-foreground" title="RSTが初めて見つけた日（GBP登録日ではありません）">RST発見{c.days_since_first_seen}日前</span>}
                        </div>
                      </td>
                      <td className="p-2 text-center">
                        {(() => {
                          const n = c.user_rating_count
                          if (n == null) return <span className="text-muted-foreground" title="口コミ件数不明">不明</span>
                          const cls = n <= 5 ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
                            : n <= 15 ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
                              : n < 100 ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
                                : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
                          const label = n <= 5 ? '新規候補' : n <= 15 ? '中' : n < 100 ? '既存寄り' : '人気既存'
                          return (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-bold">{n}</span>
                              <span className={cn('rounded-sm px-1 text-[8px]', cls)}>{label}</span>
                              {c.oldest_review_days_ago != null && (
                                <span className={cn('text-[8px]', c.oldest_review_is_recent ? 'text-green-600' : 'text-muted-foreground')} title={`最古口コミ ${fmtDate(c.oldest_review_publish_time)}`}>
                                  最古{c.oldest_review_days_ago}日前
                                </span>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="p-2 text-center">
                        <span className={cn('font-bold', c.owner_reachability_score >= 80 ? 'text-green-600' : c.owner_reachability_score >= 50 ? 'text-amber-600' : 'text-red-600')}>
                          {c.owner_reachability_score}
                        </span>
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-0.5">
                          {c.is_chain_store && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">チェーン</span>}
                          {c.is_in_shopping_mall && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">施設内</span>}
                          {c.is_in_station_building && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">駅ビル</span>}
                          {c.is_large_company_branch && <span className="rounded-sm bg-zinc-200 px-1 text-[9px] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">支店</span>}
                          {c.should_exclude_from_call_list && <span className="rounded-sm bg-red-100 px-1 text-[9px] text-red-700 dark:bg-red-500/20 dark:text-red-300">投入不可</span>}
                          {c.duplicate_of_case_id && <span className="rounded-sm bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">重複</span>}
                          {c.exclusion_reason && <div className="w-full text-[9px] text-muted-foreground">{c.exclusion_reason}</div>}
                        </div>
                      </td>
                      <td className="max-w-[300px] p-2">
                        {c.review_newness_reason && <div className="text-[10px] text-sky-700 dark:text-sky-300">口コミ日付: {c.review_newness_reason}</div>}
                        {c.newness_reason && <div className="text-[10px] text-green-700 dark:text-green-300">新規理由: {c.newness_reason}</div>}
                        <div className="mt-0.5 line-clamp-3 text-[10px] text-muted-foreground" title={c.ai_comment ?? ''}>{c.ai_comment}</div>
                        {renderHotReject(c)}
                      </td>
                      <td className="whitespace-nowrap p-2 text-center text-muted-foreground">{moment(c.first_seen_at).format('MM/DD')}</td>
                      <td className="p-2 text-center">
                        {c.imported_to_cases
                          ? <span className="inline-flex items-center gap-0.5 text-green-600"><CheckCircle2 className="h-3 w-3" />投入済</span>
                          : <span className="text-muted-foreground">未投入</span>}
                      </td>
                      <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
                        {c.imported_to_cases ? (
                          <span className="text-[9px] text-muted-foreground">{c.imported_at ? moment(c.imported_at).format('MM/DD HH:mm') : ''}</span>
                        ) : c.duplicate_of_case_id ? (
                          <span className="text-[9px] text-muted-foreground">重複のため不可</span>
                        ) : c.lead_temperature === 'EXCLUDED' ? (
                          <button className="rounded border px-1.5 py-0.5 text-[9px] text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-500/10" onClick={() => handleManualImport(c, true)}>除外解除して投入</button>
                        ) : (
                          <button className="rounded border border-primary px-1.5 py-0.5 text-[9px] text-primary hover:bg-primary/10" onClick={() => handleManualImport(c)}>
                            {c.lead_temperature === 'HOT' ? 'casesへ投入' : '保留から投入'}
                          </button>
                        )}
                        {c.lead_temperature !== 'HOT' && c.hot_blocking_reason && !c.imported_to_cases && (
                          <div className="mt-0.5 text-[9px] text-amber-600 dark:text-amber-300" title={c.hot_reject_summary ?? ''}>HOLD理由: {c.hot_blocking_reason}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </>)}

          {/* ===== 統合トリアージタブ ===== */}
          {mainView === 'triage' && (() => {
            const gradeColor: Record<string, string> = { S: 'bg-purple-600 text-white', A: 'bg-rose-600 text-white', B: 'bg-amber-500 text-white', C: 'bg-slate-400 text-white', D: 'bg-zinc-300 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300' }
            const gradeDist: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 }
            for (const c of triageList as any[]) gradeDist[c.quality_grade || 'D'] = (gradeDist[c.quality_grade || 'D'] || 0) + 1
            const Btn = ({ on, children, onClick }: any) => <button onClick={onClick} className={cn('rounded border px-2 py-0.5 text-[11px]', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card hover:bg-accent')}>{children}</button>
            return (
            <div className="space-y-3">
              {/* 操作バー */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2">
                <Button size="sm" onClick={() => buildCallList(30)} className="bg-rose-600 hover:bg-rose-700">📞 今日の架電リストを作成（重複除去・高品質30件）</Button>
                <Button size="sm" variant="outline" onClick={() => exportCsv(triageList, `leads_${moment().format('YYYYMMDD_HHmm')}.csv`)}>⬇ 絞り込み結果をCSV出力（{triageList.length}件）</Button>
                <Button size="sm" variant="outline" onClick={runQualityRecompute} disabled={qualityRunning}>{qualityRunning ? '再計算中...' : '品質を再計算'}</Button>
                <Button size="sm" variant="outline" onClick={autoExcludeBad} disabled={qualityRunning} className="border-red-400 text-red-600">閉店/移転を自動除外</Button>
                <div className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                  {(['S', 'A', 'B', 'C', 'D'] as const).map((g) => <span key={g} className={cn('rounded px-1.5 py-0.5 font-bold', gradeColor[g])}>{g} {gradeDist[g]}</span>)}
                </div>
              </div>

              {/* フィルタ */}
              <div className="space-y-1.5 rounded-xl border bg-card p-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">温度:</span>
                  {(['HOT', 'HOLD', 'EXCLUDED', 'all'] as const).map((t) => <Btn key={t} on={tTemp === t} onClick={() => setTTemp(t)}>{t === 'all' ? '全て' : t}</Btn>)}
                  <span className="ml-2 text-muted-foreground">グレード:</span>
                  {(['all', 'S', 'A', 'B', 'C', 'D'] as const).map((g) => <Btn key={g} on={tGrade === g} onClick={() => setTGrade(g)}>{g === 'all' ? '全' : g}</Btn>)}
                  <span className="ml-2 text-muted-foreground">電話:</span>
                  {([['yes', 'あり'], ['fixed', '固定のみ'], ['no', 'なし'], ['all', '全']] as const).map(([k, l]) => <Btn key={k} on={tPhone === k} onClick={() => setTPhone(k as any)}>{l}</Btn>)}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">業種:</span>
                  {(['all', '飲食', '美容・サロン', '医療・治療', '小売・物販', '暮らし・サービス', '宿泊・観光', 'その他'] as const).map((c) => <Btn key={c} on={tCat === c} onClick={() => setTCat(c)}>{c === 'all' ? '全' : c}</Btn>)}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">営業優先度:</span>
                  {(['all', 'S', 'A', 'B', 'C'] as const).map((g) => <Btn key={g} on={tSalesGrade === g} onClick={() => setTSalesGrade(g)}>{g === 'all' ? '全' : g}</Btn>)}
                  <span className="ml-2 text-muted-foreground">Web:</span>
                  {([['all', '全'], ['none', 'HPなし'], ['instagram_only', 'IGのみ'], ['builder', '簡易HP'], ['own_domain', '独自']] as const).map(([k, l]) => <Btn key={k} on={tWebsite === k} onClick={() => setTWebsite(k)}>{l}</Btn>)}
                  <span className="ml-2 text-muted-foreground">取得元:</span>
                  <select value={tSource} onChange={(e) => setTSource(e.target.value)} className="rounded border border-input bg-background px-1 py-0.5 text-[11px]">
                    <option value="all">全て</option>
                    {Array.from(new Set(candidates.map((c: any) => c.discovery_source_type || c.source || c.lead_source).filter(Boolean))).map((s: any) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">都道府県:</span>
                  <select value={tPref} onChange={(e) => setTPref(e.target.value)} className="rounded border border-input bg-background px-1 py-0.5 text-[11px]">
                    <option value="all">全て</option>
                    {prefList.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <span className="ml-2 text-muted-foreground">並び:</span>
                  {([['sales', '営業優先順'], ['quality', '品質順'], ['priority', '架電優先順'], ['newest', '新着順']] as const).map(([k, l]) => <Btn key={k} on={tSort === k} onClick={() => setTSort(k as any)}>{l}</Btn>)}
                  <label className="ml-2 flex items-center gap-1"><input type="checkbox" checked={tNotImported} onChange={(e) => setTNotImported(e.target.checked)} />未投入のみ</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={tDup} onChange={(e) => setTDup(e.target.checked)} />重複のみ</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={tFlagged} onChange={(e) => setTFlagged(e.target.checked)} />要注意のみ</label>
                  <input value={tSearch} onChange={(e) => setTSearch(e.target.value)} placeholder="店名/住所/電話で検索" className="ml-1 w-40 rounded border border-input bg-background px-2 py-0.5 text-[11px]" />
                </div>
              </div>

              {/* 取得元別の歩留まり */}
              <details className="rounded-xl border bg-card p-2 text-[11px]">
                <summary className="cursor-pointer font-bold">取得元別の歩留まり（品質平均・HOT率・投入率）</summary>
                <table className="mt-1 w-full">
                  <thead className="text-muted-foreground"><tr className="text-left"><th className="py-0.5">取得元</th><th>件数</th><th>HOT</th><th>投入済</th><th>品質平均</th></tr></thead>
                  <tbody>{sourceYield.map((s) => <tr key={s.source} className="border-t border-border/40"><td className="py-0.5">{s.source}</td><td>{s.total}</td><td>{s.hot}</td><td>{s.imported}</td><td><span className={cn('rounded px-1 font-bold', s.avgQ >= 65 ? 'text-emerald-600' : s.avgQ >= 50 ? 'text-amber-600' : 'text-muted-foreground')}>{s.avgQ}</span></td></tr>)}</tbody>
                </table>
              </details>

              {/* バルクアクションバー */}
              {selectedIds.size > 0 && (
                <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-primary bg-primary/10 p-2 text-xs backdrop-blur">
                  <span className="font-bold">{selectedIds.size}件 選択中</span>
                  <Button size="sm" onClick={bulkInject} disabled={bulkBusy} className="bg-emerald-600 hover:bg-emerald-700">案件に一括投入</Button>
                  <Button size="sm" variant="outline" onClick={() => bulkSetTemp('EXCLUDED')} disabled={bulkBusy}>一括除外</Button>
                  <Button size="sm" variant="outline" onClick={() => bulkSetTemp('HOLD')} disabled={bulkBusy}>一括保留</Button>
                  <Button size="sm" variant="outline" onClick={() => exportCsv(selectedCands, `callist_${moment().format('YYYYMMDD_HHmm')}.csv`)}>選択をCSV出力</Button>
                  <button onClick={clearSel} className="ml-auto text-[11px] text-muted-foreground hover:underline">選択解除</button>
                </div>
              )}

              {/* リスト */}
              <div className="overflow-x-auto rounded-xl border bg-card">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr className="text-left">
                      <th className="w-8 px-2 py-1"><input type="checkbox" checked={triageVisible.length > 0 && triageVisible.every((c: any) => selectedIds.has(c.id))} onChange={(e) => e.target.checked ? selectAllVisible() : clearSel()} /></th>
                      <th className="px-1 py-1">営業</th><th className="px-1">品質</th><th className="px-1">温度</th><th className="px-2">店名</th><th className="px-2">電話</th><th className="px-2">住所</th><th className="px-1">業種</th><th className="px-1">Web</th><th className="px-1">注意</th>
                    </tr>
                  </thead>
                  <tbody>
                    {triageVisible.map((c: any) => (
                      <tr key={c.id} className={cn('border-t border-border/40 hover:bg-accent/40', selectedIds.has(c.id) && 'bg-primary/5')}>
                        <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSel(c.id)} /></td>
                        <td className="px-1 py-1 cursor-pointer" onClick={() => setDrawerCand(c)}>{c.sales_priority_grade ? <span className={cn('rounded px-1 py-0.5 font-bold', c.sales_priority_grade === 'S' ? 'bg-purple-600 text-white' : c.sales_priority_grade === 'A' ? 'bg-rose-600 text-white' : c.sales_priority_grade === 'B' ? 'bg-amber-500 text-white' : 'bg-zinc-300 text-zinc-700 dark:bg-zinc-700')} title={`営業優先度 ${c.sales_priority_score ?? ''}`}>{c.sales_priority_grade}</span> : <span className="text-muted-foreground">-</span>}{c.call_memo && <span className="ml-0.5" title="架電前メモあり">📝</span>}</td>
                        <td className="px-1 py-1 cursor-pointer" onClick={() => setDrawerCand(c)}><span className={cn('rounded px-1 py-0.5 font-bold', gradeColor[c.quality_grade || 'D'])}>{c.quality_grade || '-'}</span> <span className="text-muted-foreground">{c.quality_score ?? '-'}</span></td>
                        <td className="px-1 cursor-pointer" onClick={() => setDrawerCand(c)}><span className="rounded px-1 py-0.5 text-[10px]" style={{ background: (LEAD_TEMP_COLORS as any)[c.lead_temperature]?.bg, color: (LEAD_TEMP_COLORS as any)[c.lead_temperature]?.fg }}>{c.lead_temperature}{c.hot_tier ? `-${c.hot_tier}` : ''}</span></td>
                        <td className="max-w-[180px] truncate px-2 cursor-pointer" onClick={() => setDrawerCand(c)} title={c.name}>{c.name || '（店名未確定）'}{c.dup_group_size > 1 && <span className="ml-1 rounded bg-orange-200 px-1 text-[9px] text-orange-800 dark:bg-orange-500/30 dark:text-orange-200">重複{c.dup_group_size}</span>}</td>
                        <td className="px-2 cursor-pointer" onClick={() => setDrawerCand(c)}>{c.phone_number || c.extracted_phone || <span className="text-red-500">なし</span>}{c.phone_pref_match === 'mismatch' && <span className="ml-1 text-[9px] text-red-500" title="市外局番が住所と不一致">⚠地域</span>}</td>
                        <td className="max-w-[200px] truncate px-2 cursor-pointer" onClick={() => setDrawerCand(c)} title={c.address}>{c.address || c.extracted_address || ''}</td>
                        <td className="px-1 text-muted-foreground">{c.industry_category || ''}</td>
                        <td className="px-1 text-muted-foreground" title={c.seo_weakness_reason || ''}>{c.website_status === 'none' ? 'HPなし' : c.website_status === 'instagram_only' ? 'IGのみ' : c.website_status === 'builder' ? `簡易(${c.website_type})` : c.website_status === 'linktree' ? 'リンク集' : c.website_status === 'own_domain' ? '独自' : ''}</td>
                        <td className="px-1">{Array.isArray(c.quality_flags) && c.quality_flags.length > 0 && <span className="rounded bg-red-100 px-1 text-[9px] text-red-700 dark:bg-red-500/20 dark:text-red-300" title={c.quality_flags.join(' / ')}>⚠{c.quality_flags.length}</span>}</td>
                      </tr>
                    ))}
                    {triageVisible.length === 0 && <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">条件に一致する候補がありません。フィルタを緩めてください。</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-center gap-2 text-[11px]">
                <span className="text-muted-foreground">{triageVisible.length} / {triageList.length} 件表示</span>
                {tShown < triageList.length && <button onClick={() => setTShown((s) => s + 60)} className="rounded border border-input px-2 py-0.5 hover:bg-accent">もっと見る (+60)</button>}
              </div>
            </div>
            )
          })()}

          {/* ===== エラー/ログタブ ===== */}
          {mainView === 'errors' && (
            <div className="space-y-2 rounded-xl border bg-card p-3 text-xs">
              <div className="font-bold">取得処理のエラー / ログ</div>
              {sourceErrors.length === 0 ? <div className="text-muted-foreground">現在エラーはありません。各取得元を実行するとここに失敗理由・APIエラー・保存失敗などが表示されます。</div> : (
                sourceErrors.map((e, i) => (
                  <div key={i} className="rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                    <div className="font-bold">{e.label} でエラー</div>
                    <div>原因/詳細：{e.msg}</div>
                    <div className="mt-0.5 text-[10px] opacity-80">対応：APIキー・レート制限・設定を確認し、各タブの「実行」で再試行してください。</div>
                  </div>
                ))
              )}
              <label className="mt-1 flex items-center gap-2 text-[11px]">
                <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />開発者モード（HTML文字数・parser_used・APIレスポンス・SKIP内訳などのデバッグ情報を表示）
              </label>
              {devMode && (
                <div className="space-y-1 text-[10px] text-muted-foreground">
                  <div>Google Places debug: {gpResult ? `取得${gpResult.fetched ?? 0} / 保存${gpResult.saved ?? 0} / SKIP${gpResult.skipped ?? 0}` : '—'}</div>
                  <div>Instagram Web debug: {iwResult ? `クエリ${iwResult.queries ?? 0} / 取得${iwResult.results ?? 0} / 保存${iwResult.saved ?? 0} / 検索失敗${iwResult.errorCount ?? 0}` : '—'}</div>
                  <div>地域メディア debug: {rmResult ? `サイト${rmResult.sites ?? 0} / 保存${rmResult.saved ?? 0} / HOT${rmResult.hot ?? 0}` : '—'}</div>
                  <div>連番URL探索 debug: {probeResult ? `probed${probeResult.probed ?? 0} / valid${probeResult.valid ?? 0} / 文字化け${probeResult.mojibake ?? 0}` : '—'}</div>
                </div>
              )}
            </div>
          )}

          {/* 連番ソース 追加/編集モーダル */}
          {probeFormOpen && probeForm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setProbeFormOpen(false)}>
              <div className="absolute inset-0 bg-black/40" />
              <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-card p-4 text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-bold">{probeFormEditId ? `連番ソースを編集：${probeForm.name || ''}` : '連番ソースを追加'}</div>
                  <button onClick={() => setProbeFormOpen(false)} className="rounded border px-2 py-0.5 text-[11px] hover:bg-accent">閉じる</button>
                </div>
                <div className="space-y-2">
                  <div><Label>サイト名</Label><Input value={probeForm.name} onChange={(e) => setProbeForm({ ...probeForm, name: e.target.value })} placeholder="じゃらん観光スポット" className="h-8" /></div>
                  <div><Label>URLテンプレート（{'{ID}'} に連番IDを差し込み）</Label><Input value={probeForm.url_template} onChange={(e) => setProbeForm({ ...probeForm, url_template: e.target.value })} placeholder="https://tabelog.com/saitama/A1101/A110102/{ID}" className="h-8 font-mono" /></div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Label>地域ラベル</Label><Input value={probeForm.region_label} onChange={(e) => setProbeForm({ ...probeForm, region_label: e.target.value })} placeholder="埼玉" className="h-8" /></div>
                    <div><Label>都道府県</Label><Input value={probeForm.prefecture} onChange={(e) => setProbeForm({ ...probeForm, prefecture: e.target.value })} placeholder="埼玉県" className="h-8" /></div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><Label>開始ID</Label><Input value={probeForm.start_probe_id} onChange={(e) => setProbeForm({ ...probeForm, start_probe_id: e.target.value })} placeholder="231369" className="h-8" /></div>
                    <div><Label>ID桁数</Label><Input type="number" value={probeForm.id_padding} onChange={(e) => setProbeForm({ ...probeForm, id_padding: Number(e.target.value) })} className="h-8" /></div>
                    <div><Label>探索方向</Label><select value={probeForm.scan_direction} onChange={(e) => setProbeForm({ ...probeForm, scan_direction: e.target.value })} className="h-8 w-full rounded border border-input bg-card px-2 text-sm"><option value="forward">昇順</option><option value="backward">降順</option></select></div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><Label>1回の探索件数</Label><Input type="number" value={probeForm.forward_scan_count} onChange={(e) => setProbeForm({ ...probeForm, forward_scan_count: Number(e.target.value) })} className="h-8" /></div>
                    <div><Label>1日最大件数</Label><Input type="number" value={probeForm.max_probe_per_run} onChange={(e) => setProbeForm({ ...probeForm, max_probe_per_run: Number(e.target.value) })} className="h-8" /></div>
                    <div><Label>parser_type</Label><select value={probeForm.parser_type} onChange={(e) => setProbeForm({ ...probeForm, parser_type: e.target.value })} className="h-8 w-full rounded border border-input bg-card px-2 text-sm">{['generic_detail_page', 'jalan_spot_detail', 'tabelog_detail', 'epark_detail', 'hotpepper_detail', 'custom'].map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
                  </div>
                  <div><Label>有効ページ判定キーワード（|区切り）</Label><Input value={probeForm.valid_page_pattern} onChange={(e) => setProbeForm({ ...probeForm, valid_page_pattern: e.target.value })} placeholder="名称|所在地|お問い合わせ|基本情報" className="h-8" /></div>
                  <div><Label>無効ページ判定キーワード（|区切り）</Label><Input value={probeForm.invalid_page_pattern} onChange={(e) => setProbeForm({ ...probeForm, invalid_page_pattern: e.target.value })} placeholder="該当観光スポット情報は存在しません|ページが見つかりません|404" className="h-8" /></div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1"><input type="checkbox" checked={probeForm.is_active} onChange={(e) => setProbeForm({ ...probeForm, is_active: e.target.checked })} />有効</label>
                    <select value={probeForm.probe_mode} onChange={(e) => setProbeForm({ ...probeForm, probe_mode: e.target.value })} className="h-7 rounded border border-input bg-card px-2 text-[11px]"><option value="safe">安全確認モード</option><option value="advance">先行探索モード</option></select>
                  </div>
                  {/* 生成URLプレビュー */}
                  {probePreviewUrl() && <div className="rounded bg-muted/40 p-1.5 text-[10px]">生成URL: <a href={probePreviewUrl()} target="_blank" rel="noreferrer" className="break-all font-mono text-primary hover:underline">{probePreviewUrl()}</a></div>}
                  {/* テスト結果 */}
                  {probeFormTest && (
                    <div className="rounded border bg-muted/40 p-1.5 text-[10px]">
                      <div className={cn('font-bold', probeFormTest.summary?.parserOk ? 'text-green-600' : 'text-red-600')}>テスト: {probeFormTest.summary?.parserOk ? '保存可能（抽出OK）' : '抽出NG（parser/パターン要確認）'}</div>
                      {(probeFormTest.items || []).map((it: any, i: number) => (
                        <div key={i} className="mt-0.5 border-t pt-0.5">
                          <span className={cn('rounded px-1 font-bold', it.probeStatus === 'valid' ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : it.probeStatus === 'invalid' ? 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300')}>{it.probeStatus || (it.valid ? 'valid' : 'invalid')}</span>
                          {' '}HTTP{it.status}{it.rendered ? ' [rendered]' : ''} / 名称:{it.name || '—'} / 住所:{it.address || '—'} / 電話:{it.phone || '—'} / parser:{it.parser_used} / 保存可:{it.saveable ? '✓' : '×'}{it.invalidReason ? ` / 理由:${it.invalidReason}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 入力例 */}
                  <details className="text-[10px] text-muted-foreground"><summary className="cursor-pointer">入力例（じゃらん）</summary><div className="mt-1">サイト名: じゃらん観光スポット / URL: https://www.jalan.net/kankou/spt_guide{'{ID}'}/ / 開始ID: 231369 / ID桁数: 12 / parser: jalan_spot_detail / 有効: 名称, 所在地, お問い合わせ / 無効: 該当観光スポット情報は存在しません, 404</div></details>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={testProbeForm} disabled={!probeForm.url_template?.includes('{ID}')}>このURLでテスト</Button>
                    <Button size="sm" onClick={() => saveProbeForm(false)}>{probeFormEditId ? '更新する' : '追加する'}</Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 候補 詳細ドロワー */}
          {drawerCand && (
            <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setDrawerCand(null)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="relative h-full w-full max-w-md overflow-y-auto border-l bg-card p-4 text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-2 flex items-center justify-between">
                  <span className={cn('rounded px-2 py-0.5 font-bold', LEAD_TEMP_COLORS[drawerCand.lead_temperature])}>{drawerCand.lead_temperature === 'HOT' && drawerCand.hot_tier ? `HOT-${drawerCand.hot_tier}` : drawerCand.lead_temperature}</span>
                  <span className={cn('rounded px-2 py-0.5 font-bold', callPriority(drawerCand) >= 70 ? 'bg-rose-500 text-white' : callPriority(drawerCand) >= 45 ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : 'bg-muted text-muted-foreground')}>架電優先度 {callPriority(drawerCand)}</span>
                  <button onClick={() => setDrawerCand(null)} className="rounded border px-2 py-0.5 text-[11px] hover:bg-accent">閉じる</button>
                </div>
                <div className="text-base font-bold">{drawerCand.name}{(drawerCand as any).name_unconfirmed_hot && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">要店名確認</span>}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>検出: {(() => { const t = (drawerCand as any).first_seen_at || (drawerCand as any).first_discovered_at || (drawerCand as any).regional_media_detected_at || (drawerCand as any).created_date; return t ? moment(t).format('YYYY/MM/DD HH:mm') : '—' })()}</span>
                  {(drawerCand as any).imported_to_cases
                    ? <span className="text-emerald-600 dark:text-emerald-400">投入: {(drawerCand as any).imported_at ? moment((drawerCand as any).imported_at).format('YYYY/MM/DD HH:mm') : '済'}</span>
                    : <span>投入: 未投入</span>}
                  <span>取得元: {(drawerCand as any).discovery_source_type || (drawerCand as any).source || (drawerCand as any).lead_source || '—'}</span>
                </div>
                {/* 品質サマリー */}
                {typeof (drawerCand as any).quality_score === 'number' && (() => {
                  const g = (drawerCand as any).quality_grade || 'D'
                  const gc: Record<string, string> = { S: 'bg-purple-600 text-white', A: 'bg-rose-600 text-white', B: 'bg-amber-500 text-white', C: 'bg-slate-400 text-white', D: 'bg-zinc-300 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300' }
                  const flags = Array.isArray((drawerCand as any).quality_flags) ? (drawerCand as any).quality_flags : []
                  return (
                    <div className="mt-1.5 rounded-lg border bg-muted/30 p-2 text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className={cn('rounded px-2 py-0.5 text-sm font-bold', gc[g])}>{g}</span>
                        <span className="text-lg font-bold">{(drawerCand as any).quality_score}</span>
                        <span className="text-muted-foreground">品質スコア</span>
                        {(drawerCand as any).industry_category && <span className="rounded bg-background px-1.5 py-0.5">{(drawerCand as any).industry_category}</span>}
                        {(drawerCand as any).phone_pref_match === 'match' && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">電話×住所 地域一致</span>}
                        {(drawerCand as any).phone_pref_match === 'mismatch' && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">⚠ 市外局番が住所と不一致</span>}
                        {(drawerCand as any).dup_group_size > 1 && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">重複{(drawerCand as any).dup_group_size}件</span>}
                      </div>
                      {flags.length > 0 && <ul className="mt-1 list-disc pl-4 text-red-600 dark:text-red-400">{flags.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul>}
                    </div>
                  )
                })()}
                {/* 営業優先度＋Web弱点 */}
                {(drawerCand as any).sales_priority_grade && (
                  <div className="mt-1.5 rounded-lg border border-emerald-300 bg-emerald-50/50 p-2 text-[11px] dark:border-emerald-500/30 dark:bg-emerald-500/10">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('rounded px-2 py-0.5 text-sm font-bold', (drawerCand as any).sales_priority_grade === 'S' ? 'bg-purple-600 text-white' : (drawerCand as any).sales_priority_grade === 'A' ? 'bg-rose-600 text-white' : (drawerCand as any).sales_priority_grade === 'B' ? 'bg-amber-500 text-white' : 'bg-zinc-300 text-zinc-700 dark:bg-zinc-700')}>営業{(drawerCand as any).sales_priority_grade}</span>
                      <span className="font-bold">{(drawerCand as any).sales_priority_score}</span>
                      <span className="text-muted-foreground">新規{(drawerCand as any).newness_score ?? '-'}/連絡{(drawerCand as any).contactability_score ?? '-'}/Web弱{(drawerCand as any).website_weakness_score ?? '-'}/投資{(drawerCand as any).budget_likelihood_score ?? '-'}</span>
                      {(drawerCand as any).signal_count > 0 && <span className="rounded bg-emerald-200 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-500/30 dark:text-emerald-200">シグナル{(drawerCand as any).signal_count}</span>}
                    </div>
                    {(drawerCand as any).hp_sales_angle && <div className="mt-1 text-muted-foreground">提案角度: {(drawerCand as any).hp_sales_angle}</div>}
                  </div>
                )}
                {(drawerCand as any).call_memo && (
                  <details className="mt-1.5 rounded-lg border bg-muted/30 p-2 text-[11px]" open>
                    <summary className="cursor-pointer font-bold">📝 架電前メモ（AI生成）</summary>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-[10px] leading-relaxed">{(drawerCand as any).call_memo}</pre>
                  </details>
                )}
                {(drawerCand as any).name_unconfirmed_hot && (
                  <div className="mt-1 rounded border border-amber-300 bg-amber-50 p-1.5 text-[10px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    店名未確定ですが、電話番号・住所・新店根拠があるため営業可能候補(HOT-B)です。<b>営業前に店名をご確認ください。</b>
                  </div>
                )}
                {(drawerCand as any).source_article_title && <div className="mt-1 text-[10px] text-muted-foreground">記事タイトル: {(drawerCand as any).source_article_title}</div>}
                {(drawerCand as any).source_date_type === 'ekiten_published_date' && (() => {
                  const pub = (drawerCand as any).source_published_date
                  const days = pub ? Math.floor((Date.now() - Date.parse(String(pub).replace(/\//g, '-'))) / 86400000) : null
                  return (
                    <div className="mt-1 rounded border border-pink-300 bg-pink-50 p-1.5 text-[10px] text-pink-800 dark:border-pink-500/30 dark:bg-pink-500/10 dark:text-pink-200">
                      <div>エキテン公開日: <b>{pub || '不明'}</b>{days != null && <>（{days}日前{days <= 7 ? '・直近7日以内の新規掲載候補' : '・8日以上前'}）</>}</div>
                      {(drawerCand as any).source_updated_date && <div>最終更新日: {(drawerCand as any).source_updated_date}</div>}
                      <div className="font-bold">※公開日は開業日ではなく、エキテン上の掲載公開日です。営業前に確認推奨。</div>
                    </div>
                  )
                })()}
                {((drawerCand as any).has_opening_date_badge || (drawerCand as any).is_new_gbp_priority) && (
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                    {(drawerCand as any).has_opening_date_badge && <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 font-bold text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">Google開業日 {(drawerCand as any).google_opening_date_year || ''}{(drawerCand as any).google_opening_date_month ? `年${(drawerCand as any).google_opening_date_month}月` : ''}{(drawerCand as any).opening_date_band === 'future' ? '（開業予定）' : ''}</span>}
                    {(drawerCand as any).is_new_gbp_priority && <span className="rounded bg-pink-100 px-1.5 py-0.5 font-bold text-pink-700 dark:bg-pink-500/20 dark:text-pink-300">新規GBP優先（登録直後の可能性・成約率高）</span>}
                  </div>
                )}
                <div className="mb-2 text-muted-foreground">{drawerCand.industry || '業種不明'}{drawerCand.extracted_area ? ` ・ ${drawerCand.extracted_area}` : ''}</div>
                <dl className="space-y-1">
                  {[['電話番号', drawerCand.phone_number], ['電話番号取得元', (drawerCand as any).phone_source === 'login_required' ? 'ログイン制限のため取得不可' : (drawerCand as any).phone_source === 'detail_page' ? '詳細ページ' : (drawerCand as any).phone_source === 'enrich' ? '検索補完(Places/公式)' : (drawerCand as any).phone_source], ['住所', drawerCand.address], ['取得元', drawerCand.lead_source], ['詳細取得モード', (drawerCand as any).detail_rendering_mode], ['parser_used', (drawerCand as any).parser_used], ['補完元電話', (drawerCand as any).enriched_phone_source], ['補完元住所', (drawerCand as any).enriched_address_source], ['新店根拠', drawerCand.newness_reason || (drawerCand as any).regional_media_newness_reason], ['HOT理由/未達', drawerCand.hot_reject_summary], ['AIコメント', drawerCand.ai_comment], ['スコア', (drawerCand as any).match_confidence ?? drawerCand.owner_reachability_score], ['状態', drawerCand.imported_to_cases ? '案件投入済' : '未投入'], ['重複', drawerCand.duplicate_of_case_id ? 'あり' : 'なし']].map(([k, v]) => (
                    <div key={String(k)} className="grid grid-cols-3 gap-2 border-b pb-0.5"><dt className="text-muted-foreground">{k}</dt><dd className="col-span-2 break-words">{v ? String(v) : '—'}</dd></div>
                  ))}
                  {[['店名の取得元', (drawerCand as any).shop_name_source === 'instagram_profile' ? 'Instagramプロフィール' : (drawerCand as any).shop_name_source === 'post_title' ? '投稿タイトル（要確認）' : (drawerCand as any).shop_name_source], ['投稿タイトル', (drawerCand as any).source_post_title], ['補完信頼度', (drawerCand as any).enrichment_confidence], ['地域矛盾', (drawerCand as any).enrichment_region_conflict ? 'あり' : 'なし']].map(([k, v]) => v != null && v !== '' ? (
                    <div key={String(k)} className="grid grid-cols-3 gap-2 border-b pb-0.5"><dt className="text-muted-foreground">{k}</dt><dd className="col-span-2 break-words">{String(v)}</dd></div>
                  ) : null)}
                  {[['元URL', (drawerCand as any).source_detail_url || (drawerCand as any).source_article_url], ['Instagram', drawerCand.instagram_url], ['Google Maps', (drawerCand as any).enriched_google_maps_url || (drawerCand as any).map_url], ['公式', drawerCand.official_url || drawerCand.website_url]].map(([k, v]) => v ? (
                    <div key={String(k)} className="grid grid-cols-3 gap-2 border-b pb-0.5"><dt className="text-muted-foreground">{k}</dt><dd className="col-span-2"><a href={String(v)} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">{String(v).slice(0, 60)}</a></dd></div>
                  ) : null)}
                </dl>
                {(drawerCand as any).lead_source === 'sequential_id_probe' && (
                  <div className="mt-2 rounded border bg-muted/30 p-2 text-[11px]">
                    <div className="mb-0.5 font-bold">連番URL探索 抽出元</div>
                    {(() => { const pu = (drawerCand as any).parser_used || ''; const src = pu === 'tabelog_detail' ? '食べログ詳細ページ（h1 / og:title / title）' : pu === 'jalan_spot_detail' ? 'じゃらん基本情報テーブル' : pu || '—'; return (
                      <dl className="space-y-0.5">
                        {[['店名取得元', src], ['電話番号取得元', (drawerCand as any).phone_number ? (pu === 'tabelog_detail' ? '食べログ詳細ページ' : pu === 'jalan_spot_detail' ? 'じゃらん詳細ページ' : '詳細ページ') : '—'], ['住所取得元', (drawerCand as any).address ? (pu === 'tabelog_detail' ? '食べログ詳細ページ' : pu === 'jalan_spot_detail' ? 'じゃらん詳細ページ' : '詳細ページ') : '—'], ['parser_used', pu || '—'], ['探索ID', (drawerCand as any).probed_id ?? '—']].map(([k, v]) => (
                          <div key={String(k)} className="grid grid-cols-3 gap-2"><dt className="text-muted-foreground">{k}</dt><dd className="col-span-2 break-words">{String(v)}</dd></div>
                        ))}
                      </dl>
                    ) })()}
                  </div>
                )}
                {Array.isArray((drawerCand as any).enrichment_rejected) && (drawerCand as any).enrichment_rejected.length > 0 && (
                  <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    <div className="font-bold">採用しなかった補完候補</div>
                    {(drawerCand as any).enrichment_rejected.map((rj: any, i: number) => (
                      <div key={i}>{rj.field === 'phone' ? '電話' : rj.field === 'address' ? '住所' : rj.field}: {rj.value} — 理由: {rj.reason}</div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {!drawerCand.imported_to_cases && drawerCand.lead_temperature !== 'EXCLUDED' && <Button size="sm" onClick={() => { handleManualImport(drawerCand); setDrawerCand(null) }}>{drawerCand.lead_temperature === 'HOT' ? '案件投入' : '手動投入'}</Button>}
                  {drawerCand.lead_temperature === 'EXCLUDED' && <Button size="sm" variant="outline" onClick={() => { handleManualImport(drawerCand, true); setDrawerCand(null) }}>除外解除して投入</Button>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

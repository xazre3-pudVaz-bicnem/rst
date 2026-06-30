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
  const [sourceTab, setSourceTab] = useState<'places' | 'instagram' | 'regional' | 'iw'>('places')
  const [iwConfigured, setIwConfigured] = useState<boolean | null>(null)
  const [iwDiag, setIwDiag] = useState<any>(null)
  const [iwRunning, setIwRunning] = useState(false)
  const [iwResult, setIwResult] = useState<any>(null)
  const [rmConfigured, setRmConfigured] = useState<boolean | null>(null)
  const [rmDiag, setRmDiag] = useState<any>(null)
  const [rmRunning, setRmRunning] = useState(false)
  const [rmResult, setRmResult] = useState<any>(null)
  // 巡回サイト管理
  const [rmSites, setRmSites] = useState<any[]>([])
  const [rmCounts, setRmCounts] = useState<{ total: number; active: number; inactive: number }>({ total: 0, active: 0, inactive: 0 })
  const [rmSitesErr, setRmSitesErr] = useState<string | null>(null)
  const [rmBusy, setRmBusy] = useState(false)
  const [siteForm, setSiteForm] = useState<any>(null) // {id?, name, base_url, list_url, media_family, source_type, category_label, is_active, reliability_score, crawl_interval_hours}
  const [siteTests, setSiteTests] = useState<Record<string, any>>({})
  const [allTest, setAllTest] = useState<any>(null)

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

  async function runRegional() {
    if (!settings.regionalEnabled) { toast.error('設定で地域メディア取得がOFFです'); return }
    setRmRunning(true); setRmResult(null)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      if (!token) { toast.error('ログインが必要です'); return }
      const res = await fetch('/api/leads/regional-media/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            regionalEnabled: settings.regionalEnabled, maxSitesPerDay: settings.regionalMaxSites,
            maxArticlesPerSite: settings.regionalMaxArticles, periodDays: settings.regionalPeriodDays, dailyCap: settings.dailyCap,
            regionalEnrichEnabled: settings.regionalEnrichEnabled, regionalEnrichMaxQueries: settings.regionalEnrichMaxQueries,
            regionalEnrichPerQuery: settings.regionalEnrichPerQuery, regionalEnrichDailyCap: settings.regionalEnrichDailyCap,
          },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(json.error || '地域メディア取得に失敗しました'); setRmResult({ error: json.error }); return }
      setRmResult(json)
      toast.success(`地域メディア完了: 記事${json.newArticles ?? 0} / HOT${json.hot ?? 0} / 投入${json.imported ?? 0}`)
      load(); loadRuns()
    } catch (e) {
      toast.error('実行に失敗しました: ' + jpError(e))
    } finally { setRmRunning(false) }
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
            iwAutoImport: settings.iwAutoImport, iwRequirePhone: settings.iwRequirePhone, iwPlacesRequired: settings.iwPlacesRequired,
            iwAnthropic: settings.iwAnthropic, iwMaxQueriesPerDay: settings.iwMaxQueriesPerDay, iwPerQuery: settings.iwPerQuery,
            iwMaxRunsPerDay: settings.iwMaxRunsPerDay, iwPerRun: settings.iwPerRun, iwAnthropicDailyCap: settings.iwAnthropicDailyCap,
            iwEnrichEnabled: settings.iwEnrichEnabled, iwEnrichMaxQueries: settings.iwEnrichMaxQueries, iwEnrichPerQuery: settings.iwEnrichPerQuery, iwEnrichDailyCap: settings.iwEnrichDailyCap,
            dailyCap: settings.dailyCap,
          },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(json.error || 'Instagram Web検索に失敗しました'); setIwResult({ error: json.error }); return }
      setIwResult(json)
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

  const emptySite = { name: '', base_url: '', list_url: '', media_family: 'other', source_type: 'html_list', category_label: '開店閉店', is_active: true, reliability_score: 50, crawl_interval_hours: 24 }

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
    if (igConfigured === false) { toast.error('IG_ACCESS_TOKEN / IG_USER_ID が未設定です'); return }
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
        iwEnabled: settings.iwEnabled, iwAutoImport: settings.iwAutoImport, iwRequirePhone: settings.iwRequirePhone,
        iwPlacesRequired: settings.iwPlacesRequired, iwAnthropic: settings.iwAnthropic,
        iwMaxQueriesPerDay: settings.iwMaxQueriesPerDay, iwPerQuery: settings.iwPerQuery,
        iwMaxRunsPerDay: settings.iwMaxRunsPerDay, iwPerRun: settings.iwPerRun, iwAnthropicDailyCap: settings.iwAnthropicDailyCap,
        iwEnrichEnabled: settings.iwEnrichEnabled, iwEnrichMaxQueries: settings.iwEnrichMaxQueries, iwEnrichPerQuery: settings.iwEnrichPerQuery, iwEnrichDailyCap: settings.iwEnrichDailyCap,
        dailyCap: settings.dailyCap,
      })
      toast.success('自動取得設定を保存しました（毎朝のCron: Places＋地域メディア / Instagram Web に反映）')
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
      noPhone: candidates.filter((c) => !c.phone_normalized).length,
      dup: candidates.filter((c) => c.duplicate_of_case_id).length,
      gbp: candidates.filter((c) => c.is_new_gbp).length,
      instagram: candidates.filter((c) => c.is_new_instagram).length,
      website: candidates.filter((c) => c.is_new_website).length,
      ad: candidates.filter((c) => c.is_new_ad_listing).length,
    }
  }, [candidates])

  const inSource = useCallback((c: LeadCandidate, tab: 'places' | 'instagram' | 'regional' | 'iw') => {
    if (tab === 'instagram') return c.lead_source === 'instagram_hashtag'
    if (tab === 'regional') return c.lead_source === 'regional_media'
    if (tab === 'iw') return c.lead_source === 'instagram_web'
    return !['instagram_hashtag', 'regional_media', 'instagram_web'].includes(c.lead_source || '')
  }, [])
  const sourceCandidates = useMemo(
    () => candidates.filter((c) => inSource(c, sourceTab)),
    [candidates, sourceTab, inSource],
  )
  const filtered = useMemo(
    () => (filter === 'ALL' ? sourceCandidates : sourceCandidates.filter((c) => c.lead_temperature === filter)),
    [sourceCandidates, filter],
  )

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

          {/* 設定パネル */}
          {showSettings && (
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
                  <div className="space-y-1"><Label>1日最大Place Details件数</Label><Input type="number" min={1} value={settings.placesMaxDetailsPerDay} onChange={(e) => saveSettings({ ...settings, placesMaxDetailsPerDay: Math.max(1, Number(e.target.value) || 100) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日あたりの投入上限</Label><Input type="number" min={1} value={settings.dailyCap} onChange={(e) => saveSettings({ ...settings, dailyCap: Math.max(1, Number(e.target.value) || 1) })} className="h-8" /></div>
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
                  ※Instagramは新規シグナルとして使用。Google Places照合は必須にせず、A:Places一致HOT / B:Instagram単体HOT候補（初期は自動投入せずHOLD扱い）/ C:HOLD に分類します。自動実行は Cron（/api/cron/instagram-leads・毎朝6:30）。
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
                    <Label>1日の巡回サイト数</Label>
                    <Input type="number" min={1} value={settings.regionalMaxSites} onChange={(e) => saveSettings({ ...settings, regionalMaxSites: Math.max(1, Number(e.target.value) || 3) })} className="h-8" />
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
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwAnthropic} onChange={(e) => saveSettings({ ...settings, iwAnthropic: e.target.checked })} />Anthropic判定（初期ON）</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwAutoImport} onChange={(e) => saveSettings({ ...settings, iwAutoImport: e.target.checked })} />HOT自動投入（初期OFF）</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwRequirePhone} onChange={(e) => saveSettings({ ...settings, iwRequirePhone: e.target.checked })} />電話番号必須（初期OFF）</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.iwPlacesRequired} onChange={(e) => saveSettings({ ...settings, iwPlacesRequired: e.target.checked })} />Places照合必須（初期OFF）</label>
                  <div className="space-y-1"><Label>1日最大実行回数</Label><Input type="number" min={1} value={settings.iwMaxRunsPerDay} onChange={(e) => saveSettings({ ...settings, iwMaxRunsPerDay: Math.max(1, Number(e.target.value) || 4) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1回最大クエリ数</Label><Input type="number" min={1} value={settings.iwPerRun} onChange={(e) => saveSettings({ ...settings, iwPerRun: Math.max(1, Number(e.target.value) || 20) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1日最大クエリ数</Label><Input type="number" min={1} value={settings.iwMaxQueriesPerDay} onChange={(e) => saveSettings({ ...settings, iwMaxQueriesPerDay: Math.max(1, Number(e.target.value) || 80) })} className="h-8" /></div>
                  <div className="space-y-1"><Label>1クエリ取得件数（最大20）</Label><Input type="number" min={1} max={20} value={settings.iwPerQuery} onChange={(e) => saveSettings({ ...settings, iwPerQuery: Math.max(1, Math.min(20, Number(e.target.value) || 10)) })} className="h-8" /></div>
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
                {/* 段階別カウント */}
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded bg-muted px-1.5 py-0.5">クエリ {gpResult.queries ?? 0}</span>
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">API取得 {gpResult.fetched ?? 0}</span>
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT {gpResult.hot ?? 0}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {gpResult.hold ?? 0}</span>
                  <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {gpResult.excluded ?? 0}</span>
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">DB保存 {gpResult.saved ?? 0}</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">案件投入 {gpResult.imported ?? 0}</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">重複 {gpResult.duplicate ?? 0}</span>
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話あり {gpResult.phoneYes ?? 0}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">Place Details 今回{gpResult.detailCalls ?? 0} / 本日{gpResult.debug?.reconcile?.detailToday ?? gpResult.debug?.detailsToday ?? 0}</span>
                  {Number(gpResult.skipped ?? 0) > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">SKIPPED {gpResult.skipped}</span>}
                  <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300">Google開業日 {gpResult.openingDateCount ?? 0}</span>
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">開業予定 {gpResult.futureOpeningCount ?? 0}</span>
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
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-600">未設定（IG_ACCESS_TOKEN / IG_USER_ID）</span>
                )}
              </div>
              <Button size="sm" onClick={runInstagram} disabled={igRunning || !settings.igEnabled}>
                <Sparkles className="h-3.5 w-3.5" />{igRunning ? '取得中...' : 'Instagram取得・実行'}
              </Button>
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              新規オープン系ハッシュタグを毎朝6:30に巡回（7日30ユニーク制限内）。Places照合は任意。Instagram単体HOT候補は初期は自動投入せずHOLD扱い（このタブの一覧から手動投入できます）。
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
              </div>
              <Button size="sm" onClick={runRegional} disabled={rmRunning || !settings.regionalEnabled}>
                <Store className="h-3.5 w-3.5" />{rmRunning ? '巡回中...' : '地域メディア巡回・実行'}
              </Button>
            </div>
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
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-muted px-1.5 py-0.5">巡回サイト {rmResult.sites ?? 0}</span>
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">新規記事 {rmResult.newArticles ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">候補 {rmResult.candidates ?? 0}</span>
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">Places一致 {rmResult.placeMatched ?? 0}</span>
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">電話あり {rmResult.phoneYes ?? 0}</span>
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT {rmResult.hot ?? 0}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">HOLD {rmResult.hold ?? 0}</span>
                      <span className="rounded bg-zinc-200 px-1.5 py-0.5 dark:bg-zinc-700">EXCLUDED {rmResult.excluded ?? 0}</span>
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-500/20 dark:text-green-300">cases投入 {rmResult.imported ?? 0}</span>
                      {Number(rmResult.saveError ?? 0) > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">保存エラー {rmResult.saveError}</span>}
                      <span className="rounded bg-muted px-1.5 py-0.5">詳細取得 {rmResult.detailFetches ?? 0}/{rmResult.debug?.maxDetailFetches ?? 20}</span>
                      {Number(rmResult.timeouts ?? 0) > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">タイムアウト {rmResult.timeouts}</span>}
                      {(Number(rmResult.deferredSites ?? 0) > 0 || Number(rmResult.deferredDetails ?? 0) > 0) && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">次回継続 サイト{rmResult.deferredSites ?? 0}/詳細{rmResult.deferredDetails ?? 0}</span>}
                    </div>
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
                                {!h.deferred && <span className="rounded bg-indigo-100 px-1 text-[9px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">{h.parserType === 'local_directory_new_listing' ? '店舗ディレクトリ型' : h.parserType === 'marketplace_listing' ? 'マーケットプレイス型' : h.parserType === 'generic_page_text_scan' ? '汎用本文スキャン' : '記事型'}{h.parser_used ? `（${h.parser_used}）` : ''}</span>}{' '}
                                {!h.deferred && <span className={cn(h.fetchOk ? 'text-green-600' : 'text-red-600')}>{h.fetchOk ? 'fetch✓' : 'fetch✗'} HTTP{h.status ?? '-'}</span>}
                                {Number(h.timeouts ?? 0) > 0 && <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">timeout{h.timeouts}</span>}</div>
                              {!h.deferred && (h.siteType === 'local_directory_new_listing' ? (
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
                {iwResult.error ? <div className="rounded bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{iwResult.error}</div>
                : iwResult.skipped ? <div className="rounded bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{iwResult.reason}</div> : (
                  <>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-muted px-1.5 py-0.5">クエリ {iwResult.queries ?? 0}</span>
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">Serper取得 {iwResult.results ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">IG URL {iwResult.igUrls ?? 0}</span>
                      <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">ルール通過 {iwResult.rulePassed ?? 0}</span>
                      <span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">AI判定 {iwResult.judged ?? 0}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5">ルール判定 {iwResult.heuristicUsed ?? 0}</span>
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-500/20 dark:text-red-300">HOT {iwResult.hot ?? 0}</span>
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
            {([['places', 'Google Places'], ['instagram', 'Instagram'], ['regional', '地域メディア'], ['iw', 'Instagram Web検索']] as const).map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => setSourceTab(k)}
                className={cn('rounded-md border px-3 py-1 text-xs font-medium', sourceTab === k ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent')}
              >
                {lbl}（{candidates.filter((c) => inSource(c, k)).length}）
              </button>
            ))}
          </div>

          {/* 巡回サイト管理（地域メディアタブ） */}
          {sourceTab === 'regional' && (
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
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={siteForm.is_active} onChange={(e) => setSiteForm({ ...siteForm, is_active: e.target.checked })} />有効化する</label>
                  <div className="flex items-end gap-1.5 lg:col-span-2">
                    <Button size="sm" onClick={saveSite} disabled={rmBusy}>{siteForm.id ? '更新' : '登録'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSiteForm(null)}>キャンセル</Button>
                  </div>
                </div>
              )}

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
                    {rmSites.length === 0 ? (
                      <tr><td colSpan={9} className="p-3 text-center text-muted-foreground">巡回サイトがありません。「初期ソースを登録」または「巡回サイトを追加」してください。</td></tr>
                    ) : rmSites.map((s) => (
                      <tr key={s.id} className="border-t align-top">
                        <td className="p-1.5 font-medium">{s.name}</td>
                        <td className="max-w-[200px] p-1.5"><a href={s.list_url || s.base_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s.list_url || s.base_url}</a></td>
                        <td className="p-1.5">{s.media_family} / {s.source_type}<div className="text-muted-foreground">{s.category_label}</div></td>
                        <td className="p-1.5 text-center">{s.reliability_score}</td>
                        <td className="p-1.5 text-center">{s.crawl_interval_hours}h</td>
                        <td className="p-1.5 text-center">{s.last_crawled_at ? moment(s.last_crawled_at).format('MM/DD HH:mm') : '—'}</td>
                        <td className="max-w-[140px] p-1.5 text-muted-foreground">{s.last_crawl_result || '—'}</td>
                        <td className="p-1.5 text-center">
                          <button onClick={() => toggleSiteActive(s)} className={cn('rounded px-1.5 py-0.5 font-bold', s.is_active ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-700')}>{s.is_active ? 'ON' : 'OFF'}</button>
                        </td>
                        <td className="p-1.5 text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => setSiteForm({ id: s.id, name: s.name, base_url: s.base_url, list_url: s.list_url || '', media_family: s.media_family || 'other', source_type: s.source_type || 'html_list', category_label: s.category_label || '開店閉店', is_active: s.is_active, reliability_score: s.reliability_score ?? 50, crawl_interval_hours: s.crawl_interval_hours ?? 24 })}>編集</Button>
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
                  {filtered.map((c) => (
                    <tr key={c.id} className="border-t align-top">
                      <td className="p-2"><span className={cn('rounded px-1.5 py-0.5 font-bold', LEAD_TEMP_COLORS[c.lead_temperature])}>{c.lead_temperature}</span></td>
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
                      <td className="p-2 text-right">
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
                  {filtered.map((c) => (
                    <tr key={c.id} className="border-t align-top">
                      <td className="p-2"><span className={cn('rounded px-1.5 py-0.5 font-bold', LEAD_TEMP_COLORS[c.lead_temperature])}>{c.lead_temperature}</span></td>
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
                      <td className="p-2 text-center">{c.imported_to_cases ? <span className="text-green-600">投入済</span> : '—'}</td>
                      <td className="p-2 text-right">
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
                  {filtered.map((c) => {
                    const klass = c.ig_classification
                    const badge = klass === 'google_match_hot' ? ['Google照合HOT', 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300']
                      : klass === 'ig_only_hot' ? ['IG単体HOT候補', 'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300']
                      : klass === 'excluded' ? ['EXCLUDED', 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700']
                      : ['HOLD', 'bg-slate-100 text-slate-600 dark:bg-slate-700']
                    return (
                      <tr key={c.id} className="border-t align-top">
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
                        <td className="p-2 text-center">{c.imported_to_cases ? <span className="text-green-600">投入済</span> : '—'}</td>
                        <td className="p-2 text-right">
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
                  {filtered.map((c) => (
                    <tr key={c.id} className="border-t align-top">
                      <td className="p-2">
                        <span className={cn('rounded px-1.5 py-0.5 font-bold', LEAD_TEMP_COLORS[c.lead_temperature])}>{c.lead_temperature}</span>
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
                      <td className="p-2 text-right">
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
        </div>
      </div>
    </div>
  )
}

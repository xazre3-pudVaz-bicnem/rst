import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { Smartphone, Copy, Upload, Plus, Sparkles, FolderOpen } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import CaseList from '@/components/dashboard/CaseList'
import CaseDetail from '@/components/dashboard/CaseDetail'
import CallLogPanel from '@/components/dashboard/CallLogPanel'
import RecallList from '@/components/dashboard/RecallList'
import MobileCallPanel from '@/components/dashboard/MobileCallPanel'
import KpiPaceChips from '@/components/dashboard/KpiPaceChips'
import AutoSearchRunner from '@/components/dashboard/AutoSearchRunner'
import CaseFormModal from '@/components/modals/CaseFormModal'
import SearchModal, { normalizeCriteria, type SearchCriteria } from '@/components/modals/SearchModal'
import CallLogFormModal from '@/components/modals/CallLogFormModal'
import RecallFormModal from '@/components/modals/RecallFormModal'
import ImportModal from '@/components/modals/ImportModal'
import AutoSearchSettingsModal from '@/components/modals/AutoSearchSettingsModal'
import BulkEditModal from '@/components/modals/BulkEditModal'
import { Button } from '@/components/ui/button'
import { SkeletonRows } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { CaseApi, CallLogApi, RecallApi, CallSessionApi, TemplateApi, AuditApi } from '@/lib/api'
import {
  MAP_QUERIES,
  TOWNPAGE_QUERIES,
  buildMapPrompt,
  buildTownpagePrompt,
  extractShops,
} from '@/lib/llm'
import {
  LS_AUTO_SEARCH,
  LS_PC_SESSION_KEY,
  TOWNPAGE_CUTOFF,
  DEFAULT_STATUS,
  DEFAULT_TEMPLATES,
  APPO_STATUSES,
  DOC_SENT_STATUSES,
  PROSPECT_STATUSES,
  LOST_STATUSES,
  UNCALLED_STATUSES,
  RECALL_STATUSES,
  type QuickFilterKey,
} from '@/lib/constants'
import { generateSessionKey, isValidSessionKey, phoneDigits, toCsv, downloadCsv } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { useAuth } from '@/context/AuthContext'
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient'
import type { AutoSearchSettings, Case, CallLog, Recall, Template } from '@/lib/types'
import moment from 'moment'

type ModalType =
  | null | 'newCase' | 'editCase' | 'search' | 'newCallLog'
  | 'editCallLog' | 'newRecall' | 'import' | 'autoSearch'

function loadAutoSettings(): AutoSearchSettings {
  try {
    const raw = localStorage.getItem(LS_AUTO_SEARCH)
    if (raw) return JSON.parse(raw)
  } catch (_) { /* noop */ }
  return { enabled: false, intervalMinutes: 10 }
}

function getOrCreateSessionKey(): string {
  let key = localStorage.getItem(LS_PC_SESSION_KEY)
  // 旧6桁英数字キーは4桁数字へ移行（入力しやすくするため）
  if (!key || !isValidSessionKey(key)) {
    key = generateSessionKey()
    localStorage.setItem(LS_PC_SESSION_KEY, key)
  }
  return key
}

interface SavedView {
  id: string
  name: string
  quickFilter: QuickFilterKey
  searchText: string
  criteria: SearchCriteria | null
}
const LS_SAVED_VIEWS = 'rst_saved_views'
function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(LS_SAVED_VIEWS)
    // 旧形式(criteria.industry:単一)で保存されたビューを新形式(industries:配列)へ正規化
    if (raw) return (JSON.parse(raw) as SavedView[]).map((v) => ({ ...v, criteria: normalizeCriteria(v.criteria) }))
  } catch (_) { /* noop */ }
  return []
}

const SAMPLE_CASES: Partial<Case>[] = [
  { name: 'サンプル和食 はる', address: '東京都新宿区西新宿1-1-1', phone1: '03-1000-0001', industry: '飲食', status: '新規', representative: '春日' },
  { name: 'Beauty Salon Lumi', address: '神奈川県横浜市西区南幸2-2-2', phone1: '045-2000-0002', industry: '美容室', status: '見込み', representative: '山本' },
  { name: '整体院やすらぎ', address: '埼玉県さいたま市大宮区桜木町3-3-3', phone1: '048-3000-0003', industry: '整体', status: '見込み', representative: '安田' },
  { name: 'カフェ ことり', address: '千葉県千葉市中央区富士見4-4-4', phone1: '043-4000-0004', industry: 'カフェ', status: '再コール', representative: '小鳥' },
  { name: 'パーソナルジム RISE', address: '東京都渋谷区道玄坂5-5-5', phone1: '03-5000-0005', industry: 'ジム・フィットネス', status: 'アポ', representative: '理瀬' },
]

export default function Dashboard() {
  const toast = useToast()
  const confirm = useConfirm()
  const { user, displayName, canWrite } = useAuth()
  const [searchParams] = useSearchParams()
  const [cases, setCases] = useState<Case[]>([])
  const [callLogs, setCallLogs] = useState<CallLog[]>([])
  const [recalls, setRecalls] = useState<Recall[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('list')

  // 一括選択
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulk, setShowBulk] = useState(false)

  const [modal, setModal] = useState<ModalType>(null)
  const [editingCallLog, setEditingCallLog] = useState<CallLog | null>(null)
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null)
  const [quickFilter, setQuickFilter] = useState<QuickFilterKey>('all')
  const [searchText, setSearchText] = useState('')
  const [savedViews, setSavedViews] = useState<SavedView[]>(loadSavedViews)
  const [sortKey, setSortKey] = useState<string>(() => localStorage.getItem('rst_sort') || 'created_desc')
  function changeSort(k: string) {
    setSortKey(k)
    localStorage.setItem('rst_sort', k)
  }

  const [autoSettings, setAutoSettings] = useState<AutoSearchSettings>(loadAutoSettings)
  const [autoBadge, setAutoBadge] = useState(0)

  const [mapSearching, setMapSearching] = useState(false)
  const [townpageSearching, setTownpageSearching] = useState(false)
  const mapAbort = useRef(false)
  const tpAbort = useRef(false)

  const [sessionKey] = useState(getOrCreateSessionKey)
  const [qrUrl, setQrUrl] = useState('')
  const [addingSample, setAddingSample] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)

  const mobileCallUrl = `${window.location.origin}/mobile-call?key=${sessionKey}`

  // ---- データロード ----
  const loadAll = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try {
      const [c, l, r] = await Promise.all([
        CaseApi.listAll(),
        CallLogApi.listAll(),
        RecallApi.listAll(),
      ])
      setCases(c)
      setCallLogs(l)
      setRecalls(r)
    } catch (e) {
      console.error('[Dashboard] load', e)
      toast.error('データの読み込みに失敗しました。接続設定を確認してください。')
    } finally {
      setInitialLoading(false)
    }
  }, [toast])

  useEffect(() => { loadAll() }, [loadAll])

  // テンプレート読込（無ければ既定を投入）
  useEffect(() => {
    if (!isSupabaseConfigured) return
    ;(async () => {
      await TemplateApi.seedDefaults(DEFAULT_TEMPLATES)
      setTemplates(await TemplateApi.list())
    })().catch((e) => console.warn('[Templates]', e))
  }, [])

  // QRコード生成
  useEffect(() => {
    QRCode.toDataURL(mobileCallUrl, { width: 120, margin: 1 })
      .then(setQrUrl)
      .catch(() => setQrUrl(''))
  }, [mobileCallUrl])

  // Realtime: スマホ側の更新を PC に反映
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(loadAll, 400)
    }
    const channel = supabase
      .channel('dashboard_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_logs' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recalls' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases' }, reload)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [loadAll])

  // Appointments からの ?case=id 連携
  useEffect(() => {
    const cid = searchParams.get('case')
    if (cid) setSelectedCaseId(cid)
  }, [searchParams])

  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) ?? null,
    [cases, selectedCaseId],
  )

  // 案件ごとの最終架電日 / 期限切れ再コール
  const lastCallByCase = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of callLogs) {
      const prev = m.get(l.case_id)
      if (!prev || l.call_at > prev) m.set(l.case_id, l.call_at)
    }
    return m
  }, [callLogs])

  const recallByCase = useMemo(() => {
    const m = new Map<string, { next: string; overdue: boolean; today: boolean }>()
    const now = moment()
    const endToday = moment().endOf('day')
    for (const r of recalls) {
      if (r.done) continue
      const t = moment(r.target_at)
      const cur = m.get(r.case_id)
      if (!cur || r.target_at < cur.next) {
        m.set(r.case_id, {
          next: r.target_at,
          overdue: t.isBefore(now),
          today: t.isSameOrBefore(endToday),
        })
      }
    }
    return m
  }, [recalls])

  // ---- フィルタ ----
  const filteredCases = useMemo(() => {
    const phoneQuery = phoneDigits(searchText)
    const text = searchText.trim()
    const arr = cases.filter((c) => {
      // インスタント検索（店舗名・電話・住所）
      if (text) {
        const inName = c.name.includes(text)
        const inAddr = (c.address ?? '').includes(text)
        const inPhone = phoneQuery && [c.phone1, c.phone2, c.phone3]
          .map(phoneDigits).some((d) => d.includes(phoneQuery))
        if (!inName && !inAddr && !inPhone) return false
      }
      // クイックフィルター
      const rc = recallByCase.get(c.id)
      switch (quickFilter) {
        case 'todayCall':
          if (!(rc?.today) && !UNCALLED_STATUSES.includes(c.status as never)) return false
          break
        case 'uncalled':
          if (!UNCALLED_STATUSES.includes(c.status as never)) return false
          break
        case 'recall':
          if (!RECALL_STATUSES.includes(c.status as never) && !rc) return false
          break
        case 'mine':
          if (c.sales_rep !== displayName) return false
          break
        case 'overdueRecall':
          if (!rc?.overdue) return false
          break
        case 'appo':
          if (!APPO_STATUSES.includes(c.status as never)) return false
          break
        case 'docSent':
          if (!DOC_SENT_STATUSES.includes(c.status as never)) return false
          break
        case 'prospect':
          if (!PROSPECT_STATUSES.includes(c.status as never)) return false
          break
        case 'notLost':
          if (LOST_STATUSES.includes(c.status as never)) return false
          break
        case 'aiRecallToday':
          // 本日再架電対象(AI): 次回架電予定日が今日以前 かつ NGでない
          if (c.do_not_call) return false
          if (!c.next_ai_call_at || moment(c.next_ai_call_at).isAfter(moment().endOf('day'))) return false
          break
        case 'notNg':
          if (c.do_not_call) return false
          break
      }
      // 詳細検索
      if (criteria) {
        if (criteria.name && !c.name.includes(criteria.name)) return false
        if (criteria.address && !(c.address ?? '').includes(criteria.address)) return false
        const pq = phoneDigits(criteria.phone)
        if (pq && ![c.phone1, c.phone2, c.phone3].map(phoneDigits).some((d) => d.includes(pq))) return false
        if (criteria.industries?.length && !criteria.industries.includes(c.industry ?? '')) return false
        if (criteria.sales_rep && c.sales_rep !== criteria.sales_rep) return false
        if (criteria.status && c.status !== criteria.status) return false
        if (criteria.uncalledOnly && !UNCALLED_STATUSES.includes(c.status as never)) return false
        if (criteria.overdueRecallOnly && !rc?.overdue) return false
        if (criteria.hasRecall === 'yes' && !rc) return false
        if (criteria.hasRecall === 'no' && rc) return false
        if (criteria.lastCallFrom) {
          const last = lastCallByCase.get(c.id)
          if (!last || moment(last).isBefore(moment(criteria.lastCallFrom).startOf('day'))) return false
        }
        if (criteria.lastCallTo) {
          const last = lastCallByCase.get(c.id)
          if (!last || moment(last).isAfter(moment(criteria.lastCallTo).endOf('day'))) return false
        }
      }
      return true
    })

    const prio = (p?: string | null) => (p === '高' ? 0 : p === '中' ? 1 : p === '低' ? 2 : 3)
    const lc = (id: string) => lastCallByCase.get(id) ?? ''
    const nr = (id: string) => recallByCase.get(id)?.next ?? '9999-12-31'
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'name': return a.name.localeCompare(b.name, 'ja')
        case 'last_call_asc': return (lc(a.id) || '9999').localeCompare(lc(b.id) || '9999')
        case 'last_call_desc': return lc(b.id).localeCompare(lc(a.id))
        case 'next_recall_asc': return nr(a.id).localeCompare(nr(b.id))
        case 'priority': return prio(a.priority) - prio(b.priority) || b.created_date.localeCompare(a.created_date)
        default: return b.created_date.localeCompare(a.created_date)
      }
    })
    return arr
  }, [cases, criteria, quickFilter, searchText, recallByCase, lastCallByCase, displayName, sortKey])

  const filterActive = !!criteria || quickFilter !== 'all' || !!searchText.trim()

  // ---- 案件選択 → CallSession upsert（スマホ連動） ----
  function selectCase(id: string) {
    setSelectedCaseId(id)
    setActiveTab('detail')
    const c = cases.find((x) => x.id === id)
    if (c && isSupabaseConfigured) {
      CallSessionApi.upsert({
        session_key: sessionKey,
        case_id: c.id,
        case_name: c.name,
        address: c.address ?? null,
        status: c.status ?? null,
        phone1: c.phone1 ?? null,
        phone2: c.phone2 ?? null,
        phone3: c.phone3 ?? null,
      }).catch((e) => console.warn('[CallSession]', e))
    }
  }

  // 「不在」をコール履歴として記録（ステータスは変更しない＝コール結果として扱う）
  async function handleAbsent() {
    if (!selectedCase || !canWrite) return
    try {
      await CallLogApi.create({
        case_id: selectedCase.id,
        case_name: selectedCase.name,
        call_at: new Date().toISOString(),
        contact_type: '非接触',
        result: '不在',
        summary: '不在',
        sales_rep: selectedCase.sales_rep ?? null,
        created_by_id: user?.id ?? null,
      })
      toast.success('「不在」をコール履歴に記録しました')
      loadAll()
    } catch (e) {
      toast.error('記録に失敗しました: ' + (e instanceof Error ? e.message : e))
    }
  }

  async function handleRepNameChange(caseId: string, name: string) {
    setCases((cs) => cs.map((c) => (c.id === caseId ? { ...c, representative: name } : c)))
    try {
      await CaseApi.update(caseId, { representative: name })
    } catch (_) { /* リアルタイム更新の失敗は無視 */ }
  }

  function updateAutoSettings(s: AutoSearchSettings) {
    setAutoSettings(s)
    localStorage.setItem(LS_AUTO_SEARCH, JSON.stringify(s))
  }

  // ---- 保存ビュー（フィルタプリセット） ----
  function persistViews(v: SavedView[]) {
    setSavedViews(v)
    localStorage.setItem(LS_SAVED_VIEWS, JSON.stringify(v))
  }
  function saveCurrentView() {
    const name = window.prompt('このフィルターを保存する名前を入力してください')
    if (!name?.trim()) return
    const v: SavedView = {
      id: (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      name: name.trim(),
      quickFilter,
      searchText,
      criteria,
    }
    persistViews([...savedViews, v])
    toast.success(`ビュー「${v.name}」を保存しました`)
  }
  function applyView(id: string) {
    const v = savedViews.find((x) => x.id === id)
    if (!v) return
    setQuickFilter(v.quickFilter)
    setSearchText(v.searchText)
    setCriteria(v.criteria)
  }
  function deleteView(id: string) {
    persistViews(savedViews.filter((v) => v.id !== id))
  }

  // ---- 一括選択 ----
  function toggleSelectionMode() {
    setSelectionMode((m) => !m)
    setSelectedIds(new Set())
  }
  function toggleSelect(id: string) {
    setSelectedIds((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function selectAllVisible() {
    setSelectedIds((s) => {
      const allSelected = filteredCases.every((c) => s.has(c.id))
      if (allSelected) return new Set()
      return new Set(filteredCases.map((c) => c.id))
    })
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const ok = await confirm({
      title: `${ids.length}件を一括削除しますか？`,
      body: '選択中の案件を削除します。元に戻せません。',
      confirmLabel: '削除する', danger: true,
    })
    if (!ok) return
    try {
      await CaseApi.bulkRemove(ids)
      AuditApi.log({ action: 'bulk', entity: 'case', detail: `${ids.length}件を一括削除`, actor_id: user?.id ?? null, actor_name: displayName })
      toast.success(`${ids.length}件を削除しました`)
      setSelectedIds(new Set())
      await loadAll()
    } catch (e) {
      toast.error('一括削除に失敗しました: ' + (e instanceof Error ? e.message : e))
    }
  }

  // ---- CSV出力（表示中の案件） ----
  function exportCsv() {
    const targets = selectionMode && selectedIds.size > 0
      ? filteredCases.filter((c) => selectedIds.has(c.id))
      : filteredCases
    if (targets.length === 0) {
      toast.error('出力対象の案件がありません')
      return
    }
    const headers = ['店舗名', '業種', '住所', '電話番号1', '電話番号2', '電話番号3', 'ステータス', '優先度', 'タグ', '担当者', '最終架電日', '次回再コール', 'メモ', '作成日', '更新日']
    const rows = targets.map((c) => {
      const last = lastCallByCase.get(c.id)
      const rc = recallByCase.get(c.id)
      return [
        c.name, c.industry ?? '', c.address ?? '', c.phone1 ?? '', c.phone2 ?? '', c.phone3 ?? '',
        c.status, c.priority ?? '', (c.tags ?? []).join('・'), c.sales_rep ?? '',
        last ? moment(last).format('YYYY/MM/DD HH:mm') : '',
        rc ? moment(rc.next).format('YYYY/MM/DD HH:mm') : '',
        c.memo ?? '', moment(c.created_date).format('YYYY/MM/DD'), moment(c.updated_date).format('YYYY/MM/DD'),
      ]
    })
    downloadCsv(`cases_${moment().format('YYYYMMDD_HHmm')}.csv`, toCsv(headers, rows))
    toast.success(`${targets.length}件をCSV出力しました`)
  }

  async function addSampleData() {
    setAddingSample(true)
    try {
      for (const s of SAMPLE_CASES) {
        await CaseApi.create({ ...s, created_by_id: user?.id ?? null })
      }
      toast.success(`サンプル案件を${SAMPLE_CASES.length}件追加しました`)
      await loadAll()
    } catch (e) {
      toast.error('サンプル追加に失敗しました: ' + (e instanceof Error ? e.message : e))
    } finally {
      setAddingSample(false)
    }
  }

  // ---- 地図検索 / 新規店検索 ----
  async function runSearch(queries: string[], builder: (q: string) => string, abort: React.MutableRefObject<boolean>, label: string) {
    let added = 0
    const existingNames = new Set(cases.map((c) => c.name.trim()))
    for (const q of queries) {
      if (abort.current) break
      try {
        const shops = await extractShops(builder(q))
        for (const s of shops) {
          const name = s.name?.trim()
          if (!name || existingNames.has(name)) continue
          await CaseApi.create({
            name, address: s.address || '', phone1: s.phone1 || '', phone2: s.phone2 || null,
            industry: s.industry || null, representative: s.representative || null,
            hp1: s.hp1 || null, instagram: s.instagram || null, source_urls: s.source_urls || null,
            memo: s.memo || null, status: DEFAULT_STATUS, created_by_id: user?.id ?? null,
          })
          existingNames.add(name)
          added++
        }
      } catch (e) {
        console.warn(`[${label}]`, e)
      }
    }
    await loadAll()
    toast.success(`${label}が完了しました。${added}件追加しました。`)
  }

  async function toggleMap() {
    if (mapSearching) { mapAbort.current = true; return }
    setMapSearching(true); mapAbort.current = false
    try {
      await runSearch(MAP_QUERIES, buildMapPrompt, mapAbort, '地図検索')
    } finally {
      setMapSearching(false); mapAbort.current = false
    }
  }

  async function toggleTownpage() {
    if (townpageSearching) { tpAbort.current = true; return }
    setTownpageSearching(true); tpAbort.current = false
    try {
      await runSearch(TOWNPAGE_QUERIES, (q) => buildTownpagePrompt(q, TOWNPAGE_CUTOFF), tpAbort, '新規店検索')
    } finally {
      setTownpageSearching(false); tpAbort.current = false
    }
  }

  // ---- キーボードショートカット ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      // 検索フォーカス（/）は入力中でも Esc 的に使えるよう先に判定
      if (e.key === '/' && !typing) {
        e.preventDefault()
        ;(document.querySelector('[data-case-search]') as HTMLInputElement | null)?.focus()
        return
      }
      if (typing) return
      if (e.key === 'j' || e.key === 'k') {
        if (filteredCases.length === 0) return
        e.preventDefault()
        const idx = filteredCases.findIndex((c) => c.id === selectedCaseId)
        let next = e.key === 'j' ? idx + 1 : idx - 1
        if (idx === -1) next = 0
        next = Math.max(0, Math.min(filteredCases.length - 1, next))
        selectCase(filteredCases[next].id)
      } else if (e.key === 'n' && canWrite) {
        e.preventDefault()
        setModal('newCase')
      } else if (e.key === 'c' && selectedCaseId && canWrite) {
        e.preventDefault()
        setEditingCallLog(null)
        setModal('newCallLog')
      } else if (e.key === 'r' && selectedCaseId && canWrite) {
        e.preventDefault()
        setModal('newRecall')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filteredCases, selectedCaseId, canWrite])

  const listProps = {
    cases: filteredCases, selectedCaseId, onSelect: selectCase,
    onOpenSearch: () => setModal('search'), onOpenAutoSearch: () => setModal('autoSearch'),
    autoBadge, onToggleMap: toggleMap, mapSearching, onToggleTownpage: toggleTownpage,
    townpageSearching, onOpenImport: () => setModal('import'), onOpenNew: () => setModal('newCase'),
    searchActive: !!criteria, quickFilter, onQuickFilter: setQuickFilter, searchText, onSearchText: setSearchText,
    lastCallByCase, recallByCase,
    selectionMode, onToggleSelectionMode: toggleSelectionMode, selectedIds,
    onToggleSelect: toggleSelect, onSelectAllVisible: selectAllVisible, onExport: exportCsv,
    canWrite,
    savedViews, onSaveView: saveCurrentView, onApplyView: applyView, onDeleteView: deleteView,
    sortKey, onSortChange: changeSort,
  }

  const curIdx = filteredCases.findIndex((c) => c.id === selectedCaseId)
  function gotoNextUncalled() {
    const start = curIdx >= 0 ? curIdx + 1 : 0
    const ordered = [...filteredCases.slice(start), ...filteredCases.slice(0, Math.max(0, start))]
    const next = ordered.find((c) => UNCALLED_STATUSES.includes(c.status as never))
    if (next) selectCase(next.id)
    else toast.info('未架電の案件は見つかりませんでした')
  }

  const detailProps = {
    selectedCase, callLogs, recalls, templates, canWrite,
    onEdit: () => setModal('editCase'),
    onAddCallLog: () => { setEditingCallLog(null); setModal('newCallLog') },
    onAddRecall: () => setModal('newRecall'),
    onChanged: loadAll,
    onPrev: () => { if (curIdx > 0) selectCase(filteredCases[curIdx - 1].id) },
    onNext: () => { if (curIdx >= 0 && curIdx < filteredCases.length - 1) selectCase(filteredCases[curIdx + 1].id) },
    onNextUncalled: gotoNextUncalled,
    hasPrev: curIdx > 0,
    hasNext: curIdx >= 0 && curIdx < filteredCases.length - 1,
  }

  const logProps = {
    callLogs, selectedCase, canWrite,
    onAdd: () => { setEditingCallLog(null); setModal('newCallLog') },
    onAbsent: handleAbsent,
    onEdit: (log: CallLog) => { setEditingCallLog(log); setModal('editCallLog') },
    onChanged: loadAll,
  }

  // 初回（案件0件）空状態。読み込み中は空状態をフラッシュさせない
  const showLoading = isSupabaseConfigured && initialLoading && cases.length === 0
  const showEmptyState = isSupabaseConfigured && !initialLoading && cases.length === 0

  return (
    <div className="flex h-screen flex-col">
      <TopBar />

      {!isSupabaseConfigured && (
        <div className="bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
          Supabase が未設定です。.env を設定すると案件データが読み込まれます。
        </div>
      )}

      {!canWrite && (
        <div className="bg-slate-100 px-3 py-1 text-xs text-slate-600 dark:bg-slate-700/50 dark:text-slate-300">
          閲覧専用モードです（ロール: 閲覧のみ）。データの追加・編集はできません。
        </div>
      )}

      {/* セッションキー連動バー（PCのみ） */}
      <div className="hidden items-center gap-2 border-b bg-primary/5 px-3 py-1 text-2xs md:flex">
        <Smartphone className="h-3.5 w-3.5 text-primary" />
        <span className="text-muted-foreground">スマホ連動:</span>
        <a href={mobileCallUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          {window.location.origin}/mobile-call
        </a>
        <span className="text-muted-foreground">キー:</span>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-sm font-bold tracking-widest text-primary">{sessionKey}</span>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
          onClick={() => { navigator.clipboard?.writeText(sessionKey); toast.success('セッションキーをコピーしました') }}
          title="キーをコピー"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        {qrUrl && (
          <div className="ml-2 flex items-center gap-1">
            <img src={qrUrl} alt="QRコード" className="h-9 w-9 rounded border bg-white" />
            <span className="text-[9px] text-muted-foreground">スマホでQR読取</span>
          </div>
        )}
        {/* 右側: 当月KPIペース（自分の担当分。目標未設定なら非表示） */}
        <KpiPaceChips callLogs={callLogs} cases={cases} salesRep={displayName || ''} />
      </div>

      {showLoading ? (
        <div className="flex flex-1 gap-3 p-3">
          <div className="hidden w-[44%] min-w-[340px] max-w-[720px] shrink-0 flex-col gap-2 md:flex lg:w-[34%] lg:max-w-[520px]">
            <SkeletonRows count={8} />
          </div>
          <div className="flex-1"><SkeletonRows count={5} /></div>
          <div className="hidden w-[300px] shrink-0 lg:block xl:w-[320px]"><SkeletonRows count={5} /></div>
        </div>
      ) : showEmptyState ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
            <FolderOpen className="mx-auto h-12 w-12 text-primary/60" />
            <h2 className="mt-3 text-lg font-bold">まずは案件を登録しましょう</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              営業リストを取り込むか、手動で1件登録すると架電・再コール・KPIの管理が始められます。
              まず試したい場合はサンプルデータを追加してください。
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button size="lg" onClick={() => setModal('import')} disabled={!canWrite}>
                <Upload className="h-4 w-4" />CSVを取り込む
              </Button>
              <Button size="lg" variant="outline" onClick={() => setModal('newCase')} disabled={!canWrite}>
                <Plus className="h-4 w-4" />新規案件を登録する
              </Button>
              <Button size="lg" variant="ghost" onClick={addSampleData} disabled={addingSample || !canWrite}>
                <Sparkles className="h-4 w-4" />{addingSample ? '追加中...' : 'サンプルデータを追加する'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* 一括操作バー */}
          {selectionMode && selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b bg-primary/10 px-3 py-1.5 text-xs">
              <span className="font-bold text-primary">{selectedIds.size}件選択中</span>
              <Button size="sm" onClick={() => setShowBulk(true)}>一括編集（ステータス/担当/優先度/タグ/再コール）</Button>
              <Button size="sm" variant="outline" onClick={exportCsv}>CSV出力</Button>
              <Button size="sm" variant="destructive" onClick={handleBulkDelete}>一括削除</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>選択解除</Button>
            </div>
          )}

          {/* PC: 3カラム（左:案件一覧 / 中央:案件詳細 / 右:コール履歴） */}
          {/* PC: xl(≧1280px)=一覧/詳細/コール履歴の3カラム。ノートPC(md〜xl)=一覧を広げた2カラム＋履歴は詳細下に折りたたみ。 */}
          <div className="hidden flex-1 overflow-hidden md:flex">
            {/* ノートPC(lg=1024px以上)はデスクトップと同じ3カラム(一覧+詳細+コール履歴)。lg未満は一覧を広げた2カラム＋履歴は折りたたみ。 */}
            <div className="flex w-[44%] min-w-[340px] max-w-[720px] shrink-0 flex-col border-r lg:w-[34%] lg:min-w-[360px] lg:max-w-[520px]">
              <div className="min-h-0 flex-1 overflow-hidden">
                <CaseList {...listProps} />
              </div>
              <div className="h-[190px] shrink-0">
                <RecallList recalls={recalls} cases={cases} canWrite={canWrite} onAdd={() => setModal('newRecall')} onSelectCase={selectCase} onChanged={loadAll} />
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-hidden">
                <CaseDetail {...detailProps} />
              </div>
              {/* lg未満(狭いノートPC)ではコール履歴を詳細の下に折りたたみで確保 */}
              <details className="shrink-0 border-t lg:hidden">
                <summary className="cursor-pointer select-none px-3 py-1.5 text-xs font-bold text-muted-foreground hover:bg-muted/40">📞 コール履歴を開く</summary>
                <div className="h-[240px] overflow-hidden border-t"><CallLogPanel {...logProps} /></div>
              </details>
            </div>

            <div className="hidden w-[300px] shrink-0 lg:block xl:w-[320px]">
              <CallLogPanel {...logProps} />
            </div>
          </div>

          {/* スマホ: タブ切替 */}
          <div className="flex flex-1 flex-col overflow-hidden md:hidden">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
              <TabsList className="m-1.5 grid grid-cols-4">
                <TabsTrigger value="list">案件一覧</TabsTrigger>
                <TabsTrigger value="detail">詳細</TabsTrigger>
                <TabsTrigger value="call">📞 コール</TabsTrigger>
                <TabsTrigger value="log">履歴</TabsTrigger>
              </TabsList>

              <TabsContent value="list" className="flex flex-1 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <CaseList {...listProps} />
                </div>
                <div className="h-[160px] shrink-0">
                  <RecallList recalls={recalls} cases={cases} canWrite={canWrite} onAdd={() => setModal('newRecall')} onSelectCase={selectCase} onChanged={loadAll} />
                </div>
              </TabsContent>

              <TabsContent value="detail" className="flex-1 overflow-hidden">
                <CaseDetail {...detailProps} />
              </TabsContent>

              <TabsContent value="call" className="flex-1 overflow-hidden">
                <MobileCallPanel selectedCase={selectedCase} />
              </TabsContent>

              <TabsContent value="log" className="flex-1 overflow-hidden">
                <CallLogPanel {...logProps} />
              </TabsContent>
            </Tabs>
          </div>
        </>
      )}

      <AutoSearchRunner
        settings={autoSettings}
        existingCases={cases}
        onAdded={(n) => { setAutoBadge((b) => b + n); loadAll() }}
      />

      {/* モーダル群 */}
      <CaseFormModal
        open={modal === 'newCase' || modal === 'editCase'}
        onClose={() => setModal(null)}
        editingCase={modal === 'editCase' ? selectedCase : null}
        existingCases={cases}
        onSaved={loadAll}
      />
      <SearchModal
        open={modal === 'search'}
        initial={criteria}
        onClose={() => setModal(null)}
        onSearch={setCriteria}
        onReset={() => setCriteria(null)}
      />
      <CallLogFormModal
        open={modal === 'newCallLog' || modal === 'editCallLog'}
        onClose={() => setModal(null)}
        selectedCase={selectedCase}
        editingLog={modal === 'editCallLog' ? editingCallLog : null}
        onSaved={loadAll}
        onRepNameChange={handleRepNameChange}
      />
      <RecallFormModal
        open={modal === 'newRecall'}
        onClose={() => setModal(null)}
        cases={cases}
        defaultCaseId={selectedCaseId}
        onSaved={loadAll}
      />
      <ImportModal
        open={modal === 'import'}
        onClose={() => setModal(null)}
        existingCases={cases}
        onImported={loadAll}
      />
      <AutoSearchSettingsModal
        open={modal === 'autoSearch'}
        onClose={() => setModal(null)}
        settings={autoSettings}
        onChange={updateAutoSettings}
        badge={autoBadge}
      />
      <BulkEditModal
        open={showBulk}
        onClose={() => setShowBulk(false)}
        cases={cases}
        selectedIds={[...selectedIds]}
        onDone={() => { setSelectedIds(new Set()); loadAll() }}
      />
    </div>
  )
}

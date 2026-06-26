import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Smartphone, Copy } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import CaseList from '@/components/dashboard/CaseList'
import CaseDetail from '@/components/dashboard/CaseDetail'
import CallLogPanel from '@/components/dashboard/CallLogPanel'
import RecallList from '@/components/dashboard/RecallList'
import MobileCallPanel from '@/components/dashboard/MobileCallPanel'
import AutoSearchRunner from '@/components/dashboard/AutoSearchRunner'
import CaseFormModal from '@/components/modals/CaseFormModal'
import SearchModal, { type SearchCriteria } from '@/components/modals/SearchModal'
import CallLogFormModal from '@/components/modals/CallLogFormModal'
import RecallFormModal from '@/components/modals/RecallFormModal'
import ImportModal from '@/components/modals/ImportModal'
import AutoSearchSettingsModal from '@/components/modals/AutoSearchSettingsModal'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { CaseApi, CallLogApi, RecallApi, CallSessionApi } from '@/lib/api'
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
} from '@/lib/constants'
import { generateSessionKey, phoneDigits } from '@/lib/utils'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import type { AutoSearchSettings, Case, CallLog, Recall } from '@/lib/types'

type ModalType =
  | null
  | 'newCase'
  | 'editCase'
  | 'search'
  | 'newCallLog'
  | 'editCallLog'
  | 'newRecall'
  | 'import'
  | 'autoSearch'

function loadAutoSettings(): AutoSearchSettings {
  try {
    const raw = localStorage.getItem(LS_AUTO_SEARCH)
    if (raw) return JSON.parse(raw)
  } catch (_) {
    /* noop */
  }
  return { enabled: false, intervalMinutes: 10 }
}

function getOrCreateSessionKey(): string {
  let key = localStorage.getItem(LS_PC_SESSION_KEY)
  if (!key) {
    key = generateSessionKey()
    localStorage.setItem(LS_PC_SESSION_KEY, key)
  }
  return key
}

export default function Dashboard() {
  const [searchParams] = useSearchParams()
  const [cases, setCases] = useState<Case[]>([])
  const [callLogs, setCallLogs] = useState<CallLog[]>([])
  const [recalls, setRecalls] = useState<Recall[]>([])
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('list')

  const [modal, setModal] = useState<ModalType>(null)
  const [editingCallLog, setEditingCallLog] = useState<CallLog | null>(null)
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null)

  const [autoSettings, setAutoSettings] = useState<AutoSearchSettings>(loadAutoSettings)
  const [autoBadge, setAutoBadge] = useState(0)

  const [mapSearching, setMapSearching] = useState(false)
  const [townpageSearching, setTownpageSearching] = useState(false)
  const mapAbort = useRef(false)
  const tpAbort = useRef(false)

  const [sessionKey] = useState(getOrCreateSessionKey)

  // ---- データロード ----
  const loadAll = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try {
      const [c, l, r] = await Promise.all([
        CaseApi.list(500),
        CallLogApi.list(1000),
        RecallApi.list(500),
      ])
      setCases(c)
      setCallLogs(l)
      setRecalls(r)
    } catch (e) {
      console.error('[Dashboard] load', e)
    }
  }, [])

  useEffect(() => {
    loadAll()
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

  // ---- 検索フィルタ ----
  const filteredCases = useMemo(() => {
    if (!criteria) return cases
    const phoneQuery = phoneDigits(criteria.phone)
    return cases.filter((c) => {
      if (criteria.name && !c.name.includes(criteria.name)) return false
      if (criteria.address && !(c.address ?? '').includes(criteria.address)) return false
      if (phoneQuery) {
        const digits = [c.phone1, c.phone2, c.phone3].map(phoneDigits)
        if (!digits.some((d) => d.includes(phoneQuery))) return false
      }
      if (criteria.industry && c.industry !== criteria.industry) return false
      if (criteria.sales_rep && c.sales_rep !== criteria.sales_rep) return false
      if (criteria.status && c.status !== criteria.status) return false
      return true
    })
  }, [cases, criteria])

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
        phone1: c.phone1 ?? null,
        phone2: c.phone2 ?? null,
        phone3: c.phone3 ?? null,
      }).catch((e) => console.warn('[CallSession]', e))
    }
  }

  // ---- 代表者名リアルタイム更新 ----
  async function handleRepNameChange(caseId: string, name: string) {
    setCases((cs) => cs.map((c) => (c.id === caseId ? { ...c, representative: name } : c)))
    try {
      await CaseApi.update(caseId, { representative: name })
    } catch (_) {
      /* リアルタイム更新の失敗は無視 */
    }
  }

  // ---- 自動検索設定の永続化 ----
  function updateAutoSettings(s: AutoSearchSettings) {
    setAutoSettings(s)
    localStorage.setItem(LS_AUTO_SEARCH, JSON.stringify(s))
  }

  // ---- MAP検索 ----
  async function toggleMap() {
    if (mapSearching) {
      mapAbort.current = true
      return
    }
    setMapSearching(true)
    mapAbort.current = false
    let added = 0
    try {
      const existingNames = new Set(cases.map((c) => c.name.trim()))
      for (const q of MAP_QUERIES) {
        if (mapAbort.current) break
        try {
          const shops = await extractShops(buildMapPrompt(q))
          for (const s of shops) {
            const name = s.name?.trim()
            if (!name || existingNames.has(name)) continue
            await CaseApi.create({
              name,
              address: s.address || '',
              phone1: s.phone1 || '',
              phone2: s.phone2 || null,
              industry: s.industry || null,
              representative: s.representative || null,
              hp1: s.hp1 || null,
              instagram: s.instagram || null,
              source_urls: s.source_urls || null,
              memo: s.memo || null,
              status: '新規',
            })
            existingNames.add(name)
            added++
          }
        } catch (e) {
          console.warn('[MAP]', e)
        }
      }
      await loadAll()
      alert(`MAP検索が完了しました。${added}件追加しました。`)
    } finally {
      setMapSearching(false)
      mapAbort.current = false
    }
  }

  // ---- タウンページ検索 ----
  async function toggleTownpage() {
    if (townpageSearching) {
      tpAbort.current = true
      return
    }
    setTownpageSearching(true)
    tpAbort.current = false
    let added = 0
    try {
      const existingNames = new Set(cases.map((c) => c.name.trim()))
      for (const q of TOWNPAGE_QUERIES) {
        if (tpAbort.current) break
        try {
          const shops = await extractShops(buildTownpagePrompt(q, TOWNPAGE_CUTOFF))
          for (const s of shops) {
            const name = s.name?.trim()
            if (!name || existingNames.has(name)) continue
            await CaseApi.create({
              name,
              address: s.address || '',
              phone1: s.phone1 || '',
              phone2: s.phone2 || null,
              industry: s.industry || null,
              representative: s.representative || null,
              hp1: s.hp1 || null,
              instagram: s.instagram || null,
              source_urls: s.source_urls || null,
              memo: s.memo || null,
              status: '新規',
            })
            existingNames.add(name)
            added++
          }
        } catch (e) {
          console.warn('[TP]', e)
        }
      }
      await loadAll()
      alert(`タウンページ検索が完了しました。${added}件追加しました。`)
    } finally {
      setTownpageSearching(false)
      tpAbort.current = false
    }
  }

  const mobileCallUrl = `${window.location.origin}/mobile-call`

  return (
    <div className="flex h-screen flex-col">
      <TopBar />

      {!isSupabaseConfigured && (
        <div className="bg-amber-50 px-3 py-1 text-2xs text-amber-800">
          Supabase が未設定です。.env を設定すると案件データが読み込まれます。
        </div>
      )}

      {/* セッションキー連動バー（PCのみ） */}
      <div className="hidden items-center gap-2 border-b bg-primary/5 px-3 py-1 text-2xs md:flex">
        <Smartphone className="h-3 w-3 text-primary" />
        <span className="text-muted-foreground">スマホ連動:</span>
        <a href="/mobile-call" target="_blank" rel="noreferrer" className="text-primary hover:underline">
          {mobileCallUrl}
        </a>
        <span className="text-muted-foreground">キー:</span>
        <span className="font-mono font-bold tracking-widest">{sessionKey}</span>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
          onClick={() => {
            navigator.clipboard?.writeText(sessionKey)
          }}
          title="キーをコピー"
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>

      {/* PC: 3カラム */}
      <div className="hidden flex-1 overflow-hidden md:flex">
        <div className="flex w-[280px] shrink-0 flex-col border-r">
          <div className="min-h-0 flex-1 overflow-hidden">
            <CaseList
              cases={filteredCases}
              selectedCaseId={selectedCaseId}
              onSelect={selectCase}
              onOpenSearch={() => setModal('search')}
              onOpenAutoSearch={() => setModal('autoSearch')}
              autoBadge={autoBadge}
              onToggleMap={toggleMap}
              mapSearching={mapSearching}
              onToggleTownpage={toggleTownpage}
              townpageSearching={townpageSearching}
              onOpenImport={() => setModal('import')}
              onOpenNew={() => setModal('newCase')}
              searchActive={!!criteria}
            />
          </div>
          <div className="h-[220px] shrink-0">
            <RecallList
              recalls={recalls}
              onAdd={() => setModal('newRecall')}
              onSelectCase={selectCase}
              onChanged={loadAll}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1 border-r">
          <CaseDetail
            selectedCase={selectedCase}
            onEdit={() => setModal('editCase')}
            onChanged={loadAll}
          />
        </div>

        <div className="w-[300px] shrink-0">
          <CallLogPanel
            callLogs={callLogs}
            selectedCase={selectedCase}
            onAdd={() => {
              setEditingCallLog(null)
              setModal('newCallLog')
            }}
            onEdit={(log) => {
              setEditingCallLog(log)
              setModal('editCallLog')
            }}
            onChanged={loadAll}
          />
        </div>
      </div>

      {/* スマホ: タブ切替 */}
      <div className="flex flex-1 flex-col overflow-hidden md:hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
          <TabsList className="m-1.5 grid grid-cols-4">
            <TabsTrigger value="list">案件一覧</TabsTrigger>
            <TabsTrigger value="detail">詳細</TabsTrigger>
            <TabsTrigger value="call">📞 コール</TabsTrigger>
            <TabsTrigger value="log">コール履歴</TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="flex flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              <CaseList
                cases={filteredCases}
                selectedCaseId={selectedCaseId}
                onSelect={selectCase}
                onOpenSearch={() => setModal('search')}
                onOpenAutoSearch={() => setModal('autoSearch')}
                autoBadge={autoBadge}
                onToggleMap={toggleMap}
                mapSearching={mapSearching}
                onToggleTownpage={toggleTownpage}
                townpageSearching={townpageSearching}
                onOpenImport={() => setModal('import')}
                onOpenNew={() => setModal('newCase')}
                searchActive={!!criteria}
              />
            </div>
            <div className="h-[200px] shrink-0">
              <RecallList
                recalls={recalls}
                onAdd={() => setModal('newRecall')}
                onSelectCase={selectCase}
                onChanged={loadAll}
              />
            </div>
          </TabsContent>

          <TabsContent value="detail" className="flex-1 overflow-hidden">
            <CaseDetail
              selectedCase={selectedCase}
              onEdit={() => setModal('editCase')}
              onChanged={loadAll}
            />
          </TabsContent>

          <TabsContent value="call" className="flex-1 overflow-hidden">
            <MobileCallPanel selectedCase={selectedCase} />
          </TabsContent>

          <TabsContent value="log" className="flex-1 overflow-hidden">
            <CallLogPanel
              callLogs={callLogs}
              selectedCase={selectedCase}
              onAdd={() => {
                setEditingCallLog(null)
                setModal('newCallLog')
              }}
              onEdit={(log) => {
                setEditingCallLog(log)
                setModal('editCallLog')
              }}
              onChanged={loadAll}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* バックグラウンド自動検索 */}
      <AutoSearchRunner
        settings={autoSettings}
        existingCases={cases}
        onAdded={(n) => {
          setAutoBadge((b) => b + n)
          loadAll()
        }}
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
    </div>
  )
}

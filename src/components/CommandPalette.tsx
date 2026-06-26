import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, LayoutDashboard, ListChecks, BarChart3, Calendar, Users, ScrollText,
  Phone, Keyboard, CornerDownLeft,
} from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { CaseApi } from '@/lib/api'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { statusColor } from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Case } from '@/lib/types'

interface NavCmd {
  type: 'nav'
  label: string
  hint: string
  to: string
  icon: React.ReactNode
}

const NAV_COMMANDS: NavCmd[] = [
  { type: 'nav', label: 'ホーム（ダッシュボード）', hint: 'home', to: '/home', icon: <LayoutDashboard className="h-4 w-4" /> },
  { type: 'nav', label: '案件（CRM）', hint: 'cases crm', to: '/', icon: <ListChecks className="h-4 w-4" /> },
  { type: 'nav', label: '分析・KPI', hint: 'analytics kpi', to: '/analytics', icon: <BarChart3 className="h-4 w-4" /> },
  { type: 'nav', label: '訪問予定', hint: 'appointments', to: '/appointments', icon: <Calendar className="h-4 w-4" /> },
  { type: 'nav', label: 'ユーザー管理', hint: 'users', to: '/users', icon: <Users className="h-4 w-4" /> },
  { type: 'nav', label: '監査ログ', hint: 'audit log', to: '/audit', icon: <ScrollText className="h-4 w-4" /> },
]

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'Ctrl / ⌘ + K', label: 'コマンドパレット（案件検索・画面移動）' },
  { keys: '?', label: 'このショートカット一覧' },
  { keys: 'j / k', label: '次 / 前の案件を選択' },
  { keys: '/', label: '案件一覧の検索にフォーカス' },
  { keys: 'n', label: '新規案件' },
  { keys: 'c', label: '選択案件に通話履歴を登録' },
  { keys: 'r', label: '選択案件に再コール予定' },
]

export default function CommandPalette() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'search' | 'help' | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Case[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // グローバルキー
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setMode('search'); setQuery(''); setResults([]); setActive(0)
      } else if (e.key === '?' && !typing) {
        e.preventDefault()
        setMode('help')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // デバウンス検索
  useEffect(() => {
    if (mode !== 'search') return
    if (!query.trim() || !isSupabaseConfigured) { setResults([]); return }
    const t = setTimeout(() => {
      CaseApi.search(query, 15).then((r) => { setResults(r); setActive(0) }).catch(() => setResults([]))
    }, 180)
    return () => clearTimeout(t)
  }, [query, mode])

  const navMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return NAV_COMMANDS
    return NAV_COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.hint.includes(q))
  }, [query])

  const items = useMemo(
    () => [...navMatches.map((n) => ({ kind: 'nav' as const, nav: n })), ...results.map((c) => ({ kind: 'case' as const, case: c }))],
    [navMatches, results],
  )

  function run(i: number) {
    const it = items[i]
    if (!it) return
    if (it.kind === 'nav') navigate(it.nav.to)
    else navigate(`/?case=${it.case.id}`)
    setMode(null)
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(active) }
  }

  return (
    <>
      {/* コマンドパレット */}
      <Dialog open={mode === 'search'} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent className="max-w-lg gap-0 p-0">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="店舗名・電話・住所で検索、または画面名で移動…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden rounded border px-1 text-[9px] text-muted-foreground sm:inline">ESC</kbd>
          </div>
          <div className="max-h-[55vh] overflow-y-auto py-1">
            {items.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {query.trim() ? '該当なし' : '案件名や電話番号を入力してください'}
              </div>
            )}
            {items.map((it, i) => (
              <button
                key={it.kind === 'nav' ? `n${i}` : it.case.id}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(i)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                  active === i ? 'bg-primary/10' : 'hover:bg-accent',
                )}
              >
                {it.kind === 'nav' ? (
                  <>
                    <span className="text-muted-foreground">{it.nav.icon}</span>
                    <span className="flex-1">{it.nav.label}</span>
                    <span className="text-[9px] text-muted-foreground">移動</span>
                  </>
                ) : (
                  <>
                    <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{it.case.name}</span>
                      <span className="block truncate text-2xs text-muted-foreground">{it.case.phone1} ・ {it.case.address}</span>
                    </span>
                    <span className={cn('shrink-0 rounded-sm px-1.5 py-0.5 text-[9px]', statusColor(it.case.status))}>{it.case.status}</span>
                  </>
                )}
                {active === i && <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" />}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ショートカット一覧 */}
      <Dialog open={mode === 'help'} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent className="max-w-sm">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Keyboard className="h-4 w-4" />キーボードショートカット
          </div>
          <div className="space-y-1.5">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">{s.label}</span>
                <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">{s.keys}</kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

import { List, type RowComponentProps } from 'react-window'
import { Search, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  HIGHLIGHT_STATUSES,
  statusColor,
  displayStatus,
  PRIORITY_COLORS,
  type QuickFilterKey,
} from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Case } from '@/lib/types'

interface RowData {
  cases: Case[]
  selectedCaseId: string | null
  selectionMode: boolean
  selectedIds: Set<string>
  lastCallByCase: Map<string, string>
  recallByCase: Map<string, { next: string; overdue: boolean; today: boolean }>
  onSelect: (id: string) => void
  onToggleSelect: (id: string) => void
}

function CaseRow({
  index, style, cases, selectedCaseId, recallByCase, onSelect,
}: RowComponentProps<RowData>) {
  const c = cases[index]
  const highlight = HIGHLIGHT_STATUSES.includes(c.status as never)
  const selected = c.id === selectedCaseId
  const rc = recallByCase.get(c.id)
  return (
    <button
      type="button"
      style={style}
      onClick={() => onSelect(c.id)}
      title={`${c.name}\n${c.address ?? ''}\n${displayStatus(c.status)}${c.sales_rep ? ' / ' + c.sales_rep : ''}`}
      className={cn(
        'flex w-full items-center gap-1 border-b px-2 text-left text-xs transition-colors',
        selected ? 'bg-primary/10 ring-1 ring-inset ring-primary/40'
          : highlight ? 'bg-green-50 dark:bg-green-500/10' : 'hover:bg-accent',
      )}
    >
      {/* 業種 */}
      <span className="w-12 shrink-0 truncate text-[10px] text-muted-foreground">{c.industry || '—'}</span>
      {/* 店名（優先度色のドット＋期限切れ再コール印） */}
      <span className="flex w-[150px] shrink-0 items-center gap-1 overflow-hidden">
        {c.priority && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_COLORS[c.priority])} />}
        {rc?.overdue && <span className="shrink-0 text-[9px] font-bold text-red-600">●</span>}
        <span className="truncate font-medium">{c.name}</span>
      </span>
      {/* 住所 */}
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{c.address || '—'}</span>
      {/* ステータス（薄色バッジ） */}
      <span className={cn('shrink-0 rounded-sm px-1 py-0.5 text-[9px] font-medium', statusColor(displayStatus(c.status)))}>
        {displayStatus(c.status)}
      </span>
    </button>
  )
}

interface Props {
  cases: Case[]
  selectedCaseId: string | null
  onSelect: (id: string) => void
  onOpenSearch: () => void
  onOpenAutoSearch: () => void
  autoBadge: number
  onToggleMap: () => void
  mapSearching: boolean
  onToggleTownpage: () => void
  townpageSearching: boolean
  onOpenImport: () => void
  onOpenNew: () => void
  searchActive: boolean
  quickFilter: QuickFilterKey
  onQuickFilter: (k: QuickFilterKey) => void
  searchText: string
  onSearchText: (v: string) => void
  lastCallByCase: Map<string, string>
  recallByCase: Map<string, { next: string; overdue: boolean; today: boolean }>
  selectionMode: boolean
  onToggleSelectionMode: () => void
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onSelectAllVisible: () => void
  onExport: () => void
  canWrite: boolean
  savedViews: { id: string; name: string }[]
  onSaveView: () => void
  onApplyView: (id: string) => void
  onDeleteView: (id: string) => void
  sortKey: string
  onSortChange: (k: string) => void
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'created_desc', label: '新着順' },
  { value: 'name', label: '店舗名' },
  { value: 'last_call_asc', label: '最終架電が古い順' },
  { value: 'last_call_desc', label: '最終架電が新しい順' },
  { value: 'next_recall_asc', label: '次回再コールが近い順' },
  { value: 'priority', label: '優先度が高い順' },
]

const ROW_HEIGHT = 34

export default function CaseList(props: Props) {
  const {
    cases, selectedCaseId, onSelect, onOpenSearch, onOpenAutoSearch, autoBadge,
    onToggleMap, mapSearching, onToggleTownpage, townpageSearching, onOpenImport, onOpenNew,
    searchActive, quickFilter, onQuickFilter, searchText, onSearchText,
    lastCallByCase, recallByCase, selectionMode, onToggleSelectionMode, selectedIds,
    onToggleSelect, onSelectAllVisible, onExport, canWrite,
    savedViews, onSaveView, onApplyView, onDeleteView, sortKey, onSortChange,
  } = props

  return (
    <div className="flex h-full flex-col">
      {/* ツールバー（案件追加・詳細検索のみ） */}
      <div className="flex items-center gap-2 border-b bg-card p-2">
        <Button size="sm" onClick={onOpenNew} disabled={!canWrite}>
          <Plus className="h-3.5 w-3.5" />案件追加
        </Button>
        <Button variant={searchActive ? 'default' : 'outline'} size="sm" onClick={onOpenSearch}>
          <Search className="h-3.5 w-3.5" />詳細検索
        </Button>
      </div>

      {/* インスタント検索 */}
      <div className="relative border-b bg-card px-2 py-1.5">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-case-search
          value={searchText}
          onChange={(e) => onSearchText(e.target.value)}
          placeholder="店舗名・電話番号・住所で絞り込み（/ でフォーカス）"
          className="h-8 pl-7 pr-7 text-sm"
        />
        {searchText && (
          <button
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => onSearchText('')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* 件数 + 並び替え */}
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1.5 text-2xs font-medium text-muted-foreground">
        <span className="shrink-0">{cases.length} 件</span>
        <label className="flex items-center gap-1">
          並び替え:
          <select
            value={sortKey}
            onChange={(e) => onSortChange(e.target.value)}
            className="rounded border border-input bg-card px-1 py-0.5 text-2xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      {/* テーブル見出し */}
      <div className="flex items-center gap-1 border-b bg-muted/50 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
        <span className="w-12 shrink-0">業種</span>
        <span className="w-[150px] shrink-0">店名</span>
        <span className="min-w-0 flex-1">住所</span>
        <span className="shrink-0">状態</span>
      </div>

      {/* 一覧（仮想スクロール / react-window v2・表形式） */}
      <div className="min-h-0 flex-1">
        {cases.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">該当する案件がありません</div>
        ) : (
          <List
            rowComponent={CaseRow}
            rowCount={cases.length}
            rowHeight={ROW_HEIGHT}
            overscanCount={12}
            style={{ height: '100%' }}
            rowProps={{
              cases, selectedCaseId, selectionMode, selectedIds,
              lastCallByCase, recallByCase, onSelect, onToggleSelect,
            }}
          />
        )}
      </div>
    </div>
  )
}

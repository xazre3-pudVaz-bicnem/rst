import { List, type RowComponentProps } from 'react-window'
import moment from 'moment'
import { Search, Bot, MapPin, Store, Upload, Plus, X, CheckSquare, Download, Flag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  HIGHLIGHT_STATUSES,
  QUICK_FILTERS,
  statusColor,
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
  index, style, cases, selectedCaseId, selectionMode, selectedIds,
  lastCallByCase, recallByCase, onSelect, onToggleSelect,
}: RowComponentProps<RowData>) {
  const c = cases[index]
  const highlight = HIGHLIGHT_STATUSES.includes(c.status as never)
  const selected = c.id === selectedCaseId
  const checked = selectedIds.has(c.id)
  const last = lastCallByCase.get(c.id)
  const rc = recallByCase.get(c.id)
  return (
    <div
      style={style}
      className={cn(
        'flex items-stretch border-b transition-colors',
        selected ? 'bg-primary/10 ring-1 ring-inset ring-primary/40'
          : highlight ? 'bg-green-50 dark:bg-green-500/10' : 'hover:bg-accent',
      )}
    >
      {selectionMode && (
        <label className="flex shrink-0 items-center px-2" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" className="h-4 w-4" checked={checked} onChange={() => onToggleSelect(c.id)} />
        </label>
      )}
      <button onClick={() => onSelect(c.id)} className="min-w-0 flex-1 overflow-hidden px-2.5 py-2 text-left">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1">
            {c.priority && (
              <span className={cn('flex shrink-0 items-center gap-0.5 rounded-sm border px-1 text-[9px]', PRIORITY_COLORS[c.priority])}>
                <Flag className="h-2.5 w-2.5" />{c.priority}
              </span>
            )}
            <span className="truncate text-sm font-semibold">{c.name}</span>
          </div>
          <span className={cn('shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-medium', statusColor(c.status))}>
            {c.status}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
          {c.industry && <span className="rounded-sm bg-muted px-1">{c.industry}</span>}
          {c.phone1 && <span>{c.phone1}</span>}
          {c.sales_rep && <span className="ml-auto shrink-0 text-primary">{c.sales_rep}</span>}
        </div>
        <div className="truncate text-2xs text-muted-foreground">{c.address}</div>
        <div className="mt-0.5 flex flex-nowrap items-center gap-x-2 overflow-hidden whitespace-nowrap text-[9px]">
          {last && <span className="text-muted-foreground">架電: {moment(last).format('MM/DD')}</span>}
          {rc && (
            <span className={cn(rc.overdue ? 'font-bold text-red-600' : rc.today ? 'font-bold text-amber-700' : 'text-muted-foreground')}>
              次回: {moment(rc.next).format('MM/DD HH:mm')}
            </span>
          )}
          {(c.tags ?? []).slice(0, 3).map((t) => (
            <span key={t} className="rounded-sm bg-sky-50 px-1 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">#{t}</span>
          ))}
        </div>
      </button>
    </div>
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

const ROW_HEIGHT = 88

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
      {/* ツールバー */}
      <div className="flex flex-wrap items-center gap-1 border-b bg-card p-2">
        <Button size="sm" onClick={onOpenNew} disabled={!canWrite}>
          <Plus className="h-3.5 w-3.5" />案件追加
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenImport} disabled={!canWrite}>
          <Upload className="h-3.5 w-3.5" />CSV取込
        </Button>
        <Button variant="outline" size="sm" onClick={onExport} title="表示中の案件をCSV出力">
          <Download className="h-3.5 w-3.5" />CSV出力
        </Button>
        <Button variant={searchActive ? 'default' : 'outline'} size="sm" onClick={onOpenSearch}>
          <Search className="h-3.5 w-3.5" />詳細検索
        </Button>
        <Button variant={selectionMode ? 'default' : 'outline'} size="sm" onClick={onToggleSelectionMode} disabled={!canWrite}>
          <CheckSquare className="h-3.5 w-3.5" />一括選択
        </Button>
        <div className="relative">
          <Button variant="outline" size="sm" onClick={onOpenAutoSearch}>
            <Bot className="h-3.5 w-3.5" />自動検索
          </Button>
          {autoBadge > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-white">
              {autoBadge}
            </span>
          )}
        </div>
        <Button
          size="sm"
          className={cn(mapSearching ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700', 'text-white')}
          onClick={onToggleMap}
          title="Googleマップから新規開業店舗を自動収集"
        >
          {mapSearching ? '■ 停止' : (<><MapPin className="h-3.5 w-3.5" />地図検索</>)}
        </Button>
        <Button
          size="sm"
          className={cn(townpageSearching ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-500 hover:bg-orange-600', 'text-white')}
          onClick={onToggleTownpage}
          title="タウンページの新規掲載店舗を自動収集"
        >
          {townpageSearching ? '■ 停止' : (<><Store className="h-3.5 w-3.5" />新規店検索</>)}
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

      {/* クイックフィルター */}
      <div className="flex flex-wrap gap-1 border-b bg-muted/30 px-2 py-1.5">
        {QUICK_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => onQuickFilter(f.key)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-2xs transition-colors',
              quickFilter === f.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card text-muted-foreground hover:bg-accent',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 保存ビュー（フィルタプリセット） */}
      <div className="flex flex-wrap items-center gap-1 border-b bg-card px-2 py-1">
        <span className="text-[10px] text-muted-foreground">ビュー:</span>
        {savedViews.map((v) => (
          <span key={v.id} className="group inline-flex items-center rounded-full border border-input bg-card text-2xs">
            <button className="px-2 py-0.5 hover:text-primary" onClick={() => onApplyView(v.id)} title="このビューを適用">{v.name}</button>
            <button className="px-1 text-muted-foreground hover:text-destructive" onClick={() => onDeleteView(v.id)} title="削除">×</button>
          </span>
        ))}
        <button className="rounded-full border border-dashed border-input px-2 py-0.5 text-2xs text-muted-foreground hover:bg-accent" onClick={onSaveView}>
          ＋現在の条件を保存
        </button>
      </div>

      {/* 件数 + 並び替え + 一括選択操作 */}
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1 text-2xs font-medium text-muted-foreground">
        <span className="shrink-0">{cases.length} 件{selectionMode && selectedIds.size > 0 && ` / ${selectedIds.size} 件選択中`}</span>
        {selectionMode ? (
          <button className="text-primary hover:underline" onClick={onSelectAllVisible}>
            表示中をすべて選択/解除
          </button>
        ) : (
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
        )}
      </div>

      {/* 一覧（仮想スクロール / react-window v2） */}
      <div className="min-h-0 flex-1">
        {cases.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">該当する案件がありません</div>
        ) : (
          <List
            rowComponent={CaseRow}
            rowCount={cases.length}
            rowHeight={ROW_HEIGHT}
            overscanCount={8}
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

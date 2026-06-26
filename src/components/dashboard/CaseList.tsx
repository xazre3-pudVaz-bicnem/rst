import { Search, Bot, MapPin, BookText, Download, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HIGHLIGHT_STATUSES } from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Case } from '@/lib/types'

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
}

export default function CaseList({
  cases,
  selectedCaseId,
  onSelect,
  onOpenSearch,
  onOpenAutoSearch,
  autoBadge,
  onToggleMap,
  mapSearching,
  onToggleTownpage,
  townpageSearching,
  onOpenImport,
  onOpenNew,
  searchActive,
}: Props) {
  return (
    <div className="flex h-full flex-col">
      {/* ツールバー */}
      <div className="flex flex-wrap items-center gap-1 border-b bg-card p-1.5">
        <Button
          variant={searchActive ? 'default' : 'outline'}
          size="sm"
          onClick={onOpenSearch}
        >
          <Search className="h-3 w-3" />
          検索
        </Button>
        <div className="relative">
          <Button variant="outline" size="sm" onClick={onOpenAutoSearch}>
            <Bot className="h-3 w-3" />
            自動
          </Button>
          {autoBadge > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[8px] font-bold text-white">
              {autoBadge}
            </span>
          )}
        </div>
        <Button
          size="sm"
          className={cn(
            mapSearching
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-green-600 hover:bg-green-700',
            'text-white',
          )}
          onClick={onToggleMap}
        >
          {mapSearching ? '■ 停止' : (<><MapPin className="h-3 w-3" />MAP</>)}
        </Button>
        <Button
          size="sm"
          className={cn(
            townpageSearching
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-orange-500 hover:bg-orange-600',
            'text-white',
          )}
          onClick={onToggleTownpage}
        >
          {townpageSearching ? '■ 停止' : (<><BookText className="h-3 w-3" />TP</>)}
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenImport}>
          <Download className="h-3 w-3" />
          取込
        </Button>
        <Button size="sm" onClick={onOpenNew}>
          <Plus className="h-3 w-3" />
          新規
        </Button>
      </div>

      {/* 件数 */}
      <div className="border-b bg-muted/30 px-2 py-0.5 text-2xs text-muted-foreground">
        {cases.length} 件
      </div>

      {/* 一覧 */}
      <div className="flex-1 overflow-y-auto">
        {cases.length === 0 && (
          <div className="p-3 text-center text-2xs text-muted-foreground">
            案件がありません
          </div>
        )}
        {cases.map((c) => {
          const highlight = HIGHLIGHT_STATUSES.includes(c.status as never)
          const selected = c.id === selectedCaseId
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={cn(
                'block w-full border-b px-2 py-1.5 text-left transition-colors',
                selected
                  ? 'bg-primary/10'
                  : highlight
                    ? 'bg-green-50 hover:bg-green-100'
                    : 'hover:bg-accent',
              )}
            >
              <div className="flex items-center gap-1">
                {c.industry && (
                  <span className="shrink-0 rounded-sm bg-muted px-1 text-[9px] text-muted-foreground">
                    {c.industry}
                  </span>
                )}
                <span className="truncate text-xs font-medium">{c.name}</span>
              </div>
              <div className="truncate text-[9px] text-muted-foreground">{c.address}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

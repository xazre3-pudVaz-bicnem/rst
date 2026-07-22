import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { INDUSTRIES, STATUSES } from '@/lib/constants'
import { useAssignableUsers, withCurrent } from '@/hooks/useAssignableUsers'
import { cn } from '@/lib/utils'

export interface SearchCriteria {
  name: string
  address: string
  phone: string
  industries: string[]   // 複数選択（空＝すべて）
  sales_rep: string
  status: string
  uncalledOnly: boolean
  overdueRecallOnly: boolean
  hasRecall: 'any' | 'yes' | 'no'
  lastCallFrom: string
  lastCallTo: string
}

const EMPTY: SearchCriteria = {
  name: '', address: '', phone: '', industries: [], sales_rep: '', status: '',
  uncalledOnly: false, overdueRecallOnly: false, hasRecall: 'any',
  lastCallFrom: '', lastCallTo: '',
}

/** 旧形式（industry:string 単一）で保存されたcriteriaを新形式(industries:string[])へ正規化。 */
export function normalizeCriteria(c: SearchCriteria | null): SearchCriteria | null {
  if (!c) return c
  const anyC = c as unknown as { industry?: string; industries?: string[] }
  if (!Array.isArray(anyC.industries)) {
    return { ...c, industries: anyC.industry ? [anyC.industry] : [] }
  }
  return c
}

const ALL = '__all__'

interface Props {
  open: boolean
  initial: SearchCriteria | null
  onClose: () => void
  onSearch: (c: SearchCriteria) => void
  onReset: () => void
}

export default function SearchModal({ open, initial, onClose, onSearch, onReset }: Props) {
  const { names: assignableNames } = useAssignableUsers()
  const [c, setC] = useState<SearchCriteria>({ ...EMPTY })
  const set = (k: keyof SearchCriteria, v: string | boolean) =>
    setC((p) => ({ ...p, [k]: v === ALL ? '' : v }))
  const toggleIndustry = (i: string) =>
    setC((p) => ({ ...p, industries: p.industries.includes(i) ? p.industries.filter((x) => x !== i) : [...p.industries, i] }))

  useEffect(() => {
    if (open) setC(normalizeCriteria(initial) ?? { ...EMPTY })
  }, [open, initial])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>案件 詳細検索</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          <div className="space-y-1">
            <Label>店舗名</Label>
            <Input value={c.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>住所<span className="ml-1 text-2xs font-normal text-muted-foreground">スペース区切りでOR検索（例: 東京 埼玉 千葉）</span></Label>
            <Input value={c.address} onChange={(e) => set('address', e.target.value)} placeholder="東京 埼玉 千葉 神奈川" />
          </div>
          <div className="space-y-1">
            <Label>電話番号（ハイフン有無問わず）</Label>
            <Input value={c.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label>業種（複数選択可）{c.industries.length > 0 && <span className="ml-1 text-2xs text-muted-foreground">{c.industries.length}件選択中</span>}</Label>
              {c.industries.length > 0 && (
                <button type="button" className="text-2xs text-muted-foreground hover:underline" onClick={() => setC((p) => ({ ...p, industries: [] }))}>クリア</button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {INDUSTRIES.map((i) => {
                const on = c.industries.includes(i)
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleIndustry(i)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-2xs',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {i}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="space-y-1">
            <Label>営業担当</Label>
            <Select value={c.sales_rep || ALL} onValueChange={(v) => set('sales_rep', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {withCurrent(assignableNames, c.sales_rep).map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>ステータス</Label>
            <Select value={c.status || ALL} onValueChange={(v) => set('status', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>最終架電日 (から)</Label>
              <Input type="date" value={c.lastCallFrom} onChange={(e) => set('lastCallFrom', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>最終架電日 (まで)</Label>
              <Input type="date" value={c.lastCallTo} onChange={(e) => set('lastCallTo', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>再コール予定</Label>
            <Select value={c.hasRecall} onValueChange={(v) => set('hasRecall', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">指定なし</SelectItem>
                <SelectItem value="yes">予定あり</SelectItem>
                <SelectItem value="no">予定なし</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={c.uncalledOnly} onChange={(e) => set('uncalledOnly', e.target.checked)} />
            未架電のみ
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={c.overdueRecallOnly} onChange={(e) => set('overdueRecallOnly', e.target.checked)} />
            再コール期限切れのみ
          </label>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => { setC({ ...EMPTY }); onReset(); onClose() }}
          >
            リセット
          </Button>
          <Button onClick={() => { onSearch(c); onClose() }}>検索</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

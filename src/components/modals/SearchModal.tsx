import { useState } from 'react'
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
import { INDUSTRIES, SALES_REPS, STATUSES } from '@/lib/constants'

export interface SearchCriteria {
  name: string
  address: string
  phone: string
  industry: string
  sales_rep: string
  status: string
}

const EMPTY: SearchCriteria = {
  name: '',
  address: '',
  phone: '',
  industry: '',
  sales_rep: '',
  status: '',
}

const ALL = '__all__'

interface Props {
  open: boolean
  onClose: () => void
  onSearch: (c: SearchCriteria) => void
  onReset: () => void
}

export default function SearchModal({ open, onClose, onSearch, onReset }: Props) {
  const [c, setC] = useState<SearchCriteria>({ ...EMPTY })
  const set = (k: keyof SearchCriteria, v: string) =>
    setC((p) => ({ ...p, [k]: v === ALL ? '' : v }))

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>案件検索</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>案件名</Label>
            <Input value={c.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>住所</Label>
            <Input value={c.address} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>電話番号（ハイフン有無問わず）</Label>
            <Input value={c.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>業種</Label>
            <Select value={c.industry || ALL} onValueChange={(v) => set('industry', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {INDUSTRIES.map((i) => (
                  <SelectItem key={i} value={i}>
                    {i}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>営業担当</Label>
            <Select value={c.sales_rep || ALL} onValueChange={(v) => set('sales_rep', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {SALES_REPS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>ステータス</Label>
            <Select value={c.status || ALL} onValueChange={(v) => set('status', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setC({ ...EMPTY })
              onReset()
              onClose()
            }}
          >
            リセット
          </Button>
          <Button
            onClick={() => {
              onSearch(c)
              onClose()
            }}
          >
            検索
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AutoSearchSettings } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  settings: AutoSearchSettings
  onChange: (s: AutoSearchSettings) => void
  badge: number
}

const INTERVALS = [
  { value: 1, label: '1分' },
  { value: 10, label: '10分' },
  { value: 30, label: '30分' },
  { value: 60, label: '1時間' },
]

export default function AutoSearchSettingsModal({
  open,
  onClose,
  settings,
  onChange,
  badge,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>自動検索設定</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="flex items-center justify-between text-xs">
            <span>自動検索を有効化</span>
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={settings.enabled}
              onChange={(e) => onChange({ ...settings, enabled: e.target.checked })}
            />
          </label>

          <div className="space-y-1">
            <Label>実行間隔</Label>
            <Select
              value={String(settings.intervalMinutes)}
              onValueChange={(v) =>
                onChange({ ...settings, intervalMinutes: Number(v) })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((i) => (
                  <SelectItem key={i.value} value={String(i.value)}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md bg-muted/50 p-2 text-2xs text-muted-foreground">
            アプリ表示中のみバックグラウンドで新規開業情報を収集します。
            <br />
            これまでの自動追加件数:{' '}
            <span className="font-bold text-primary">{badge}</span> 件
          </div>
          <div className="text-[9px] text-muted-foreground">
            ※ LLM + Web検索は Supabase Edge Function（llm-search）を使用します。
            未設定の場合は検索はスキップされます。
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>閉じる</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

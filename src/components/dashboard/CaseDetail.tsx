import { useEffect, useState } from 'react'
import { Pencil, Trash2, Save, Award, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CaseApi } from '@/lib/api'
import { SALES_REPS, STATUSES } from '@/lib/constants'
import type { Case } from '@/lib/types'

interface Props {
  selectedCase: Case | null
  onEdit: () => void
  onChanged: () => void
}

const NONE = '__none__'

function UrlLink({ label, url }: { label: string; url?: string | null }) {
  if (!url) return <span className="text-muted-foreground">—</span>
  const href = url.startsWith('http') ? url : `https://${url}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-primary hover:underline"
    >
      {label}
      <ExternalLink className="h-2.5 w-2.5" />
    </a>
  )
}

export default function CaseDetail({ selectedCase, onEdit, onChanged }: Props) {
  const [salesRep, setSalesRep] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSalesRep(selectedCase?.sales_rep ?? '')
    setStatus(selectedCase?.status ?? '')
  }, [selectedCase])

  if (!selectedCase) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        案件を選択してください
      </div>
    )
  }

  const dirty =
    salesRep !== (selectedCase.sales_rep ?? '') || status !== selectedCase.status

  async function handleSave() {
    if (!selectedCase) return
    setSaving(true)
    try {
      await CaseApi.update(selectedCase.id, {
        sales_rep: salesRep || null,
        status,
      })
      onChanged()
    } catch (e) {
      alert('保存に失敗しました: ' + (e instanceof Error ? e.message : e))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!selectedCase) return
    if (!confirm(`「${selectedCase.name}」を削除しますか？`)) return
    try {
      await CaseApi.remove(selectedCase.id)
      onChanged()
    } catch (e) {
      alert('削除に失敗しました: ' + (e instanceof Error ? e.message : e))
    }
  }

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex border-b py-1">
      <div className="w-20 shrink-0 text-2xs text-muted-foreground">{label}</div>
      <div className="flex-1 text-xs">{value || '—'}</div>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {/* ヘッダ */}
      <div className="flex items-start justify-between border-b bg-card p-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{selectedCase.name}</div>
          <div className="truncate text-2xs text-muted-foreground">
            {selectedCase.address}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="h-3 w-3" />
            編集
          </Button>
          <Button variant="outline" size="sm" onClick={() => alert('成約情報は未実装です')}>
            <Award className="h-3 w-3" />
            成約情報
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="h-3 w-3" />
            削除
          </Button>
        </div>
      </div>

      {/* インライン担当/ステータス編集 */}
      <div className="flex items-end gap-2 border-b bg-muted/30 p-2">
        <div className="flex-1 space-y-0.5">
          <div className="text-2xs text-muted-foreground">営業担当</div>
          <Select value={salesRep || NONE} onValueChange={(v) => setSalesRep(v === NONE ? '' : v)}>
            <SelectTrigger>
              <SelectValue placeholder="未割当" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未割当</SelectItem>
              {SALES_REPS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 space-y-0.5">
          <div className="text-2xs text-muted-foreground">ステータス</div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          <Save className="h-3 w-3" />
          {saving ? '...' : '保存'}
        </Button>
      </div>

      {/* 詳細 */}
      <div className="flex-1 overflow-y-auto p-2">
        {row('業種', selectedCase.industry)}
        {row('電話1', selectedCase.phone1)}
        {row('電話2', selectedCase.phone2)}
        {row('電話3', selectedCase.phone3)}
        {row('住所', selectedCase.address)}
        {row('代表者名', selectedCase.representative)}
        {row('HP1', <UrlLink label="HP1を開く" url={selectedCase.hp1} />)}
        {row('HP2', <UrlLink label="HP2を開く" url={selectedCase.hp2} />)}
        {row('Instagram', <UrlLink label="Instagram" url={selectedCase.instagram} />)}
        {row(
          '情報源',
          selectedCase.source_urls ? (
            <div className="space-y-0.5">
              {selectedCase.source_urls
                .split('\n')
                .filter(Boolean)
                .map((u, i) => (
                  <div key={i}>
                    <UrlLink label={u} url={u} />
                  </div>
                ))}
            </div>
          ) : null,
        )}
        {row('メモ', <span className="whitespace-pre-wrap">{selectedCase.memo}</span>)}
      </div>
    </div>
  )
}

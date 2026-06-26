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
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { CaseApi } from '@/lib/api'
import { extractShops, buildImportPrompt } from '@/lib/llm'
import { phoneDigits } from '@/lib/utils'
import type { Case, ExtractedShop } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  existingCases: Case[]
  onImported: () => void
}

interface Row extends ExtractedShop {
  _selected: boolean
}

export default function ImportModal({ open, onClose, existingCases, onImported }: Props) {
  const [urls, setUrls] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  async function handleExtract() {
    const list = urls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean)
    if (list.length === 0) {
      alert('URLを入力してください')
      return
    }
    setLoading(true)
    setRows([])
    try {
      const all: Row[] = []
      for (const url of list) {
        try {
          const shops = await extractShops(buildImportPrompt(url))
          shops.forEach((s) =>
            all.push({ ...s, source_urls: s.source_urls || url, _selected: true }),
          )
        } catch (e) {
          console.error('[Import]', url, e)
        }
      }
      if (all.length === 0) {
        alert(
          '抽出できませんでした。Edge Function(llm-search)が未設定の可能性があります。',
        )
      }
      setRows(all)
    } finally {
      setLoading(false)
    }
  }

  function updateRow(i: number, k: keyof ExtractedShop, v: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
  }
  function toggle(i: number) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, _selected: !r._selected } : r)))
  }

  async function handleImport() {
    const selected = rows.filter((r) => r._selected && r.name?.trim())
    if (selected.length === 0) {
      alert('登録する案件を選択してください')
      return
    }
    setImporting(true)
    let added = 0
    try {
      const existDigits = new Set(
        existingCases.flatMap((c) => [c.phone1, c.phone2, c.phone3].map(phoneDigits)),
      )
      for (const r of selected) {
        const d = phoneDigits(r.phone1)
        if (d && existDigits.has(d)) continue // 電話重複はスキップ
        await CaseApi.create({
          name: r.name,
          address: r.address || '',
          phone1: r.phone1 || '',
          phone2: r.phone2 || null,
          industry: r.industry || null,
          representative: r.representative || null,
          hp1: r.hp1 || null,
          instagram: r.instagram || null,
          source_urls: r.source_urls || null,
          memo: r.memo || null,
          status: '新規',
        })
        if (d) existDigits.add(d)
        added++
      }
      alert(`${added}件を登録しました`)
      onImported()
      setUrls('')
      setRows([])
      onClose()
    } catch (e) {
      alert('登録に失敗しました: ' + (e instanceof Error ? e.message : e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>URLから案件を取込</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <div className="space-y-1">
            <Label>URL（1行に1つ）</Label>
            <Textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              rows={3}
              placeholder="https://..."
            />
          </div>
          <Button onClick={handleExtract} disabled={loading}>
            {loading ? '抽出中...' : 'Webから情報抽出'}
          </Button>

          {rows.length > 0 && (
            <div className="max-h-[40vh] space-y-2 overflow-y-auto rounded-md border p-2">
              {rows.map((r, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[auto_1fr_1fr] items-center gap-1 border-b pb-2 last:border-0"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={r._selected}
                    onChange={() => toggle(i)}
                  />
                  <Input
                    value={r.name ?? ''}
                    onChange={(e) => updateRow(i, 'name', e.target.value)}
                    placeholder="店名"
                  />
                  <Input
                    value={r.phone1 ?? ''}
                    onChange={(e) => updateRow(i, 'phone1', e.target.value)}
                    placeholder="電話"
                  />
                  <div />
                  <Input
                    value={r.address ?? ''}
                    onChange={(e) => updateRow(i, 'address', e.target.value)}
                    placeholder="住所"
                  />
                  <Input
                    value={r.industry ?? ''}
                    onChange={(e) => updateRow(i, 'industry', e.target.value)}
                    placeholder="業種"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button onClick={handleImport} disabled={importing || rows.length === 0}>
            {importing
              ? '登録中...'
              : `選択した${rows.filter((r) => r._selected).length}件を案件登録`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

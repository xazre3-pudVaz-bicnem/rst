import { useMemo, useRef, useState } from 'react'
import { Upload, FileSpreadsheet, Link2, AlertTriangle, CheckCircle2 } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CaseApi, ImportBatchApi, AuditApi } from '@/lib/api'
import { extractShops, buildImportPrompt } from '@/lib/llm'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { DEFAULT_STATUS } from '@/lib/constants'
import { normalizePhone, phoneDigits, normalizeAddress, parseCsv, readCsvFile } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { Case, ExtractedShop } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  existingCases: Case[]
  onImported: () => void
}

type Tab = 'csv' | 'url'
type DupMode = 'skip' | 'overwrite' | 'add'

/** 取込対象フィールド定義（* は必須） */
const FIELDS = [
  { key: 'name', label: '店舗名 *', required: true, synonyms: ['店名', '店舗名', '会社名', '名前', '案件名', '屋号', 'name', 'company'] },
  { key: 'phone1', label: '電話番号1', synonyms: ['電話', '電話番号', '電話1', '電話番号1', 'tel', 'phone', '代表電話'] },
  { key: 'phone2', label: '電話番号2', synonyms: ['電話2', '電話番号2'] },
  { key: 'phone3', label: '電話番号3', synonyms: ['電話3', '電話番号3'] },
  { key: 'address', label: '住所', synonyms: ['住所', '所在地', '場所', 'address'] },
  { key: 'industry', label: '業種', synonyms: ['業種', 'ジャンル', 'カテゴリ', 'industry'] },
  { key: 'representative', label: '代表者名', synonyms: ['代表', '代表者', '代表者名', 'オーナー'] },
  { key: 'status', label: 'ステータス', synonyms: ['ステータス', '状態', 'status'] },
  { key: 'sales_rep', label: '営業担当', synonyms: ['営業', '営業担当', '担当', '担当者'] },
  { key: 'hp1', label: 'HP', synonyms: ['hp', 'url', 'ホームページ', 'ウェブサイト', 'web', 'サイト'] },
  { key: 'instagram', label: 'Instagram', synonyms: ['instagram', 'インスタ', 'ig'] },
  { key: 'memo', label: 'メモ', synonyms: ['メモ', '備考', 'memo', 'note'] },
] as const

type FieldKey = (typeof FIELDS)[number]['key']

const NONE = '__none__'

interface MappedRow {
  rowNo: number
  data: Partial<Record<FieldKey, string>>
  error?: string
  dup?: Case
}

export default function ImportModal({ open, onClose, existingCases, onImported }: Props) {
  const { user } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('csv')
  const fileRef = useRef<HTMLInputElement>(null)

  // ---- CSV state ----
  const [rawRows, setRawRows] = useState<string[][]>([])
  const [hasHeader, setHasHeader] = useState(true)
  const [fileName, setFileName] = useState('')
  const [mapping, setMapping] = useState<Record<FieldKey, number>>(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, -1])) as Record<FieldKey, number>,
  )
  const [dupMode, setDupMode] = useState<DupMode>('skip')
  const [importing, setImporting] = useState(false)

  // ---- URL/LLM state ----
  const [urls, setUrls] = useState('')
  const [rows, setRows] = useState<(ExtractedShop & { _selected: boolean })[]>([])
  const [loading, setLoading] = useState(false)

  function resetCsv() {
    setRawRows([])
    setFileName('')
    setMapping(Object.fromEntries(FIELDS.map((f) => [f.key, -1])) as Record<FieldKey, number>)
  }

  function autoMap(headerRow: string[]) {
    const next = { ...mapping }
    FIELDS.forEach((f) => {
      const idx = headerRow.findIndex((h) => {
        const hn = h.trim().toLowerCase()
        return f.synonyms.some((s) => hn === s.toLowerCase() || hn.includes(s.toLowerCase()))
      })
      next[f.key] = idx
    })
    setMapping(next)
  }

  function loadText(text: string, name = '') {
    const parsed = parseCsv(text)
    if (parsed.length === 0) {
      toast.error('CSVを読み込めませんでした。内容を確認してください。')
      return
    }
    setRawRows(parsed)
    setFileName(name)
    setHasHeader(true)
    autoMap(parsed[0])
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      // UTF-8 / Shift-JIS を自動判定して読み込む
      const text = await readCsvFile(file)
      loadText(text, file.name)
    } catch {
      toast.error('ファイルの読み込みに失敗しました。')
    }
  }

  const headerRow = rawRows[0] ?? []
  const dataRows = hasHeader ? rawRows.slice(1) : rawRows
  const columns = useMemo(
    () => headerRow.map((h, i) => ({ index: i, label: hasHeader ? h || `列${i + 1}` : `列${i + 1}` })),
    [headerRow, hasHeader],
  )

  // 既存案件の重複インデックス
  const dupIndex = useMemo(() => {
    const byPhone = new Map<string, Case>()
    const byNameAddr = new Map<string, Case>()
    for (const c of existingCases) {
      for (const p of [c.phone1, c.phone2, c.phone3]) {
        const d = phoneDigits(p)
        if (d) byPhone.set(d, c)
      }
      byNameAddr.set(`${c.name.trim()}|${normalizeAddress(c.address)}`, c)
    }
    return { byPhone, byNameAddr }
  }, [existingCases])

  // マッピング適用＋検証
  const mapped = useMemo<MappedRow[]>(() => {
    if (rawRows.length === 0) return []
    return dataRows.map((cols, i) => {
      const data: Partial<Record<FieldKey, string>> = {}
      FIELDS.forEach((f) => {
        const idx = mapping[f.key]
        if (idx >= 0) {
          const v = (cols[idx] ?? '').trim()
          if (v) data[f.key] = v
        }
      })
      const rowNo = hasHeader ? i + 2 : i + 1
      let error: string | undefined
      if (!data.name) error = '店舗名が空です'
      // 重複判定
      let dup: Case | undefined
      const d = phoneDigits(data.phone1)
      if (d && dupIndex.byPhone.has(d)) dup = dupIndex.byPhone.get(d)
      if (!dup && data.name) {
        const key = `${data.name.trim()}|${normalizeAddress(data.address)}`
        if (dupIndex.byNameAddr.has(key)) dup = dupIndex.byNameAddr.get(key)
      }
      return { rowNo, data, error, dup }
    })
  }, [rawRows, dataRows, mapping, hasHeader, dupIndex])

  const stats = useMemo(() => {
    const errors = mapped.filter((m) => m.error)
    const dups = mapped.filter((m) => !m.error && m.dup)
    const fresh = mapped.filter((m) => !m.error && !m.dup)
    return { total: mapped.length, errors, dups, fresh }
  }, [mapped])

  async function handleCsvImport() {
    if (mapped.length === 0) {
      toast.error('取り込む行がありません。')
      return
    }
    if (mapping.name < 0) {
      toast.error('「店舗名」の列を指定してください。')
      return
    }
    setImporting(true)
    let added = 0
    let duplicate = 0
    let errorCount = stats.errors.length
    try {
      for (const m of mapped) {
        if (m.error) continue
        const payload: Partial<Case> = {
          name: m.data.name!.trim(),
          address: (m.data.address ?? '').trim(),
          phone1: normalizePhone(m.data.phone1 ?? ''),
          phone2: normalizePhone(m.data.phone2 ?? '') || null,
          phone3: normalizePhone(m.data.phone3 ?? '') || null,
          industry: m.data.industry || null,
          representative: m.data.representative || null,
          status: m.data.status || DEFAULT_STATUS,
          sales_rep: m.data.sales_rep || null,
          hp1: m.data.hp1 || null,
          instagram: m.data.instagram || null,
          memo: m.data.memo || null,
        }
        try {
          if (m.dup) {
            if (dupMode === 'skip') {
              duplicate++
              continue
            }
            if (dupMode === 'overwrite') {
              await CaseApi.update(m.dup.id, payload)
              duplicate++
              continue
            }
            // add → 別案件として追加
          }
          await CaseApi.create({ ...payload, created_by_id: user?.id ?? null })
          added++
        } catch (e) {
          console.error('[CSV import row]', m.rowNo, e)
          errorCount++
        }
      }

      await ImportBatchApi.create({
        source: 'csv',
        file_name: fileName || null,
        total_rows: mapped.length,
        added_count: added,
        duplicate_count: duplicate,
        error_count: errorCount,
        detail: stats.errors.slice(0, 50).map((e) => `${e.rowNo}行目: ${e.error}`).join('\n') || null,
        created_by_id: user?.id ?? null,
      })

      AuditApi.log({
        action: 'import',
        entity: 'import',
        entity_name: fileName || 'CSV',
        detail: `追加${added} / 重複${duplicate} / エラー${errorCount}`,
        actor_id: user?.id ?? null,
      })
      toast.success(`取込完了: ${added}件追加 / ${duplicate}件重複 / ${errorCount}件エラー`)
      onImported()
      resetCsv()
      onClose()
    } catch (e) {
      toast.error('取込中にエラーが発生しました: ' + (e instanceof Error ? e.message : e))
    } finally {
      setImporting(false)
    }
  }

  // ---- URL/LLM 抽出（既存機能を維持） ----
  async function handleExtract() {
    const list = urls.split('\n').map((u) => u.trim()).filter(Boolean)
    if (list.length === 0) {
      toast.error('URLを入力してください')
      return
    }
    setLoading(true)
    setRows([])
    try {
      const all: (ExtractedShop & { _selected: boolean })[] = []
      for (const url of list) {
        try {
          const shops = await extractShops(buildImportPrompt(url))
          shops.forEach((s) => all.push({ ...s, source_urls: s.source_urls || url, _selected: true }))
        } catch (e) {
          console.error('[Import]', url, e)
        }
      }
      if (all.length === 0) {
        toast.error('抽出できませんでした。Edge Function(llm-search)が未設定の可能性があります。')
      }
      setRows(all)
    } finally {
      setLoading(false)
    }
  }

  async function handleUrlImport() {
    const selected = rows.filter((r) => r._selected && r.name?.trim())
    if (selected.length === 0) {
      toast.error('登録する案件を選択してください')
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
        if (d && existDigits.has(d)) continue
        await CaseApi.create({
          name: r.name,
          address: r.address || '',
          phone1: r.phone1 || '',
          phone2: r.phone2 || null,
          industry: r.industry || null,
          representative: r.representative || null,
          status: DEFAULT_STATUS,
          hp1: r.hp1 || null,
          instagram: r.instagram || null,
          source_urls: r.source_urls || null,
          memo: r.memo || null,
          created_by_id: user?.id ?? null,
        })
        if (d) existDigits.add(d)
        added++
      }
      toast.success(`${added}件を登録しました`)
      onImported()
      setUrls('')
      setRows([])
      onClose()
    } catch (e) {
      toast.error('登録に失敗しました: ' + (e instanceof Error ? e.message : e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>案件を取り込む</DialogTitle>
        </DialogHeader>

        {/* タブ */}
        <div className="flex gap-1 border-b">
          <button
            className={cn(
              'flex items-center gap-1 border-b-2 px-3 py-1.5 text-sm font-medium',
              tab === 'csv' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground',
            )}
            onClick={() => setTab('csv')}
          >
            <FileSpreadsheet className="h-4 w-4" /> CSV取込
          </button>
          <button
            className={cn(
              'flex items-center gap-1 border-b-2 px-3 py-1.5 text-sm font-medium',
              tab === 'url' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground',
            )}
            onClick={() => setTab('url')}
          >
            <Link2 className="h-4 w-4" /> URL取込（AI）
          </button>
        </div>

        {tab === 'csv' && (
          <div className="space-y-3">
            {rawRows.length === 0 ? (
              <div className="space-y-2">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed border-input py-8 text-muted-foreground hover:border-primary hover:text-primary"
                >
                  <Upload className="h-7 w-7" />
                  <span className="text-sm font-medium">CSVファイルを選択</span>
                  <span className="text-2xs">店舗名・電話番号・住所などを含むCSV（UTF-8）</span>
                </button>
                <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onFile} />
                <div className="text-2xs text-muted-foreground">またはCSVを直接貼り付け:</div>
                <Textarea
                  rows={3}
                  placeholder={'店舗名,電話番号,住所\nABC店,03-1234-5678,東京都...'}
                  onChange={(e) => e.target.value.includes(',') && loadText(e.target.value)}
                />
              </div>
            ) : (
              <>
                {/* サマリ + ファイル名 */}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{fileName || '貼り付けデータ'}</span>
                  <span className="text-muted-foreground">{stats.total}行</span>
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-800">新規 {stats.fresh.length}</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">重複 {stats.dups.length}</span>
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">エラー {stats.errors.length}</span>
                  <label className="ml-auto flex items-center gap-1">
                    <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                    1行目はヘッダー
                  </label>
                  <Button variant="outline" size="sm" onClick={resetCsv}>選び直す</Button>
                </div>

                {/* 列マッピング */}
                <div className="rounded-md border p-2">
                  <div className="mb-1.5 text-2xs font-bold text-muted-foreground">列マッピング（CSVの列を項目に割り当て）</div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 md:grid-cols-3">
                    {FIELDS.map((f) => (
                      <div key={f.key} className="flex items-center gap-1.5">
                        <span className={cn('w-20 shrink-0 text-2xs', 'required' in f && f.required && 'font-bold')}>{f.label}</span>
                        <Select
                          value={mapping[f.key] >= 0 ? String(mapping[f.key]) : NONE}
                          onValueChange={(v) =>
                            setMapping((m) => ({ ...m, [f.key]: v === NONE ? -1 : Number(v) }))
                          }
                        >
                          <SelectTrigger className="h-6 flex-1 text-2xs">
                            <SelectValue placeholder="未割当" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>未割当</SelectItem>
                            {columns.map((c) => (
                              <SelectItem key={c.index} value={String(c.index)}>{c.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 重複時の動作 */}
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium">重複時:</span>
                  {([
                    ['skip', 'スキップ'],
                    ['overwrite', '上書き'],
                    ['add', '別案件で追加'],
                  ] as [DupMode, string][]).map(([v, label]) => (
                    <label key={v} className="flex items-center gap-1">
                      <input type="radio" name="dupMode" checked={dupMode === v} onChange={() => setDupMode(v)} />
                      {label}
                    </label>
                  ))}
                  <span className="text-2xs text-muted-foreground">（電話番号 / 店舗名＋住所で判定）</span>
                </div>

                {/* プレビュー */}
                <div className="max-h-[34vh] overflow-auto rounded-md border">
                  <table className="w-full text-2xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr className="text-left text-muted-foreground">
                        <th className="p-1">行</th>
                        <th className="p-1">店舗名</th>
                        <th className="p-1">電話</th>
                        <th className="p-1">住所</th>
                        <th className="p-1">状態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mapped.slice(0, 100).map((m) => (
                        <tr
                          key={m.rowNo}
                          className={cn(
                            'border-t',
                            m.error ? 'bg-red-50 dark:bg-red-500/10' : m.dup ? 'bg-amber-50 dark:bg-amber-500/10' : '',
                          )}
                        >
                          <td className="p-1 text-muted-foreground">{m.rowNo}</td>
                          <td className="p-1">{m.data.name ?? '—'}</td>
                          <td className="p-1">{m.data.phone1 ?? '—'}</td>
                          <td className="max-w-[200px] truncate p-1">{m.data.address ?? '—'}</td>
                          <td className="p-1">
                            {m.error ? (
                              <span className="flex items-center gap-0.5 text-red-600">
                                <AlertTriangle className="h-3 w-3" />{m.error}
                              </span>
                            ) : m.dup ? (
                              <span className="text-amber-700">重複: {m.dup.name}</span>
                            ) : (
                              <span className="flex items-center gap-0.5 text-green-600">
                                <CheckCircle2 className="h-3 w-3" />新規
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {mapped.length > 100 && (
                    <div className="p-1 text-center text-2xs text-muted-foreground">
                      先頭100行を表示中（全{mapped.length}行を取り込みます）
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'url' && (
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>URL（1行に1つ）</Label>
              <Textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={3} placeholder="https://..." />
            </div>
            <Button onClick={handleExtract} disabled={loading}>
              {loading ? '抽出中...' : 'Webから情報抽出'}
            </Button>
            {rows.length > 0 && (
              <div className="max-h-[40vh] space-y-2 overflow-y-auto rounded-md border p-2">
                {rows.map((r, i) => (
                  <div key={i} className="grid grid-cols-[auto_1fr_1fr] items-center gap-1 border-b pb-2 last:border-0">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={r._selected}
                      onChange={() => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, _selected: !x._selected } : x)))}
                    />
                    <Input value={r.name ?? ''} onChange={(e) => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))} placeholder="店名" />
                    <Input value={r.phone1 ?? ''} onChange={(e) => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, phone1: e.target.value } : x)))} placeholder="電話" />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          {tab === 'csv' ? (
            <Button onClick={handleCsvImport} disabled={importing || mapped.length === 0}>
              {importing ? '取込中...' : `${stats.fresh.length + (dupMode === 'add' ? stats.dups.length : 0)}件を取り込む`}
            </Button>
          ) : (
            <Button onClick={handleUrlImport} disabled={importing || rows.length === 0}>
              {importing ? '登録中...' : `選択した${rows.filter((r) => r._selected).length}件を登録`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

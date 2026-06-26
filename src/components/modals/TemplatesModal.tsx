import { useEffect, useState } from 'react'
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { TemplateApi } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { STATUSES, DEFAULT_TEMPLATES } from '@/lib/constants'
import { jpError } from '@/lib/utils'
import type { Template } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  onChanged: () => void
}

const NONE = '__none__'

export default function TemplatesModal({ open, onClose, onChanged }: Props) {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [list, setList] = useState<Template[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [status, setStatus] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    setList(await TemplateApi.list())
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  function resetForm() {
    setTitle(''); setBody(''); setStatus(''); setEditingId(null)
  }

  async function save() {
    if (!title.trim() || !body.trim()) {
      toast.error('タイトルと本文を入力してください')
      return
    }
    setBusy(true)
    try {
      if (editingId) {
        await TemplateApi.update(editingId, { title: title.trim(), body: body.trim(), status: status || null })
        toast.success('定型文を更新しました')
      } else {
        await TemplateApi.create({ category: 'memo', title: title.trim(), body: body.trim(), status: status || null, created_by_id: user?.id ?? null })
        toast.success('定型文を追加しました')
      }
      resetForm()
      await load()
      onChanged()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setBusy(false)
    }
  }

  function edit(t: Template) {
    setEditingId(t.id); setTitle(t.title); setBody(t.body); setStatus(t.status ?? '')
  }

  async function remove(id: string) {
    if (!(await confirm({ title: '定型文を削除しますか？', confirmLabel: '削除する', danger: true }))) return
    try {
      await TemplateApi.remove(id)
      await load()
      onChanged()
    } catch (e) {
      toast.error('削除に失敗しました: ' + jpError(e))
    }
  }

  async function seed() {
    const n = await TemplateApi.seedDefaults(DEFAULT_TEMPLATES)
    if (n > 0) {
      toast.success(`既定の定型文を${n}件追加しました`)
      await load()
      onChanged()
    } else {
      toast.info('既に定型文が登録されています')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>通話メモ定型文の管理</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 rounded-md border p-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>タイトル</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 不在" />
            </div>
            <div className="space-y-1">
              <Label>紐づくステータス（任意）</Label>
              <Select value={status || NONE} onValueChange={(v) => setStatus(v === NONE ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="なし" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>なし</SelectItem>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label>本文</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="例: 不在でした。時間を変えて再架電。" />
          </div>
          <div className="flex justify-end gap-2">
            {editingId && <Button variant="outline" size="sm" onClick={resetForm}><X className="h-3.5 w-3.5" />キャンセル</Button>}
            <Button size="sm" onClick={save} disabled={busy}>
              {editingId ? <><Check className="h-3.5 w-3.5" />更新</> : <><Plus className="h-3.5 w-3.5" />追加</>}
            </Button>
          </div>
        </div>

        <div className="max-h-[40vh] space-y-1 overflow-y-auto">
          {list.length === 0 && (
            <div className="py-4 text-center text-xs text-muted-foreground">
              定型文がありません。
              <button className="ml-1 text-primary underline" onClick={seed}>既定の定型文を投入</button>
            </div>
          )}
          {list.map((t) => (
            <div key={t.id} className="flex items-start gap-2 rounded-md border p-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="text-sm font-medium">{t.title}</span>
                  {t.status && <span className="rounded-sm bg-muted px-1 text-[9px] text-muted-foreground">{t.status}</span>}
                </div>
                <div className="whitespace-pre-wrap text-2xs text-muted-foreground">{t.body}</div>
              </div>
              <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => edit(t)}><Pencil className="h-3.5 w-3.5" /></button>
              <button className="rounded p-1 text-destructive hover:bg-destructive/10" onClick={() => remove(t.id)}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>閉じる</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

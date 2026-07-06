import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, FileText } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { EmployeeApi, LaborDocumentApi, LaborAuditApi } from '@/lib/api'
import { laborPerms, DOCUMENT_TYPES, DOCUMENT_STATUSES } from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, LaborDocument } from '@/lib/types'

const ALL = '__all__'

/** ISO timestamp / YYYY-MM-DD → YYYY-MM-DD 表記 */
function fmtDate(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** ISO timestamp → date input 用 YYYY-MM-DD */
function toDateInput(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isExpired(doc: LaborDocument): boolean {
  if (!doc.expires_at) return false
  if (doc.status === '確認済み') return false
  const d = new Date(doc.expires_at)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() < Date.now()
}

function statusVariant(status?: string | null): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case '確認済み':
    case '提出済み':
      return 'success'
    case '未提出':
      return 'warning'
    case '期限切れ':
    case '差戻し':
      return 'destructive'
    default:
      return 'secondary'
  }
}

interface DocForm {
  id: string | null
  employee_id: string
  document_type: string
  title: string
  file_url: string
  status: string
  signed_at: string
  expires_at: string
}

function emptyDocForm(): DocForm {
  return {
    id: null, employee_id: '', document_type: DOCUMENT_TYPES[0], title: '',
    file_url: '', status: DOCUMENT_STATUSES[0], signed_at: '', expires_at: '',
  }
}

export default function Documents() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [docs, setDocs] = useState<LaborDocument[]>([])
  const [loading, setLoading] = useState(true)

  const [empFilter, setEmpFilter] = useState<string>(ALL)
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [typeFilter, setTypeFilter] = useState<string>(ALL)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<DocForm>(emptyDocForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, list] = await Promise.all([EmployeeApi.list(), LaborDocumentApi.list()])
      setEmployees(emps)
      setDocs(list)
    } catch (e) {
      console.error('[Documents]', e)
      toast.error(e instanceof Error ? e.message : '労務書類の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])
  const myEmployee = useMemo(
    () => employees.find((e) => e.user_id && user?.id && e.user_id === user.id) ?? null,
    [employees, user?.id],
  )

  const scopedDocs = useMemo(
    () => (perms.selfOnly ? docs.filter((d) => d.employee_id === myEmployee?.id) : docs),
    [docs, perms.selfOnly, myEmployee?.id],
  )

  const filteredDocs = useMemo(() => scopedDocs.filter((d) => {
    if (empFilter !== ALL && d.employee_id !== empFilter) return false
    if (statusFilter !== ALL && (d.status ?? '') !== statusFilter) return false
    if (typeFilter !== ALL && d.document_type !== typeFilter) return false
    return true
  }), [scopedDocs, empFilter, statusFilter, typeFilter])

  const summary = useMemo(() => {
    const s = { 未提出: 0, 提出済み: 0, 確認済み: 0, 期限切れ: 0, 差戻し: 0 }
    for (const d of scopedDocs) {
      if (isExpired(d)) { s.期限切れ++; continue }
      const st = d.status as keyof typeof s
      if (st in s) s[st]++
    }
    return s
  }, [scopedDocs])

  const setField = (k: keyof DocForm, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  function openCreate() {
    setForm({ ...emptyDocForm(), employee_id: perms.selfOnly ? (myEmployee?.id ?? '') : '' })
    setDialogOpen(true)
  }

  function openEdit(doc: LaborDocument) {
    setForm({
      id: doc.id,
      employee_id: doc.employee_id,
      document_type: doc.document_type || DOCUMENT_TYPES[0],
      title: doc.title ?? '',
      file_url: doc.file_url ?? '',
      status: doc.status || DOCUMENT_STATUSES[0],
      signed_at: toDateInput(doc.signed_at),
      expires_at: toDateInput(doc.expires_at),
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!perms.canManage) return
    const employeeId = perms.selfOnly ? (myEmployee?.id ?? '') : form.employee_id
    if (!employeeId) { toast.error('従業員を選択してください'); return }
    if (!form.document_type) { toast.error('書類種別を選択してください'); return }
    const payload: Partial<LaborDocument> = {
      employee_id: employeeId,
      document_type: form.document_type,
      title: form.title.trim() === '' ? null : form.title.trim(),
      file_url: form.file_url.trim() === '' ? null : form.file_url.trim(),
      status: form.status || null,
      signed_at: form.signed_at === '' ? null : form.signed_at,
      expires_at: form.expires_at === '' ? null : form.expires_at,
      uploaded_by: user?.id ?? null,
    }
    setSaving(true)
    try {
      let targetId = form.id
      if (form.id) {
        await LaborDocumentApi.update(form.id, payload)
      } else {
        const created = await LaborDocumentApi.create(payload)
        targetId = created.id
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: employeeId,
        action: '労務書類変更', target_table: 'labor_documents', target_id: targetId, after_data: payload,
      })
      toast.success('労務書類を保存しました')
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(doc: LaborDocument) {
    if (!perms.canManage) return
    if (!window.confirm('この労務書類を削除しますか？')) return
    try {
      await LaborDocumentApi.remove(doc.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: doc.employee_id,
        action: '労務書類変更', target_table: 'labor_documents', target_id: doc.id, after_data: { deleted: true },
      })
      toast.success('削除しました')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '削除に失敗しました')
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <LaborLayout>
        <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Supabase が未設定です。
        </div>
      </LaborLayout>
    )
  }

  return (
    <LaborLayout>
      <div className="mx-auto max-w-6xl space-y-3">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">労務書類</h1>
            <p className="text-2xs text-muted-foreground">契約書・通知書などの提出状況・期限管理</p>
          </div>
          {perms.canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />書類を追加
            </Button>
          )}
        </div>

        {/* サマリー */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="warning">未提出 {summary.未提出}</Badge>
          <Badge variant="success">提出済み {summary.提出済み}</Badge>
          <Badge variant="success">確認済み {summary.確認済み}</Badge>
          <Badge variant="destructive">期限切れ {summary.期限切れ}</Badge>
          <Badge variant="destructive">差戻し {summary.差戻し}</Badge>
        </div>

        {/* フィルタ */}
        <div className="flex flex-wrap gap-2">
          {!perms.selfOnly && (
            <div className="w-44">
              <Select value={empFilter} onValueChange={setEmpFilter}>
                <SelectTrigger><SelectValue placeholder="従業員" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>すべての従業員</SelectItem>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="w-36">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべてのステータス</SelectItem>
                {DOCUMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-44">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger><SelectValue placeholder="書類種別" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての種別</SelectItem>
                {DOCUMENT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 一覧 */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">
            <FileText className="mr-1 inline h-3.5 w-3.5" />労務書類一覧（{filteredDocs.length}）
          </div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : filteredDocs.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">登録された労務書類はありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">書類種別</th>
                    <th className="px-2 py-1.5 text-left font-medium">タイトル</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    <th className="px-2 py-1.5 text-left font-medium">署名日</th>
                    <th className="px-2 py-1.5 text-left font-medium">期限</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredDocs.map((d) => {
                    const expired = isExpired(d)
                    return (
                      <tr
                        key={d.id}
                        className={cn(
                          'border-b last:border-0 hover:bg-accent/50',
                          expired && 'bg-red-50 dark:bg-red-500/10',
                        )}
                      >
                        <td className="px-2 py-1.5 font-medium">{empMap.get(d.employee_id)?.name ?? '—'}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">{d.document_type}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">{d.title || '—'}</td>
                        <td className="px-2 py-1.5">
                          <Badge variant={expired ? 'destructive' : statusVariant(d.status)}>
                            {expired ? '期限切れ' : (d.status ?? '—')}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(d.signed_at)}</td>
                        <td className={cn('px-2 py-1.5', expired ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
                          {fmtDate(d.expires_at)}
                        </td>
                        {perms.canManage && (
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" onClick={() => openEdit(d)}>編集</Button>
                              <Button size="sm" variant="destructive" onClick={() => handleDelete(d)}>削除</Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 追加・編集ダイアログ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? '労務書類の編集' : '書類を追加'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>従業員 *</Label>
              <Select
                value={perms.selfOnly ? (myEmployee?.id ?? '') : form.employee_id}
                onValueChange={(v) => setField('employee_id', v)}
                disabled={perms.selfOnly}
              >
                <SelectTrigger><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>書類種別 *</Label>
              <Select value={form.document_type} onValueChange={(v) => setField('document_type', v)}>
                <SelectTrigger><SelectValue placeholder="書類種別" /></SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>ステータス</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
                <SelectContent>
                  {DOCUMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>タイトル</Label>
              <Input value={form.title} onChange={(e) => setField('title', e.target.value)} placeholder="例：2026年度 雇用契約書" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>ファイルURL / ファイル名</Label>
              <Input value={form.file_url} onChange={(e) => setField('file_url', e.target.value)} placeholder="https://... または ファイル名" />
              <p className="text-2xs text-muted-foreground">初期実装ではURL/ファイル名の記録のみ</p>
            </div>
            <div className="space-y-1">
              <Label>署名日</Label>
              <Input type="date" value={form.signed_at} onChange={(e) => setField('signed_at', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>期限</Label>
              <Input type="date" value={form.expires_at} onChange={(e) => setField('expires_at', e.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>キャンセル</Button>
            {perms.canManage && (
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

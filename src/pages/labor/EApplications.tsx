import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Send } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { EmployeeApi, EApplicationApi, LaborAuditApi } from '@/lib/api'
import {
  laborPerms,
  EAPP_TYPES,
  EAPP_STATUSES,
  EAPP_TARGETS,
  procedureStatusColor,
} from '@/lib/labor'
import type { Employee, EApplication } from '@/lib/types'

const ALL = 'すべて'
/** 従業員なし（全社）を Select で表現するためのセンチネル値 */
const NONE = '__none__'

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

interface EaForm {
  id: string | null
  employee_id: string
  application_type: string
  submission_target: string
  status: string
  reference_number: string
  submitted_at: string
  completed_at: string
  note: string
}

function emptyForm(): EaForm {
  return {
    id: null,
    employee_id: NONE,
    application_type: EAPP_TYPES[0],
    submission_target: EAPP_TARGETS[0],
    status: EAPP_STATUSES[0],
    reference_number: '',
    submitted_at: '',
    completed_at: '',
    note: '',
  }
}

export default function EApplications() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [rows, setRows] = useState<EApplication[]>([])
  const [loading, setLoading] = useState(true)

  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [typeFilter, setTypeFilter] = useState<string>(ALL)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<EaForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, list] = await Promise.all([EmployeeApi.list(), EApplicationApi.list()])
      setEmployees(emps)
      setRows(list)
    } catch (e) {
      console.error('[EApplications]', e)
      toast.error(e instanceof Error ? e.message : '電子申請の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])

  const filtered = useMemo(() => rows.filter((r) => {
    if (statusFilter !== ALL && (r.status ?? '') !== statusFilter) return false
    if (typeFilter !== ALL && r.application_type !== typeFilter) return false
    return true
  }), [rows, statusFilter, typeFilter])

  const summary = useMemo(() => {
    const s: Record<string, number> = {}
    for (const st of EAPP_STATUSES) s[st] = 0
    for (const r of rows) {
      const st = r.status ?? ''
      if (st in s) s[st]++
    }
    return s
  }, [rows])

  const setField = (k: keyof EaForm, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  function openCreate() {
    setForm(emptyForm())
    setDialogOpen(true)
  }

  function openEdit(r: EApplication) {
    setForm({
      id: r.id,
      employee_id: r.employee_id ?? NONE,
      application_type: r.application_type || EAPP_TYPES[0],
      submission_target: r.submission_target || EAPP_TARGETS[0],
      status: r.status || EAPP_STATUSES[0],
      reference_number: r.reference_number ?? '',
      submitted_at: toDateInput(r.submitted_at),
      completed_at: toDateInput(r.completed_at),
      note: r.note ?? '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!perms.canManage) return
    if (!form.application_type) { toast.error('申請種別を選択してください'); return }
    const employeeId = form.employee_id === NONE ? null : form.employee_id
    const payload: Partial<EApplication> = {
      employee_id: employeeId,
      application_type: form.application_type,
      submission_target: form.submission_target || null,
      status: form.status || null,
      reference_number: form.reference_number.trim() === '' ? null : form.reference_number.trim(),
      submitted_at: form.submitted_at === '' ? null : form.submitted_at,
      completed_at: form.completed_at === '' ? null : form.completed_at,
      note: form.note.trim() === '' ? null : form.note.trim(),
    }
    setSaving(true)
    try {
      let targetId = form.id
      if (form.id) {
        await EApplicationApi.update(form.id, payload)
      } else {
        const created = await EApplicationApi.create(payload)
        targetId = created.id
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: employeeId,
        action: '電子申請', target_table: 'e_applications', target_id: targetId, after_data: payload,
      })
      toast.success('電子申請を保存しました')
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(r: EApplication) {
    if (!perms.canManage) return
    if (!window.confirm('この電子申請を削除しますか？')) return
    try {
      await EApplicationApi.remove(r.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: r.employee_id ?? null,
        action: '電子申請', target_table: 'e_applications', target_id: r.id, after_data: { deleted: true },
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

  if (perms.selfOnly) {
    return (
      <LaborLayout>
        <div className="rounded-lg border bg-sky-50 p-4 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
          この画面は管理者向けです。
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
            <h1 className="text-lg font-bold">電子申請</h1>
            <p className="text-2xs text-muted-foreground">e-Gov・ハローワーク等への電子申請の進捗管理</p>
          </div>
          {perms.canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />申請を追加
            </Button>
          )}
        </div>

        {/* 注意バナー */}
        <div className="rounded-lg border bg-amber-50 p-3 text-2xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          初期実装では申請の進捗管理のみです（e-Gov API等の自動連携は未対応）。
        </div>

        {/* サマリー */}
        <div className="flex flex-wrap gap-1.5">
          {EAPP_STATUSES.map((st) => (
            <Badge key={st} variant="outline" className={procedureStatusColor(st)}>{st} {summary[st] ?? 0}</Badge>
          ))}
        </div>

        {/* ステータスタブ */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant={statusFilter === ALL ? 'default' : 'outline'}
              onClick={() => setStatusFilter(ALL)}
            >
              すべて
            </Button>
            {EAPP_STATUSES.map((st) => (
              <Button
                key={st}
                size="sm"
                variant={statusFilter === st ? 'default' : 'outline'}
                onClick={() => setStatusFilter(st)}
              >
                {st}
              </Button>
            ))}
          </div>
          <div className="w-48">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger><SelectValue placeholder="申請種別" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての種別</SelectItem>
                {EAPP_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 一覧 */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">
            <Send className="mr-1 inline h-3.5 w-3.5" />電子申請一覧（{filtered.length}）
          </div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">電子申請はありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">申請種別</th>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">提出先</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    <th className="px-2 py-1.5 text-left font-medium">到達番号</th>
                    <th className="px-2 py-1.5 text-left font-medium">提出日</th>
                    <th className="px-2 py-1.5 text-left font-medium">完了日</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                      <td className="px-2 py-1.5 font-medium">{r.application_type}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {r.employee_id ? (empMap.get(r.employee_id)?.name ?? '—') : '全社'}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.submission_target || '—'}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="outline" className={procedureStatusColor(r.status)}>{r.status ?? '—'}</Badge>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.reference_number || '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(r.submitted_at)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(r.completed_at)}</td>
                      {perms.canManage && (
                        <td className="px-2 py-1.5">
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>編集</Button>
                            <Button size="sm" variant="destructive" onClick={() => handleDelete(r)}>削除</Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
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
            <DialogTitle>{form.id ? '電子申請の編集' : '申請を追加'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>従業員</Label>
              <Select value={form.employee_id} onValueChange={(v) => setField('employee_id', v)}>
                <SelectTrigger><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>全社</SelectItem>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>申請種別 *</Label>
              <Select value={form.application_type} onValueChange={(v) => setField('application_type', v)}>
                <SelectTrigger><SelectValue placeholder="申請種別" /></SelectTrigger>
                <SelectContent>
                  {EAPP_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>提出先</Label>
              <Select value={form.submission_target} onValueChange={(v) => setField('submission_target', v)}>
                <SelectTrigger><SelectValue placeholder="提出先" /></SelectTrigger>
                <SelectContent>
                  {EAPP_TARGETS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>ステータス</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
                <SelectContent>
                  {EAPP_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>到達番号</Label>
              <Input value={form.reference_number} onChange={(e) => setField('reference_number', e.target.value)} placeholder="到達番号" />
            </div>
            <div className="space-y-1">
              <Label>提出日</Label>
              <Input type="date" value={form.submitted_at} onChange={(e) => setField('submitted_at', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>完了日</Label>
              <Input type="date" value={form.completed_at} onChange={(e) => setField('completed_at', e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>メモ</Label>
              <Textarea value={form.note} onChange={(e) => setField('note', e.target.value)} placeholder="備考・添付書類など" />
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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ShieldCheck } from 'lucide-react'
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
import { EmployeeApi, SocialInsuranceApi, LaborAuditApi } from '@/lib/api'
import {
  laborPerms,
  SOCIAL_INSURANCE_PROCEDURE_TYPES,
  SOCIAL_INSURANCE_STATUSES,
  INSURERS,
  procedureStatusColor,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, SocialInsuranceProcedure } from '@/lib/types'

const ALL = 'すべて'

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

interface SiForm {
  id: string | null
  employee_id: string
  procedure_type: string
  insurer: string
  status: string
  target_date: string
  submitted_at: string
  reference_number: string
  standard_monthly_wage: string
  note: string
}

function emptyForm(): SiForm {
  return {
    id: null,
    employee_id: '',
    procedure_type: SOCIAL_INSURANCE_PROCEDURE_TYPES[0],
    insurer: INSURERS[0],
    status: SOCIAL_INSURANCE_STATUSES[0],
    target_date: '',
    submitted_at: '',
    reference_number: '',
    standard_monthly_wage: '',
    note: '',
  }
}

export default function SocialInsurance() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [rows, setRows] = useState<SocialInsuranceProcedure[]>([])
  const [loading, setLoading] = useState(true)

  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [typeFilter, setTypeFilter] = useState<string>(ALL)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<SiForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, list] = await Promise.all([EmployeeApi.list(), SocialInsuranceApi.list()])
      setEmployees(emps)
      setRows(list)
    } catch (e) {
      console.error('[SocialInsurance]', e)
      toast.error(e instanceof Error ? e.message : '社会保険手続きの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])

  const filtered = useMemo(() => rows.filter((r) => {
    if (statusFilter !== ALL && (r.status ?? '') !== statusFilter) return false
    if (typeFilter !== ALL && r.procedure_type !== typeFilter) return false
    return true
  }), [rows, statusFilter, typeFilter])

  const summary = useMemo(() => {
    const s: Record<string, number> = {}
    for (const st of SOCIAL_INSURANCE_STATUSES) s[st] = 0
    for (const r of rows) {
      const st = r.status ?? ''
      if (st in s) s[st]++
    }
    return s
  }, [rows])

  const setField = (k: keyof SiForm, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  function openCreate() {
    setForm(emptyForm())
    setDialogOpen(true)
  }

  function openEdit(r: SocialInsuranceProcedure) {
    setForm({
      id: r.id,
      employee_id: r.employee_id,
      procedure_type: r.procedure_type || SOCIAL_INSURANCE_PROCEDURE_TYPES[0],
      insurer: r.insurer || INSURERS[0],
      status: r.status || SOCIAL_INSURANCE_STATUSES[0],
      target_date: toDateInput(r.target_date),
      submitted_at: toDateInput(r.submitted_at),
      reference_number: r.reference_number ?? '',
      standard_monthly_wage: r.standard_monthly_wage != null ? String(r.standard_monthly_wage) : '',
      note: r.note ?? '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!perms.canManage) return
    if (!form.employee_id) { toast.error('従業員を選択してください'); return }
    if (!form.procedure_type) { toast.error('手続き種別を選択してください'); return }
    const wage = form.standard_monthly_wage.trim()
    const payload: Partial<SocialInsuranceProcedure> = {
      employee_id: form.employee_id,
      procedure_type: form.procedure_type,
      insurer: form.insurer || null,
      status: form.status || null,
      target_date: form.target_date === '' ? null : form.target_date,
      submitted_at: form.submitted_at === '' ? null : form.submitted_at,
      reference_number: form.reference_number.trim() === '' ? null : form.reference_number.trim(),
      standard_monthly_wage: wage === '' ? null : Number(wage),
      note: form.note.trim() === '' ? null : form.note.trim(),
    }
    setSaving(true)
    try {
      let targetId = form.id
      if (form.id) {
        await SocialInsuranceApi.update(form.id, payload)
      } else {
        const created = await SocialInsuranceApi.create(payload)
        targetId = created.id
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: form.employee_id,
        action: '社会保険手続き', target_table: 'social_insurance_procedures', target_id: targetId, after_data: payload,
      })
      toast.success('社会保険手続きを保存しました')
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(r: SocialInsuranceProcedure) {
    if (!perms.canManage) return
    if (!window.confirm('この社会保険手続きを削除しますか？')) return
    try {
      await SocialInsuranceApi.remove(r.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: r.employee_id,
        action: '社会保険手続き', target_table: 'social_insurance_procedures', target_id: r.id, after_data: { deleted: true },
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
            <h1 className="text-lg font-bold">社会保険手続き</h1>
            <p className="text-2xs text-muted-foreground">資格取得・喪失・算定基礎・月額変更などの進捗管理</p>
          </div>
          {perms.canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />手続きを追加
            </Button>
          )}
        </div>

        {/* サマリー */}
        <div className="flex flex-wrap gap-1.5">
          {SOCIAL_INSURANCE_STATUSES.map((st) => (
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
            {SOCIAL_INSURANCE_STATUSES.map((st) => (
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
          <div className="w-44">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger><SelectValue placeholder="手続き種別" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての種別</SelectItem>
                {SOCIAL_INSURANCE_PROCEDURE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 一覧 */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">
            <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />社会保険手続き一覧（{filtered.length}）
          </div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">社会保険手続きはありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">手続き種別</th>
                    <th className="px-2 py-1.5 text-left font-medium">保険者</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    <th className="px-2 py-1.5 text-left font-medium">対象日</th>
                    <th className="px-2 py-1.5 text-left font-medium">提出日</th>
                    <th className="px-2 py-1.5 text-left font-medium">受付番号</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                      <td className="px-2 py-1.5 font-medium">{empMap.get(r.employee_id)?.name ?? '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.procedure_type}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.insurer || '—'}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="outline" className={procedureStatusColor(r.status)}>{r.status ?? '—'}</Badge>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(r.target_date)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(r.submitted_at)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.reference_number || '—'}</td>
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
            <DialogTitle>{form.id ? '社会保険手続きの編集' : '手続きを追加'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>従業員 *</Label>
              <Select value={form.employee_id} onValueChange={(v) => setField('employee_id', v)}>
                <SelectTrigger><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>手続き種別 *</Label>
              <Select value={form.procedure_type} onValueChange={(v) => setField('procedure_type', v)}>
                <SelectTrigger><SelectValue placeholder="手続き種別" /></SelectTrigger>
                <SelectContent>
                  {SOCIAL_INSURANCE_PROCEDURE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>保険者</Label>
              <Select value={form.insurer} onValueChange={(v) => setField('insurer', v)}>
                <SelectTrigger><SelectValue placeholder="保険者" /></SelectTrigger>
                <SelectContent>
                  {INSURERS.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>ステータス</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
                <SelectContent>
                  {SOCIAL_INSURANCE_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>標準報酬月額</Label>
              <Input type="number" value={form.standard_monthly_wage} onChange={(e) => setField('standard_monthly_wage', e.target.value)} placeholder="例：300000" />
            </div>
            <div className="space-y-1">
              <Label>対象日</Label>
              <Input type="date" value={form.target_date} onChange={(e) => setField('target_date', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>提出日</Label>
              <Input type="date" value={form.submitted_at} onChange={(e) => setField('submitted_at', e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>受付番号</Label>
              <Input value={form.reference_number} onChange={(e) => setField('reference_number', e.target.value)} placeholder="受付番号 / 提出先の控え番号" />
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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Check, BellOff, Trash2 } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import { EmployeeApi, LaborAlertApi, LaborAuditApi } from '@/lib/api'
import {
  laborPerms, ALERT_TYPES, ALERT_SEVERITIES, ALERT_SEVERITY_LABEL, alertSeverityColor,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, LaborAlert } from '@/lib/types'

const ALL = '__all__'

type StatusTab = 'open' | 'resolved' | 'ignored' | 'all'

const STATUS_TABS: { value: StatusTab; label: string }[] = [
  { value: 'open', label: '未対応' },
  { value: 'resolved', label: '対応済み' },
  { value: 'ignored', label: '無視' },
  { value: 'all', label: 'すべて' },
]

const STATUS_LABEL: Record<string, string> = {
  open: '未対応', resolved: '対応済み', ignored: '無視',
}

/** ISO timestamp / YYYY-MM-DD → YYYY-MM-DD 表記 */
function fmtDate(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface AlertForm {
  employee_id: string
  alert_type: string
  severity: string
  title: string
  message: string
  target_date: string
}

function emptyAlertForm(): AlertForm {
  return {
    employee_id: ALL, alert_type: ALERT_TYPES[0], severity: 'warning',
    title: '', message: '', target_date: '',
  }
}

export default function Alerts() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [alerts, setAlerts] = useState<LaborAlert[]>([])
  const [loading, setLoading] = useState(true)

  const [statusTab, setStatusTab] = useState<StatusTab>('open')
  const [severityFilter, setSeverityFilter] = useState<string>(ALL)
  const [typeFilter, setTypeFilter] = useState<string>(ALL)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<AlertForm>(emptyAlertForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, list] = await Promise.all([EmployeeApi.list(), LaborAlertApi.list()])
      setEmployees(emps)
      setAlerts(list)
    } catch (e) {
      console.error('[Alerts]', e)
      toast.error(e instanceof Error ? e.message : '労務アラートの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])

  const filteredAlerts = useMemo(() => alerts.filter((a) => {
    if (statusTab !== 'all' && (a.status ?? 'open') !== statusTab) return false
    if (severityFilter !== ALL && (a.severity ?? '') !== severityFilter) return false
    if (typeFilter !== ALL && a.alert_type !== typeFilter) return false
    return true
  }), [alerts, statusTab, severityFilter, typeFilter])

  const openSummary = useMemo(() => {
    const s = { critical: 0, warning: 0, info: 0 }
    for (const a of alerts) {
      if ((a.status ?? 'open') !== 'open') continue
      const sev = (a.severity ?? 'info') as keyof typeof s
      if (sev in s) s[sev]++
    }
    return s
  }, [alerts])

  const setField = (k: keyof AlertForm, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  function openCreate() {
    setForm(emptyAlertForm())
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!perms.canManage) return
    if (!form.alert_type) { toast.error('種別を選択してください'); return }
    if (form.title.trim() === '' && form.message.trim() === '') {
      toast.error('タイトルまたは内容を入力してください'); return
    }
    const employeeId = form.employee_id === ALL ? null : form.employee_id
    const payload: Partial<LaborAlert> = {
      employee_id: employeeId,
      alert_type: form.alert_type,
      severity: form.severity || 'info',
      title: form.title.trim() === '' ? null : form.title.trim(),
      message: form.message.trim() === '' ? null : form.message.trim(),
      target_date: form.target_date === '' ? null : form.target_date,
      status: 'open',
    }
    setSaving(true)
    try {
      const created = await LaborAlertApi.create(payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: employeeId,
        action: 'アラート作成', target_table: 'labor_alerts', target_id: created.id, after_data: payload,
      })
      toast.success('アラートを作成しました')
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function resolveAlert(a: LaborAlert, status: 'resolved' | 'ignored') {
    if (!perms.canManage) return
    setSaving(true)
    try {
      const patch: Partial<LaborAlert> = {
        status,
        resolved_by: user?.id ?? null,
        resolved_at: new Date().toISOString(),
      }
      await LaborAlertApi.update(a.id, patch)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: a.employee_id ?? null,
        action: '労務アラート対応', target_table: 'labor_alerts', target_id: a.id, after_data: patch,
      })
      toast.success(status === 'resolved' ? '対応済みにしました' : '無視しました')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(a: LaborAlert) {
    if (!perms.canManage) return
    if (!window.confirm('このアラートを削除しますか？')) return
    try {
      await LaborAlertApi.remove(a.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: a.employee_id ?? null,
        action: '労務アラート対応', target_table: 'labor_alerts', target_id: a.id, after_data: { deleted: true },
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
            <h1 className="text-lg font-bold">労務アラート</h1>
            <p className="text-2xs text-muted-foreground">打刻漏れ・残業超過・契約更新などの労務リスク</p>
          </div>
          {perms.canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />アラート追加
            </Button>
          )}
        </div>

        {/* サマリー（未対応の重要度別） */}
        <div className="flex flex-wrap gap-1.5">
          <span className={cn('rounded-md px-2 py-1 text-2xs font-medium', alertSeverityColor('critical'))}>
            重要 {openSummary.critical}
          </span>
          <span className={cn('rounded-md px-2 py-1 text-2xs font-medium', alertSeverityColor('warning'))}>
            注意 {openSummary.warning}
          </span>
          <span className={cn('rounded-md px-2 py-1 text-2xs font-medium', alertSeverityColor('info'))}>
            情報 {openSummary.info}
          </span>
        </div>

        {/* ステータスタブ + フィルタ */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1.5">
            {STATUS_TABS.map((t) => (
              <Button
                key={t.value}
                size="sm"
                variant={statusTab === t.value ? 'default' : 'outline'}
                onClick={() => setStatusTab(t.value)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <div className="w-32">
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger><SelectValue placeholder="重要度" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての重要度</SelectItem>
                {ALERT_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>{ALERT_SEVERITY_LABEL[s] ?? s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-44">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger><SelectValue placeholder="種別" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての種別</SelectItem>
                {ALERT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 一覧 */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">労務アラート一覧（{filteredAlerts.length}）</div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : filteredAlerts.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">労務アラートはありません 👍</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">重要度</th>
                    <th className="px-2 py-1.5 text-left font-medium">種別</th>
                    <th className="px-2 py-1.5 text-left font-medium">内容</th>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">対象日</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredAlerts.map((a) => {
                    const st = a.status ?? 'open'
                    return (
                      <tr key={a.id} className="border-b last:border-0 hover:bg-accent/50">
                        <td className="px-2 py-1.5">
                          <span className={cn('rounded-md px-1.5 py-0.5 text-2xs font-medium', alertSeverityColor(a.severity))}>
                            {ALERT_SEVERITY_LABEL[a.severity ?? 'info'] ?? a.severity}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{a.alert_type}</td>
                        <td className="px-2 py-1.5 font-medium">{a.title || a.message || '—'}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {a.employee_id ? (empMap.get(a.employee_id)?.name ?? '—') : '全社'}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {fmtDate(a.target_date) !== '—' ? fmtDate(a.target_date) : (a.target_month || '—')}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge variant={st === 'open' ? 'warning' : st === 'resolved' ? 'success' : 'secondary'}>
                            {STATUS_LABEL[st] ?? st}
                          </Badge>
                        </td>
                        {perms.canManage && (
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              {st === 'open' && (
                                <>
                                  <Button size="sm" variant="outline" disabled={saving} onClick={() => resolveAlert(a, 'resolved')}>
                                    <Check className="h-3.5 w-3.5" />対応済み
                                  </Button>
                                  <Button size="sm" variant="ghost" disabled={saving} onClick={() => resolveAlert(a, 'ignored')}>
                                    <BellOff className="h-3.5 w-3.5" />無視
                                  </Button>
                                </>
                              )}
                              <Button size="sm" variant="destructive" onClick={() => handleDelete(a)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
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

      {/* アラート追加ダイアログ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>アラート追加</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>従業員</Label>
              <Select value={form.employee_id} onValueChange={(v) => setField('employee_id', v)}>
                <SelectTrigger><SelectValue placeholder="従業員" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全社</SelectItem>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>種別 *</Label>
              <Select value={form.alert_type} onValueChange={(v) => setField('alert_type', v)}>
                <SelectTrigger><SelectValue placeholder="種別" /></SelectTrigger>
                <SelectContent>
                  {ALERT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>重要度</Label>
              <Select value={form.severity} onValueChange={(v) => setField('severity', v)}>
                <SelectTrigger><SelectValue placeholder="重要度" /></SelectTrigger>
                <SelectContent>
                  {ALERT_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>{ALERT_SEVERITY_LABEL[s] ?? s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>タイトル</Label>
              <Input value={form.title} onChange={(e) => setField('title', e.target.value)} placeholder="例：契約更新期限まで残りわずか" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>内容</Label>
              <Textarea value={form.message} onChange={(e) => setField('message', e.target.value)} rows={2} />
            </div>
            <div className="space-y-1">
              <Label>対象日</Label>
              <Input type="date" value={form.target_date} onChange={(e) => setField('target_date', e.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>キャンセル</Button>
            {perms.canManage && (
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? '作成中…' : '作成'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

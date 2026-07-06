import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Check, X, CalendarClock, Wallet } from 'lucide-react'
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
import { EmployeeApi, LeaveBalanceApi, LeaveRequestApi, LaborAuditApi } from '@/lib/api'
import { laborPerms, LEAVE_TYPES, APPROVAL_STATUS_LABEL } from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, LeaveBalance, LeaveRequest } from '@/lib/types'

/** 空文字 → null、それ以外は数値（NaN は null） */
function numOrNull(v: string): number | null {
  const raw = v.trim()
  if (raw === '') return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

function statusVariant(status?: string | null): 'warning' | 'success' | 'destructive' | 'secondary' {
  switch (status) {
    case 'pending': return 'warning'
    case 'approved': return 'success'
    case 'rejected': return 'destructive'
    default: return 'secondary'
  }
}

interface RequestForm {
  employee_id: string
  leave_type: string
  start_date: string
  end_date: string
  days: string
  hours: string
  reason: string
}

function emptyRequestForm(): RequestForm {
  return { employee_id: '', leave_type: '有給', start_date: '', end_date: '', days: '1', hours: '', reason: '' }
}

interface BalanceForm {
  id: string | null
  employee_id: string
  fiscal_year: string
  granted: string
  used: string
  remaining: string
  required_5days: string
  expire_date: string
}

function emptyBalanceForm(): BalanceForm {
  return {
    id: null, employee_id: '', fiscal_year: String(new Date().getFullYear()),
    granted: '', used: '', remaining: '', required_5days: '', expire_date: '',
  }
}

export default function Leaves() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [tab, setTab] = useState<'requests' | 'balances'>('requests')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [balances, setBalances] = useState<LeaveBalance[]>([])
  const [loading, setLoading] = useState(true)

  const [reqDialogOpen, setReqDialogOpen] = useState(false)
  const [reqForm, setReqForm] = useState<RequestForm>(emptyRequestForm)
  const [balDialogOpen, setBalDialogOpen] = useState(false)
  const [balForm, setBalForm] = useState<BalanceForm>(emptyBalanceForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, reqs, bals] = await Promise.all([
        EmployeeApi.list(),
        LeaveRequestApi.list(),
        LeaveBalanceApi.list(),
      ])
      setEmployees(emps)
      setRequests(reqs)
      setBalances(bals)
    } catch (e) {
      console.error('[Leaves]', e)
      toast.error(e instanceof Error ? e.message : '休暇情報の取得に失敗しました')
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

  const scopedRequests = useMemo(
    () => (perms.selfOnly ? requests.filter((r) => r.employee_id === myEmployee?.id) : requests),
    [requests, perms.selfOnly, myEmployee?.id],
  )
  const scopedBalances = useMemo(
    () => (perms.selfOnly ? balances.filter((b) => b.employee_id === myEmployee?.id) : balances),
    [balances, perms.selfOnly, myEmployee?.id],
  )

  const setReqField = (k: keyof RequestForm, v: string) => setReqForm((prev) => ({ ...prev, [k]: v }))
  const setBalField = (k: keyof BalanceForm, v: string) => setBalForm((prev) => ({ ...prev, [k]: v }))

  // --- 休暇申請 ---
  function openRequestCreate() {
    setReqForm({ ...emptyRequestForm(), employee_id: perms.selfOnly ? (myEmployee?.id ?? '') : '' })
    setReqDialogOpen(true)
  }

  async function handleRequestSave() {
    const employeeId = perms.selfOnly ? (myEmployee?.id ?? '') : reqForm.employee_id
    if (!employeeId) { toast.error('従業員を選択してください'); return }
    if (!reqForm.start_date || !reqForm.end_date) { toast.error('期間を入力してください'); return }
    const payload: Partial<LeaveRequest> = {
      employee_id: employeeId,
      leave_type: reqForm.leave_type || null,
      start_date: reqForm.start_date,
      end_date: reqForm.end_date,
      days: numOrNull(reqForm.days),
      hours: numOrNull(reqForm.hours),
      reason: reqForm.reason.trim() === '' ? null : reqForm.reason.trim(),
      status: 'pending',
      requested_at: new Date().toISOString(),
    }
    setSaving(true)
    try {
      const created = await LeaveRequestApi.create(payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: employeeId,
        action: '休暇申請', target_table: 'leave_requests', target_id: created.id, after_data: payload,
      })
      toast.success('休暇を申請しました')
      setReqDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '申請に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function approveRequest(req: LeaveRequest) {
    if (!perms.canApprove) return
    setSaving(true)
    try {
      const now = new Date().toISOString()
      await LeaveRequestApi.update(req.id, {
        status: 'approved', approved_by: user?.id ?? null, approved_at: now,
      })
      // 有給の場合は残高を減算（ベストエフォート）
      if (req.leave_type === '有給') {
        try {
          const bal = balances
            .filter((b) => b.employee_id === req.employee_id)
            .sort((a, b) => b.fiscal_year - a.fiscal_year)[0]
          if (bal) {
            const days = req.days ?? 0
            await LeaveBalanceApi.update(bal.id, {
              paid_leave_used_days: (bal.paid_leave_used_days ?? 0) + days,
              paid_leave_remaining_days: (bal.paid_leave_remaining_days ?? 0) - days,
              required_5days_used: (bal.required_5days_used ?? 0) + days,
            })
          }
        } catch (e) {
          console.warn('[Leaves] balance decrement skipped', e)
        }
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: req.employee_id,
        action: '休暇承認', target_table: 'leave_requests', target_id: req.id, after_data: { status: 'approved' },
      })
      toast.success('承認しました')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '承認に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function rejectRequest(req: LeaveRequest) {
    if (!perms.canApprove) return
    const reason = window.prompt('却下理由を入力してください')
    if (reason === null) return
    setSaving(true)
    try {
      await LeaveRequestApi.update(req.id, {
        status: 'rejected', approved_by: user?.id ?? null, approved_at: new Date().toISOString(),
        rejected_reason: reason.trim() === '' ? null : reason.trim(),
      })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: req.employee_id,
        action: '休暇承認', target_table: 'leave_requests', target_id: req.id,
        after_data: { status: 'rejected', rejected_reason: reason },
      })
      toast.success('却下しました')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '却下に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  // --- 有給残高 ---
  function openBalanceCreate() {
    setBalForm(emptyBalanceForm())
    setBalDialogOpen(true)
  }

  function openBalanceEdit(b: LeaveBalance) {
    setBalForm({
      id: b.id,
      employee_id: b.employee_id,
      fiscal_year: String(b.fiscal_year),
      granted: b.paid_leave_granted_days == null ? '' : String(b.paid_leave_granted_days),
      used: b.paid_leave_used_days == null ? '' : String(b.paid_leave_used_days),
      remaining: b.paid_leave_remaining_days == null ? '' : String(b.paid_leave_remaining_days),
      required_5days: b.required_5days_used == null ? '' : String(b.required_5days_used),
      expire_date: b.paid_leave_expire_date ?? '',
    })
    setBalDialogOpen(true)
  }

  async function handleBalanceSave() {
    if (!perms.canManage) return
    if (!balForm.employee_id) { toast.error('従業員を選択してください'); return }
    const fiscalYear = numOrNull(balForm.fiscal_year)
    if (fiscalYear == null) { toast.error('年度を入力してください'); return }
    const payload: Partial<LeaveBalance> & { employee_id: string; fiscal_year: number } = {
      employee_id: balForm.employee_id,
      fiscal_year: fiscalYear,
      paid_leave_granted_days: numOrNull(balForm.granted),
      paid_leave_used_days: numOrNull(balForm.used),
      paid_leave_remaining_days: numOrNull(balForm.remaining),
      required_5days_used: numOrNull(balForm.required_5days),
      paid_leave_expire_date: balForm.expire_date === '' ? null : balForm.expire_date,
    }
    setSaving(true)
    try {
      let targetId = balForm.id
      if (balForm.id) {
        await LeaveBalanceApi.update(balForm.id, payload)
      } else {
        const created = await LeaveBalanceApi.upsert(payload)
        targetId = created.id
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: balForm.employee_id,
        action: '有給付与', target_table: 'leave_balances', target_id: targetId, after_data: payload,
      })
      toast.success('有給残高を保存しました')
      setBalDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
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
            <h1 className="text-lg font-bold">有給・休暇管理</h1>
            <p className="text-2xs text-muted-foreground">休暇申請の受付・承認と有給残高の管理</p>
          </div>
          {tab === 'requests' ? (
            <Button size="sm" onClick={openRequestCreate}>
              <Plus className="h-3.5 w-3.5" />休暇申請
            </Button>
          ) : (
            perms.canManage && (
              <Button size="sm" onClick={openBalanceCreate}>
                <Plus className="h-3.5 w-3.5" />付与登録/編集
              </Button>
            )
          )}
        </div>

        {/* タブ */}
        <div className="flex gap-1.5">
          <Button size="sm" variant={tab === 'requests' ? 'default' : 'outline'} onClick={() => setTab('requests')}>
            <CalendarClock className="h-3.5 w-3.5" />休暇申請
          </Button>
          <Button size="sm" variant={tab === 'balances' ? 'default' : 'outline'} onClick={() => setTab('balances')}>
            <Wallet className="h-3.5 w-3.5" />有給残高
          </Button>
        </div>

        {tab === 'requests' ? (
          <div className="rounded-xl border bg-card">
            <div className="border-b px-3 py-2 text-sm font-bold">休暇申請一覧（{scopedRequests.length}）</div>
            {loading ? (
              <div className="p-3"><SkeletonRows count={8} /></div>
            ) : scopedRequests.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">休暇申請はありません</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                      <th className="px-2 py-1.5 text-left font-medium">種別</th>
                      <th className="px-2 py-1.5 text-left font-medium">期間</th>
                      <th className="px-2 py-1.5 text-left font-medium">日数</th>
                      <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                      {perms.canApprove && <th className="px-2 py-1.5 text-left font-medium"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {scopedRequests.map((r) => (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                        <td className="px-2 py-1.5 font-medium">{empMap.get(r.employee_id)?.name ?? '—'}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">{r.leave_type ?? '—'}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {r.start_date ?? '—'}〜{r.end_date ?? '—'}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {r.days != null ? `${r.days}日` : ''}{r.hours ? `${r.hours}h` : ''}
                          {r.days == null && !r.hours ? '—' : ''}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge variant={statusVariant(r.status)}>
                            {APPROVAL_STATUS_LABEL[r.status ?? 'pending'] ?? r.status}
                          </Badge>
                        </td>
                        {perms.canApprove && (
                          <td className="px-2 py-1.5">
                            {r.status === 'pending' && (
                              <div className="flex gap-1">
                                <Button size="sm" variant="outline" disabled={saving} onClick={() => approveRequest(r)}>
                                  <Check className="h-3.5 w-3.5" />承認
                                </Button>
                                <Button size="sm" variant="destructive" disabled={saving} onClick={() => rejectRequest(r)}>
                                  <X className="h-3.5 w-3.5" />却下
                                </Button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border bg-card">
            <div className="border-b px-3 py-2 text-sm font-bold">有給残高一覧（{scopedBalances.length}）</div>
            {loading ? (
              <div className="p-3"><SkeletonRows count={8} /></div>
            ) : scopedBalances.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">有給残高の登録はありません</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                      <th className="px-2 py-1.5 text-left font-medium">年度</th>
                      <th className="px-2 py-1.5 text-left font-medium">付与</th>
                      <th className="px-2 py-1.5 text-left font-medium">取得</th>
                      <th className="px-2 py-1.5 text-left font-medium">残</th>
                      <th className="px-2 py-1.5 text-left font-medium">失効日</th>
                      <th className="px-2 py-1.5 text-left font-medium">5日取得</th>
                      {perms.canManage && <th className="px-2 py-1.5 text-left font-medium"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {scopedBalances.map((b) => {
                      const under5 = (b.required_5days_used ?? 0) < 5
                      return (
                        <tr
                          key={b.id}
                          className={cn(
                            'border-b last:border-0 hover:bg-accent/50',
                            under5 && 'bg-amber-50 dark:bg-amber-500/10',
                          )}
                        >
                          <td className="px-2 py-1.5 font-medium">{empMap.get(b.employee_id)?.name ?? '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{b.fiscal_year}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{b.paid_leave_granted_days ?? '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{b.paid_leave_used_days ?? '—'}</td>
                          <td className="px-2 py-1.5 font-medium">{b.paid_leave_remaining_days ?? '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{b.paid_leave_expire_date ?? '—'}</td>
                          <td className="px-2 py-1.5">
                            {under5 ? (
                              <Badge variant="destructive">{b.required_5days_used ?? 0}/5</Badge>
                            ) : (
                              <Badge variant="success">{b.required_5days_used ?? 0}/5</Badge>
                            )}
                          </td>
                          {perms.canManage && (
                            <td className="px-2 py-1.5">
                              <Button size="sm" variant="ghost" onClick={() => openBalanceEdit(b)}>編集</Button>
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
        )}
      </div>

      {/* 休暇申請ダイアログ */}
      <Dialog open={reqDialogOpen} onOpenChange={setReqDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>休暇申請</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>従業員 *</Label>
              <Select
                value={perms.selfOnly ? (myEmployee?.id ?? '') : reqForm.employee_id}
                onValueChange={(v) => setReqField('employee_id', v)}
                disabled={perms.selfOnly}
              >
                <SelectTrigger><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>種別</Label>
              <Select value={reqForm.leave_type} onValueChange={(v) => setReqField('leave_type', v)}>
                <SelectTrigger><SelectValue placeholder="種別" /></SelectTrigger>
                <SelectContent>
                  {LEAVE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>開始日 *</Label>
              <Input type="date" value={reqForm.start_date} onChange={(e) => setReqField('start_date', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>終了日 *</Label>
              <Input type="date" value={reqForm.end_date} onChange={(e) => setReqField('end_date', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>日数</Label>
              <Input type="number" value={reqForm.days} onChange={(e) => setReqField('days', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>時間（時間休）</Label>
              <Input type="number" value={reqForm.hours} onChange={(e) => setReqField('hours', e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>理由</Label>
              <Textarea value={reqForm.reason} onChange={(e) => setReqField('reason', e.target.value)} rows={2} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setReqDialogOpen(false)} disabled={saving}>キャンセル</Button>
            <Button size="sm" onClick={handleRequestSave} disabled={saving}>
              {saving ? '送信中…' : '申請'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 有給残高ダイアログ */}
      <Dialog open={balDialogOpen} onOpenChange={setBalDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{balForm.id ? '有給残高の編集' : '付与登録'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>従業員 *</Label>
              <Select
                value={balForm.employee_id}
                onValueChange={(v) => setBalField('employee_id', v)}
                disabled={!!balForm.id}
              >
                <SelectTrigger><SelectValue placeholder="従業員を選択" /></SelectTrigger>
                <SelectContent>
                  {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>年度 *</Label>
              <Input type="number" value={balForm.fiscal_year} onChange={(e) => setBalField('fiscal_year', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>失効日</Label>
              <Input type="date" value={balForm.expire_date} onChange={(e) => setBalField('expire_date', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>付与日数</Label>
              <Input type="number" value={balForm.granted} onChange={(e) => setBalField('granted', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>取得日数</Label>
              <Input type="number" value={balForm.used} onChange={(e) => setBalField('used', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>残日数</Label>
              <Input type="number" value={balForm.remaining} onChange={(e) => setBalField('remaining', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>5日取得済</Label>
              <Input type="number" value={balForm.required_5days} onChange={(e) => setBalField('required_5days', e.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBalDialogOpen(false)} disabled={saving}>キャンセル</Button>
            {perms.canManage && (
              <Button size="sm" onClick={handleBalanceSave} disabled={saving || !balForm.employee_id}>
                {saving ? '保存中…' : '保存'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

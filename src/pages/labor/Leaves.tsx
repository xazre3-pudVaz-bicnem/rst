import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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

/** 有給消化の配分1件（どの付与から何日引くか）。複数付与に跨る消化を表す。 */
type ConsumePlan = { bal: LeaveBalance; take: number }

/** 開始日〜終了日の暦日数（両日含む）。不正・逆転は null */
function calcDaysInclusive(start: string, end: string): number | null {
  if (!start || !end) return null
  const s = new Date(`${start}T00:00:00`)
  const e = new Date(`${end}T00:00:00`)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null
  if (e < s) return null
  // 86400000ms=1日。両端を含めるため +1
  return Math.floor((e.getTime() - s.getTime()) / 86400000) + 1
}

/**
 * 種別と期間から申請日数を自動算出。
 * 半休は0.5日固定、時間休は日数で管理せず時間入力へ誘導するため null（days は触らない）。
 */
function autoDays(leaveType: string, start: string, end: string): string | null {
  if (leaveType === '時間休') return null
  if (leaveType === '半休') return '0.5'
  const d = calcDaysInclusive(start, end)
  return d == null ? null : String(d)
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
  const [searchParams, setSearchParams] = useSearchParams()

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
  // 残高不足/未登録時の明示承認ダイアログ（reason で文言を出し分け）
  const [approveConfirm, setApproveConfirm] = useState<
    {
      req: LeaveRequest
      plan: ConsumePlan[]
      obligationBal: LeaveBalance | null
      deduct: number
      totalAvailable: number
      shortfall: number
      reason: 'insufficient' | 'no-balance'
    } | null
  >(null)

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

  // Approvals から「有給申請」導線で ?new=1 が付いたら申請ダイアログを自動オープン
  useEffect(() => {
    if (searchParams.get('new')) {
      openRequestCreate()
      searchParams.delete('new')
      setSearchParams(searchParams, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])
  const myEmployee = useMemo(
    () => employees.find((e) => e.user_id && user?.id && e.user_id === user.id) ?? null,
    [employees, user?.id],
  )

  // selfOnly は従業員が非同期ロードされるため、ダイアログ表示後に本人IDを補完
  useEffect(() => {
    if (perms.selfOnly && myEmployee && reqDialogOpen && !reqForm.employee_id) {
      setReqField('employee_id', myEmployee.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms.selfOnly, myEmployee, reqDialogOpen])

  const scopedRequests = useMemo(
    () => (perms.selfOnly ? requests.filter((r) => r.employee_id === myEmployee?.id) : requests),
    [requests, perms.selfOnly, myEmployee?.id],
  )
  const scopedBalances = useMemo(
    () => (perms.selfOnly ? balances.filter((b) => b.employee_id === myEmployee?.id) : balances),
    [balances, perms.selfOnly, myEmployee?.id],
  )

  // 申請ダイアログの対象従業員（selfOnly は本人固定）
  const reqEmployeeId = perms.selfOnly ? (myEmployee?.id ?? '') : reqForm.employee_id
  // 申請ダイアログに表示する残高（fiscal_year 降順）
  const reqBalances = useMemo(
    () => balances.filter((b) => b.employee_id === reqEmployeeId).sort((a, b) => b.fiscal_year - a.fiscal_year),
    [balances, reqEmployeeId],
  )
  // 対象従業員の残日数合計（残数超過の警告判定用）
  const reqRemainingTotal = useMemo(
    () => reqBalances.reduce((sum, b) => sum + (b.paid_leave_remaining_days ?? 0), 0),
    [reqBalances],
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
    // 終了日が開始日より前は不正
    if (reqForm.end_date < reqForm.start_date) { toast.error('終了日は開始日以降にしてください'); return }
    // 残高を消費する種別（有給・半休）は取得日数が必須。null/0日を許すと承認時に無引当で
    // 通ってしまい残高が減らず年5日義務も計上されないため、申請の入口で防ぐ。
    const reqDays = numOrNull(reqForm.days)
    if (['有給', '半休'].includes(reqForm.leave_type ?? '') && (reqDays == null || reqDays <= 0)) {
      toast.error('取得日数を入力してください'); return
    }
    // 残数超過は送信をブロックしない（申請自体は許可し、承認時に残高で最終判断）
    if (reqForm.leave_type !== '時間休' && reqDays != null && reqDays > reqRemainingTotal) {
      toast.info(`申請日数(${reqDays}日)が残数合計(${reqRemainingTotal}日)を超えています。承認時に残高をご確認ください`)
    }
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

  /**
   * 消化先の残高を「失効日が申請開始日以降（or 失効日なし）」の付与から古い順（fiscal_year 昇順）で
   * 申請日数ぶん配分する。労基法39条の時効2年に従い古い付与から消化し、失効年度への誤減算を防ぐ。
   * 単一付与の残数を超える場合も複数付与に跨って配分するため、合計残数が足りれば不足にならない。
   * 返り値: plan=配分（各付与から何日引くか・下限0で負値なし）, usable=消化候補の付与,
   *   totalAvailable=消化可能な残数合計, shortfall=残数合計でも充当しきれない日数。
   */
  function planConsumption(employeeId: string, start: string | null | undefined, deduct: number): {
    plan: ConsumePlan[]; usable: LeaveBalance[]; totalAvailable: number; shortfall: number
  } {
    const startD = start ?? ''
    const usable = balances
      .filter((b) => b.employee_id === employeeId)
      .filter((b) => !b.paid_leave_expire_date || !startD || b.paid_leave_expire_date >= startD)
      .sort((a, b) => a.fiscal_year - b.fiscal_year)
    const totalAvailable = usable.reduce((s, b) => s + Math.max(0, b.paid_leave_remaining_days ?? 0), 0)
    const plan: ConsumePlan[] = []
    let remaining = deduct
    for (const b of usable) {
      if (remaining <= 0) break
      const avail = Math.max(0, b.paid_leave_remaining_days ?? 0)
      if (avail <= 0) continue
      const take = Math.min(avail, remaining)
      plan.push({ bal: b, take })
      remaining -= take
    }
    return { plan, usable, totalAvailable, shortfall: Math.max(0, remaining) }
  }

  /**
   * 年5日取得義務（労基法39条7項）のカウント先。消化(FIFO最古)とは別に、実取得日数を
   * 申請開始日が属する現基準日の付与＝最新 fiscal_year の付与へ計上する（消化元付与への誤計上を防ぐ）。
   */
  function pickObligationBalance(usable: LeaveBalance[]): LeaveBalance | null {
    if (usable.length === 0) return null
    return usable.reduce((latest, b) => (b.fiscal_year > latest.fiscal_year ? b : latest), usable[0])
  }

  /**
   * 承認確定処理。二重承認は approveIfPending（pending 条件付き update）で検出。
   * 残高引当は plan（複数付与に古い順で配分）で行い、年5日義務は obligationBal（現基準日付与）へ
   * 実取得日数 deduct を計上する（消化元とカウント先を分離）。shortfall（不足承知の承認）は
   * 最新付与を負値にして used に反映する。付与ごとの増減はマージして1付与1回だけ update する。
   */
  async function doApprove(
    req: LeaveRequest,
    plan: ConsumePlan[],
    obligationBal: LeaveBalance | null,
    deduct: number,
    shortfall: number,
  ) {
    if (!perms.canApprove) return
    setSaving(true)
    try {
      const now = new Date().toISOString()
      // 二重承認防止: status='pending' のときだけ承認。他管理者が処理済みなら conflict
      const res = await LeaveRequestApi.approveIfPending(req.id, {
        status: 'approved', approved_by: user?.id ?? null, approved_at: now,
      })
      if (res?.conflict) {
        toast.error('他の管理者が処理済みです')
        setApproveConfirm(null)
        load()
        return
      }
      // 付与ごとに used/remaining/required_5days の増減を集約（同一付与への二重 update を防ぐ）
      const updates = new Map<
        string,
        { bal: LeaveBalance; usedDelta: number; remainingDelta: number; req5Delta: number }
      >()
      const bump = (bal: LeaveBalance) => {
        let u = updates.get(bal.id)
        if (!u) { u = { bal, usedDelta: 0, remainingDelta: 0, req5Delta: 0 }; updates.set(bal.id, u) }
        return u
      }
      // 残高消化（古い付与から配分）
      for (const { bal, take } of plan) {
        const u = bump(bal); u.usedDelta += take; u.remainingDelta -= take
      }
      // 充当しきれない不足分（不足承知の承認）は最新付与を負値にして used に反映（前借り扱い）
      if (shortfall > 0 && obligationBal) {
        const u = bump(obligationBal); u.usedDelta += shortfall; u.remainingDelta -= shortfall
      }
      // 年5日取得義務は実取得日数(deduct)を現基準日付与へ計上（半休0.5含む・時間休は呼び出し側で除外済）
      if (deduct > 0 && obligationBal) bump(obligationBal).req5Delta += deduct
      await Promise.all(
        [...updates.values()].map((u) =>
          LeaveBalanceApi.update(u.bal.id, {
            paid_leave_used_days: (u.bal.paid_leave_used_days ?? 0) + u.usedDelta,
            paid_leave_remaining_days: (u.bal.paid_leave_remaining_days ?? 0) + u.remainingDelta,
            required_5days_used: (u.bal.required_5days_used ?? 0) + u.req5Delta,
          }),
        ),
      )
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: req.employee_id,
        action: '休暇承認', target_table: 'leave_requests', target_id: req.id,
        after_data: {
          status: 'approved', deducted_days: deduct, shortfall,
          balance_ids: [...updates.keys()], obligation_balance_id: obligationBal?.id ?? null,
        },
      })
      toast.success('承認しました')
      setApproveConfirm(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '承認に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  function approveRequest(req: LeaveRequest) {
    if (!perms.canApprove) return
    // 残高を消費する種別のみ引当。半休0.5固定・時間休は残日数を消費しない・有給は申請日数
    const consumesBalance = ['有給', '半休', '時間休'].includes(req.leave_type ?? '')
    if (!consumesBalance) { doApprove(req, [], null, 0, 0); return }
    const deduct = req.leave_type === '半休' ? (req.days ?? 0.5)
      : req.leave_type === '時間休' ? 0
      : (req.days ?? 0)
    if (deduct <= 0) {
      // 時間休は残日数を消費しないため通常承認。有給/半休で0日は日数未入力の異常データ＝
      // 無引当で承認すると残高が減らず年5日義務も計上されないため、承認を止めて是正を促す。
      if (req.leave_type === '時間休') { doApprove(req, [], null, 0, 0); return }
      toast.error('この申請は取得日数が未設定です。申請者に日数の再入力を依頼してください')
      return
    }
    const { plan, usable, totalAvailable, shortfall } = planConsumption(req.employee_id, req.start_date, deduct)
    const obligationBal = pickObligationBalance(usable)
    // 消化可能な残高が未登録なら silent skip せず明示確認
    if (usable.length === 0) {
      setApproveConfirm({ req, plan: [], obligationBal: null, deduct, totalAvailable: 0, shortfall, reason: 'no-balance' })
      return
    }
    // 合計残数でも不足する場合のみ明示承認を要求（複数付与に跨れば足りるケースは通常承認）
    if (shortfall > 0) {
      setApproveConfirm({ req, plan, obligationBal, deduct, totalAvailable, shortfall, reason: 'insufficient' })
      return
    }
    doApprove(req, plan, obligationBal, deduct, 0)
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
            {/* 残数インライン表示（fiscal_year 降順）。入力前に残りを一目で確認できる */}
            {reqEmployeeId && (
              <div className="col-span-2 flex flex-wrap items-center gap-1.5">
                {reqBalances.length === 0 ? (
                  <span className="text-2xs text-muted-foreground">有給残高の登録がありません</span>
                ) : (
                  reqBalances.map((b) => (
                    <Badge key={b.id} variant="secondary" className="font-normal">
                      {b.fiscal_year}年度 残{b.paid_leave_remaining_days ?? 0}日
                      {b.paid_leave_expire_date ? `（失効 ${b.paid_leave_expire_date}）` : ''}
                    </Badge>
                  ))
                )}
              </div>
            )}
            <div className="col-span-2 space-y-1">
              <Label>種別</Label>
              <Select
                value={reqForm.leave_type}
                onValueChange={(v) => setReqForm((prev) => {
                  const d = autoDays(v, prev.start_date, prev.end_date)
                  return { ...prev, leave_type: v, ...(d != null ? { days: d } : {}) }
                })}
              >
                <SelectTrigger><SelectValue placeholder="種別" /></SelectTrigger>
                <SelectContent>
                  {LEAVE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>開始日 *</Label>
              <Input
                type="date"
                value={reqForm.start_date}
                onChange={(e) => setReqForm((prev) => {
                  const start = e.target.value
                  const d = autoDays(prev.leave_type, start, prev.end_date)
                  return { ...prev, start_date: start, ...(d != null ? { days: d } : {}) }
                })}
              />
            </div>
            <div className="space-y-1">
              <Label>終了日 *</Label>
              <Input
                type="date"
                value={reqForm.end_date}
                onChange={(e) => setReqForm((prev) => {
                  const end = e.target.value
                  const d = autoDays(prev.leave_type, prev.start_date, end)
                  return { ...prev, end_date: end, ...(d != null ? { days: d } : {}) }
                })}
              />
            </div>
            <div className="space-y-1">
              <Label>日数</Label>
              <Input type="number" value={reqForm.days} onChange={(e) => setReqField('days', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>時間（時間休）</Label>
              <Input type="number" value={reqForm.hours} onChange={(e) => setReqField('hours', e.target.value)} />
            </div>
            {/* 残数超過の注意（送信はブロックしない） */}
            {reqForm.leave_type !== '時間休' && (() => {
              const rd = numOrNull(reqForm.days)
              return rd != null && rd > reqRemainingTotal ? (
                <div className="col-span-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-2xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  申請日数 {rd}日 が残数合計 {reqRemainingTotal}日 を超えています。承認時に残高をご確認ください。
                </div>
              ) : null
            })()}
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

      {/* 残高不足/未登録の明示承認ダイアログ */}
      <Dialog open={!!approveConfirm} onOpenChange={(o) => { if (!o) setApproveConfirm(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>残高を確認してください</DialogTitle>
          </DialogHeader>
          {approveConfirm && (
            <div className="space-y-2 text-xs text-muted-foreground">
              {approveConfirm.reason === 'no-balance' ? (
                <p>
                  {empMap.get(approveConfirm.req.employee_id)?.name ?? '対象者'} の消化可能な有給残高が登録されていません。
                  残高を減算せずに承認します。よろしいですか？
                </p>
              ) : (
                <p>
                  消化可能な残数合計 {approveConfirm.totalAvailable}日 に対し {approveConfirm.deduct}日 の申請です。
                  不足 {approveConfirm.shortfall}日 を承知で承認しますか？（最新付与の残高がマイナスになります）
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setApproveConfirm(null)} disabled={saving}>キャンセル</Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={saving}
              onClick={() =>
                approveConfirm &&
                doApprove(
                  approveConfirm.req,
                  approveConfirm.plan,
                  approveConfirm.obligationBal,
                  approveConfirm.deduct,
                  approveConfirm.shortfall,
                )
              }
            >
              {saving ? '処理中…' : '不足を承知で承認'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

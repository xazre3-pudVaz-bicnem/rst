import { useCallback, useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import { ChevronLeft, ChevronRight, Download, Train, Check, X, Trash2, Pencil } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import TravelExpenseModal from '@/components/modals/TravelExpenseModal'
import { TravelExpenseApi, EmployeeApi, LaborAuditApi } from '@/lib/api'
import {
  laborPerms, fmtYen, monthStr, toCsv, downloadCsv,
  TRAVEL_EXPENSE_STATUSES, travelExpenseStatusColor,
} from '@/lib/labor'
import { cn, jpError } from '@/lib/utils'
import type { Employee, TravelExpense } from '@/lib/types'

const ALL = '__all__'

/** 申請者名（従業員マスタ未紐付けでも、申請時に記録した氏名で束ねる） */
function repNameOf(x: TravelExpense): string {
  return (x.employee_name || '').trim() || '（担当者未設定）'
}

export default function TravelExpenses() {
  const toast = useToast()
  const confirm = useConfirm()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [month, setMonth] = useState(monthStr())
  const [rows, setRows] = useState<TravelExpense[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [repFilter, setRepFilter] = useState<string>(ALL)
  const [editing, setEditing] = useState<TravelExpense | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [list, emps] = await Promise.all([
        TravelExpenseApi.listByMonth(month),
        EmployeeApi.listDirectory().catch(() => [] as Employee[]),
      ])
      setRows(list)
      setEmployees(emps)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '交通費の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [month, toast])

  useEffect(() => { load() }, [load])

  // 一般従業員は自分の申請のみ（同僚の経費を見せない）
  const myEmployee = useMemo(() => employees.find((e) => e.user_id === user?.id) ?? null, [employees, user?.id])
  const scoped = useMemo(() => {
    if (!perms.selfOnly) return rows
    return rows.filter((x) => (myEmployee && x.employee_id === myEmployee.id) || (x.user_id && x.user_id === user?.id))
  }, [rows, perms.selfOnly, myEmployee, user?.id])

  // 営業担当ごとの集計（却下は金額に含めない）
  const byRep = useMemo(() => {
    const m = new Map<string, { name: string; total: number; count: number; pending: number; approved: number }>()
    for (const x of scoped) {
      const name = repNameOf(x)
      const v = m.get(name) ?? { name, total: 0, count: 0, pending: 0, approved: 0 }
      v.count++
      if (x.status !== '却下') v.total += Number(x.amount || 0)
      if (!x.status || x.status === '申請中') v.pending++
      if (x.status === '承認済み' || x.status === '精算済み') v.approved += Number(x.amount || 0)
      m.set(name, v)
    }
    return [...m.values()].sort((a, b) => b.total - a.total)
  }, [scoped])

  const filtered = useMemo(() => scoped.filter((x) => {
    if (statusFilter !== ALL && (x.status ?? '申請中') !== statusFilter) return false
    if (repFilter !== ALL && repNameOf(x) !== repFilter) return false
    return true
  }), [scoped, statusFilter, repFilter])

  const total = useMemo(
    () => filtered.filter((x) => x.status !== '却下').reduce((a, x) => a + Number(x.amount || 0), 0),
    [filtered],
  )
  const pendingCount = useMemo(() => scoped.filter((x) => !x.status || x.status === '申請中').length, [scoped])

  async function setStatus(x: TravelExpense, status: string) {
    if (!perms.canApprove) return
    setBusy(true)
    try {
      const approved = status === '承認済み' || status === '精算済み'
      await TravelExpenseApi.update(x.id, {
        status,
        approved_by: approved ? user?.id ?? null : null,
        approved_at: approved ? new Date().toISOString() : null,
      })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: x.employee_id ?? null,
        action: `交通費${status}`, target_table: 'travel_expenses', target_id: x.id,
        after_data: { status, amount: x.amount, case_name: x.case_name },
      })
      toast.success(`${status}にしました`)
      load()
    } catch (e) {
      toast.error('更新に失敗しました: ' + jpError(e))
    } finally { setBusy(false) }
  }

  /** 表示中の「申請中」をまとめて承認（月次精算の実務向け） */
  async function approveAllPending() {
    const targets = filtered.filter((x) => !x.status || x.status === '申請中')
    if (!targets.length) { toast.info('承認待ちの申請はありません'); return }
    const sum = targets.reduce((a, x) => a + Number(x.amount || 0), 0)
    if (!(await confirm({
      title: `${targets.length}件をまとめて承認しますか？`,
      body: `合計 ${fmtYen(sum)} を承認済みにします。`,
      confirmLabel: '承認する',
    }))) return
    setBusy(true)
    try {
      const now = new Date().toISOString()
      for (const x of targets) {
        await TravelExpenseApi.update(x.id, { status: '承認済み', approved_by: user?.id ?? null, approved_at: now })
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName,
        action: '交通費一括承認', target_table: 'travel_expenses',
        after_data: { month, count: targets.length, total: sum },
      })
      toast.success(`${targets.length}件を承認しました`)
      load()
    } catch (e) {
      toast.error('一括承認に失敗しました: ' + jpError(e))
    } finally { setBusy(false) }
  }

  async function remove(x: TravelExpense) {
    const ok = await confirm({
      title: 'この交通費申請を削除しますか？',
      body: `${moment(x.expense_date).format('YYYY/MM/DD')} ${fmtYen(x.amount)}`,
      confirmLabel: '削除する', danger: true,
    })
    if (!ok) return
    try {
      await TravelExpenseApi.remove(x.id)
      toast.success('削除しました')
      load()
    } catch (e) {
      toast.error('削除に失敗しました: ' + jpError(e))
    }
  }

  function exportCsv() {
    const head = ['発生日', '営業担当', '案件', '交通手段', '出発地', '到着地', '往復', '金額', '目的', 'ステータス', 'メモ']
    const body = filtered.map((x) => [
      moment(x.expense_date).format('YYYY/MM/DD'), repNameOf(x), x.case_name ?? '', x.transport_type ?? '',
      x.departure ?? '', x.destination ?? '', x.round_trip ? '往復' : '片道', Math.round(Number(x.amount || 0)),
      x.purpose ?? '', x.status ?? '申請中', x.memo ?? '',
    ])
    // 担当者ごとの小計も付けて、そのまま精算資料として使えるようにする
    const summary: (string | number)[][] = [
      [], ['■ 営業担当ごとの合計'], ['営業担当', '件数', '合計金額', 'うち承認済み'],
      ...byRep.map((r) => [r.name, r.count, Math.round(r.total), Math.round(r.approved)]),
    ]
    downloadCsv(`交通費_${month}.csv`, toCsv([head, ...body, ...summary]))
  }

  const shiftMonth = (d: number) => setMonth(moment(`${month}-01`).add(d, 'month').format('YYYY-MM'))

  return (
    <LaborLayout>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="flex items-center gap-1.5 text-base font-bold"><Train className="h-4 w-4 text-primary" />交通費</h1>
            <p className="text-2xs text-muted-foreground">案件ごとの交通費申請を、営業担当ごとに集計・承認・精算します</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="outline" size="icon" onClick={() => shiftMonth(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-[150px]" />
            <Button variant="outline" size="icon" onClick={() => shiftMonth(1)}><ChevronRight className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!perms.canExport || filtered.length === 0}>
              <Download className="h-3.5 w-3.5" />CSV
            </Button>
            <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true) }}>交通費を登録</Button>
          </div>
        </div>

        {/* 営業担当ごとの集計（カードを押すとその担当で絞り込み） */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border bg-primary/5 p-3">
            <div className="text-2xs text-muted-foreground">{month} 合計（却下を除く）</div>
            <div className="text-xl font-bold tabular-nums">{fmtYen(total)}</div>
            <div className="text-2xs text-muted-foreground">
              {filtered.length}件{pendingCount > 0 ? ` / 承認待ち${pendingCount}件` : ''}
            </div>
          </div>
          {byRep.map((r) => (
            <button
              key={r.name}
              onClick={() => setRepFilter(repFilter === r.name ? ALL : r.name)}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors hover:bg-accent',
                repFilter === r.name && 'border-primary bg-primary/10',
              )}
            >
              <div className="truncate text-2xs text-muted-foreground">{r.name}</div>
              <div className="text-lg font-bold tabular-nums">{fmtYen(r.total)}</div>
              <div className="text-2xs text-muted-foreground">
                {r.count}件
                {r.pending > 0 && <span className="ml-1 text-amber-700 dark:text-amber-300">承認待ち{r.pending}</span>}
              </div>
            </button>
          ))}
        </div>

        {/* 絞り込み */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>すべてのステータス</SelectItem>
              {TRAVEL_EXPENSE_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={repFilter} onValueChange={setRepFilter}>
            <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>すべての営業担当</SelectItem>
              {byRep.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {perms.canApprove && (
            <Button variant="outline" size="sm" onClick={approveAllPending} disabled={busy}>
              <Check className="h-3.5 w-3.5" />表示中の申請中をまとめて承認
            </Button>
          )}
        </div>

        {/* 明細 */}
        <div className="rounded-lg border">
          {loading ? (
            <div className="p-3"><SkeletonRows count={6} /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">この月の交通費申請はありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b bg-muted/40 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">発生日</th>
                    <th className="px-2 py-1.5 text-left font-medium">営業担当</th>
                    <th className="px-2 py-1.5 text-left font-medium">案件</th>
                    <th className="px-2 py-1.5 text-left font-medium">区間・手段</th>
                    <th className="px-2 py-1.5 text-right font-medium">金額</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    <th className="px-2 py-1.5 text-left font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((x) => (
                    <tr key={x.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{moment(x.expense_date).format('MM/DD')}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{repNameOf(x)}</td>
                      <td className="max-w-[220px] truncate px-2 py-1.5">{x.case_name ?? '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {x.departure ? `${x.departure}→` : ''}{x.destination ?? ''}
                        <span className="ml-1">{x.transport_type ?? ''}{x.round_trip ? '（往復）' : ''}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-medium tabular-nums">{fmtYen(x.amount)}</td>
                      <td className="px-2 py-1.5">
                        <span className={cn('rounded px-1.5 py-0.5 text-2xs', travelExpenseStatusColor(x.status))}>
                          {x.status ?? '申請中'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          {perms.canApprove && (!x.status || x.status === '申請中') && (
                            <>
                              <Button size="sm" variant="outline" className="h-6 text-2xs" disabled={busy} onClick={() => setStatus(x, '承認済み')}>
                                <Check className="h-3 w-3" />承認
                              </Button>
                              <Button size="sm" variant="outline" className="h-6 text-2xs" disabled={busy} onClick={() => setStatus(x, '却下')}>
                                <X className="h-3 w-3" />却下
                              </Button>
                            </>
                          )}
                          {perms.canApprove && x.status === '承認済み' && (
                            <Button size="sm" variant="outline" className="h-6 text-2xs" disabled={busy} onClick={() => setStatus(x, '精算済み')}>
                              精算済みにする
                            </Button>
                          )}
                          <button className="p-1 text-muted-foreground hover:text-foreground" title="編集" onClick={() => { setEditing(x); setModalOpen(true) }}>
                            <Pencil className="h-3 w-3" />
                          </button>
                          {perms.canManage && (
                            <button className="p-1 text-muted-foreground hover:text-red-600" title="削除" onClick={() => remove(x)}>
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <TravelExpenseModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null) }}
        selectedCase={null}
        editing={editing}
        onSaved={load}
      />
    </LaborLayout>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ClipboardCheck, Plus, Check, X, Clock, User as UserIcon, Search,
} from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { EmployeeApi, ApprovalApi, LaborAuditApi } from '@/lib/api'
import { laborPerms, REQUEST_TYPES, APPROVAL_STATUS_LABEL } from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { Employee, ApprovalRequest } from '@/lib/types'

const ALL = '__all__'
type StatusTab = 'pending' | 'approved' | 'rejected' | 'all'

const STATUS_TABS: { value: StatusTab; label: string }[] = [
  { value: 'pending', label: '承認待ち' },
  { value: 'approved', label: '承認済み' },
  { value: 'rejected', label: '却下' },
  { value: 'all', label: 'すべて' },
]

function fmtDate(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function fmtDateTime(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${fmtDate(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function statusBadgeVariant(status?: string | null): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' {
  switch (status) {
    case 'approved': return 'success'
    case 'rejected': return 'destructive'
    case 'canceled': return 'secondary'
    default: return 'warning'
  }
}

function jsonPretty(v: unknown): string {
  if (v == null) return ''
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

export default function Approvals() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)
  const [searchParams, setSearchParams] = useSearchParams()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [statusTab, setStatusTab] = useState<StatusTab>('pending')
  const [typeFilter, setTypeFilter] = useState<string>(ALL)

  const [detail, setDetail] = useState<ApprovalRequest | null>(null)
  const [detailComment, setDetailComment] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<{ employee_id: string; request_type: string; title: string; reason: string }>({
    employee_id: '', request_type: REQUEST_TYPES[0], title: '', reason: '',
  })

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, reqs] = await Promise.all([EmployeeApi.list(), ApprovalApi.list()])
      setEmployees(emps)
      setRequests(reqs)
    } catch (e) {
      console.error('[Approvals]', e)
      toast.error(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { load() }, [load])

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status !== '退職済み'), [employees])
  const myEmployee = useMemo(
    () => employees.find((e) => e.user_id && user?.id && e.user_id === user.id) ?? null,
    [employees, user],
  )

  // ?new= パラメータで作成ダイアログを開く
  useEffect(() => {
    const nw = searchParams.get('new')
    if (!nw) return
    const rt = (REQUEST_TYPES as readonly string[]).includes(nw) ? nw : REQUEST_TYPES[0]
    setForm((f) => ({ ...f, request_type: rt }))
    setCreateOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 一般従業員は自分の従業員IDを既定に
  useEffect(() => {
    if (perms.selfOnly && myEmployee && !form.employee_id) {
      setForm((f) => ({ ...f, employee_id: myEmployee.id }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms.selfOnly, myEmployee])

  const visible = useMemo(() => {
    return requests.filter((r) => {
      if (perms.selfOnly && myEmployee && r.employee_id !== myEmployee.id) return false
      if (perms.selfOnly && !myEmployee) return false
      if (statusTab !== 'all' && (r.status ?? 'pending') !== statusTab) return false
      if (typeFilter !== ALL && r.request_type !== typeFilter) return false
      return true
    })
  }, [requests, statusTab, typeFilter, perms.selfOnly, myEmployee])

  const pendingCount = useMemo(() => {
    return requests.filter((r) => {
      if (perms.selfOnly && myEmployee && r.employee_id !== myEmployee.id) return false
      if (perms.selfOnly && !myEmployee) return false
      return (r.status ?? 'pending') === 'pending'
    }).length
  }, [requests, perms.selfOnly, myEmployee])

  async function approve(req: ApprovalRequest) {
    if (!perms.canApprove) return
    setBusyId(req.id)
    try {
      const now = new Date().toISOString()
      const after = { status: 'approved', approved_by: user?.id ?? null, approved_at: now }
      await ApprovalApi.update(req.id, after)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: req.employee_id,
        action: '勤怠承認', target_table: 'approval_requests', target_id: req.id,
        before_data: { status: req.status }, after_data: after,
      })
      toast.success('承認しました')
      setDetail(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '承認に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  async function reject(req: ApprovalRequest) {
    if (!perms.canApprove) return
    const reason = window.prompt('却下理由を入力してください')
    if (reason == null) return
    setBusyId(req.id)
    try {
      const now = new Date().toISOString()
      const after = { status: 'rejected', rejected_by: user?.id ?? null, rejected_at: now, rejected_reason: reason }
      await ApprovalApi.update(req.id, after)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: req.employee_id,
        action: '勤怠承認', target_table: 'approval_requests', target_id: req.id,
        before_data: { status: req.status }, after_data: after,
      })
      toast.success('却下しました')
      setDetail(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '却下に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  async function saveComment(req: ApprovalRequest) {
    setBusyId(req.id)
    try {
      await ApprovalApi.update(req.id, { comment: detailComment })
      toast.success('コメントを保存しました')
      setRequests((prev) => prev.map((r) => (r.id === req.id ? { ...r, comment: detailComment } : r)))
      setDetail((d) => (d && d.id === req.id ? { ...d, comment: detailComment } : d))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  async function submitCreate() {
    const employee_id = perms.selfOnly && myEmployee ? myEmployee.id : form.employee_id
    if (!employee_id) { toast.error('従業員を選択してください'); return }
    if (!form.request_type) { toast.error('申請種別を選択してください'); return }
    // 有給申請は残高引当まで行う休暇管理へ一本化。ここでは作成せず誘導のみ
    if (form.request_type === '有給申請') {
      toast.info('有給申請は「有給・休暇管理」から行ってください')
      return
    }
    setCreating(true)
    try {
      const now = new Date().toISOString()
      const payload: Partial<ApprovalRequest> = {
        employee_id,
        request_type: form.request_type,
        title: form.title.trim() || null,
        reason: form.reason.trim() || null,
        status: 'pending',
        requested_at: now,
        target_table: 'approval_requests',
      }
      const created = await ApprovalApi.create(payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id,
        action: '申請作成', target_table: 'approval_requests', target_id: created.id,
        after_data: payload,
      })
      toast.success('申請を作成しました')
      setCreateOpen(false)
      setForm({ employee_id: perms.selfOnly && myEmployee ? myEmployee.id : '', request_type: REQUEST_TYPES[0], title: '', reason: '' })
      if (searchParams.get('new')) {
        searchParams.delete('new')
        setSearchParams(searchParams, { replace: true })
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '作成に失敗しました')
    } finally {
      setCreating(false)
    }
  }

  function openDetail(req: ApprovalRequest) {
    setDetail(req)
    setDetailComment(req.comment ?? '')
  }

  function openCreate() {
    setForm((f) => ({
      ...f,
      employee_id: perms.selfOnly && myEmployee ? myEmployee.id : f.employee_id,
    }))
    setCreateOpen(true)
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
      <div className="mx-auto max-w-6xl space-y-4">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="flex items-center gap-1.5 text-lg font-bold">
              <ClipboardCheck className="h-5 w-5 text-primary" />申請承認
            </h1>
            <p className="text-2xs text-muted-foreground">各種申請の承認・差戻し・却下</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5">
              <Clock className="h-4 w-4 text-amber-500" />
              <span className="text-2xs text-muted-foreground">承認待ち</span>
              <span className="text-lg font-bold text-amber-600">{pendingCount}</span>
            </div>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />新規申請
            </Button>
          </div>
        </div>

        {/* フィルタ */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {STATUS_TABS.map((t) => (
              <button
                key={t.value}
                onClick={() => setStatusTab(t.value)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                  statusTab === t.value ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent',
                )}
              >
                {t.label}
                {t.value === 'pending' && pendingCount > 0 && (
                  <span className={cn('ml-1 rounded-full px-1.5 text-2xs', statusTab === t.value ? 'bg-primary-foreground/20' : 'bg-amber-100 text-amber-700')}>
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue placeholder="種別" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての種別</SelectItem>
                {REQUEST_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">申請一覧（{visible.length}）</div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : visible.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">該当する申請はありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">申請日</th>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">種別</th>
                    <th className="px-2 py-1.5 text-left font-medium">内容</th>
                    <th className="px-2 py-1.5 text-left font-medium">ステータス</th>
                    <th className="px-2 py-1.5 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const status = r.status ?? 'pending'
                    const isPending = status === 'pending'
                    const emp = empById.get(r.employee_id)
                    return (
                      <tr
                        key={r.id}
                        onClick={() => openDetail(r)}
                        className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                      >
                        <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{fmtDate(r.requested_at)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 font-medium">{emp?.name ?? '—'}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">{r.request_type}</td>
                        <td className="max-w-[16rem] truncate px-2 py-1.5 text-muted-foreground">{r.title || r.reason || '—'}</td>
                        <td className="px-2 py-1.5">
                          <Badge variant={statusBadgeVariant(status)}>{APPROVAL_STATUS_LABEL[status] ?? status}</Badge>
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                          {isPending && perms.canApprove ? (
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                className="h-7 bg-green-600 px-2 text-white hover:bg-green-700"
                                disabled={busyId === r.id}
                                onClick={() => approve(r)}
                              >
                                <Check className="h-3.5 w-3.5" />承認
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                className="h-7 px-2"
                                disabled={busyId === r.id}
                                onClick={() => reject(r)}
                              >
                                <X className="h-3.5 w-3.5" />却下
                              </Button>
                            </div>
                          ) : isPending ? (
                            <span className="text-2xs text-muted-foreground">承認待ち</span>
                          ) : status === 'approved' ? (
                            <span className="text-2xs text-muted-foreground">承認 {fmtDate(r.approved_at)}</span>
                          ) : status === 'rejected' ? (
                            <span className="text-2xs text-destructive" title={r.rejected_reason ?? ''}>
                              却下{r.rejected_reason ? `：${r.rejected_reason}` : ''}
                            </span>
                          ) : (
                            <span className="text-2xs text-muted-foreground">{APPROVAL_STATUS_LABEL[status] ?? status}</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 詳細ダイアログ */}
      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null) }}>
        <DialogContent className="max-w-lg">
          {detail && (() => {
            const status = detail.status ?? 'pending'
            const emp = empById.get(detail.employee_id)
            const before = jsonPretty(detail.before_data)
            const after = jsonPretty(detail.after_data)
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    {detail.request_type}
                    <Badge variant={statusBadgeVariant(status)}>{APPROVAL_STATUS_LABEL[status] ?? status}</Badge>
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-2 text-xs">
                  <Field label="従業員" value={emp?.name ?? '—'} />
                  <Field label="申請日" value={fmtDateTime(detail.requested_at)} />
                  {detail.title && <Field label="件名" value={detail.title} />}
                  {detail.reason && <Field label="理由" value={detail.reason} multiline />}
                  {status === 'approved' && <Field label="承認日時" value={fmtDateTime(detail.approved_at)} />}
                  {status === 'rejected' && (
                    <>
                      <Field label="却下日時" value={fmtDateTime(detail.rejected_at)} />
                      <Field label="却下理由" value={detail.rejected_reason ?? '—'} multiline />
                    </>
                  )}
                  {before && (
                    <div>
                      <div className="mb-0.5 text-2xs font-medium text-muted-foreground">変更前</div>
                      <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-2xs">{before}</pre>
                    </div>
                  )}
                  {after && (
                    <div>
                      <div className="mb-0.5 text-2xs font-medium text-muted-foreground">変更後</div>
                      <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-2xs">{after}</pre>
                    </div>
                  )}
                  <div>
                    <div className="mb-0.5 text-2xs font-medium text-muted-foreground">コメント</div>
                    {perms.canApprove ? (
                      <div className="flex items-start gap-1.5">
                        <Textarea
                          value={detailComment}
                          onChange={(e) => setDetailComment(e.target.value)}
                          rows={2}
                          className="text-xs"
                          placeholder="コメントを入力"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === detail.id || detailComment === (detail.comment ?? '')}
                          onClick={() => saveComment(detail)}
                        >
                          保存
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-md border bg-muted/40 p-2 text-2xs">{detail.comment || '—'}</div>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  {status === 'pending' && perms.canApprove ? (
                    <>
                      <Button variant="destructive" disabled={busyId === detail.id} onClick={() => reject(detail)}>
                        <X className="h-3.5 w-3.5" />却下
                      </Button>
                      <Button className="bg-green-600 text-white hover:bg-green-700" disabled={busyId === detail.id} onClick={() => approve(detail)}>
                        <Check className="h-3.5 w-3.5" />承認
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" onClick={() => setDetail(null)}>閉じる</Button>
                  )}
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* 新規申請ダイアログ */}
      <Dialog open={createOpen} onOpenChange={(o) => {
        setCreateOpen(o)
        if (!o && searchParams.get('new')) {
          searchParams.delete('new')
          setSearchParams(searchParams, { replace: true })
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><Plus className="h-4 w-4" />新規申請</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <div>
              <label className="mb-1 block font-medium text-muted-foreground">従業員</label>
              {perms.selfOnly ? (
                <div className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-2">
                  <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  {myEmployee?.name ?? '（あなたに紐付く従業員が未登録です）'}
                </div>
              ) : (
                <Select value={form.employee_id} onValueChange={(v) => setForm((f) => ({ ...f, employee_id: v }))}>
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="従業員を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeEmployees.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}{e.department ? `（${e.department}）` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <label className="mb-1 block font-medium text-muted-foreground">申請種別</label>
              <Select value={form.request_type} onValueChange={(v) => setForm((f) => ({ ...f, request_type: v }))}>
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder="種別を選択" />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.request_type === '有給申請' ? (
              // 有給は残高引当込みの休暇管理へ誘導（二系統でのデータ欠落を防ぐ）
              <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-2xs text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
                <p className="mb-1.5">有給の申請は残高から自動で引き当てるため「有給・休暇管理」から行ってください。</p>
                <Link
                  to="/labor/leaves?new=1"
                  className="inline-flex items-center gap-1 font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300"
                  onClick={() => setCreateOpen(false)}
                >
                  有給・休暇管理を開く
                </Link>
              </div>
            ) : (
              <>
            <div>
              <label className="mb-1 block font-medium text-muted-foreground">件名</label>
              <Input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="例：7/3の退勤打刻漏れ"
                className="text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block font-medium text-muted-foreground">理由・詳細</label>
              <Textarea
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                rows={3}
                placeholder="申請の理由を記入してください"
                className="text-xs"
              />
            </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>キャンセル</Button>
            <Button disabled={creating || form.request_type === '有給申請'} onClick={submitCreate}>
              {creating ? '送信中…' : '申請する'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

function Field({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className={cn(multiline ? 'block' : 'flex items-center gap-2')}>
      <span className="shrink-0 text-2xs font-medium text-muted-foreground">{label}</span>
      <span className={cn('text-xs', multiline && 'mt-0.5 block whitespace-pre-wrap')}>{value}</span>
    </div>
  )
}

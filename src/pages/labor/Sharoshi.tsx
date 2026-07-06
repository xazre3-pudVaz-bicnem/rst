import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Handshake } from 'lucide-react'
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
import { SharoshiApi, LaborAuditApi } from '@/lib/api'
import {
  laborPerms, SHAROSHI_SHARE_TYPES, SHAROSHI_STATUSES, procedureStatusColor,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { SharoshiShare } from '@/lib/types'

const ALL = '__all__'
type ShareType = (typeof SHAROSHI_SHARE_TYPES)[number]

/** ISO → 日時表記 */
function fmtDateTime(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface CreateForm {
  title: string
  share_type: ShareType
  status: string
  target_month: string
  assigned_to: string
  message: string
  note: string
}

function emptyForm(): CreateForm {
  return {
    title: '', share_type: SHAROSHI_SHARE_TYPES[0], status: SHAROSHI_STATUSES[0],
    target_month: '', assigned_to: '', message: '', note: '',
  }
}

export default function Sharoshi() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [rows, setRows] = useState<SharoshiShare[]>([])
  const [loading, setLoading] = useState(true)

  const [statusTab, setStatusTab] = useState<string>(ALL)
  const [typeFilter, setTypeFilter] = useState<string>(ALL)

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<CreateForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  // 詳細ダイアログ
  const [detail, setDetail] = useState<SharoshiShare | null>(null)
  const [detailStatus, setDetailStatus] = useState<string>(SHAROSHI_STATUSES[0])
  const [detailResponse, setDetailResponse] = useState('')

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const list = await SharoshiApi.list()
      setRows(list)
    } catch (e) {
      console.error('[Sharoshi]', e)
      toast.error(e instanceof Error ? e.message : '社労士連携の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => rows.filter((r) => {
    if (statusTab !== ALL && (r.status ?? '') !== statusTab) return false
    if (typeFilter !== ALL && (r.share_type ?? '') !== typeFilter) return false
    return true
  }), [rows, statusTab, typeFilter])

  const summary = useMemo(() => {
    const s: Record<string, number> = {}
    for (const st of SHAROSHI_STATUSES) s[st] = 0
    for (const r of rows) {
      const st = r.status ?? ''
      if (st in s) s[st]++
    }
    return s
  }, [rows])

  const setField = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }))

  function openDetail(r: SharoshiShare) {
    setDetail(r)
    setDetailStatus(r.status || SHAROSHI_STATUSES[0])
    setDetailResponse(r.response ?? '')
  }

  async function handleCreate() {
    if (!perms.canManage) return
    if (form.title.trim() === '') { toast.error('タイトルを入力してください'); return }
    const payload: Partial<SharoshiShare> = {
      title: form.title.trim(),
      share_type: form.share_type,
      status: form.status || SHAROSHI_STATUSES[0],
      target_month: form.target_month === '' ? null : form.target_month,
      assigned_to: form.assigned_to.trim() === '' ? null : form.assigned_to.trim(),
      message: form.message.trim() === '' ? null : form.message.trim(),
      note: form.note.trim() === '' ? null : form.note.trim(),
      shared_by: user?.id ?? null,
    }
    setSaving(true)
    try {
      const created = await SharoshiApi.create(payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName,
        action: '社労士連携作成', target_table: 'sharoshi_shares', target_id: created.id, after_data: payload,
      })
      toast.success('依頼を作成しました')
      setCreateOpen(false)
      setForm(emptyForm())
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveResponse(complete: boolean) {
    if (!perms.canManage || !detail) return
    const payload: Partial<SharoshiShare> = {
      status: complete ? '完了' : detailStatus,
      response: detailResponse.trim() === '' ? null : detailResponse.trim(),
      responded_at: new Date().toISOString(),
    }
    setSaving(true)
    try {
      await SharoshiApi.update(detail.id, payload)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName,
        action: '社労士連携', target_table: 'sharoshi_shares', target_id: detail.id, after_data: payload,
      })
      toast.success('回答を保存しました')
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!perms.canManage || !detail) return
    if (!window.confirm('この依頼を削除しますか？')) return
    try {
      await SharoshiApi.remove(detail.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName,
        action: '社労士連携', target_table: 'sharoshi_shares', target_id: detail.id, after_data: { deleted: true },
      })
      toast.success('削除しました')
      setDetail(null)
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
            <h1 className="text-lg font-bold">社労士連携</h1>
            <p className="text-2xs text-muted-foreground">社労士とのデータ共有・相談・依頼管理</p>
          </div>
          {perms.canManage && (
            <Button size="sm" onClick={() => { setForm(emptyForm()); setCreateOpen(true) }}>
              <Plus className="h-3.5 w-3.5" />依頼を作成
            </Button>
          )}
        </div>

        {/* サマリー */}
        <div className="flex flex-wrap gap-1.5">
          {SHAROSHI_STATUSES.map((st) => (
            <Badge key={st} className={procedureStatusColor(st)}>{st} {summary[st] ?? 0}</Badge>
          ))}
        </div>

        {/* ステータスタブ + 種別フィルタ */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setStatusTab(ALL)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                statusTab === ALL ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
            >
              すべて
            </button>
            {SHAROSHI_STATUSES.map((st) => (
              <button
                key={st}
                onClick={() => setStatusTab(st)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  statusTab === st ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent',
                )}
              >
                {st}
              </button>
            ))}
          </div>
          <div className="w-36">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger><SelectValue placeholder="共有種別" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての種別</SelectItem>
                {SHAROSHI_SHARE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* カード一覧 */}
        {loading ? (
          <div className="rounded-xl border bg-card p-3"><SkeletonRows count={6} /></div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center text-xs text-muted-foreground">
            社労士への依頼はありません
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {filtered.map((r) => (
              <button
                key={r.id}
                onClick={() => openDetail(r)}
                className="rounded-xl border bg-card p-3 text-left transition-colors hover:bg-accent/50"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-bold">{r.title}</p>
                  <Badge className={cn('shrink-0', procedureStatusColor(r.status))}>{r.status ?? '—'}</Badge>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                  {r.share_type && <Badge variant="secondary">{r.share_type}</Badge>}
                  {r.assigned_to && <span>社労士: {r.assigned_to}</span>}
                  {r.target_month && <span>対象月: {r.target_month}</span>}
                </div>
                {r.message && (
                  <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{r.message}</p>
                )}
                {r.response && (
                  <p className="mt-1.5 line-clamp-2 rounded-md bg-muted/60 px-2 py-1 text-2xs text-foreground/80">
                    回答: {r.response}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 詳細ダイアログ */}
      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null) }}>
        <DialogContent className="max-w-lg">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.title}</DialogTitle>
              </DialogHeader>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {detail.share_type && <Badge variant="secondary">{detail.share_type}</Badge>}
                  <Badge className={procedureStatusColor(detail.status)}>{detail.status ?? '—'}</Badge>
                  {detail.assigned_to && <span className="text-2xs text-muted-foreground">社労士: {detail.assigned_to}</span>}
                  {detail.target_month && <span className="text-2xs text-muted-foreground">対象月: {detail.target_month}</span>}
                </div>

                <div className="space-y-1">
                  <Label>依頼内容</Label>
                  <div className="whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs">
                    {detail.message || '—'}
                  </div>
                </div>

                {perms.canManage ? (
                  <>
                    <div className="space-y-1">
                      <Label>ステータス</Label>
                      <Select value={detailStatus} onValueChange={setDetailStatus}>
                        <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
                        <SelectContent>
                          {SHAROSHI_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>社労士回答</Label>
                      <Textarea value={detailResponse} onChange={(e) => setDetailResponse(e.target.value)} rows={4} placeholder="回答内容を入力" />
                    </div>
                  </>
                ) : (
                  <div className="space-y-1">
                    <Label>社労士回答</Label>
                    <div className="whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs">
                      {detail.response || '未回答'}
                    </div>
                  </div>
                )}

                {detail.responded_at && (
                  <p className="text-2xs text-muted-foreground">回答日時: {fmtDateTime(detail.responded_at)}</p>
                )}
              </div>

              <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                {perms.canManage ? (
                  <>
                    <Button variant="destructive" size="sm" onClick={handleDelete} disabled={saving}>削除</Button>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleSaveResponse(false)} disabled={saving}>回答を保存</Button>
                      <Button size="sm" onClick={() => handleSaveResponse(true)} disabled={saving}>完了にする</Button>
                    </div>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setDetail(null)}>閉じる</Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 作成ダイアログ */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <Handshake className="mr-1 inline h-4 w-4" />社労士への依頼を作成
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>タイトル *</Label>
              <Input value={form.title} onChange={(e) => setField('title', e.target.value)} placeholder="例：2026年6月分 給与データ共有" />
            </div>
            <div className="space-y-1">
              <Label>共有種別</Label>
              <Select value={form.share_type} onValueChange={(v) => setField('share_type', v as ShareType)}>
                <SelectTrigger><SelectValue placeholder="共有種別" /></SelectTrigger>
                <SelectContent>
                  {SHAROSHI_SHARE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>ステータス</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger><SelectValue placeholder="ステータス" /></SelectTrigger>
                <SelectContent>
                  {SHAROSHI_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>対象月</Label>
              <Input type="month" value={form.target_month} onChange={(e) => setField('target_month', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>社労士名</Label>
              <Input value={form.assigned_to} onChange={(e) => setField('assigned_to', e.target.value)} placeholder="担当社労士" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>依頼内容</Label>
              <Textarea value={form.message} onChange={(e) => setField('message', e.target.value)} rows={3} placeholder="相談・依頼の内容" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>メモ</Label>
              <Textarea value={form.note} onChange={(e) => setField('note', e.target.value)} rows={2} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)} disabled={saving}>キャンセル</Button>
            <Button size="sm" onClick={handleCreate} disabled={saving}>
              {saving ? '作成中…' : '作成'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

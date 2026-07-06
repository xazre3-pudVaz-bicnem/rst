import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ShieldAlert, Lock } from 'lucide-react'
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
import { EmployeeApi, MyNumberApi, LaborAuditApi } from '@/lib/api'
import {
  laborPerms, MYNUMBER_HOLDER_TYPES, MYNUMBER_COLLECTION_STATUSES, procedureStatusColor,
} from '@/lib/labor'
import type { Employee, MyNumber as MyNumberType } from '@/lib/types'

const ALL = '__all__'
type HolderType = (typeof MYNUMBER_HOLDER_TYPES)[number]

/** ISO / YYYY-MM-DD → YYYY-MM-DD 表記 */
function fmtDate(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** ISO → date input 用 YYYY-MM-DD */
function toDateInput(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface MnForm {
  id: string | null
  employee_id: string
  holder_type: HolderType
  holder_name: string
  masked_number: string
  collection_status: string
  purpose: string
  stored_location: string
  collected_at: string
  disposed_at: string
  note: string
}

function emptyForm(): MnForm {
  return {
    id: null, employee_id: '', holder_type: MYNUMBER_HOLDER_TYPES[0], holder_name: '',
    masked_number: '', collection_status: MYNUMBER_COLLECTION_STATUSES[0], purpose: '',
    stored_location: '', collected_at: '', disposed_at: '', note: '',
  }
}

export default function MyNumber() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [rows, setRows] = useState<MyNumberType[]>([])
  const [loading, setLoading] = useState(true)

  const [statusFilter, setStatusFilter] = useState<string>(ALL)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<MnForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    if (!perms.canConfigure) { setLoading(false); return }
    setLoading(true)
    try {
      const [emps, list] = await Promise.all([EmployeeApi.list(), MyNumberApi.list()])
      setEmployees(emps)
      setRows(list)
      // 閲覧アクセスを監査ログに記録
      LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName,
        action: 'マイナンバー画面閲覧', target_table: 'my_numbers',
      })
    } catch (e) {
      console.error('[MyNumber]', e)
      toast.error(e instanceof Error ? e.message : 'マイナンバー情報の取得に失敗しました')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, perms.canConfigure, user?.id, displayName])

  useEffect(() => { load() }, [load])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === '在籍中'), [employees])

  const filtered = useMemo(() => rows.filter((r) => {
    if (statusFilter !== ALL && (r.collection_status ?? '') !== statusFilter) return false
    return true
  }), [rows, statusFilter])

  const summary = useMemo(() => {
    const s: Record<string, number> = {}
    for (const st of MYNUMBER_COLLECTION_STATUSES) s[st] = 0
    for (const r of rows) {
      const st = r.collection_status ?? ''
      if (st in s) s[st]++
    }
    return s
  }, [rows])

  const setField = <K extends keyof MnForm>(k: K, v: MnForm[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }))

  function openCreate() {
    setForm(emptyForm())
    setDialogOpen(true)
  }

  function openEdit(r: MyNumberType) {
    setForm({
      id: r.id,
      employee_id: r.employee_id,
      holder_type: (r.holder_type as HolderType) || MYNUMBER_HOLDER_TYPES[0],
      holder_name: r.holder_name ?? '',
      masked_number: r.masked_number ?? '',
      collection_status: r.collection_status || MYNUMBER_COLLECTION_STATUSES[0],
      purpose: r.purpose ?? '',
      stored_location: r.stored_location ?? '',
      collected_at: toDateInput(r.collected_at),
      disposed_at: toDateInput(r.disposed_at),
      note: r.note ?? '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!perms.canConfigure) return
    if (!form.employee_id) { toast.error('従業員を選択してください'); return }
    const payload: Partial<MyNumberType> = {
      employee_id: form.employee_id,
      holder_type: form.holder_type,
      holder_name: form.holder_name.trim() === '' ? null : form.holder_name.trim(),
      masked_number: form.masked_number.trim() === '' ? null : form.masked_number.trim(),
      collection_status: form.collection_status || null,
      purpose: form.purpose.trim() === '' ? null : form.purpose.trim(),
      stored_location: form.stored_location.trim() === '' ? null : form.stored_location.trim(),
      collected_at: form.collected_at === '' ? null : form.collected_at,
      disposed_at: form.disposed_at === '' ? null : form.disposed_at,
      note: form.note.trim() === '' ? null : form.note.trim(),
    }
    setSaving(true)
    try {
      let targetId = form.id
      if (form.id) {
        await MyNumberApi.update(form.id, payload)
      } else {
        const created = await MyNumberApi.create(payload)
        targetId = created.id
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: form.employee_id,
        action: 'マイナンバー変更', target_table: 'my_numbers', target_id: targetId, after_data: payload,
      })
      toast.success('マイナンバー情報を保存しました')
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(r: MyNumberType) {
    if (!perms.canConfigure) return
    if (!window.confirm('このマイナンバー情報を削除しますか？')) return
    try {
      await MyNumberApi.remove(r.id)
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName, employee_id: r.employee_id,
        action: 'マイナンバー削除', target_table: 'my_numbers', target_id: r.id, after_data: { deleted: true },
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

  if (!perms.canConfigure) {
    return (
      <LaborLayout>
        <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
          <Lock className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">マイナンバーの閲覧には管理者権限が必要です。</p>
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
            <h1 className="text-lg font-bold">マイナンバー管理</h1>
            <p className="text-2xs text-muted-foreground">収集状況・保管管理（番号本体は保存しません）</p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />登録
          </Button>
        </div>

        {/* セキュリティバナー */}
        <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="leading-relaxed">
            ⚠ マイナンバー本体は本システムに保存しません。番号は暗号化ストレージ等で別途厳重に保管し、
            本画面では収集状況・下4桁マスク・利用目的のみを管理します。閲覧・変更はすべて監査ログに記録されます。
          </p>
        </div>

        {/* サマリー */}
        <div className="flex flex-wrap gap-1.5">
          {MYNUMBER_COLLECTION_STATUSES.map((st) => (
            <Badge key={st} className={procedureStatusColor(st)}>{st} {summary[st] ?? 0}</Badge>
          ))}
        </div>

        {/* フィルタ */}
        <div className="flex flex-wrap gap-2">
          <div className="w-40">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue placeholder="収集状況" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべての状況</SelectItem>
                {MYNUMBER_COLLECTION_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 一覧 */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">
            <Lock className="mr-1 inline h-3.5 w-3.5" />マイナンバー一覧（{filtered.length}）
          </div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={8} /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">マイナンバー情報は登録されていません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                    <th className="px-2 py-1.5 text-left font-medium">保有者</th>
                    <th className="px-2 py-1.5 text-left font-medium">マスク番号</th>
                    <th className="px-2 py-1.5 text-left font-medium">収集状況</th>
                    <th className="px-2 py-1.5 text-left font-medium">利用目的</th>
                    <th className="px-2 py-1.5 text-left font-medium">保管場所</th>
                    <th className="px-2 py-1.5 text-left font-medium">収集日</th>
                    <th className="px-2 py-1.5 text-left font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/50">
                      <td className="px-2 py-1.5 font-medium">{empMap.get(r.employee_id)?.name ?? '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {r.holder_type ?? '—'}{r.holder_name ? ` / ${r.holder_name}` : ''}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-muted-foreground">{r.masked_number || '—'}</td>
                      <td className="px-2 py-1.5">
                        <Badge className={procedureStatusColor(r.collection_status)}>{r.collection_status ?? '—'}</Badge>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.purpose || '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.stored_location || '—'}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(r.collected_at)}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>編集</Button>
                          <Button size="sm" variant="destructive" onClick={() => handleDelete(r)}>削除</Button>
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

      {/* 追加・編集ダイアログ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? 'マイナンバー情報の編集' : 'マイナンバーを登録'}</DialogTitle>
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
              <Label>保有者区分</Label>
              <Select value={form.holder_type} onValueChange={(v) => setField('holder_type', v as HolderType)}>
                <SelectTrigger><SelectValue placeholder="保有者区分" /></SelectTrigger>
                <SelectContent>
                  {MYNUMBER_HOLDER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>保有者氏名</Label>
              <Input value={form.holder_name} onChange={(e) => setField('holder_name', e.target.value)} placeholder="扶養家族の場合など" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>マスク番号</Label>
              <Input
                value={form.masked_number}
                onChange={(e) => setField('masked_number', e.target.value)}
                placeholder="****-****-1234"
                className="font-mono"
              />
              <p className="text-2xs text-muted-foreground">下4桁のみを推奨します。例: ****-****-1234（フル番号は入力しないでください）</p>
            </div>
            <div className="space-y-1">
              <Label>収集状況</Label>
              <Select value={form.collection_status} onValueChange={(v) => setField('collection_status', v)}>
                <SelectTrigger><SelectValue placeholder="収集状況" /></SelectTrigger>
                <SelectContent>
                  {MYNUMBER_COLLECTION_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>利用目的</Label>
              <Input value={form.purpose} onChange={(e) => setField('purpose', e.target.value)} placeholder="源泉徴収・社会保険手続 等" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>保管場所</Label>
              <Input value={form.stored_location} onChange={(e) => setField('stored_location', e.target.value)} placeholder="施錠キャビネット / 暗号化ストレージ 等" />
            </div>
            <div className="space-y-1">
              <Label>収集日</Label>
              <Input type="date" value={form.collected_at} onChange={(e) => setField('collected_at', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>廃棄日</Label>
              <Input type="date" value={form.disposed_at} onChange={(e) => setField('disposed_at', e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>メモ</Label>
              <Textarea value={form.note} onChange={(e) => setField('note', e.target.value)} rows={2} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>キャンセル</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LaborLayout>
  )
}

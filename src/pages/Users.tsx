import { useCallback, useEffect, useState } from 'react'
import { Save, ShieldCheck, User as UserIcon, KeyRound, UserPlus, Inbox } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SkeletonRows } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ProfileApi, SignupRequestApi, AdminUserApi } from '@/lib/api'
import { useAuth, FIXED_ADMIN_EMAIL } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { ROLES, roleLabel } from '@/lib/constants'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { jpError } from '@/lib/utils'
import type { Profile, SignupRequest } from '@/lib/types'

const isFixedAdmin = (p: Pick<Profile, 'email'>) => (p.email || '').toLowerCase() === FIXED_ADMIN_EMAIL

export default function Users() {
  const { user, isAdmin } = useAuth()
  const toast = useToast()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [requests, setRequests] = useState<SignupRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'users' | 'requests'>('users')
  const [edits, setEdits] = useState<Record<string, { full_name: string; role: string }>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  // 作成/承認モーダル
  const [createOpen, setCreateOpen] = useState(false)
  const [cf, setCf] = useState({ email: '', display_name: '', username: '', password: '', role: 'sales', is_sales_assignee: true, requestId: '' })
  const [cfBusy, setCfBusy] = useState(false)
  // パスワード再設定
  const [pwTarget, setPwTarget] = useState<Profile | null>(null)
  const [pwValue, setPwValue] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [list, reqs] = await Promise.all([ProfileApi.list(), SignupRequestApi.list()])
      setProfiles(list)
      setRequests(reqs)
      setEdits(Object.fromEntries(list.map((p) => [p.id, { full_name: p.full_name ?? '', role: p.role ?? 'sales' }])))
    } catch (e) {
      console.error('[Users]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function save(p: Profile) {
    const e = edits[p.id]
    if (!e) return
    setSavingId(p.id)
    try {
      const role = isFixedAdmin(p) ? 'admin' : e.role // 固定adminはadmin固定
      await ProfileApi.update(p.id, { full_name: e.full_name || null, role })
      toast.success('ユーザー情報を更新しました')
      await load()
    } catch (err) {
      toast.error('更新に失敗しました: ' + jpError(err))
    } finally {
      setSavingId(null)
    }
  }

  async function toggle(p: Profile, key: 'is_active' | 'is_sales_assignee', value: boolean) {
    if (key === 'is_active' && isFixedAdmin(p) && !value) { toast.error('固定管理者は無効化できません'); return }
    try {
      await ProfileApi.update(p.id, { [key]: value })
      setProfiles((ps) => ps.map((x) => (x.id === p.id ? { ...x, [key]: value } : x)))
    } catch (err) {
      toast.error('更新に失敗しました: ' + jpError(err))
    }
  }

  function openCreate(req?: SignupRequest) {
    setCf({
      email: req?.email ?? '', display_name: req?.display_name ?? '', username: '', password: '',
      role: 'sales', is_sales_assignee: true, requestId: req?.id ?? '',
    })
    setCreateOpen(true)
  }

  async function submitCreate() {
    setCfBusy(true)
    try {
      await AdminUserApi.call('create', cf)
      toast.success('ユーザーを作成しました')
      setCreateOpen(false)
      await load()
    } catch (err) {
      toast.error('作成に失敗しました: ' + jpError(err))
    } finally {
      setCfBusy(false)
    }
  }

  async function submitReset() {
    if (!pwTarget) return
    setPwBusy(true)
    try {
      await AdminUserApi.call('reset-password', { userId: pwTarget.id, password: pwValue })
      toast.success('パスワードを再設定しました')
      setPwTarget(null); setPwValue('')
    } catch (err) {
      toast.error('再設定に失敗しました: ' + jpError(err))
    } finally {
      setPwBusy(false)
    }
  }

  async function rejectRequest(r: SignupRequest) {
    try { await SignupRequestApi.setStatus(r.id, 'rejected'); await load() }
    catch (err) { toast.error('却下に失敗: ' + jpError(err)) }
  }

  const pendingCount = requests.filter((r) => r.status === 'pending').length

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-4xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-lg font-bold">ユーザー管理</h1>
              <p className="text-2xs text-muted-foreground">管理者がユーザー作成・ロール設定・申請承認を行います。固定管理者は admin 固定で削除/無効化できません。</p>
            </div>
            {isAdmin && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => openCreate()}><UserPlus className="h-3.5 w-3.5" />新規ユーザー作成</Button>
              </div>
            )}
          </div>

          {!isSupabaseConfigured ? (
            <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">Supabase が未設定です。</div>
          ) : !isAdmin ? (
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">この画面は管理者のみ操作できます。</div>
          ) : loading ? (
            <SkeletonRows count={5} />
          ) : (
            <>
              {/* タブ */}
              <div className="flex gap-1">
                <button onClick={() => setTab('users')} className={`rounded-md border px-3 py-1 text-xs font-medium ${tab === 'users' ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent'}`}>ユーザー（{profiles.length}）</button>
                <button onClick={() => setTab('requests')} className={`flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium ${tab === 'requests' ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent'}`}>
                  <Inbox className="h-3.5 w-3.5" />登録申請（{pendingCount}）
                </button>
              </div>

              {tab === 'users' ? (
                <div className="overflow-x-auto rounded-lg border bg-card">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/50 text-2xs text-muted-foreground">
                      <tr>
                        <th className="p-2 text-left">ユーザー</th>
                        <th className="p-2 text-left">表示名</th>
                        <th className="p-2 text-left">メール</th>
                        <th className="p-2 text-left">ロール</th>
                        <th className="p-2 text-center">営業担当</th>
                        <th className="p-2 text-center">有効</th>
                        <th className="p-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profiles.map((p) => {
                        const e = edits[p.id] ?? { full_name: '', role: 'sales' }
                        const isMe = p.id === user?.id
                        const fixed = isFixedAdmin(p)
                        return (
                          <tr key={p.id} className="border-t align-top">
                            <td className="p-2">
                              <div className="flex items-center gap-1.5">
                                {(fixed || e.role === 'admin') ? <ShieldCheck className="h-3.5 w-3.5 text-primary" /> : <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                                <span className="text-2xs text-muted-foreground">{roleLabel(fixed ? 'admin' : e.role)}</span>
                                {isMe && <span className="rounded bg-primary/10 px-1 text-[9px] text-primary">自分</span>}
                                {fixed && <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">管理者固定</span>}
                              </div>
                            </td>
                            <td className="p-2">
                              <Input value={e.full_name} onChange={(ev) => setEdits((s) => ({ ...s, [p.id]: { ...e, full_name: ev.target.value } }))} className="h-7" placeholder="表示名" />
                            </td>
                            <td className="p-2 text-2xs text-muted-foreground">{p.email || '—'}</td>
                            <td className="p-2">
                              <Select value={fixed ? 'admin' : e.role} onValueChange={(v) => setEdits((s) => ({ ...s, [p.id]: { ...e, role: v } }))} disabled={fixed}>
                                <SelectTrigger className="h-7 w-28"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </td>
                            <td className="p-2 text-center">
                              <input type="checkbox" checked={p.is_sales_assignee ?? true} onChange={(ev) => toggle(p, 'is_sales_assignee', ev.target.checked)} />
                            </td>
                            <td className="p-2 text-center">
                              <input type="checkbox" checked={p.is_active ?? true} disabled={fixed} onChange={(ev) => toggle(p, 'is_active', ev.target.checked)} />
                            </td>
                            <td className="p-2 text-right">
                              <div className="flex justify-end gap-1">
                                <Button size="sm" variant="outline" className="h-7" onClick={() => { setPwTarget(p); setPwValue('') }} title="パスワード再設定"><KeyRound className="h-3.5 w-3.5" /></Button>
                                <Button size="sm" className="h-7" onClick={() => save(p)} disabled={savingId === p.id}><Save className="h-3.5 w-3.5" />{savingId === p.id ? '...' : '保存'}</Button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border bg-card">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-muted/50 text-2xs text-muted-foreground">
                      <tr>
                        <th className="p-2 text-left">申請日</th>
                        <th className="p-2 text-left">メール</th>
                        <th className="p-2 text-left">希望表示名</th>
                        <th className="p-2 text-left">メモ</th>
                        <th className="p-2 text-left">状態</th>
                        <th className="p-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.length === 0 ? (
                        <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">申請はありません</td></tr>
                      ) : requests.map((r) => (
                        <tr key={r.id} className="border-t align-top">
                          <td className="p-2 text-2xs text-muted-foreground">{new Date(r.created_at).toLocaleString('ja-JP')}</td>
                          <td className="p-2">{r.email}</td>
                          <td className="p-2">{r.display_name || '—'}</td>
                          <td className="max-w-[200px] p-2 text-2xs text-muted-foreground">{r.memo || '—'}</td>
                          <td className="p-2">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] ${r.status === 'pending' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : r.status === 'approved' ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700'}`}>{r.status}</span>
                          </td>
                          <td className="p-2 text-right">
                            {r.status === 'pending' && (
                              <div className="flex justify-end gap-1">
                                <Button size="sm" className="h-7" onClick={() => openCreate(r)}>ユーザー作成（承認）</Button>
                                <Button size="sm" variant="outline" className="h-7" onClick={() => rejectRequest(r)}>却下</Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ユーザー作成 / 承認 */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && setCreateOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{cf.requestId ? '申請を承認してユーザー作成' : '新規ユーザー作成'}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <div className="space-y-1"><label className="text-2xs text-muted-foreground">メール</label><Input type="email" value={cf.email} onChange={(e) => setCf({ ...cf, email: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><label className="text-2xs text-muted-foreground">表示名</label><Input value={cf.display_name} onChange={(e) => setCf({ ...cf, display_name: e.target.value })} /></div>
              <div className="space-y-1"><label className="text-2xs text-muted-foreground">ユーザー名</label><Input value={cf.username} onChange={(e) => setCf({ ...cf, username: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><label className="text-2xs text-muted-foreground">初期パスワード</label><Input type="text" value={cf.password} onChange={(e) => setCf({ ...cf, password: e.target.value })} placeholder="6文字以上" /></div>
              <div className="space-y-1">
                <label className="text-2xs text-muted-foreground">ロール</label>
                <Select value={cf.role} onValueChange={(v) => setCf({ ...cf, role: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>{ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cf.is_sales_assignee} onChange={(e) => setCf({ ...cf, is_sales_assignee: e.target.checked })} />営業担当として表示する</label>
          </div>
          <DialogFooter className="justify-between">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>キャンセル</Button>
            <Button onClick={submitCreate} disabled={cfBusy || !cf.email.trim() || cf.password.length < 6}>{cfBusy ? '作成中...' : 'ユーザー作成'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* パスワード再設定 */}
      <Dialog open={!!pwTarget} onOpenChange={(o) => !o && setPwTarget(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader><DialogTitle>パスワード再設定</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <div className="text-2xs text-muted-foreground">{pwTarget?.email || pwTarget?.full_name}</div>
            <Input type="text" value={pwValue} onChange={(e) => setPwValue(e.target.value)} placeholder="新しいパスワード（6文字以上）" />
          </div>
          <DialogFooter className="justify-between">
            <Button variant="outline" onClick={() => setPwTarget(null)}>キャンセル</Button>
            <Button onClick={submitReset} disabled={pwBusy || pwValue.length < 6}>{pwBusy ? '設定中...' : '再設定'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

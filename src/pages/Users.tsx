import { useCallback, useEffect, useState } from 'react'
import { Save, ShieldCheck, User as UserIcon } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SkeletonRows } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ProfileApi } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { ROLES, roleLabel } from '@/lib/constants'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { jpError } from '@/lib/utils'
import type { Profile } from '@/lib/types'

export default function Users() {
  const { user } = useAuth()
  const toast = useToast()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, { full_name: string; role: string }>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const list = await ProfileApi.list()
      setProfiles(list)
      setEdits(Object.fromEntries(list.map((p) => [p.id, { full_name: p.full_name ?? '', role: p.role ?? 'member' }])))
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
      await ProfileApi.update(p.id, { full_name: e.full_name || null, role: e.role })
      toast.success('ユーザー情報を更新しました')
      await load()
    } catch (err) {
      toast.error('更新に失敗しました: ' + jpError(err))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-3xl space-y-3">
          <div>
            <h1 className="text-lg font-bold">ユーザー管理</h1>
            <p className="text-2xs text-muted-foreground">
              担当者名とロールを設定できます。ユーザーの追加・削除は Supabase の Authentication 画面から行います。
            </p>
          </div>

          {!isSupabaseConfigured ? (
            <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">Supabase が未設定です。</div>
          ) : loading ? (
            <SkeletonRows count={5} />
          ) : profiles.length === 0 ? (
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              プロフィールがまだありません。schema.sql / migration を適用し、ユーザーが一度ログインすると表示されます。
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-2xs text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">ユーザー</th>
                    <th className="p-2 text-left">担当者名</th>
                    <th className="p-2 text-left">ロール</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((p) => {
                    const e = edits[p.id] ?? { full_name: '', role: 'member' }
                    const isMe = p.id === user?.id
                    return (
                      <tr key={p.id} className="border-t">
                        <td className="p-2">
                          <div className="flex items-center gap-1.5">
                            {e.role === 'admin' ? <ShieldCheck className="h-3.5 w-3.5 text-primary" /> : <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                            <span className="text-2xs text-muted-foreground">{roleLabel(e.role)}</span>
                            {isMe && <span className="rounded bg-primary/10 px-1 text-[9px] text-primary">自分</span>}
                          </div>
                        </td>
                        <td className="p-2">
                          <Input
                            value={e.full_name}
                            onChange={(ev) => setEdits((s) => ({ ...s, [p.id]: { ...e, full_name: ev.target.value } }))}
                            className="h-7"
                            placeholder="担当者名"
                          />
                        </td>
                        <td className="p-2">
                          <Select value={e.role} onValueChange={(v) => setEdits((s) => ({ ...s, [p.id]: { ...e, role: v } }))}>
                            <SelectTrigger className="h-7 w-28"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-2 text-right">
                          <Button size="sm" onClick={() => save(p)} disabled={savingId === p.id}>
                            <Save className="h-3.5 w-3.5" />{savingId === p.id ? '...' : '保存'}
                          </Button>
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
    </div>
  )
}

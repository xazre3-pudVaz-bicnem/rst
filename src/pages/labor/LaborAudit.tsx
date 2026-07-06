import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldAlert, Search } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { LaborAuditApi, EmployeeApi } from '@/lib/api'
import { laborPerms } from '@/lib/labor'
import type { Employee, LaborAuditLog } from '@/lib/types'

const ALL = '__all__'

function fmtDateTime(x?: string | null): string {
  if (!x) return '—'
  const d = new Date(x)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ja-JP')
}

function shortId(id?: string | null): string {
  if (!id) return ''
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

export default function LaborAudit() {
  const toast = useToast()
  const { role } = useAuth()
  const perms = laborPerms(role)

  const [logs, setLogs] = useState<LaborAuditLog[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState('')
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [audit, emps] = await Promise.all([
        LaborAuditApi.list(300),
        EmployeeApi.list(),
      ])
      setLogs(audit)
      setEmployees(emps)
    } catch (e) {
      console.error('[LaborAudit]', e)
      toast.error(e instanceof Error ? e.message : '監査ログの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { if (perms.canManage) load() }, [load, perms.canManage])

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const actions = useMemo(
    () => Array.from(new Set(logs.map((l) => l.action).filter(Boolean))).sort(),
    [logs],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return logs.filter((l) => {
      if (action && l.action !== action) return false
      if (q) {
        const hay = `${l.actor_name ?? ''} ${l.action ?? ''} ${l.target_table ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [logs, action, search])

  if (!isSupabaseConfigured) {
    return (
      <LaborLayout>
        <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Supabase が未設定です。
        </div>
      </LaborLayout>
    )
  }

  if (!perms.canManage) {
    return (
      <LaborLayout>
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <ShieldAlert className="h-5 w-5 shrink-0" />
            <div>
              <div className="font-bold">この画面の閲覧権限がありません</div>
              <p className="text-2xs">労務監査ログの閲覧には管理者または労務管理者権限が必要です。</p>
            </div>
          </div>
        </div>
      </LaborLayout>
    )
  }

  return (
    <LaborLayout>
      <div className="mx-auto max-w-5xl space-y-3">
        {/* ヘッダー */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">労務監査ログ</h1>
            <p className="text-2xs text-muted-foreground">打刻・承認・情報変更などの操作履歴</p>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />更新
          </Button>
        </div>

        {/* フィルター */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={action || ALL} onValueChange={(v) => setAction(v === ALL ? '' : v)}>
            <SelectTrigger className="h-8 w-40"><SelectValue placeholder="アクションすべて" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>アクションすべて</SelectItem>
              {actions.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="操作者・アクション・対象で検索"
              className="h-8 w-56 pl-7"
            />
          </div>
          <span className="text-2xs text-muted-foreground">{filtered.length} 件</span>
        </div>

        {/* テーブル */}
        <div className="rounded-xl border bg-card">
          <div className="border-b px-3 py-2 text-sm font-bold">操作履歴</div>
          {loading ? (
            <div className="p-3"><SkeletonRows count={10} /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">監査ログはまだありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-2xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">日時</th>
                    <th className="px-2 py-1.5 text-left font-medium">操作者</th>
                    <th className="px-2 py-1.5 text-left font-medium">アクション</th>
                    <th className="px-2 py-1.5 text-left font-medium">対象</th>
                    <th className="px-2 py-1.5 text-left font-medium">従業員</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => {
                    const open = expandedId === l.id
                    const empName = l.employee_id ? empMap.get(l.employee_id)?.name ?? '—' : '—'
                    return (
                      <Fragment key={l.id}>
                        <tr
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                          onClick={() => setExpandedId(open ? null : l.id)}
                        >
                          <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{fmtDateTime(l.created_at)}</td>
                          <td className="px-2 py-1.5 font-medium">{l.actor_name || '—'}</td>
                          <td className="px-2 py-1.5">
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{l.action}</span>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {l.target_table || '—'}
                            {l.target_id && <span className="ml-1 text-2xs opacity-70">#{shortId(l.target_id)}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{empName}</td>
                        </tr>
                        {open && (
                          <tr className="border-b last:border-0 bg-muted/30">
                            <td colSpan={5} className="px-3 py-2">
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div>
                                  <div className="mb-1 text-2xs font-bold text-muted-foreground">変更前 (before)</div>
                                  <pre className="text-2xs overflow-auto max-h-40 whitespace-pre-wrap rounded bg-background p-2">
                                    {l.before_data != null ? JSON.stringify(l.before_data, null, 2) : '—'}
                                  </pre>
                                </div>
                                <div>
                                  <div className="mb-1 text-2xs font-bold text-muted-foreground">変更後 (after)</div>
                                  <pre className="text-2xs overflow-auto max-h-40 whitespace-pre-wrap rounded bg-background p-2">
                                    {l.after_data != null ? JSON.stringify(l.after_data, null, 2) : '—'}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </LaborLayout>
  )
}

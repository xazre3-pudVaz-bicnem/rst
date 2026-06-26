import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import moment from 'moment'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Button } from '@/components/ui/button'
import { SkeletonRows } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { AuditApi } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient'
import type { AuditLog } from '@/lib/types'

const ACTION_LABELS: Record<string, string> = {
  create: '作成', update: '編集', delete: '削除', status_change: 'ステータス変更',
  import: 'CSV取込', bulk: '一括操作', recall_done: '再コール完了',
}
const ALL = '__all__'

export default function AuditLogPage() {
  const { isAdmin } = useAuth()
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [entity, setEntity] = useState('')
  const [action, setAction] = useState('')
  const liveRef = useRef(true)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      setLogs(await AuditApi.list(500))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Realtime: 新しい監査ログを先頭に追加
  useEffect(() => {
    if (!isSupabaseConfigured) return
    const channel = supabase
      .channel('audit_live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_logs' }, (payload) => {
        if (!liveRef.current) return
        const row = payload.new as AuditLog
        setLogs((prev) => [row, ...prev].slice(0, 1000))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const filtered = useMemo(
    () => logs.filter((l) => (!entity || l.entity === entity) && (!action || l.action === action)),
    [logs, entity, action],
  )

  const entities = useMemo(() => Array.from(new Set(logs.map((l) => l.entity))).sort(), [logs])
  const actions = useMemo(() => Array.from(new Set(logs.map((l) => l.action))).sort(), [logs])

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-4xl space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold">監査ログ</h1>
              <p className="text-2xs text-muted-foreground">
                重要操作の履歴をリアルタイムで表示します（作成/編集/削除/ステータス変更/取込/一括/再コール完了）
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" />更新</Button>
          </div>

          {!isAdmin && (
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-2xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              <ShieldAlert className="h-3.5 w-3.5" />
              監査ログは管理者向けの機能です（閲覧は可能ですが、運用上は管理者ロールの利用を推奨）。
            </div>
          )}

          {/* フィルター */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={entity || ALL} onValueChange={(v) => setEntity(v === ALL ? '' : v)}>
              <SelectTrigger className="h-8 w-36"><SelectValue placeholder="対象すべて" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>対象すべて</SelectItem>
                {entities.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={action || ALL} onValueChange={(v) => setAction(v === ALL ? '' : v)}>
              <SelectTrigger className="h-8 w-36"><SelectValue placeholder="操作すべて" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>操作すべて</SelectItem>
                {actions.map((a) => <SelectItem key={a} value={a}>{ACTION_LABELS[a] ?? a}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-2xs text-muted-foreground">{filtered.length} 件</span>
          </div>

          {!isSupabaseConfigured ? (
            <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">Supabase が未設定です。</div>
          ) : loading ? (
            <SkeletonRows count={8} />
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
              監査ログがありません。<br />
              <span className="text-2xs">（`audit_logs` テーブル未作成の場合は schema.sql / migration を適用してください）</span>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-2xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">日時</th>
                    <th className="p-2 text-left">操作</th>
                    <th className="p-2 text-left">対象</th>
                    <th className="p-2 text-left">詳細</th>
                    <th className="p-2 text-left">実行者</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id} className="border-t">
                      <td className="whitespace-nowrap p-2 text-muted-foreground">{moment(l.created_date).format('MM/DD HH:mm:ss')}</td>
                      <td className="p-2">
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{ACTION_LABELS[l.action] ?? l.action}</span>
                      </td>
                      <td className="p-2">{l.entity_name || l.entity}</td>
                      <td className="max-w-[280px] truncate p-2 text-muted-foreground">{l.detail}</td>
                      <td className="whitespace-nowrap p-2 text-muted-foreground">{l.actor_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

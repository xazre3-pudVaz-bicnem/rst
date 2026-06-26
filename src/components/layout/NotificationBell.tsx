import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import { Bell } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RecallApi } from '@/lib/api'
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient'
import { cn } from '@/lib/utils'
import type { Recall } from '@/lib/types'

export default function NotificationBell() {
  const navigate = useNavigate()
  const [recalls, setRecalls] = useState<Recall[]>([])
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try {
      setRecalls(await RecallApi.listAll())
    } catch (e) {
      console.warn('[Notify]', e)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Realtime: 再コール/案件の変化で再集計
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => { if (timer) clearTimeout(timer); timer = setTimeout(load, 500) }
    const channel = supabase
      .channel('notify_recalls')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recalls' }, refresh)
      .subscribe()
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
  }, [load])

  const { overdue, today, count } = useMemo(() => {
    const now = moment()
    const endToday = moment().endOf('day')
    const active = recalls.filter((r) => !r.done).sort((a, b) => a.target_at.localeCompare(b.target_at))
    const overdue = active.filter((r) => moment(r.target_at).isBefore(now))
    const today = active.filter((r) => {
      const t = moment(r.target_at)
      return t.isSameOrAfter(now) && t.isSameOrBefore(endToday)
    })
    return { overdue, today, count: overdue.length + today.length }
  }, [recalls])

  function go(r: Recall) {
    setOpen(false)
    navigate(`/?case=${r.case_id}`)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className="relative rounded p-1.5 text-muted-foreground hover:bg-accent" title="通知">
          <Bell className="h-4 w-4" />
          {count > 0 && (
            <span className={cn(
              'absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white',
              overdue.length > 0 ? 'bg-red-600' : 'bg-amber-500',
            )}>
              {count}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[60vh] w-72 overflow-y-auto p-0">
        <div className="border-b px-3 py-2 text-2xs font-bold">通知（要対応の再コール）</div>
        {count === 0 && (
          <div className="p-4 text-center text-2xs text-muted-foreground">対応が必要な再コールはありません 👍</div>
        )}
        {overdue.length > 0 && (
          <div>
            <div className="bg-red-50 px-3 py-1 text-[10px] font-bold text-red-700 dark:bg-red-500/15 dark:text-red-300">期限切れ（{overdue.length}）</div>
            {overdue.slice(0, 15).map((r) => (
              <button key={r.id} onClick={() => go(r)} className="block w-full border-b px-3 py-1.5 text-left hover:bg-accent">
                <div className="text-[10px] font-bold text-red-600">{moment(r.target_at).format('MM/DD HH:mm')}</div>
                <div className="truncate text-xs">{r.case_name}</div>
              </button>
            ))}
          </div>
        )}
        {today.length > 0 && (
          <div>
            <div className="bg-amber-50 px-3 py-1 text-[10px] font-bold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">今日（{today.length}）</div>
            {today.slice(0, 15).map((r) => (
              <button key={r.id} onClick={() => go(r)} className="block w-full border-b px-3 py-1.5 text-left hover:bg-accent">
                <div className="text-[10px] font-bold text-amber-700">{moment(r.target_at).format('HH:mm')}</div>
                <div className="truncate text-xs">{r.case_name}</div>
              </button>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

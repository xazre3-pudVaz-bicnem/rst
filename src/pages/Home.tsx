import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import {
  PhoneCall, CalendarClock, AlertTriangle, Clock, TrendingUp, Bell, BellRing, FileText, ChevronRight, Target,
} from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import TemplatesModal from '@/components/modals/TemplatesModal'
import { Button } from '@/components/ui/button'
import { SkeletonCards, SkeletonRows } from '@/components/ui/skeleton'
import { CaseApi, CallLogApi, RecallApi, AppointmentApi } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import {
  APPO_STATUSES, UNCALLED_STATUSES, PROSPECT_STATUSES, statusColor,
} from '@/lib/constants'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { cn } from '@/lib/utils'
import type { Appointment, Case, CallLog, Recall } from '@/lib/types'
import { TimeRexShare } from '@/components/TimeRex'

export default function Home() {
  const navigate = useNavigate()
  const { displayName } = useAuth()
  const [cases, setCases] = useState<Case[]>([])
  const [callLogs, setCallLogs] = useState<CallLog[]>([])
  const [recalls, setRecalls] = useState<Recall[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [showTemplates, setShowTemplates] = useState(false)
  const [goal, setGoal] = useState<number>(() => {
    const v = Number(localStorage.getItem('rst_daily_goal'))
    return v > 0 ? v : 30
  })
  const [notifyOn, setNotifyOn] = useState(() => localStorage.getItem('rst_desktop_notify') === '1')
  const notifiedRef = useRef(false)

  function updateGoal(v: number) {
    const n = Math.max(1, Math.min(999, Math.round(v)))
    setGoal(n)
    localStorage.setItem('rst_daily_goal', String(n))
  }

  async function toggleNotify() {
    if (notifyOn) {
      setNotifyOn(false)
      localStorage.removeItem('rst_desktop_notify')
      return
    }
    if (!('Notification' in window)) return
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    if (perm === 'granted') {
      setNotifyOn(true)
      localStorage.setItem('rst_desktop_notify', '1')
    }
  }

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const [c, l, r, a] = await Promise.all([
        CaseApi.listAll(), CallLogApi.listAll(), RecallApi.listAll(), AppointmentApi.list(1000),
      ])
      setCases(c); setCallLogs(l); setRecalls(r); setAppointments(a)
    } catch (e) {
      console.error('[Home]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const data = useMemo(() => {
    const now = moment()
    const endToday = moment().endOf('day')
    const startToday = moment().startOf('day')
    const caseById = new Map(cases.map((c) => [c.id, c]))

    const activeRecalls = recalls.filter((r) => !r.done)
    const overdueRecalls = activeRecalls.filter((r) => moment(r.target_at).isBefore(now))
    const todayRecalls = activeRecalls.filter((r) => {
      const t = moment(r.target_at)
      return t.isSameOrAfter(now) && t.isSameOrBefore(endToday)
    })

    const uncalled = cases.filter((c) => UNCALLED_STATUSES.includes(c.status as never))
    const todayCalls = callLogs.filter((l) => moment(l.call_at).isBetween(startToday, endToday, undefined, '[]'))
    const todayAppos = appointments.filter((a) => moment(a.appo_at).isBetween(startToday, endToday, undefined, '[]'))

    const recentUpdated = [...cases].sort((a, b) => b.updated_date.localeCompare(a.updated_date)).slice(0, 8)
    const myCases = cases.filter((c) => c.sales_rep === displayName)

    // 次に架電すべき: 期限切れ再コール → 今日再コール → 未架電（優先度高い順）
    const nextToCall: { case: Case; reason: string }[] = []
    const seen = new Set<string>()
    const pushCase = (cid: string, reason: string) => {
      const c = caseById.get(cid)
      if (c && !seen.has(cid)) { seen.add(cid); nextToCall.push({ case: c, reason }) }
    }
    overdueRecalls.forEach((r) => pushCase(r.case_id, '期限切れ再コール'))
    todayRecalls.forEach((r) => pushCase(r.case_id, '今日の再コール'))
    uncalled
      .sort((a, b) => (a.priority === '高' ? -1 : 1) - (b.priority === '高' ? -1 : 1))
      .slice(0, 10)
      .forEach((c) => pushCase(c.id, '未架電'))

    // 注意が必要: 長期未更新の見込み / アポ後7日以上更新なし
    const staleProspects = cases.filter(
      (c) => PROSPECT_STATUSES.includes(c.status as never) && moment(c.updated_date).isBefore(moment().subtract(7, 'days')),
    )
    const appoNoFollow = cases.filter(
      (c) => APPO_STATUSES.includes(c.status as never) && moment(c.updated_date).isBefore(moment().subtract(3, 'days')),
    )

    return {
      overdueRecalls, todayRecalls, uncalled, todayCalls, todayAppos,
      recentUpdated, myCases, nextToCall: nextToCall.slice(0, 12),
      staleProspects, appoNoFollow,
      todoCount: overdueRecalls.length + todayRecalls.length,
    }
  }, [cases, callLogs, recalls, appointments, displayName])

  // デスクトップ通知（期限切れ/今日の再コールがある場合に一度だけ）
  useEffect(() => {
    if (!notifyOn || loading || notifiedRef.current) return
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    const overdue = data.overdueRecalls.length
    const today = data.todayRecalls.length
    if (overdue + today === 0) return
    notifiedRef.current = true
    try {
      new Notification('RST CRM — 本日の再コール', {
        body: `期限切れ ${overdue} 件 / 今日 ${today} 件の再コールがあります`,
      })
    } catch { /* noop */ }
  }, [notifyOn, loading, data])

  const kpi = (icon: React.ReactNode, label: string, value: number, color: string, onClick?: () => void) => (
    <button
      onClick={onClick}
      className={cn('flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition-shadow hover:shadow-sm', onClick && 'cursor-pointer')}
    >
      <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', color)}>{icon}</div>
      <div>
        <div className="text-2xs text-muted-foreground">{label}</div>
        <div className="text-xl font-bold">{value}</div>
      </div>
    </button>
  )

  const caseRow = (c: Case, extra?: React.ReactNode) => (
    <button
      key={c.id}
      onClick={() => navigate(`/?case=${c.id}`)}
      className="flex w-full items-center gap-2 border-b px-2 py-1.5 text-left last:border-0 hover:bg-accent"
    >
      <span className={cn('shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-medium', statusColor(c.status))}>{c.status}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
      {extra}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  )

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        {!isSupabaseConfigured ? (
          <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            Supabase が未設定です。.env を設定するとダッシュボードが表示されます。
          </div>
        ) : loading ? (
          <div className="mx-auto max-w-6xl space-y-4">
            <SkeletonCards count={5} className="grid-cols-2 md:grid-cols-5" />
            <div className="grid gap-3 md:grid-cols-2">
              <SkeletonRows count={6} />
              <SkeletonRows count={6} />
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-6xl space-y-4">
            {/* 見出し */}
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-lg font-bold">こんにちは、{displayName} さん</h1>
                <p className="text-2xs text-muted-foreground">{moment().format('YYYY年M月D日 (ddd)')} の営業ダッシュボード</p>
              </div>
              <div className="flex gap-2">
                <Button variant={notifyOn ? 'default' : 'outline'} size="sm" onClick={toggleNotify} title="期限切れ再コールをデスクトップ通知">
                  {notifyOn ? <BellRing className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                  通知{notifyOn ? 'ON' : 'OFF'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowTemplates(true)}>
                  <FileText className="h-3.5 w-3.5" />定型文管理
                </Button>
                <Button size="sm" onClick={() => navigate('/')}>
                  <PhoneCall className="h-3.5 w-3.5" />架電を始める
                </Button>
              </div>
            </div>

            <TimeRexShare />

            {/* 本日の目標進捗 */}
            <div className="rounded-xl border bg-card p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-bold"><Target className="h-4 w-4 text-primary" />本日の架電目標</div>
                <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                  目標
                  <button className="rounded border px-1.5 hover:bg-accent" onClick={() => updateGoal(goal - 5)}>−</button>
                  <span className="w-8 text-center font-bold text-foreground">{goal}</span>
                  <button className="rounded border px-1.5 hover:bg-accent" onClick={() => updateGoal(goal + 5)}>＋</button>
                  件
                </div>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full transition-all', data.todayCalls.length >= goal ? 'bg-green-500' : 'bg-primary')}
                  style={{ width: `${Math.min(100, Math.round((data.todayCalls.length / goal) * 100))}%` }}
                />
              </div>
              <div className="mt-1 text-2xs text-muted-foreground">
                本日 <b className="text-foreground">{data.todayCalls.length}</b> / {goal} 件
                （{Math.min(100, Math.round((data.todayCalls.length / goal) * 100))}%）
                {data.todayCalls.length >= goal ? ' 🎉 目標達成！' : ` あと ${goal - data.todayCalls.length} 件`}
              </div>
            </div>

            {/* KPIカード */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              {kpi(<CalendarClock className="h-5 w-5 text-white" />, '今日やるべき', data.todoCount, 'bg-primary', () => navigate('/'))}
              {kpi(<AlertTriangle className="h-5 w-5 text-white" />, '期限切れ再コール', data.overdueRecalls.length, 'bg-red-500', () => navigate('/'))}
              {kpi(<Clock className="h-5 w-5 text-white" />, '未架電', data.uncalled.length, 'bg-slate-500', () => navigate('/'))}
              {kpi(<PhoneCall className="h-5 w-5 text-white" />, '本日の架電数', data.todayCalls.length, 'bg-green-600')}
              {kpi(<TrendingUp className="h-5 w-5 text-white" />, '本日のアポ数', data.todayAppos.length, 'bg-amber-500')}
            </div>

            {/* 通知・リマインド */}
            {(data.overdueRecalls.length > 0 || data.staleProspects.length > 0 || data.appoNoFollow.length > 0) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-amber-800 dark:text-amber-300">
                  <Bell className="h-4 w-4" />通知・リマインド
                </div>
                <div className="space-y-1 text-xs text-amber-900 dark:text-amber-200">
                  {data.overdueRecalls.length > 0 && <div>・期限切れの再コールが <b>{data.overdueRecalls.length}</b> 件あります</div>}
                  {data.todayRecalls.length > 0 && <div>・今日中の再コールが <b>{data.todayRecalls.length}</b> 件あります</div>}
                  {data.staleProspects.length > 0 && <div>・7日以上更新のない見込み案件が <b>{data.staleProspects.length}</b> 件あります</div>}
                  {data.appoNoFollow.length > 0 && <div>・アポ獲得後フォローのない案件が <b>{data.appoNoFollow.length}</b> 件あります</div>}
                </div>
              </div>
            )}

            {/* リスト群 */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border bg-card">
                <div className="border-b px-3 py-2 text-sm font-bold">次に架電すべき案件</div>
                <div className="max-h-72 overflow-y-auto">
                  {data.nextToCall.length === 0 && <div className="p-4 text-center text-xs text-muted-foreground">対象なし</div>}
                  {data.nextToCall.map(({ case: c, reason }) =>
                    caseRow(c, <span className="shrink-0 text-2xs text-muted-foreground">{reason}</span>),
                  )}
                </div>
              </div>

              <div className="rounded-xl border bg-card">
                <div className="border-b px-3 py-2 text-sm font-bold">自分の担当案件（{data.myCases.length}）</div>
                <div className="max-h-72 overflow-y-auto">
                  {data.myCases.length === 0 && <div className="p-4 text-center text-xs text-muted-foreground">担当案件はありません</div>}
                  {data.myCases.slice(0, 30).map((c) => caseRow(c, c.phone1 ? <span className="shrink-0 text-2xs text-muted-foreground">{c.phone1}</span> : undefined))}
                </div>
              </div>

              <div className="rounded-xl border bg-card">
                <div className="border-b px-3 py-2 text-sm font-bold">最近更新された案件</div>
                <div className="max-h-72 overflow-y-auto">
                  {data.recentUpdated.map((c) => caseRow(c, <span className="shrink-0 text-2xs text-muted-foreground">{moment(c.updated_date).format('MM/DD HH:mm')}</span>))}
                </div>
              </div>

              <div className="rounded-xl border bg-card">
                <div className="border-b px-3 py-2 text-sm font-bold">注意が必要な案件</div>
                <div className="max-h-72 overflow-y-auto">
                  {data.staleProspects.length === 0 && data.appoNoFollow.length === 0 && (
                    <div className="p-4 text-center text-xs text-muted-foreground">問題ありません 👍</div>
                  )}
                  {data.appoNoFollow.map((c) => caseRow(c, <span className="shrink-0 text-2xs text-red-600">アポ後未対応</span>))}
                  {data.staleProspects.map((c) => caseRow(c, <span className="shrink-0 text-2xs text-amber-700">長期未更新</span>))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <TemplatesModal open={showTemplates} onClose={() => setShowTemplates(false)} onChanged={() => {}} />
    </div>
  )
}

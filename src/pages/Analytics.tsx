import { useCallback, useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Radio, RefreshCw } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { SkeletonCards } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { AppointmentApi, CaseApi, CallLogApi, RecallApi, ProfileApi } from '@/lib/api'
import {
  DEAL_STATUSES, DOC_SENT_STATUSES, PROSPECT_STATUSES, LOST_STATUSES,
} from '@/lib/constants'
import { useAssignableUsers } from '@/hooks/useAssignableUsers'
import { isCall, isAnswered, isRepContact, pct } from '@/lib/kpi'
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient'
import { cn } from '@/lib/utils'
import type { Appointment, Case, CallLog, Profile, Recall } from '@/lib/types'

type Period = 'today' | 'week' | 'month' | 'year' | 'all'
const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '今週' },
  { value: 'month', label: '今月' },
  { value: 'year', label: '今年' },
  { value: 'all', label: '全期間' },
]
// 時間帯別集計の時間スロット（9時〜20時台）
const HOUR_SLOTS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
function rangeOf(p: Period): [moment.Moment, moment.Moment] {
  switch (p) {
    case 'today': return [moment().startOf('day'), moment().endOf('day')]
    case 'week': return [moment().startOf('week'), moment().endOf('week')]
    case 'month': return [moment().startOf('month'), moment().endOf('month')]
    case 'year': return [moment().startOf('year'), moment().endOf('year')]
    case 'all': return [moment('2000-01-01'), moment('2999-12-31')]
  }
}
function prefOf(address?: string | null): string {
  if (!address) return '不明'
  const m = address.match(/^(.+?[都道府県])/)
  return m ? m[1] : '不明'
}
const ALL = '__all__'

export default function Analytics() {
  const [callLogs, setCallLogs] = useState<CallLog[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [cases, setCases] = useState<Case[]>([])
  const [recalls, setRecalls] = useState<Recall[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('today')
  const [scope, setScope] = useState('') // '' = 全員
  const [updatedAt, setUpdatedAt] = useState(() => moment().format('HH:mm:ss'))
  const [live, setLive] = useState(false)
  const [hourMetric, setHourMetric] = useState<'call' | 'rep' | 'appo'>('call')
  const { names: assignableNames } = useAssignableUsers()

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    try {
      const [l, a, c, r, p] = await Promise.all([
        CallLogApi.listAll(), AppointmentApi.listAll(), CaseApi.listAll(), RecallApi.listAll(), ProfileApi.list(),
      ])
      setCallLogs(l); setAppointments(a); setCases(c); setRecalls(r); setProfiles(p)
      setUpdatedAt(moment().format('HH:mm:ss'))
    } catch (e) {
      console.error('[KPI]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // リアルタイム更新
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      setLive(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { load(); setTimeout(() => setLive(false), 1200) }, 500)
    }
    const ch = supabase
      .channel('kpi_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_logs' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recalls' }, refresh)
      .subscribe()
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(ch) }
  }, [load])

  // ---- 下ごしらえ ----
  const caseById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases])
  const profileName = useMemo(() => new Map(profiles.map((p) => [p.id, p.full_name || ''])), [profiles])
  const calls = useMemo(() => callLogs.filter(isCall), [callLogs])

  const callRep = useCallback(
    (l: CallLog) => l.sales_rep || caseById.get(l.case_id)?.sales_rep || '未割当',
    [caseById],
  )
  const caseCreator = useCallback(
    (c: Case) => profileName.get(c.created_by_id ?? '') || c.sales_rep || '未割当',
    [profileName],
  )

  // 全担当者（固定リスト＋データ上の担当を統合）
  const reps = useMemo(() => {
    // 営業担当プルダウンと同じ実名（ユーザー管理profiles）を基点にする。ダミーのSALES_REPSは使わない。
    const set = new Set<string>(assignableNames)
    calls.forEach((l) => set.add(callRep(l)))
    appointments.forEach((a) => a.sales_rep && set.add(a.sales_rep))
    cases.forEach((c) => set.add(caseCreator(c)))
    return [...set].filter(Boolean)
  }, [assignableNames, calls, appointments, cases, callRep, caseCreator])

  // ---- ペース（コール数の各時間窓） scope 対応 ----
  const pace = useMemo(() => {
    const inScope = (l: CallLog) => scope === '' || callRep(l) === scope
    const within = (l: CallLog, s: moment.Moment, e: moment.Moment) =>
      moment(l.call_at).isBetween(s, e, undefined, '[]')
    const cnt = (s: moment.Moment, e: moment.Moment) =>
      calls.filter((l) => inScope(l) && within(l, s, e)).length
    const now = moment()
    return {
      hour: cnt(moment().subtract(1, 'hour'), now),
      today: cnt(moment().startOf('day'), moment().endOf('day')),
      week: cnt(moment().startOf('week'), moment().endOf('week')),
      month: cnt(moment().startOf('month'), moment().endOf('month')),
      year: cnt(moment().startOf('year'), moment().endOf('year')),
    }
  }, [calls, scope, callRep])

  // ---- 期間 × 担当者ごとの集計テーブル ----
  const table = useMemo(() => {
    const [start, end] = rangeOf(period)
    const inR = (d: string) => moment(d).isBetween(start, end, undefined, '[]')

    const rows = reps.map((rep) => {
      const rc = calls.filter((l) => callRep(l) === rep && inR(l.call_at))
      const callN = rc.length
      const ansN = rc.filter(isAnswered).length
      const repN = rc.filter(isRepContact).length
      const appoList = appointments.filter((a) => a.sales_rep === rep && inR(a.appo_at))
      const appoN = appoList.length
      const convN = appoList.filter((a) => DEAL_STATUSES.includes((caseById.get(a.case_id ?? '')?.status ?? '') as never)).length
      const listN = cases.filter((c) => caseCreator(c) === rep && inR(c.created_date)).length
      return {
        rep, listN, callN, ansN, repN, appoN, convN,
        ansRate: pct(ansN, callN),
        repRate: pct(repN, callN),
        appoRate: pct(appoN, callN),
        appoFromRep: pct(appoN, repN),
        convRate: pct(convN, appoN),
      }
    }).filter((r) => r.listN + r.callN + r.appoN > 0)
      .sort((a, b) => b.callN - a.callN || b.appoN - a.appoN)

    const total = rows.reduce((t, r) => ({
      listN: t.listN + r.listN, callN: t.callN + r.callN, ansN: t.ansN + r.ansN,
      repN: t.repN + r.repN, appoN: t.appoN + r.appoN, convN: t.convN + r.convN,
    }), { listN: 0, callN: 0, ansN: 0, repN: 0, appoN: 0, convN: 0 })

    return { rows, total }
  }, [reps, calls, appointments, cases, period, callRep, caseCreator, caseById])

  // ---- 時間帯別（担当者 × 9〜20時台）: コール/代表接触/アポ ----
  const hourlyByRep = useMemo(() => {
    const [start, end] = rangeOf(period)
    const inR = (d: string) => moment(d).isBetween(start, end, undefined, '[]')
    const blank = () => HOUR_SLOTS.reduce((o, h) => { o[h] = { call: 0, rep: 0, appo: 0 }; return o }, {} as Record<number, { call: number; rep: number; appo: number }>)
    const byRep = new Map<string, Record<number, { call: number; rep: number; appo: number }>>()
    const ensure = (rep: string) => { let r = byRep.get(rep); if (!r) { r = blank(); byRep.set(rep, r) } return r }
    for (const l of calls) {
      if (!inR(l.call_at)) continue
      const h = moment(l.call_at).hour(); if (h < 9 || h > 20) continue
      const cell = ensure(callRep(l))[h]; cell.call++; if (isRepContact(l)) cell.rep++
    }
    for (const a of appointments) {
      if (!a.appo_at || !inR(a.appo_at)) continue
      const h = moment(a.appo_at).hour(); if (h < 9 || h > 20) continue
      ensure(a.sales_rep || '未割当')[h].appo++
    }
    const rows = [...byRep.entries()].map(([rep, hrs]) => {
      const tot = HOUR_SLOTS.reduce((t, h) => ({ call: t.call + hrs[h].call, rep: t.rep + hrs[h].rep, appo: t.appo + hrs[h].appo }), { call: 0, rep: 0, appo: 0 })
      return { rep, hrs, tot }
    }).filter((r) => r.tot.call + r.tot.appo > 0).sort((a, b) => b.tot.call - a.tot.call || b.tot.appo - a.tot.appo)
    const colTot = blank(); const grand = { call: 0, rep: 0, appo: 0 }
    for (const r of rows) for (const h of HOUR_SLOTS) { colTot[h].call += r.hrs[h].call; colTot[h].rep += r.hrs[h].rep; colTot[h].appo += r.hrs[h].appo }
    for (const h of HOUR_SLOTS) { grand.call += colTot[h].call; grand.rep += colTot[h].rep; grand.appo += colTot[h].appo }
    return { rows, colTot, grand }
  }, [calls, appointments, period, callRep])

  // ---- 選択スコープのファネル（期間） ----
  const scopeStats = useMemo(() => {
    if (scope === '') return { ...table.total }
    const r = table.rows.find((x) => x.rep === scope)
    return r ? { listN: r.listN, callN: r.callN, ansN: r.ansN, repN: r.repN, appoN: r.appoN, convN: r.convN }
      : { listN: 0, callN: 0, ansN: 0, repN: 0, appoN: 0, convN: 0 }
  }, [scope, table])

  // ---- 時間帯別コール（本日・scope） ----
  const hourly = useMemo(() => {
    const arr = Array.from({ length: 24 }, (_, h) => ({ h: `${h}`, count: 0 }))
    const s = moment().startOf('day'), e = moment().endOf('day')
    calls.forEach((l) => {
      if (scope !== '' && callRep(l) !== scope) return
      if (!moment(l.call_at).isBetween(s, e, undefined, '[]')) return
      arr[moment(l.call_at).hour()].count++
    })
    return arr
  }, [calls, scope, callRep])

  // ---- 日別推移（範囲内・直近最大60日・scope） ----
  const daily = useMemo(() => {
    const [start, end] = rangeOf(period)
    const from = moment.max(start, moment().subtract(59, 'days').startOf('day'))
    const to = moment.min(end, moment().endOf('day'))
    const days: { d: string; count: number }[] = []
    const key = new Map<string, number>()
    for (let m = from.clone(); m.isSameOrBefore(to, 'day'); m.add(1, 'day')) {
      const k = m.format('MM/DD'); key.set(k, days.length); days.push({ d: k, count: 0 })
    }
    calls.forEach((l) => {
      if (scope !== '' && callRep(l) !== scope) return
      const k = moment(l.call_at).format('MM/DD')
      const i = key.get(k)
      if (i !== undefined && moment(l.call_at).isBetween(from, to, undefined, '[]')) days[i].count++
    })
    return days
  }, [calls, period, scope, callRep])

  // ---- 業種別 / エリア別 アポ率（現ステータスベース） ----
  const breakdowns = useMemo(() => {
    const byInd = new Map<string, { total: number; appo: number }>()
    const byArea = new Map<string, { total: number; appo: number }>()
    for (const c of cases) {
      if (scope !== '' && c.sales_rep !== scope) continue
      const isAppo = DEAL_STATUSES.includes(c.status as never) || c.status === 'アポ獲得' || c.status === 'アポ'
      const gi = byInd.get(c.industry || '未分類') ?? { total: 0, appo: 0 }
      gi.total++; if (isAppo) gi.appo++; byInd.set(c.industry || '未分類', gi)
      const a = prefOf(c.address)
      const ga = byArea.get(a) ?? { total: 0, appo: 0 }
      ga.total++; if (isAppo) ga.appo++; byArea.set(a, ga)
    }
    const mk = (m: Map<string, { total: number; appo: number }>, limit?: number) =>
      [...m.entries()].map(([k, v]) => ({ key: k, total: v.total, appo: v.appo, rate: pct(v.appo, v.total) }))
        .sort((a, b) => b.rate - a.rate || b.total - a.total).slice(0, limit)
    return { industry: mk(byInd), area: mk(byArea, 12) }
  }, [cases, scope])

  // 案件サマリ（scope）
  const caseSummary = useMemo(() => {
    const list = scope === '' ? cases : cases.filter((c) => c.sales_rep === scope)
    return {
      total: list.length,
      docSent: list.filter((c) => DOC_SENT_STATUSES.includes(c.status as never)).length,
      prospect: list.filter((c) => PROSPECT_STATUSES.includes(c.status as never)).length,
      lost: list.filter((c) => LOST_STATUSES.includes(c.status as never)).length,
      recallRemain: recalls.filter((r) => !r.done && (scope === '' || caseById.get(r.case_id)?.sales_rep === scope)).length,
      recallOverdue: recalls.filter((r) => !r.done && moment(r.target_at).isBefore(moment()) && (scope === '' || caseById.get(r.case_id)?.sales_rep === scope)).length,
    }
  }, [cases, recalls, scope, caseById])

  const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? ''
  const scopeLabel = scope === '' ? '全員' : scope

  const card = (label: string, value: number | string, color: string, sub?: string) => (
    <div className="rounded-xl border bg-card p-3">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={cn('text-2xl font-bold', color)}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )

  const funnelStages = [
    { label: 'コール', value: scopeStats.callN, color: 'bg-blue-500' },
    { label: '接続', value: scopeStats.ansN, color: 'bg-cyan-500' },
    { label: '代表接触', value: scopeStats.repN, color: 'bg-teal-500' },
    { label: 'アポ', value: scopeStats.appoN, color: 'bg-amber-500' },
    { label: '行動転換', value: scopeStats.convN, color: 'bg-emerald-500' },
  ]
  const funnelMax = Math.max(1, scopeStats.callN)

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        {/* コントロール */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                className={cn('rounded px-3 py-1 text-xs', period === p.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
                onClick={() => setPeriod(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Select value={scope || ALL} onValueChange={(v) => setScope(v === ALL ? '' : v)}>
            <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全員</SelectItem>
              {reps.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]', live ? 'bg-green-500/15 text-green-600' : 'bg-muted text-muted-foreground')}>
            <Radio className={cn('h-3 w-3', live && 'animate-pulse')} />
            {live ? '更新中' : 'リアルタイム'} ・ {updatedAt}
          </div>
          <button className="ml-auto flex items-center gap-1 rounded border px-2 py-1 text-2xs text-muted-foreground hover:bg-accent" onClick={load}>
            <RefreshCw className="h-3 w-3" />更新
          </button>
        </div>

        {loading ? (
          <div className="space-y-3">
            <SkeletonCards count={5} className="grid-cols-2 md:grid-cols-5" />
            <SkeletonCards count={6} className="grid-cols-2 md:grid-cols-6" />
            <div className="h-64 animate-pulse rounded-xl border bg-muted" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* ペース：コール数の各時間窓 */}
            <div>
              <div className="mb-1 text-xs font-bold">コール数ペース（{scopeLabel}）</div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                {card('直近1時間', pace.hour, 'text-primary', '件/時')}
                {card('本日', pace.today, 'text-primary')}
                {card('今週', pace.week, 'text-primary')}
                {card('今月', pace.month, 'text-primary')}
                {card('今年', pace.year, 'text-primary')}
              </div>
            </div>

            {/* ファネル（期間×scope） */}
            <div className="rounded-xl border bg-card p-3">
              <div className="mb-2 text-xs font-bold">コールファネル（{scopeLabel} ・ {periodLabel}）</div>
              <div className="space-y-1.5">
                {funnelStages.map((s, i) => {
                  const prev = i === 0 ? s.value : funnelStages[i - 1].value
                  return (
                    <div key={s.label} className="flex items-center gap-2">
                      <div className="w-16 shrink-0 text-2xs text-muted-foreground">{s.label}</div>
                      <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                        <div className={cn('flex h-full items-center justify-end rounded px-2 text-[10px] font-bold text-white', s.color)} style={{ width: `${Math.max(4, (s.value / funnelMax) * 100)}%` }}>
                          {s.value}
                        </div>
                      </div>
                      <div className="w-14 shrink-0 text-right text-2xs text-muted-foreground">
                        {i === 0 ? '—' : `${pct(s.value, prev)}%`}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">右端＝前段からの転換率（コール→接続→代表接触→アポ→行動転換）</div>
            </div>

            {/* 主要KPIカード（期間×scope） */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
              {card('リスト作成', scopeStats.listN, 'text-indigo-600')}
              {card('コール数', scopeStats.callN, 'text-blue-600')}
              {card('接続数', scopeStats.ansN, 'text-cyan-600', `接続率 ${pct(scopeStats.ansN, scopeStats.callN)}%`)}
              {card('代表接触', scopeStats.repN, 'text-teal-600', `接触率 ${pct(scopeStats.repN, scopeStats.callN)}%`)}
              {card('アポ数', scopeStats.appoN, 'text-amber-600', `アポ率 ${pct(scopeStats.appoN, scopeStats.callN)}%`)}
              {card('行動転換', scopeStats.convN, 'text-emerald-600', `転換率 ${pct(scopeStats.convN, scopeStats.appoN)}%`)}
              {card('代表接触→アポ', `${pct(scopeStats.appoN, scopeStats.repN)}%`, 'text-amber-600', '有効商談率')}
            </div>

            {/* 案件サマリ */}
            <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
              {card('保有案件', caseSummary.total, 'text-slate-700')}
              {card('資料送付', caseSummary.docSent, 'text-sky-600')}
              {card('見込み', caseSummary.prospect, 'text-green-600')}
              {card('失注', caseSummary.lost, 'text-rose-600')}
              {card('再コール残', caseSummary.recallRemain, 'text-orange-600')}
              {card('期限切れ再コール', caseSummary.recallOverdue, 'text-red-600')}
            </div>

            {/* 時間帯別 / 日別 */}
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border bg-card p-3">
                <div className="mb-2 text-xs font-bold">時間帯別コール（本日 ・ {scopeLabel}）</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={hourly}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="h" tick={{ fontSize: 9 }} interval={1} />
                    <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
                    <Tooltip wrapperStyle={{ fontSize: 11 }} labelFormatter={(h) => `${h}時台`} />
                    <Bar dataKey="count" name="コール" fill="#2563eb" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="rounded-xl border bg-card p-3">
                <div className="mb-2 text-xs font-bold">日別コール推移（{scopeLabel}）</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={daily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="d" tick={{ fontSize: 9 }} interval={Math.max(0, Math.floor(daily.length / 12))} />
                    <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
                    <Tooltip wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="count" name="コール" fill="#0ea5e9" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 担当者別 詳細テーブル */}
            <div className="overflow-x-auto rounded-xl border bg-card p-3">
              <div className="mb-2 text-xs font-bold">担当者別 詳細（{periodLabel}）</div>
              <table className="w-full min-w-[760px] text-2xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-1 text-left">担当者</th>
                    <th className="py-1 text-right">リスト作成</th>
                    <th className="py-1 text-right">コール</th>
                    <th className="py-1 text-right">接続</th>
                    <th className="py-1 text-right">接続率</th>
                    <th className="py-1 text-right">代表接触</th>
                    <th className="py-1 text-right">接触率</th>
                    <th className="py-1 text-right">アポ</th>
                    <th className="py-1 text-right">アポ率</th>
                    <th className="py-1 text-right">行動転換</th>
                    <th className="py-1 text-right">転換率</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.length === 0 && (
                    <tr><td colSpan={11} className="py-4 text-center text-muted-foreground">この期間の実績はありません</td></tr>
                  )}
                  {table.rows.map((r) => (
                    <tr key={r.rep} className={cn('border-b last:border-0', scope === r.rep && 'bg-primary/5')}>
                      <td className="py-1 font-medium">{r.rep}</td>
                      <td className="py-1 text-right">{r.listN}</td>
                      <td className="py-1 text-right font-bold text-blue-600">{r.callN}</td>
                      <td className="py-1 text-right">{r.ansN}</td>
                      <td className="py-1 text-right text-muted-foreground">{r.ansRate}%</td>
                      <td className="py-1 text-right">{r.repN}</td>
                      <td className="py-1 text-right text-muted-foreground">{r.repRate}%</td>
                      <td className="py-1 text-right font-bold text-amber-600">{r.appoN}</td>
                      <td className="py-1 text-right text-muted-foreground">{r.appoRate}%</td>
                      <td className="py-1 text-right text-emerald-600">{r.convN}</td>
                      <td className="py-1 text-right text-muted-foreground">{r.convRate}%</td>
                    </tr>
                  ))}
                  {table.rows.length > 0 && (
                    <tr className="border-t-2 font-bold">
                      <td className="py-1">合計</td>
                      <td className="py-1 text-right">{table.total.listN}</td>
                      <td className="py-1 text-right">{table.total.callN}</td>
                      <td className="py-1 text-right">{table.total.ansN}</td>
                      <td className="py-1 text-right">{pct(table.total.ansN, table.total.callN)}%</td>
                      <td className="py-1 text-right">{table.total.repN}</td>
                      <td className="py-1 text-right">{pct(table.total.repN, table.total.callN)}%</td>
                      <td className="py-1 text-right">{table.total.appoN}</td>
                      <td className="py-1 text-right">{pct(table.total.appoN, table.total.callN)}%</td>
                      <td className="py-1 text-right">{table.total.convN}</td>
                      <td className="py-1 text-right">{pct(table.total.convN, table.total.appoN)}%</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* 時間帯別（担当者 × 9〜20時台） */}
            <div className="overflow-x-auto rounded-xl border bg-card p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-bold">時間帯別 担当者実績（{periodLabel}）</span>
                <div className="flex gap-1">
                  {([['call', 'コール'], ['rep', '代表接触'], ['appo', 'アポ']] as const).map(([k, lbl]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setHourMetric(k)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-2xs',
                        hourMetric === k ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <span className="text-2xs text-muted-foreground">（{hourMetric === 'call' ? 'コール数' : hourMetric === 'rep' ? '代表接触数' : 'アポ数'}・9〜20時台）</span>
              </div>
              <table className="w-full min-w-[820px] text-2xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-1 pr-2 text-left">担当者</th>
                    {HOUR_SLOTS.map((h) => <th key={h} className="py-1 px-1 text-right tabular-nums">{h}時</th>)}
                    <th className="py-1 pl-2 text-right">計</th>
                  </tr>
                </thead>
                <tbody>
                  {hourlyByRep.rows.length === 0 && (
                    <tr><td colSpan={HOUR_SLOTS.length + 2} className="py-4 text-center text-muted-foreground">この期間の実績はありません</td></tr>
                  )}
                  {hourlyByRep.rows.map((r) => (
                    <tr key={r.rep} className={cn('border-b last:border-0', scope === r.rep && 'bg-primary/5')}>
                      <td className="py-1 pr-2 font-medium">{r.rep}</td>
                      {HOUR_SLOTS.map((h) => {
                        const v = r.hrs[h][hourMetric]
                        return <td key={h} className={cn('py-1 px-1 text-right tabular-nums', v === 0 ? 'text-muted-foreground/40' : hourMetric === 'appo' ? 'font-bold text-amber-600' : hourMetric === 'call' ? 'font-medium text-blue-600' : '')}>{v || '·'}</td>
                      })}
                      <td className="py-1 pl-2 text-right font-bold tabular-nums">{r.tot[hourMetric]}</td>
                    </tr>
                  ))}
                  {hourlyByRep.rows.length > 0 && (
                    <tr className="border-t-2 font-bold">
                      <td className="py-1 pr-2">合計</td>
                      {HOUR_SLOTS.map((h) => <td key={h} className="py-1 px-1 text-right tabular-nums">{hourlyByRep.colTot[h][hourMetric] || '·'}</td>)}
                      <td className="py-1 pl-2 text-right tabular-nums">{hourlyByRep.grand[hourMetric]}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* 業種別 / エリア別 アポ率 */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border bg-card p-3">
                <div className="mb-2 text-xs font-bold">業種別 アポ率（{scopeLabel}）</div>
                <RateBars rows={breakdowns.industry} />
              </div>
              <div className="rounded-xl border bg-card p-3">
                <div className="mb-2 text-xs font-bold">エリア別 アポ率（上位12 ・ {scopeLabel}）</div>
                <RateBars rows={breakdowns.area} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RateBars({ rows }: { rows: { key: string; total: number; appo: number; rate: number }[] }) {
  if (rows.length === 0) return <div className="text-2xs text-muted-foreground">データなし</div>
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <div className="w-24 shrink-0 truncate text-2xs">{r.key}</div>
          <div className="h-3.5 flex-1 overflow-hidden rounded bg-muted">
            <div className="h-full rounded bg-primary" style={{ width: `${Math.min(r.rate, 100)}%` }} />
          </div>
          <div className="w-20 shrink-0 text-right text-2xs text-muted-foreground">{r.rate}% ({r.appo}/{r.total})</div>
        </div>
      ))}
    </div>
  )
}

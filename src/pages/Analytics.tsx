import { useCallback, useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import TopBar from '@/components/layout/TopBar'
import { AppointmentApi, CaseApi, CallLogApi } from '@/lib/api'
import { DEAL_STATUSES, SALES_REPS } from '@/lib/constants'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import type { Appointment, Case, CallLog } from '@/lib/types'

type Period = 'today' | 'week' | 'month' | 'all'

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '今週' },
  { value: 'month', label: '今月' },
  { value: 'all', label: '全期間' },
]

function rangeOf(period: Period): [moment.Moment, moment.Moment] {
  switch (period) {
    case 'today':
      return [moment().startOf('day'), moment().endOf('day')]
    case 'week':
      return [moment().startOf('week'), moment().endOf('week')]
    case 'month':
      return [moment().startOf('month'), moment().endOf('month')]
    case 'all':
      return [moment('2000-01-01'), moment('2999-12-31')]
  }
}

export default function Analytics() {
  const [callLogs, setCallLogs] = useState<CallLog[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [cases, setCases] = useState<Case[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [l, a, c] = await Promise.all([
        CallLogApi.list(2000),
        AppointmentApi.list(1000),
        CaseApi.list(1000),
      ])
      setCallLogs(l)
      setAppointments(a)
      setCases(c)
    } catch (e) {
      console.error('[Analytics]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const stats = useMemo(() => {
    const [start, end] = rangeOf(period)
    const caseById = new Map(cases.map((c) => [c.id, c]))

    const rows = SALES_REPS.map((rep) => {
      const calls = callLogs.filter((l) => {
        const c = caseById.get(l.case_id)
        return (
          c?.sales_rep === rep &&
          moment(l.call_at).isBetween(start, end, undefined, '[]')
        )
      })
      const callCount = calls.length
      const contactCount = calls.filter((l) => l.contact_type === '接触').length
      const appoCount = appointments.filter(
        (a) =>
          a.sales_rep === rep &&
          moment(a.appo_at).isBetween(start, end, undefined, '[]'),
      ).length
      const dealCount = cases.filter(
        (c) => c.sales_rep === rep && DEAL_STATUSES.includes(c.status as never),
      ).length

      return {
        rep,
        calls: callCount,
        contacts: contactCount,
        contactRate: callCount > 0 ? Math.round((contactCount / callCount) * 100) : 0,
        appos: appoCount,
        appoRate: contactCount > 0 ? Math.round((appoCount / contactCount) * 100) : 0,
        deals: dealCount,
      }
    })

    const total = rows.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        contacts: acc.contacts + r.contacts,
        appos: acc.appos + r.appos,
        deals: acc.deals + r.deals,
      }),
      { calls: 0, contacts: 0, appos: 0, deals: 0 },
    )

    return { rows, total }
  }, [callLogs, appointments, cases, period])

  const card = (label: string, value: number, color: string) => (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )

  return (
    <div className="flex h-screen flex-col">
      <TopBar />

      <div className="flex-1 overflow-y-auto p-3">
        {/* 期間切替 */}
        <div className="mb-3 flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              className={`rounded px-3 py-1 text-xs ${
                period === p.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-muted-foreground">読み込み中...</div>
        ) : (
          <>
            {/* KPIカード */}
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              {card('総架電数', stats.total.calls, 'text-primary')}
              {card('総接触数', stats.total.contacts, 'text-green-600')}
              {card('総アポ数', stats.total.appos, 'text-amber-600')}
              {card('総成約数', stats.total.deals, 'text-rose-600')}
            </div>

            {/* グラフ */}
            <div className="mb-4 rounded-lg border bg-card p-3">
              <div className="mb-2 text-xs font-bold">担当者別 実績</div>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={stats.rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="rep" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip wrapperStyle={{ fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="calls" name="架電" fill="#2563eb" />
                  <Bar dataKey="contacts" name="接触" fill="#16a34a" />
                  <Bar dataKey="appos" name="アポ" fill="#d97706" />
                  <Bar dataKey="deals" name="成約" fill="#e11d48" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* 詳細テーブル */}
            <div className="rounded-lg border bg-card p-3">
              <div className="mb-2 text-xs font-bold">担当者別 詳細</div>
              <table className="w-full text-2xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-1 text-left">担当者</th>
                    <th className="py-1 text-right">架電数</th>
                    <th className="py-1 text-right">接触数</th>
                    <th className="py-1 text-right">接触率</th>
                    <th className="py-1 text-right">アポ数</th>
                    <th className="py-1 text-right">アポ率</th>
                    <th className="py-1 text-right">成約数</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.rows.map((r) => (
                    <tr key={r.rep} className="border-b last:border-0">
                      <td className="py-1">{r.rep}</td>
                      <td className="py-1 text-right">{r.calls}</td>
                      <td className="py-1 text-right">{r.contacts}</td>
                      <td className="py-1 text-right">{r.contactRate}%</td>
                      <td className="py-1 text-right">{r.appos}</td>
                      <td className="py-1 text-right">{r.appoRate}%</td>
                      <td className="py-1 text-right">{r.deals}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 font-bold">
                    <td className="py-1">合計</td>
                    <td className="py-1 text-right">{stats.total.calls}</td>
                    <td className="py-1 text-right">{stats.total.contacts}</td>
                    <td className="py-1 text-right">
                      {stats.total.calls > 0
                        ? Math.round((stats.total.contacts / stats.total.calls) * 100)
                        : 0}
                      %
                    </td>
                    <td className="py-1 text-right">{stats.total.appos}</td>
                    <td className="py-1 text-right">
                      {stats.total.contacts > 0
                        ? Math.round((stats.total.appos / stats.total.contacts) * 100)
                        : 0}
                      %
                    </td>
                    <td className="py-1 text-right">{stats.total.deals}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

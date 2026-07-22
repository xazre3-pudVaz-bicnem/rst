import { useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import { BarChart3 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { CaseApi, CallLogApi, AppointmentApi } from '@/lib/api'
import { isCall } from '@/lib/kpi'
import { SALES_REPS } from '@/lib/constants'
import type { Appointment, Case, CallLog } from '@/lib/types'

type Period = 'month' | 'day'

interface RepKpi {
  rep: string
  calls: number
  contacts: number
  appos: number
}

export default function KpiBar() {
  const [open, setOpen] = useState(false)
  const [period, setPeriod] = useState<Period>('month')
  const [cases, setCases] = useState<Case[]>([])
  const [callLogs, setCallLogs] = useState<CallLog[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!open || loaded) return
    Promise.all([CaseApi.list(1000), CallLogApi.list(2000), AppointmentApi.list(1000)])
      .then(([c, l, a]) => {
        setCases(c)
        setCallLogs(l)
        setAppointments(a)
        setLoaded(true)
      })
      .catch((e) => console.error('[KPI]', e))
  }, [open, loaded])

  const rows = useMemo<RepKpi[]>(() => {
    const start =
      period === 'month'
        ? moment().startOf('month')
        : moment().startOf('day')
    const end = period === 'month' ? moment().endOf('month') : moment().endOf('day')

    const caseById = new Map(cases.map((c) => [c.id, c]))

    return SALES_REPS.map((rep) => {
      // ログの sales_rep、無ければ案件の担当で判定
      const logs = callLogs.filter((l) => {
        if (!moment(l.call_at).isBetween(start, end, undefined, '[]')) return false
        if (l.sales_rep) return l.sales_rep === rep
        return caseById.get(l.case_id)?.sales_rep === rep
      })
      // 実際の架電のみ（ステータス変更ログ・再コール完了・通話メモは除外）。不在・接触は含む
      const calls = logs.filter(isCall).length
      const contacts = logs.filter((l) => l.contact_type === '接触').length
      const appos = appointments.filter(
        (a) =>
          a.sales_rep === rep &&
          a.case_id && // 案件なしの予定（社内MTG等）はKPIのアポに含めない
          moment(a.appo_at).isBetween(start, end, undefined, '[]'),
      ).length

      return { rep, calls, contacts, appos }
    })
  }, [cases, callLogs, appointments, period])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1">
          <BarChart3 className="h-3.5 w-3.5" />
          KPI
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[320px] p-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-2xs font-bold">担当者別KPI</span>
          <div className="flex gap-1">
            <button
              className={`rounded px-2 py-0.5 text-2xs ${period === 'month' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              onClick={() => setPeriod('month')}
            >
              月次
            </button>
            <button
              className={`rounded px-2 py-0.5 text-2xs ${period === 'day' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              onClick={() => setPeriod('day')}
            >
              日次
            </button>
          </div>
        </div>
        <table className="w-full text-2xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-1 text-left">担当</th>
              <th className="py-1 text-right">コール</th>
              <th className="py-1 text-right">代表接触</th>
              <th className="py-1 text-right">アポ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rep} className="border-b last:border-0">
                <td className="py-1">{r.rep}</td>
                <td className="py-1 text-right">{r.calls}</td>
                <td className="py-1 text-right">{r.contacts}</td>
                <td className="py-1 text-right font-bold text-primary">{r.appos}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-1 text-[9px] text-muted-foreground">
          ※コール・代表接触数はアポ案件のログから集計
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

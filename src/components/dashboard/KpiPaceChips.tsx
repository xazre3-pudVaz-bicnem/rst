import { useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import { AppointmentApi, VisitReportApi, KpiTargetApi } from '@/lib/api'
import {
  KPI_METRICS, monthKey, kpiActuals, paceTarget, findTarget, targetCounts,
} from '@/lib/kpi'
import { cn } from '@/lib/utils'
import type { Appointment, Case, CallLog, VisitReport, KpiTarget } from '@/lib/types'

interface Props {
  callLogs: CallLog[]
  cases: Case[]
  /** 表示対象の担当。'' なら全体。 */
  salesRep: string
}

/**
 * スマホ連動バー右側に置く、当月のKPIペース表示。
 * 各指標を「当月実績 / その日までに必要な数（ペース）」で表示する。
 */
export default function KpiPaceChips({ callLogs, cases, salesRep }: Props) {
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [visitReports, setVisitReports] = useState<VisitReport[]>([])
  const [targets, setTargets] = useState<KpiTarget[]>([])
  const month = monthKey()

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [a, v, t] = await Promise.all([
          AppointmentApi.list(1000),
          VisitReportApi.listAll(),
          KpiTargetApi.listByMonth(month),
        ])
        if (!alive) return
        setAppointments(a); setVisitReports(v); setTargets(t)
      } catch { /* バーの補助表示なので失敗しても黙って空 */ }
    })()
    return () => { alive = false }
  }, [month])

  const rows = useMemo(() => {
    const caseById = new Map(cases.map((c) => [c.id, c]))
    const actual = kpiActuals(month, salesRep, { callLogs, appointments, visitReports, caseById }, moment())
    const target = targetCounts(findTarget(targets, salesRep))
    return KPI_METRICS.map((m) => ({
      key: m.key,
      label: m.label,
      actual: actual[m.key],
      pace: paceTarget(target[m.key], month),
      monthly: target[m.key],
    }))
  }, [cases, callLogs, appointments, visitReports, targets, salesRep, month])

  // 目標が全く設定されていなければ非表示
  if (rows.every((r) => r.monthly === 0)) return null

  return (
    <div className="ml-auto flex items-center gap-1.5">
      <span className="text-[9px] text-muted-foreground">今月ペース</span>
      {rows.map((r) => {
        const ok = r.actual >= r.pace
        return (
          <span
            key={r.key}
            title={`${r.label}: 当月 ${r.actual} / 今日までに必要 ${r.pace}（月間目標 ${r.monthly}）`}
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
              r.monthly === 0
                ? 'bg-muted text-muted-foreground'
                : ok
                  ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
            )}
          >
            {r.label} <b>{r.actual}</b>/{r.pace}
          </span>
        )
      })}
    </div>
  )
}

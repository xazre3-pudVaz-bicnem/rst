import { useCallback, useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import { Target, ChevronLeft, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { jpError } from '@/lib/utils'
import { VisitReportApi, KpiTargetApi } from '@/lib/api'
import {
  KPI_METRICS, monthKey, dailyTarget, paceTarget, findTarget, kpiActuals,
  type KpiMetricKey,
} from '@/lib/kpi'
import { cn } from '@/lib/utils'
import type { Appointment, Case, CallLog, VisitReport, KpiTarget } from '@/lib/types'

interface Props {
  cases: Case[]
  callLogs: CallLog[]
  appointments: Appointment[]
  assignableNames: string[]
  canWrite?: boolean
}

const OVERALL = '' // 全体行の sales_rep

/** 月次KPI目標（コール/アポ/行動/契約）の設定＋当月ペース表示。全体と営業マン毎。 */
export default function KpiTargetPanel({ cases, callLogs, appointments, assignableNames, canWrite = true }: Props) {
  const toast = useToast()
  const [month, setMonth] = useState(() => monthKey())
  const [metric, setMetric] = useState<KpiMetricKey>('call')
  const [targets, setTargets] = useState<KpiTarget[]>([])
  const [visitReports, setVisitReports] = useState<VisitReport[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const year = Number(month.slice(0, 4))
  const metricDef = KPI_METRICS.find((m) => m.key === metric)!
  const targetKey = metricDef.targetKey

  const loadTargets = useCallback(async () => {
    try { setTargets(await KpiTargetApi.listByMonth(month)) } catch { setTargets([]) }
  }, [month])

  useEffect(() => { loadTargets() }, [loadTargets])
  useEffect(() => {
    let alive = true
    VisitReportApi.listAll().then((v) => { if (alive) setVisitReports(v) }).catch(() => { /* noop */ })
    return () => { alive = false }
  }, [])

  // 選択中メトリクスの入力ドラフトを targets から初期化（月・メトリクス切替時）
  useEffect(() => {
    const next: Record<string, string> = {}
    for (const rep of [OVERALL, ...assignableNames]) {
      const v = (findTarget(targets, rep) as any)[targetKey] as number
      next[rep] = v ? String(v) : ''
    }
    setDrafts(next)
  }, [targets, targetKey, assignableNames])

  const caseById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases])
  const actualsByRep = useMemo(() => {
    const src = { callLogs, appointments, visitReports, caseById }
    const map: Record<string, ReturnType<typeof kpiActuals>> = {}
    for (const rep of [OVERALL, ...assignableNames]) map[rep] = kpiActuals(month, rep, src, moment())
    return map
  }, [callLogs, appointments, visitReports, caseById, assignableNames, month])

  async function commit(rep: string) {
    if (!canWrite) return
    const raw = drafts[rep] ?? ''
    const value = Math.max(0, Math.min(99999, Math.round(Number(raw) || 0)))
    const cur = findTarget(targets, rep)
    if ((cur as any)[targetKey] === value) return // 変化なしなら書き込まない
    try {
      await KpiTargetApi.upsert({
        month, sales_rep: rep,
        call_target: cur.call_target, appo_target: cur.appo_target,
        action_target: cur.action_target, contract_target: cur.contract_target,
        [targetKey]: value,
      })
      await loadTargets()
      toast.success(`${rep === OVERALL ? '全体' : rep} の${metricDef.label}目標を保存しました`)
    } catch (e) {
      toast.error('KPI目標の保存に失敗しました: ' + jpError(e))
    }
  }

  const months = Array.from({ length: 12 }, (_, i) => i + 1)
  const isCurrentMonth = month === monthKey()

  const rows = [OVERALL, ...assignableNames]

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-bold">
        <Target className="h-4 w-4 text-primary" />月次KPI目標
        <span className="text-2xs font-normal text-muted-foreground">（コール／アポ／行動＝訪問／契約＝成約）</span>
      </div>

      {/* 年・月タブ */}
      <div className="mb-2 flex items-center gap-1">
        <button className="rounded border p-0.5 hover:bg-accent" onClick={() => setMonth(`${year - 1}-${month.slice(5)}`)} title="前年">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="w-12 text-center text-xs font-bold">{year}年</span>
        <button className="rounded border p-0.5 hover:bg-accent" onClick={() => setMonth(`${year + 1}-${month.slice(5)}`)} title="翌年">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <div className="ml-2 flex flex-wrap gap-1">
          {months.map((m) => {
            const mk = `${year}-${String(m).padStart(2, '0')}`
            const sel = mk === month
            return (
              <button
                key={m}
                onClick={() => setMonth(mk)}
                className={cn(
                  'rounded px-2 py-0.5 text-2xs',
                  sel ? 'bg-primary font-bold text-primary-foreground' : 'border text-muted-foreground hover:bg-accent',
                  mk === monthKey() && !sel && 'border-primary text-primary',
                )}
              >
                {m}月
              </button>
            )
          })}
        </div>
      </div>

      {/* メトリクスタブ */}
      <div className="mb-2 flex gap-1">
        {KPI_METRICS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs',
              metric === m.key ? 'bg-primary font-bold text-primary-foreground' : 'border text-muted-foreground hover:bg-accent',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* テーブル */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="px-2 py-1.5 text-left">担当</th>
              <th className="px-2 py-1.5 text-right">月間目標</th>
              <th className="px-2 py-1.5 text-right">1日目標</th>
              <th className="px-2 py-1.5 text-right">当月実績</th>
              <th className="px-2 py-1.5 text-right">今日まで必要</th>
              <th className="px-2 py-1.5 text-right">達成率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((rep) => {
              const monthly = Math.max(0, Math.round(Number(drafts[rep] ?? '') || 0))
              const daily = dailyTarget(monthly, month)
              const need = isCurrentMonth ? paceTarget(monthly, month, moment()) : monthly
              const actual = actualsByRep[rep]?.[metric] ?? 0
              const rate = monthly > 0 ? Math.round((actual / monthly) * 100) : 0
              const onPace = actual >= need
              return (
                <tr key={rep || '__overall__'} className={cn('border-b last:border-0', rep === OVERALL && 'bg-muted/30 font-bold')}>
                  <td className="px-2 py-1.5">{rep === OVERALL ? '全体' : rep}</td>
                  <td className="px-2 py-1 text-right">
                    <Input
                      inputMode="numeric"
                      value={drafts[rep] ?? ''}
                      disabled={!canWrite}
                      onChange={(e) => setDrafts((d) => ({ ...d, [rep]: e.target.value }))}
                      onBlur={() => commit(rep)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      placeholder="0"
                      className="h-7 w-20 text-right tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{daily || '—'}</td>
                  <td className="px-2 py-1.5 text-right font-bold tabular-nums">{actual}</td>
                  <td className={cn('px-2 py-1.5 text-right tabular-nums', monthly > 0 && (onPace ? 'text-green-600' : 'text-amber-600'))}>
                    {monthly > 0 ? need : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{monthly > 0 ? `${rate}%` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        「今日まで必要」＝月間目標×経過日数÷当月日数（ペース）。緑＝ペース達成、橙＝未達。全体行はチーム全体の目標を別途設定できます。
      </p>
    </div>
  )
}

import moment from 'moment'
import type { Appointment, Case, CallLog, VisitReport, KpiTarget } from './types'

/**
 * コール履歴のうち「実際の架電」とみなすもの。
 * ステータス変更ログ・再コール完了ログ・通話メモは集計から除外する。
 */
export function isCall(l: CallLog): boolean {
  if (!l.contact_type) return false
  const r = l.result ?? ''
  const s = l.summary ?? ''
  if (r.startsWith('ステータス変更')) return false
  if (r === '再コール予定 完了') return false
  if (s === '通話メモ' || s === '再コール完了') return false
  return true
}

/** 接続（誰かが応答した）— 不在以外で応答があったもの */
export function isAnswered(l: CallLog): boolean {
  if (l.contact_type === '接触') return true
  return l.contact_type === '非接触' && !!l.result && l.result !== '不在'
}

/** 代表接触（決裁者・代表と話せた）= 接触 */
export function isRepContact(l: CallLog): boolean {
  return l.contact_type === '接触'
}

export function pct(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 100) : 0
}

// ============================================================
// 月次KPI目標（コール/アポ/行動(訪問)/契約）の実績集計・ペース算出。
//   - コール = 架電（isCall）件数
//   - アポ   = 案件に紐づくアポ（コール由来）件数
//   - 行動   = 訪問結果を登録した件数（成約＋失注）
//   - 契約   = 訪問結果が「成約」の件数
// 担当帰属: コールは sales_rep→案件の担当、アポは appo.sales_rep→案件の担当、
//           行動/契約は案件(case_id)の担当。salesRep='' は全体。
// ============================================================
export const KPI_METRICS = [
  { key: 'call', label: 'コール', targetKey: 'call_target' },
  { key: 'appo', label: 'アポ', targetKey: 'appo_target' },
  { key: 'action', label: '行動', targetKey: 'action_target' },
  { key: 'contract', label: '契約', targetKey: 'contract_target' },
] as const

export type KpiMetricKey = (typeof KPI_METRICS)[number]['key']
export type KpiCounts = Record<KpiMetricKey, number>

/** 'YYYY-MM'。省略時は当月。 */
export function monthKey(d: moment.Moment = moment()): string {
  return d.format('YYYY-MM')
}

/** 月間目標を当月日数で割った1日あたりの目標（四捨五入）。 */
export function dailyTarget(monthlyTarget: number, month: string): number {
  if (!monthlyTarget) return 0
  const dim = moment(month + '-01', 'YYYY-MM-DD').daysInMonth()
  return Math.round(monthlyTarget / dim)
}

/**
 * 「その日までに必要な数」（ペース）。月間目標 × 当月経過日数 / 当月日数。
 * 過去の月は満了（=月間目標）、未来の月は0。
 */
export function paceTarget(monthlyTarget: number, month: string, today: moment.Moment = moment()): number {
  if (!monthlyTarget) return 0
  const first = moment(month + '-01', 'YYYY-MM-DD')
  const dim = first.daysInMonth()
  let dom: number
  if (today.isSame(first, 'month')) dom = today.date()
  else if (today.isBefore(first, 'month')) dom = 0
  else dom = dim
  return Math.round((monthlyTarget * dom) / dim)
}

/** kpi_targets 配列（month固定）から指定担当の目標を引く。無ければ0埋め。 */
export function findTarget(targets: KpiTarget[], salesRep: string): KpiTarget {
  const t = targets.find((x) => x.sales_rep === salesRep)
  return t ?? { month: '', sales_rep: salesRep, call_target: 0, appo_target: 0, action_target: 0, contract_target: 0 }
}

export function targetCounts(t: KpiTarget): KpiCounts {
  return { call: t.call_target, appo: t.appo_target, action: t.action_target, contract: t.contract_target }
}

interface KpiSource {
  callLogs: CallLog[]
  appointments: Appointment[]
  visitReports: VisitReport[]
  caseById: Map<string, Case>
}

/**
 * 指定月・指定担当（''=全体）の実績を集計。
 * today を渡すと当月はその日の終わりまでで締める。
 */
export function kpiActuals(month: string, salesRep: string, src: KpiSource, today?: moment.Moment): KpiCounts {
  const first = moment(month + '-01', 'YYYY-MM-DD').startOf('month')
  const monthEnd = moment(first).endOf('month')
  const end = today && today.isSame(first, 'month') ? moment(today).endOf('day') : monthEnd
  const inRange = (iso?: string | null) => {
    if (!iso) return false
    const m = moment(iso)
    return m.isSameOrAfter(first) && m.isSameOrBefore(end)
  }
  const caseRepOf = (caseId?: string | null) => (caseId ? src.caseById.get(caseId)?.sales_rep ?? '' : '')
  const match = (rep: string) => !salesRep || rep === salesRep

  const call = src.callLogs.filter((l) => isCall(l) && inRange(l.call_at) && match(l.sales_rep || caseRepOf(l.case_id))).length
  const appo = src.appointments.filter((a) => a.case_id && inRange(a.appo_at) && match(a.sales_rep || caseRepOf(a.case_id))).length
  const visits = src.visitReports.filter((v) => inRange(v.visited_at) && match(caseRepOf(v.case_id)))
  const action = visits.length
  const contract = visits.filter((v) => v.result === '成約').length
  return { call, appo, action, contract }
}

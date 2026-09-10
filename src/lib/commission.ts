// ============================================================
// 成約案件の歩合計算（画面共通の唯一の計算ロジック）
//
//  ルール:
//   - 歩合原資 = その月の売上 × 20%
//   - 分配     = リスト担当 10% / アポ担当 40% / 営業担当 50%
//   - 売上は「入金ベース」で月ごとに発生させる
//       ・HP制作(一括)        … 契約月に全額
//       ・HP制作(分割)        … 契約月から分割回数ぶん、毎月その回の分割額
//       ・保守/SEO/MEO(月額)  … 契約月から解約月（未設定なら現在月）まで毎月
//   - 未払い（入金待ち）に設定した案件は、未払い開始月以降の歩合を計上しない
//     （支払済みの過去月は遡って消さない）
//   - 担当が未設定の役割の分は「未割当」として誰にも配らない
//   - AI投入リスト（リスト担当=「AI自動投入」）はアポ担当がリスト担当を兼ねる
//     ＝リスト分10%もアポ担当に配る（人がリストを作っていないため）
//   - 販売代理店が営業担当の成約は歩合計算の対象外（代理店とは別契約で精算するため）。
//     販売代理店は歩合の受取人にもならない
//   - 社長（織田春樹）は歩合を受け取らない。案件自体は対象のままで、社長の担当分だけを
//     計算しない（同じ案件の他の担当＝アポを取った人などには通常どおり配る）
// ============================================================
import moment from 'moment'
import type { VisitReport } from './types'
import { AI_CREATOR_LABEL } from './caseCreator.js'

/**
 * 役割ごとの受取人。AI投入リストはリスト分をアポ担当が受け取る。
 * 未設定なら空文字（＝未配分）。
 */
export function commissionRecipient(r: Pick<VisitReport, 'list_rep' | 'appo_rep' | 'sales_rep'>, role: CommissionRole): string {
  if (role === 'list') {
    const list = r.list_rep?.trim() || ''
    return list === AI_CREATOR_LABEL ? (r.appo_rep?.trim() || '') : list
  }
  return (role === 'appo' ? r.appo_rep : r.sales_rep)?.trim() || ''
}

/** 売上に対する歩合原資の割合 */
export const COMMISSION_RATE = 0.2
/** 歩合原資の分配比率 */
export const COMMISSION_SPLIT = { list: 0.1, appo: 0.4, sales: 0.5 } as const
export type CommissionRole = keyof typeof COMMISSION_SPLIT
export const ROLE_LABEL: Record<CommissionRole, string> = { list: 'リスト', appo: 'アポ', sales: '営業' }

/** 販売代理店（歩合計算の対象外） */
export const AGENCY_REP = '販売代理店'
/** 歩合を受け取らない人（社長）。この人の担当分は計算しない（未配分にも数えない） */
export const COMMISSION_EXCLUDED_PEOPLE: readonly string[] = ['織田春樹']
/** 歩合の受取人にならない名前か（社長・販売代理店） */
export function isExcludedRecipient(name?: string | null): boolean {
  const n = (name || '').trim()
  return !!n && (n === AGENCY_REP || COMMISSION_EXCLUDED_PEOPLE.includes(n))
}
/** 販売代理店が営業担当の成約か（＝歩合計算の対象外） */
export function isAgencyDeal(r: Pick<VisitReport, 'sales_rep'>): boolean {
  return (r.sales_rep?.trim() || '') === AGENCY_REP
}

/** 月キー（YYYY-MM） */
const mk = (d: moment.Moment) => d.format('YYYY-MM')

/** 契約の開始月（契約日が無ければ訪問日） */
export function contractStartMonth(r: Pick<VisitReport, 'contract_date' | 'visited_at'>): string | null {
  const d = r.contract_date || r.visited_at
  if (!d) return null
  const m = moment(d)
  return m.isValid() ? mk(m) : null
}

/** 月額サービス（保守/SEO/MEO）の合計 */
function monthlyServiceTotal(r: VisitReport): number {
  return (Number(r.maintenance_price) || 0) + (Number(r.seo_price) || 0) + (Number(r.meo_price) || 0)
}

/**
 * 案件1件の、指定月（YYYY-MM）に発生する売上（入金ベース）。
 * 未払い・解約・契約前の月は 0。
 */
export function dealRevenueForMonth(r: VisitReport, month: string): number {
  if (r.result !== '成約') return 0
  const start = contractStartMonth(r)
  if (!start || month < start) return 0

  // 未払い（入金待ち）: 開始月以降は計上しない。開始月が無ければ契約月から全て止める
  if (r.commission_unpaid) {
    const since = r.unpaid_since ? mk(moment(r.unpaid_since)) : start
    if (month >= since) return 0
  }

  const endMonth = r.contract_end_month ? mk(moment(r.contract_end_month)) : null
  const idx = moment(month + '-01').diff(moment(start + '-01'), 'months')   // 契約月=0
  let revenue = 0

  // HP制作: 一括なら契約月に全額、分割なら各回の入金月に分割額
  const hp = Number(r.hp_price) || 0
  if (hp > 0) {
    const n = Number(r.hp_installments) || 0
    if (r.hp_payment_type === '分割' && n > 0) {
      if (idx < n) revenue += Math.round(hp / n)
    } else if (idx === 0) {
      revenue += hp
    }
  }

  // 月額サービス: 解約月まで毎月
  if (!endMonth || month <= endMonth) revenue += monthlyServiceTotal(r)

  return revenue
}

export interface PersonCommission {
  name: string
  list: number
  appo: number
  sales: number
  total: number
  /** その期間に歩合が発生した案件数（重複なし） */
  deals: number
}

export interface CommissionSummary {
  /** 担当者ごとの歩合（合計の多い順） */
  people: PersonCommission[]
  /** 期間の売上（入金ベース・未払い除く） */
  revenue: number
  /** 歩合原資（売上×20%） */
  pool: number
  /** 担当未設定のため配られなかった額 */
  unassigned: number
  /** 受取人が社長のため計算しなかった額（原資 = 配分額 + 未配分 + この額） */
  excluded: number
  /** 未払いで除外した案件数 */
  unpaidDeals: number
  /** 期間内に売上が発生した案件数 */
  activeDeals: number
  /** 販売代理店の成約のため対象外にした案件数（期間内に売上が発生したもの） */
  agencyDeals: number
}

/**
 * 指定した月の範囲（from〜to、YYYY-MM、両端含む）の歩合を担当者ごとに集計する。
 * 1ヶ月だけ見るなら from = to。
 */
export function summarizeCommission(reports: VisitReport[], from: string, to: string): CommissionSummary {
  const byName = new Map<string, PersonCommission>()
  const dealsByName = new Map<string, Set<string>>()
  let revenue = 0, pool = 0, unassigned = 0, excluded = 0, unpaidDeals = 0
  const activeIds = new Set<string>()
  const agencyIds = new Set<string>()

  const months: string[] = []
  for (let m = moment(from + '-01'); mk(m) <= to; m = m.add(1, 'month')) months.push(mk(m))

  for (const r of reports) {
    if (r.result !== '成約') continue
    if (r.commission_unpaid) unpaidDeals++
    for (const month of months) {
      const rev = dealRevenueForMonth(r, month)
      if (rev <= 0) continue
      // 販売代理店の成約は歩合計算の対象外（売上・原資にも含めない）
      if (isAgencyDeal(r)) { agencyIds.add(r.id); continue }
      activeIds.add(r.id)
      revenue += rev
      const dealPool = rev * COMMISSION_RATE
      pool += dealPool
      for (const role of Object.keys(COMMISSION_SPLIT) as CommissionRole[]) {
        const amount = Math.round(dealPool * COMMISSION_SPLIT[role])
        const who = commissionRecipient(r, role)
        // 社長・販売代理店は受取人にしない。未配分とは分けて数える（担当を入れ忘れた分と区別するため）
        if (isExcludedRecipient(who)) { excluded += amount; continue }
        if (!who) { unassigned += amount; continue }
        const p = byName.get(who) ?? { name: who, list: 0, appo: 0, sales: 0, total: 0, deals: 0 }
        p[role] += amount
        p.total += amount
        byName.set(who, p)
        const ds = dealsByName.get(who) ?? new Set<string>()
        ds.add(r.id)
        dealsByName.set(who, ds)
      }
    }
  }
  const people = [...byName.values()]
    .map((p) => ({ ...p, deals: dealsByName.get(p.name)?.size ?? 0 }))
    .sort((a, b) => b.total - a.total)
  return { people, revenue: Math.round(revenue), pool: Math.round(pool), unassigned, excluded, unpaidDeals, activeDeals: activeIds.size, agencyDeals: agencyIds.size }
}

// ============================================================
// 支払サイクル: 月末日締め → 翌月25日の給与と一緒に支払い
//  「2026年9月歩合」= 9/1〜9/30 に発生した歩合。9/30締め・10/25支払。
// ============================================================
export const COMMISSION_PAY_DAY = 25

export type PayStatus = '集計中' | '支払予定' | '支払済み'

export interface PayrollInfo {
  /** 対象月 YYYY-MM */
  month: string
  /** 表示名（例: 2026年9月歩合） */
  label: string
  /** 締め日（対象月の末日） */
  closeDate: string
  /** 支払日（翌月25日） */
  payDate: string
  /** 集計中=締め前 / 支払予定=締め後で支払日前 / 支払済み=支払日を過ぎた */
  status: PayStatus
}

/** 対象月の締め日・支払日・状態 */
export function payrollInfo(month: string, today = moment()): PayrollInfo {
  const first = moment(month + '-01')
  const close = moment(first).endOf('month')
  const pay = moment(first).add(1, 'month').date(COMMISSION_PAY_DAY)
  const t = moment(today).startOf('day')
  const status: PayStatus = t.isAfter(close, 'day') ? (t.isBefore(pay, 'day') ? '支払予定' : '支払済み') : '集計中'
  return {
    month,
    label: `${first.format('YYYY年M月')}歩合`,
    closeDate: close.format('YYYY-MM-DD'),
    payDate: pay.format('YYYY-MM-DD'),
    status,
  }
}

export interface MonthlyCommissionRow extends PayrollInfo {
  summary: CommissionSummary
}

/** 月ごとの歩合（新しい月が先頭）。from〜to は YYYY-MM・両端含む */
export function monthlyCommission(reports: VisitReport[], from: string, to: string): MonthlyCommissionRow[] {
  const rows: MonthlyCommissionRow[] = []
  for (let m = moment(to + '-01'); mk(m) >= from; m = m.subtract(1, 'month')) {
    const month = mk(m)
    rows.push({ ...payrollInfo(month), summary: summarizeCommission(reports, month, month) })
  }
  return rows
}

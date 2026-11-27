// ============================================================
// 成約案件の歩合計算（画面共通の唯一の計算ロジック）
//
//  ルール:
//   - 歩合原資 = その月の粗利（売上 − 原価）× 20%
//   - 原価はサービスごとに決めている（constants.ts の CONTRACT_PRODUCTS.cost）。
//     月額サービスの原価は1ヶ月あたりで、売上を計上した月に同じだけ引く
//     （カードでまとめて入金した月は、そのぶんの月数ぶんの原価もまとめて引く）
//   - 分配     = リスト担当 10% / アポ担当 40% / 営業担当 50%
//   - 売上は「入金ベース」で月ごとに発生させる
//       ・HP制作(一括)        … 契約月に全額
//       ・HP制作(分割/カード) … カード会社から契約月に全額まとめて入金（ショット）。
//                               お客様がカード会社へ毎月払っていても、当社の入金は一度なので
//                               歩合もその月にまとめて立つ
//       ・HP制作(分割/口座振替等) … その回の入金月ごとに分割額
//       ・途中で支払方法が変わる契約（例: 1〜24回カード／25回目以降 口座振替）は
//         区間ごとに上の判定をする（カード分は契約月にショット、残りは25ヶ月目から毎月）
//       ・保守/SEO/MEO(月額)  … 契約月から解約月（未設定なら現在月）まで毎月
//       ・月額の支払方法が途中で変わる契約（例: 月額49,500円を12ヶ月カード／13ヶ月目から口座振替）
//         … カードでまとめて決済したぶんが契約月に一括入金（ショット）ならその月にまとめて、
//           毎月課金ならその月ごとに計上。切替後は解約月まで毎月
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
import {
  hpPaymentSegments, monthlyPaymentSegments, monthlyServiceTotal, monthlyCostTotal, initialCostTotal,
} from './constants.js'

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

/**
 * 入金の計上ルールを直した月（この月ぶんから新ルールで支払う）。
 * 2026-10-21に「カード分割はカード会社から契約月に一括入金（ショット）」へ直したため、
 * それ以前の月は旧ルール（分割回数ぶん毎月に按分）で計算した額を支払い済み。
 * 社長の判断で**遡っての精算はしない**ので、画面の過去月の金額は実際の支払額と一致しないことがある。
 * 画面ではこの月より前に注記を出して、支払済みの額と混同しないようにする。
 */
export const COMMISSION_RULE_CHANGE_MONTH = '2026-10'

/**
 * 原価を引いた粗利で歩合を計算し始めた月（この月ぶんから新ルール）。
 * これより前の月は売上そのままの旧ルールで計算した額を支払い済みなので、遡って減らさない。
 * 2026-11分は11/30締め・12/25支払でまだ未払いのため、この月から適用する。
 */
export const COMMISSION_COST_START_MONTH = '2026-11'

/** 月キー（YYYY-MM） */
const mk = (d: moment.Moment) => d.format('YYYY-MM')

/** 契約の開始月（契約日が無ければ訪問日） */
export function contractStartMonth(r: Pick<VisitReport, 'contract_date' | 'visited_at'>): string | null {
  const d = r.contract_date || r.visited_at
  if (!d) return null
  const m = moment(d)
  return m.isValid() ? mk(m) : null
}

/** 月額サービス（保守/SEO/MEO/SNS）の合計・原価は constants.ts と共通（二重定義しない） */

/** 案件1件の、ある月の売上・原価・粗利 */
export interface DealAmounts {
  /** その月に入金される額 */
  revenue: number
  /** その月ぶんの原価（売上を超えないように丸める） */
  cost: number
  /** 歩合の計算に使う額（売上 − 原価。原価割れでもマイナスにはしない） */
  profit: number
}

/**
 * 案件1件の、指定月（YYYY-MM）に発生する売上・原価・粗利（入金ベース）。
 * 未払い・解約・契約前の月は 0。
 * 原価は「売上を計上した月に、その月数ぶんだけ」引く。カードでまとめて入金した月は
 * まとめた月数ぶんの原価を同じ月に引く（売上だけ先に立って原価が後から出る、を避ける）。
 */
export function dealAmountsForMonth(r: VisitReport, month: string): DealAmounts {
  const zero: DealAmounts = { revenue: 0, cost: 0, profit: 0 }
  if (r.result !== '成約') return zero
  const start = contractStartMonth(r)
  if (!start || month < start) return zero

  // 未払い（入金待ち）: 開始月以降は計上しない。開始月が無ければ契約月から全て止める
  if (r.commission_unpaid) {
    const since = r.unpaid_since ? mk(moment(r.unpaid_since)) : start
    if (month >= since) return zero
  }

  const endMonth = r.contract_end_month ? mk(moment(r.contract_end_month)) : null
  const idx = moment(month + '-01').diff(moment(start + '-01'), 'months')   // 契約月=0
  // 原価を引き始めた月より前は、売上そのままの旧ルールで支払い済み（遡って減らさない）
  const costOn = month >= COMMISSION_COST_START_MONTH
  let revenue = 0, cost = 0

  // HP制作: 一括は契約月に全額。分割は「当社にいつ入金されるか」で計上する。
  //   カード区間  … 区間の初月に区間の合計額（カード会社からのショット入金）
  //   それ以外    … その回の入金月に1回ぶん
  const hp = Number(r.hp_price) || 0
  if (hp > 0) {
    const segs = hpPaymentSegments(r)
    if (segs.length) {
      for (const seg of segs) {
        const fromIdx = seg.from - 1   // 1回目 = 契約月(idx 0)
        if (seg.lump) { if (idx === fromIdx) revenue += seg.total }
        else if (idx >= fromIdx && idx <= seg.to - 1) revenue += seg.perPayment
      }
    } else if (idx === 0) {
      revenue += hp
    }
    // 制作の原価は1契約につき1回。最初に売上が立つ契約月に引く
    if (costOn && idx === 0) cost += initialCostTotal(r)
  }

  // 月額サービス: 解約月まで毎月。
  //   ただし「1〜12ヶ月目はカード／13ヶ月目以降は口座振替」のように支払方法が途中で変わる契約は、
  //   カードでまとめて決済したぶんが契約月に一括で入金される（ショット入金）ことがあるので、
  //   区間ごとに入金月を見る。HP制作の分割とまったく同じ考え方。
  const monthly = monthlyServiceTotal(r)
  if (monthly > 0 && (!endMonth || month <= endMonth)) {
    const mSegs = monthlyPaymentSegments(r)
    let units = 0   // この月に計上する「月数」。ショット入金の月はまとめた月数になる
    if (!mSegs.length) {
      units = 1
    } else {
      for (const seg of mSegs) {
        const fromIdx = seg.from - 1                       // 1ヶ月目 = 契約月(idx 0)
        const toIdx = seg.to == null ? Infinity : seg.to - 1
        // ショット入金は区間の初月にまとめて入る（解約してもすでに入金済みなので遡らない）
        if (seg.lump) { if (idx === fromIdx) units += seg.count ?? 0 }
        else if (idx >= fromIdx && idx <= toIdx) units += 1
      }
    }
    revenue += monthly * units
    if (costOn) cost += monthlyCostTotal(r) * units
  }

  cost = Math.min(cost, revenue)          // 原価割れの契約で歩合をマイナスにしない
  return { revenue, cost, profit: revenue - cost }
}

/** 案件1件の、指定月に発生する売上（入金ベース）。原価を引く前の額。 */
export function dealRevenueForMonth(r: VisitReport, month: string): number {
  return dealAmountsForMonth(r, month).revenue
}

// ============================================================
// 昇級判定（四半期ごと）
//   昇級表のルール:
//     - 四半期（3ヶ月）の有効成約で判定し、条件を満たせば次の四半期から昇級
//     - 四半期は10月始まり（10〜12 / 1〜3 / 4〜6 / 7〜9）
//     - 「本数」と「P」の両方を満たしたときだけ昇級する
//     - 無効: 四半期終了時までに支払いが滞っている / 解約 / 途中キャンセル。本数・Pとも判定から除外
//   Pの数え方（2026-11に社長の指示で変更）:
//     1契約=120P固定ではなく、その契約の支払い総額（HP制作の総額 ＋ 月額×最低契約期間）を
//     1万円=1P で換算する。歩合と同じく リスト10% / アポ40% / 営業50% で分け合う。
// ============================================================
/** 支払い総額をPに換算する単位（1P = 1万円） */
export const PROMOTION_POINT_YEN = 10000

export interface PromotionRank {
  rank: string
  /** 必要な有効成約数（3ヶ月合計） */
  deals: number
  /** 必要な有効P（3ヶ月合計） */
  points: number
  /** 固定給アップ額（円/月） */
  raiseYen: number
}
/** 昇級表（下位から順に）。一般社員が初期役職 */
export const PROMOTION_RANKS: readonly PromotionRank[] = [
  { rank: '上級社員', deals: 6, points: 720, raiseYen: 50000 },
  { rank: '主任', deals: 9, points: 1080, raiseYen: 100000 },
  { rank: '課長', deals: 12, points: 1440, raiseYen: 150000 },
]
export const PROMOTION_BASE_RANK = '一般社員'

/**
 * 契約の支払い総額（円）。HP制作の総額（一括/分割を問わず契約金額）＋ 月額サービス×最低契約期間。
 * 最低契約期間が未入力の契約は月額ぶんを数えられない（0ヶ月扱い）ので、入力を促すために
 * そのまま0として扱う＝初期費用だけがPになる。
 */
export function contractTotalYen(r: VisitReport): number {
  const hp = Number(r.hp_price) || 0
  const months = Number(r.min_contract_months) || 0
  return hp + monthlyServiceTotal(r) * months
}

/** 10月始まりの四半期。月(YYYY-MM)が属する四半期の範囲とラベルを返す */
export function promotionQuarter(month: string): { from: string; to: string; label: string } {
  const m = moment(month + '-01')
  // 10,1,4,7月が四半期の開始。(月-10+12)%3 で開始月までの戻り月数が出る
  const back = ((m.month() + 1 - 10) % 3 + 3) % 3
  const start = m.clone().subtract(back, 'months')
  const end = start.clone().add(2, 'months')
  return {
    from: start.format('YYYY-MM'),
    to: end.format('YYYY-MM'),
    label: `${start.format('YYYY年M月')}〜${end.format('M月')}期`,
  }
}

/** 昇級判定の対象になる契約か（無効＝未払い/解約/途中キャンセル、販売代理店は対象外） */
export function isPromotionCountable(r: VisitReport): boolean {
  if (r.result !== '成約') return false
  if (isAgencyDeal(r)) return false
  if (r.commission_unpaid) return false      // 支払いが滞っている
  if (r.contract_end_month) return false     // 解約/途中キャンセル
  return true
}

export interface PersonPromotion {
  name: string
  /** 有効成約数（自分が営業担当＝クロージングした案件の数） */
  deals: number
  /** 有効P（支払い総額を役割比率で分けて1万円=1Pに換算） */
  points: number
  /** いまの実績で満たしている役職（満たしていなければ一般社員） */
  rank: string
  /** 次に目指す役職（課長まで到達していれば null） */
  next: PromotionRank | null
  /** 次の役職まであと何本・何P（満たしていれば0） */
  dealsLeft: number
  pointsLeft: number
}

/**
 * 四半期の昇級進捗を担当者ごとに集計する。
 * 本数は「自分が営業担当としてクロージングした有効案件の数」。リスト/アポだけ担当した案件は
 * 本数に数えない（昇級表の「成約数」はクロージング実績を指すため）。
 * Pは本数と違い、歩合と同じ比率で3役に分け合う（同じ案件で2役兼任ならその合計）。
 * ＝リスト/アポだけの関与でもPは貯まるが、本数の条件は自分で取った契約でしか埋まらない。
 */
export function summarizePromotion(reports: VisitReport[], month: string): {
  from: string; to: string; label: string; people: PersonPromotion[]
} {
  const q = promotionQuarter(month)
  const acc = new Map<string, { yen: number; deals: Set<string> }>()
  for (const r of reports) {
    if (!isPromotionCountable(r)) continue
    const start = contractStartMonth(r)
    if (!start || start < q.from || start > q.to) continue
    const total = contractTotalYen(r)
    const key = r.id || `${r.case_name}-${start}`
    for (const role of Object.keys(COMMISSION_SPLIT) as CommissionRole[]) {
      const name = commissionRecipient(r, role)
      if (!name || isExcludedRecipient(name)) continue
      const cur = acc.get(name) ?? { yen: 0, deals: new Set<string>() }
      cur.yen += total * COMMISSION_SPLIT[role]
      if (role === 'sales') cur.deals.add(key)   // 本数は営業担当のぶんだけ
      acc.set(name, cur)
    }
  }
  const people: PersonPromotion[] = [...acc.entries()].map(([name, v]) => {
    const points = Math.round(v.yen / PROMOTION_POINT_YEN)
    const deals = v.deals.size
    // 本数とPの両方を満たした役職のうち、いちばん上を現在の到達役職とする
    let rank = PROMOTION_BASE_RANK
    for (const t of PROMOTION_RANKS) if (deals >= t.deals && points >= t.points) rank = t.rank
    const next = PROMOTION_RANKS.find((t) => !(deals >= t.deals && points >= t.points)) ?? null
    return {
      name, deals, points, rank, next,
      dealsLeft: next ? Math.max(0, next.deals - deals) : 0,
      pointsLeft: next ? Math.max(0, next.points - points) : 0,
    }
  }).sort((a, b) => b.points - a.points)
  return { ...q, people }
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
  /** 期間の原価（サービスごとの原価×計上月数） */
  cost: number
  /** 期間の粗利（売上 − 原価）。歩合原資の元になる額 */
  profit: number
  /** 歩合原資（粗利×20%） */
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
  let revenue = 0, cost = 0, pool = 0, unassigned = 0, excluded = 0, unpaidDeals = 0
  const activeIds = new Set<string>()
  const agencyIds = new Set<string>()

  const months: string[] = []
  for (let m = moment(from + '-01'); mk(m) <= to; m = m.add(1, 'month')) months.push(mk(m))

  for (const r of reports) {
    if (r.result !== '成約') continue
    if (r.commission_unpaid) unpaidDeals++
    for (const month of months) {
      const amt = dealAmountsForMonth(r, month)
      if (amt.revenue <= 0) continue
      // 販売代理店の成約は歩合計算の対象外（売上・原資にも含めない）
      if (isAgencyDeal(r)) { agencyIds.add(r.id); continue }
      activeIds.add(r.id)
      revenue += amt.revenue
      cost += amt.cost
      // 歩合は売上そのままではなく、原価を引いた粗利を元に計算する
      const dealPool = amt.profit * COMMISSION_RATE
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
  return {
    people,
    revenue: Math.round(revenue), cost: Math.round(cost), profit: Math.round(revenue - cost),
    pool: Math.round(pool), unassigned, excluded, unpaidDeals,
    activeDeals: activeIds.size, agencyDeals: agencyIds.size,
  }
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

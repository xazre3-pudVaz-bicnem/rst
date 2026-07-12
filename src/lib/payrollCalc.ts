// ============================================================
// 給与計算エンジン（本体）
// 勤怠集計 + 従業員の給与条件から給与明細(Payslip)の下書きを算出する。
// 料率は「適用開始月→料率セット」の RATE_TABLE で月別に管理し、対象月に応じて
// 当時の率を適用する（過去月の再計算でも当時額を再現できる）。
// 割増率は労基法37条準拠。社会保険料の端数は被保険者負担の法定ルールで処理する。
// ============================================================
import type { Employee, Payslip } from './types'

/**
 * 月単位で変動する料率セット（被保険者負担分・折半後）。
 * from = 適用開始月(YYYY-MM)。calcPayslip は対象月に対し from<=month の最新セットを選ぶ。
 * 協会けんぽは東京支部の料率を採用（他支部は誤差が残る＝将来課題）。
 */
export interface PayrollRateSet {
  /** 適用開始月 YYYY-MM */
  from: string
  /** 健康保険（折半後・東京） */
  healthInsurance: number
  /** 子ども・子育て支援金（2026.4新設・健康保険料に上乗せ徴収）。健保に合算して表示・徴収する */
  childSupport: number
  /** 介護保険（40歳以上・折半後） */
  longTermCare: number
  /** 厚生年金（折半後） */
  pension: number
  /** 雇用保険（一般の事業・労働者負担） */
  employmentInsurance: number
  /** 源泉所得税の課税最低ライン（月額・概算） */
  incomeTaxThreshold: number
}

/**
 * 料率テーブル（from 昇順で保持）。過去月の再計算で当時の率が当たるよう履歴を残す。
 * ※令和8年度(2026)の値は2026-07に公的一次資料でWeb照合済み（下記コメントに出典）。
 */
export const RATE_TABLE: PayrollRateSet[] = [
  {
    // 令和6年度（現行コードの値を踏襲。過去月の再計算で当時額を再現するため保持）
    from: '2024-04',
    healthInsurance: 0.0499, // 協会けんぽ東京 R6 健康保険（折半後）
    childSupport: 0, // 2026.3まで支援金の徴収なし
    longTermCare: 0.0080, // 介護保険 R6（40歳以上・折半後）
    pension: 0.0915, // 厚生年金 18.3%の労使折半（2017.9以降固定・確実）
    employmentInsurance: 0.006, // 雇用保険 R6 労働者負担（一般の事業）
    incomeTaxThreshold: 88000, // 源泉月額表 非課税ライン（概算）
  },
  {
    // 令和8年度（2026.4〜）。全料率をWeb照合済み（協会けんぽ/厚労省/国税庁の一次資料）。
    from: '2026-04',
    healthInsurance: 0.04925, // 協会けんぽ東京R8 健保9.85%の折半（kyoukaikenpo.or.jp R8保険料額表）
    childSupport: 0.00115, // 子ども・子育て支援金R8 全国一律0.23%の折半（2026.4新設・健保に上乗せ）
    longTermCare: 0.0081, // 介護保険R8 全国一律1.62%の折半（40歳以上・kyoukaikenpo R8）
    pension: 0.0915, // 厚生年金 18.3%の労使折半（2017.9固定・確実）
    employmentInsurance: 0.005, // 雇用保険R8 労働者負担5/1000（一般の事業・mhlw.go.jp 001692566）
    incomeTaxThreshold: 105000, // 令和8年分 源泉月額表の非課税ライン105,000円（国税庁 zeigakuhyo2026）
  },
]

/** 対象月(YYYY-MM)に適用する料率セットを返す。該当なし（テーブル最古より前）なら最古セット。 */
export function ratesForMonth(month: string): PayrollRateSet {
  let picked = RATE_TABLE[0]
  for (const s of RATE_TABLE) {
    // from も month も 'YYYY-MM' 形式なので辞書順比較で月の前後を判定できる
    if (s.from <= month) picked = s
    else break
  }
  return picked
}

/** 月に依らない固定の割増率・換算定数（労基法37条の法定割増）。 */
export const PAYROLL_RATES = {
  /** 月給者の時間外倍率（base に残業分を含まないため満額 1.25） */
  overtimeRate: 1.25,
  /** 時給者の時間外割増（base に実労働全時間の1.0倍が含まれるため割増分のみ 0.25） */
  overtimePremiumRate: 0.25,
  /** 月60時間超の時間外に追加する割増（法定1.5倍・中小企業も2023.4から義務） */
  overtimeRate60Extra: 0.25,
  /** 深夜割増（22-5時・月給/時給問わず賃金に上乗せ 0.25） */
  lateNightExtraRate: 0.25,
  /** 月給者の法定休日労働倍率（満額 1.35） */
  holidayRate: 1.35,
  /** 時給者の法定休日労働割増（割増分のみ 0.35） */
  holidayPremiumRate: 0.35,
  /** 月間所定労働時間の目安（時給・時間単価換算用） */
  monthlyStandardHours: 160,
  /** 所得税の概算税率（源泉・甲欄の簡易近似） */
  incomeTaxRate: 0.05105,
} as const

/**
 * 社会保険料（被保険者負担分）の端数処理。
 * 法定ルール: 給与から控除する場合、端数が50銭以下は切捨て・50銭超は切上げ（1円単位）。
 * 健康保険・介護保険・厚生年金・雇用保険の4控除に適用する。
 */
export function roundPremium(n: number): number {
  const whole = Math.floor(n)
  const sen = n - whole // 円未満の端数
  // 50銭ちょうど(=0.5)は「50銭以下」に該当し切り捨てる
  return sen <= 0.5 ? whole : whole + 1
}

export interface PayrollInput {
  /** 実労働(分) */
  workMinutes: number
  overtimeMinutes: number
  lateNightMinutes: number
  holidayWorkMinutes: number
  paidLeaveDays?: number
  absentDays?: number
  workDays?: number
  /** 通勤手当（非課税想定・そのまま加算） */
  commuteAllowance?: number
  positionAllowance?: number
  otherAllowance?: number
  /** 住民税（毎月定額・特別徴収額。分かる場合に指定） */
  residentTax?: number
  /** その他控除（社宅・貸付金返済など・手入力の引き継ぎ用） */
  otherDeduction?: number
  /** 40歳以上（介護保険を徴収するか） */
  longTermCareApplicable?: boolean
}

export type PayslipDraft = Omit<Payslip, 'id' | 'created_at' | 'updated_at'>

/** 従業員の時間単価（円/時）を求める */
export function hourlyRateOf(emp: Employee): number {
  if (emp.hourly_wage && emp.hourly_wage > 0) return emp.hourly_wage
  if (emp.base_salary && emp.base_salary > 0) {
    return Math.round(emp.base_salary / PAYROLL_RATES.monthlyStandardHours)
  }
  return 0
}

const yen = (n: number) => Math.round(n)

/** 支給内訳（総支給・控除の再計算に渡す） */
export interface PayComponents {
  base: number
  overtimePay: number
  lateNightPay: number
  holidayPay: number
  fixedOtPay: number
  commute: number
  position: number
  other: number
}

/** 社会保険料（標準報酬ベース・手当に連動しない据え置き分） */
export interface SocialComponents {
  health: number
  care: number
  pension: number
}

export interface DeductionResult {
  gross: number
  employmentInsurance: number
  socialTotal: number
  incomeTax: number
  totalDeduction: number
  netPay: number
}

/**
 * 総支給に連動する控除（雇用保険・源泉所得税）と合計を再計算する。
 * 社保(健保/介護/厚年)は標準報酬月額ベースで手当に連動しないため引数の据え置き値を使う。
 * → 手当変更時にこの関数を呼べば、明細内の控除が矛盾しないよう連動できる。
 */
export function recalcDeductions(
  month: string,
  pay: PayComponents,
  social: SocialComponents,
  residentTax: number,
  otherDeduction: number,
): DeductionResult {
  const rates = ratesForMonth(month)
  const gross = pay.base + pay.overtimePay + pay.lateNightPay + pay.holidayPay
    + pay.fixedOtPay + pay.commute + pay.position + pay.other
  // 雇用保険は賃金総額（通勤手当を含む）が算定基礎。手当変更に連動する。
  const employmentInsurance = roundPremium(gross * rates.employmentInsurance)
  const socialTotal = social.health + social.care + social.pension + employmentInsurance
  // 源泉所得税（概算）。通勤手当は非課税として、社会保険料は控除して課税ベースを出す。
  const taxBase = gross - pay.commute - socialTotal
  const incomeTax = taxBase > rates.incomeTaxThreshold
    ? yen((taxBase - rates.incomeTaxThreshold) * PAYROLL_RATES.incomeTaxRate)
    : 0
  const totalDeduction = socialTotal + incomeTax + residentTax + otherDeduction
  const netPay = gross - totalDeduction
  return { gross, employmentInsurance, socialTotal, incomeTax, totalDeduction, netPay }
}

/**
 * 給与明細の下書きを算出する。
 * 標準報酬月額は base_salary を概算値として用いる（未設定なら時間単価×所定時間）。
 */
export function calcPayslip(emp: Employee, month: string, input: PayrollInput): PayslipDraft {
  const rates = ratesForMonth(month) // 対象月に適用する料率セット
  const c = PAYROLL_RATES
  const hourly = hourlyRateOf(emp)
  const otHours = input.overtimeMinutes / 60
  const nightHours = input.lateNightMinutes / 60
  const holidayHours = input.holidayWorkMinutes / 60

  // --- 支給 ---
  // 月給者は base_salary をそのまま基本給に。時給者は実労働×時給。
  const isMonthly = !!(emp.base_salary && emp.base_salary > 0)
  const base = isMonthly
    ? yen(emp.base_salary as number)
    : yen(hourly * (input.workMinutes / 60))

  // --- 時間外手当 ---
  // 固定残業(みなし残業)は月給者の概念。月給者は固定残業手当が時間外を充当済みとみなし、
  // 超過分(paidOtHours)にのみ通常の時間外割増を支給して二重払いを防ぐ。
  // 時給者は base に全労働時間の1.0倍が含まれ固定残業手当も持たないため、固定残業控除をせず
  // 全時間外に割増(0.25)を付与する（控除すると固定残業時間分の割増が欠落し過小払いになる）。
  const fixedOtHours = emp.fixed_overtime_hours ?? 0
  const paidOtHours = isMonthly ? Math.max(0, otHours - fixedOtHours) : otHours
  // 月給者は base に時間外分を含まないため満額(1.25)、時給者は base に実労働全時間の
  // 1.0倍が含まれるため割増分(0.25)のみ。→ 時給者の2.25倍払いを解消。
  const otUplift = isMonthly ? c.overtimeRate : c.overtimePremiumRate
  const overtimeBase = hourly * otUplift * paidOtHours
  // 月60時間超の時間外は+25%（法定1.5倍）。判定は実際の時間外(otHours)ベース
  // （固定残業分も実労働時間なので60h算入する）。固定残業手当は通常割増分までの充当。
  const over60Hours = Math.max(0, otHours - 60)
  const over60Extra = hourly * c.overtimeRate60Extra * over60Hours
  const overtimePay = yen(overtimeBase + over60Extra)

  const lateNightPay = yen(hourly * c.lateNightExtraRate * nightHours)
  // 休日労働も時間外と同じ理由で月給/時給を分岐（満額1.35 / 割増のみ0.35）。
  const holidayUplift = isMonthly ? c.holidayRate : c.holidayPremiumRate
  const holidayPay = yen(hourly * holidayUplift * holidayHours)
  // 固定残業手当は月給者のみ。時給者は実労働(base)＋全時間外割増で支給済みのため加算しない
  // （加算すると base の1.0倍と二重計上になり、社保の標準報酬も過大になる）。
  const fixedOtPay = isMonthly ? yen(emp.fixed_overtime_pay || 0) : 0
  const commute = yen(input.commuteAllowance || 0)
  const position = yen(input.positionAllowance || 0)
  const other = yen(input.otherAllowance || 0)

  // --- 社会保険（標準報酬月額 ≒ 基本給+固定残業。通勤・時間外は簡略化のため除外） ---
  // 子ども・子育て支援金(2026.4新設)は健康保険料に合算して徴収する。端数は法定処理。
  const standardWage = base + fixedOtPay
  const social: SocialComponents = {
    health: roundPremium(standardWage * (rates.healthInsurance + rates.childSupport)),
    care: input.longTermCareApplicable ? roundPremium(standardWage * rates.longTermCare) : 0,
    pension: roundPremium(standardWage * rates.pension),
  }

  const pay: PayComponents = {
    base, overtimePay, lateNightPay, holidayPay, fixedOtPay, commute, position, other,
  }
  const residentTax = yen(input.residentTax || 0)
  const otherDeduction = yen(input.otherDeduction || 0)
  // 総支給・雇用保険・源泉所得税・合計は共通ロジックで算出（手当変更時の再計算と一致させる）
  const d = recalcDeductions(month, pay, social, residentTax, otherDeduction)

  return {
    payroll_run_id: null,
    employee_id: emp.id,
    target_month: month,
    work_days: input.workDays ?? 0,
    work_minutes: input.workMinutes,
    overtime_minutes: input.overtimeMinutes,
    late_night_minutes: input.lateNightMinutes,
    holiday_work_minutes: input.holidayWorkMinutes,
    paid_leave_days: input.paidLeaveDays ?? 0,
    absent_days: input.absentDays ?? 0,
    base_salary: base,
    overtime_pay: overtimePay,
    late_night_pay: lateNightPay,
    holiday_pay: holidayPay,
    fixed_overtime_pay: fixedOtPay,
    commute_allowance: commute,
    position_allowance: position,
    other_allowance: other,
    gross_pay: d.gross,
    health_insurance: social.health,
    long_term_care_insurance: social.care,
    pension_insurance: social.pension,
    employment_insurance: d.employmentInsurance,
    income_tax: d.incomeTax,
    resident_tax: residentTax,
    other_deduction: otherDeduction,
    total_deduction: d.totalDeduction,
    net_pay: d.netPay,
    status: '未確定',
    note: null,
  }
}

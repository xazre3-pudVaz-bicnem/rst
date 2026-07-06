// ============================================================
// 給与計算エンジン（本体）
// 勤怠集計 + 従業員の給与条件から給与明細(Payslip)の下書きを算出する。
// 保険料率・税額は概算（2026年想定の簡易値）。実運用時は最新の料率表・
// 源泉徴収税額表(甲欄)に差し替えること。PAYROLL_RATES を書き換えれば調整可能。
// ============================================================
import type { Employee, Payslip } from './types'

/** 各種料率・定数（従業員負担分。折半後の率）。実運用では都度更新する。 */
export const PAYROLL_RATES = {
  /** 健康保険（協会けんぽ東京・折半後の目安） */
  healthInsurance: 0.0499,
  /** 介護保険（40歳以上・折半後の目安） */
  longTermCare: 0.0080,
  /** 厚生年金（折半後） */
  pension: 0.0915,
  /** 雇用保険（一般の事業・労働者負担） */
  employmentInsurance: 0.006,
  /** 残業割増率（法定 25%） */
  overtimeRate: 1.25,
  /** 深夜割増（上乗せ 25%） */
  lateNightExtraRate: 0.25,
  /** 休日労働割増率（法定 35%） */
  holidayRate: 1.35,
  /** 月間所定労働時間の目安（時給・時間単価換算用） */
  monthlyStandardHours: 160,
  /** 所得税の課税最低ライン（月額・概算） */
  incomeTaxThreshold: 88000,
  /** 所得税の概算税率（源泉・甲欄の簡易近似） */
  incomeTaxRate: 0.05105,
} as const

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

/**
 * 給与明細の下書きを算出する。
 * 標準報酬月額は base_salary を概算値として用いる（未設定なら時間単価×所定時間）。
 */
export function calcPayslip(emp: Employee, month: string, input: PayrollInput): PayslipDraft {
  const r = PAYROLL_RATES
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

  const overtimePay = yen(hourly * r.overtimeRate * otHours)
  const lateNightPay = yen(hourly * r.lateNightExtraRate * nightHours)
  const holidayPay = yen(hourly * r.holidayRate * holidayHours)
  const fixedOtPay = yen(emp.fixed_overtime_pay || 0)
  const commute = yen(input.commuteAllowance || 0)
  const position = yen(input.positionAllowance || 0)
  const other = yen(input.otherAllowance || 0)

  const gross = base + overtimePay + lateNightPay + holidayPay + fixedOtPay + commute + position + other

  // --- 控除（標準報酬月額 ≒ 基本給+固定残業。通勤・時間外は簡略化のため除外） ---
  const standardWage = base + fixedOtPay
  const health = yen(standardWage * r.healthInsurance)
  const care = input.longTermCareApplicable ? yen(standardWage * r.longTermCare) : 0
  const pension = yen(standardWage * r.pension)
  const employment = yen(gross * r.employmentInsurance)
  const socialTotal = health + care + pension + employment

  // 所得税（源泉・概算）。通勤手当は非課税として除外。
  const taxBase = gross - commute - socialTotal
  const incomeTax = taxBase > r.incomeTaxThreshold
    ? yen((taxBase - r.incomeTaxThreshold) * r.incomeTaxRate)
    : 0
  const residentTax = yen(input.residentTax || 0)

  const totalDeduction = socialTotal + incomeTax + residentTax
  const netPay = gross - totalDeduction

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
    gross_pay: gross,
    health_insurance: health,
    long_term_care_insurance: care,
    pension_insurance: pension,
    employment_insurance: employment,
    income_tax: incomeTax,
    resident_tax: residentTax,
    other_deduction: 0,
    total_deduction: totalDeduction,
    net_pay: netPay,
    status: '未確定',
    note: null,
  }
}

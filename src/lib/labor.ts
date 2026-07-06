// ============================================================
// 労務管理の定数・権限・ユーティリティ
// ============================================================
import type { AttendanceRecord, Employee } from './types'

// --- 従業員マスタの選択肢 ---
export const EMPLOYMENT_TYPES = ['正社員', '契約社員', 'アルバイト', 'パート', '業務委託', '役員'] as const
export const EMPLOYEE_STATUSES = ['在籍中', '休職中', '退職済み'] as const
export const WORK_STYLES = ['固定勤務', 'シフト制', 'フレックス', '時短勤務', '在宅勤務', '直行直帰あり'] as const
export const ACCOUNT_TYPES = ['普通', '当座'] as const

/** 労務ロール（アプリの role とは別軸。従業員レコード側の権限区分） */
export const LABOR_ROLES = ['管理者', '労務管理者', 'マネージャー', '従業員', '社労士', '閲覧専用'] as const

// --- 勤怠 ---
export const ATTENDANCE_STATUSES = ['未出勤', '出勤中', '休憩中', '退勤済', '欠勤', '休暇', '在宅勤務', '直行直帰'] as const
export const WORK_LOCATION_TYPES = [
  { value: 'office', label: 'オフィス' },
  { value: 'remote', label: '在宅' },
  { value: 'direct', label: '直行直帰' },
] as const
/** 打刻種別 */
export const CLOCK_ACTIONS = ['出勤', '退勤', '休憩開始', '休憩終了', '直行', '直帰'] as const

// --- 休暇 ---
export const LEAVE_TYPES = ['有給', '半休', '時間休', '欠勤', '慶弔休暇', '産休', '育休', '介護休暇', '特別休暇'] as const

// --- 申請承認 ---
export const REQUEST_TYPES = [
  '打刻修正', '有給申請', '残業申請', '休日出勤申請', 'シフト変更', '遅刻申請',
  '早退申請', '欠勤申請', '交通費申請', '経費申請', '住所変更', '銀行口座変更',
] as const
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'canceled'] as const
export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: '承認待ち', approved: '承認済み', rejected: '却下', canceled: '取消',
}

// --- アラート ---
export const ALERT_TYPES = [
  '打刻漏れ', '退勤打刻忘れ', '残業超過', '週労働超過', '休憩不足', '連勤アラート',
  '深夜労働過多', '休日労働過多', '残業申請なし', '勤怠未締め',
  '有給5日未取得リスク', '有給残不足', '有給失効予定', '契約更新期限',
  '試用期間終了予定', '労務書類未提出',
] as const
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const
export const ALERT_SEVERITY_LABEL: Record<string, string> = {
  info: '情報', warning: '注意', critical: '重要',
}
export function alertSeverityColor(sev?: string | null): string {
  switch (sev) {
    case 'critical': return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
    case 'warning': return 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
    default: return 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'
  }
}

// --- 労務書類 ---
export const DOCUMENT_TYPES = [
  '雇用契約書', '労働条件通知書', '誓約書', '秘密保持契約書', '就業規則同意書',
  '入社書類', '退職書類', '給与辞令', '契約更新書類', '身元保証書',
] as const
export const DOCUMENT_STATUSES = ['未提出', '提出済み', '確認済み', '期限切れ', '差戻し'] as const

// --- シフト ---
export const SHIFT_TYPES = ['通常', '早番', '遅番', '夜勤', '休み', '希望'] as const
export const SHIFT_STATUSES = ['希望', '申請中', '確定', '変更申請中'] as const

// --- CSVフォーマット ---
export const CSV_FORMATS = [
  { value: 'generic', label: '汎用CSV' },
  { value: 'freee', label: 'freee' },
  { value: 'moneyforward', label: 'マネーフォワード' },
  { value: 'yayoi', label: '弥生給与' },
] as const

export function employeeStatusColor(status?: string | null): string {
  switch (status) {
    case '在籍中': return 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
    case '休職中': return 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
    case '退職済み': return 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700/60 dark:text-zinc-300'
    default: return 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300'
  }
}

export function attendanceStatusColor(status?: string | null): string {
  switch (status) {
    case '出勤中': return 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
    case '休憩中': return 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
    case '退勤済': return 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'
    case '欠勤': return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
    case '休暇': return 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
    default: return 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300'
  }
}

// ============================================================
// 権限（アプリのアカウントロール admin/manager/sales/viewer を労務向けに解釈）
// - admin        : 全閲覧・全編集
// - manager      : 労務管理者相当（従業員/勤怠/休暇/申請/書類/給与連携を管理）
// - sales/member : 従業員相当（自分の打刻・申請・勤怠確認のみ）
// - viewer       : 閲覧のみ（社労士/閲覧専用相当・CSV出力可）
// ============================================================
export interface LaborPerms {
  /** 労務管理画面（他人分含む）を閲覧できるか */
  canViewAll: boolean
  /** 従業員・勤怠・休暇・書類などを編集できるか */
  canManage: boolean
  /** 申請を承認/却下できるか */
  canApprove: boolean
  /** CSV出力できるか */
  canExport: boolean
  /** 労務設定・権限を変更できるか（管理者のみ） */
  canConfigure: boolean
  /** 自分の打刻・申請のみ（一般従業員） */
  selfOnly: boolean
}

export function laborPerms(role?: string | null): LaborPerms {
  const r = role || 'member'
  if (r === 'admin') {
    return { canViewAll: true, canManage: true, canApprove: true, canExport: true, canConfigure: true, selfOnly: false }
  }
  if (r === 'manager') {
    return { canViewAll: true, canManage: true, canApprove: true, canExport: true, canConfigure: false, selfOnly: false }
  }
  if (r === 'viewer') {
    return { canViewAll: true, canManage: false, canApprove: false, canExport: true, canConfigure: false, selfOnly: false }
  }
  // sales / member / その他 = 一般従業員
  return { canViewAll: false, canManage: false, canApprove: false, canExport: false, canConfigure: false, selfOnly: true }
}

// ============================================================
// 時刻・集計ユーティリティ
// ============================================================
export function minutesBetween(start?: string | null, end?: string | null): number {
  if (!start || !end) return 0
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 0
  return Math.round((e - s) / 60000)
}

/** 分 → "8h30m" 表記 */
export function fmtMinutes(min?: number | null): string {
  const m = Math.max(0, Math.round(min || 0))
  const h = Math.floor(m / 60)
  const r = m % 60
  return r === 0 ? `${h}h` : `${h}h${r}m`
}

/** HH:mm 表記（TIMESTAMPTZ から） */
export function fmtTime(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const LATE_NIGHT_START = 22 // 22:00
const LATE_NIGHT_END = 5 // 05:00

/**
 * 打刻レコードから実労働・残業・深夜を概算する（土台のためシンプルな概算）。
 * scheduledMinutes: その日の所定労働（分）。超過を残業とみなす。
 */
export function computeAttendance(
  rec: Pick<AttendanceRecord, 'clock_in_at' | 'clock_out_at' | 'break_start_at' | 'break_end_at' | 'total_break_minutes'>,
  scheduledMinutes = 480,
): { workMinutes: number; overtimeMinutes: number; lateNightMinutes: number; breakMinutes: number } {
  const gross = minutesBetween(rec.clock_in_at, rec.clock_out_at)
  const breakMin = rec.total_break_minutes ?? minutesBetween(rec.break_start_at, rec.break_end_at)
  const workMinutes = Math.max(0, gross - breakMin)
  const overtimeMinutes = Math.max(0, workMinutes - scheduledMinutes)

  // 深夜（22-5時）にかかる分を概算
  let lateNightMinutes = 0
  if (rec.clock_in_at && rec.clock_out_at) {
    const s = new Date(rec.clock_in_at)
    const e = new Date(rec.clock_out_at)
    for (let t = s.getTime(); t < e.getTime(); t += 60000) {
      const hr = new Date(t).getHours()
      if (hr >= LATE_NIGHT_START || hr < LATE_NIGHT_END) lateNightMinutes++
    }
  }
  return { workMinutes, overtimeMinutes, lateNightMinutes, breakMinutes: breakMin }
}

/** ローカル日付 YYYY-MM-DD */
export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 当月 YYYY-MM */
export function monthStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 従業員のフルタイム時給換算（人件費見込み用の粗い概算） */
export function estimateMonthlyCost(emp: Employee): number {
  if (emp.base_salary) return emp.base_salary
  if (emp.hourly_wage) {
    const days = emp.weekly_work_days ?? 5
    return Math.round(emp.hourly_wage * 8 * days * 4.3)
  }
  return 0
}

/** CSV セルのエスケープ */
export function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 2次元配列 → CSV文字列（BOM付きでExcel文字化け防止） */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
  return '﻿' + body
}

/** ブラウザでCSVダウンロード */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

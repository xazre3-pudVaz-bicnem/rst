import type { CallLog } from './types'

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

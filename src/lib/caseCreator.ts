// ============================================================
// リスト投入者（案件を架電リストへ入れた人）の解決ヘルパー。
//  cases には created_by_user_name（新）と created_by_name（旧）の2列があり、
//  cronのAI自動投入は人が介在しないためどちらも空になる。表示・絞り込みでは常にここを通す。
// ============================================================
import type { Case } from './types'

/** 人が投入していない（cron等のAI自動投入）案件のラベル */
export const AI_CREATOR_LABEL = 'AI自動投入'

export type CaseCreatorFields = Pick<Case, 'created_by_user_name' | 'created_by_name'>

/** 案件のリスト投入者名。人の記録が無ければ AI自動投入 を返す（空文字は返さない） */
export function creatorNameOf(c: CaseCreatorFields): string {
  return (c.created_by_user_name || c.created_by_name || '').trim() || AI_CREATOR_LABEL
}

/** 案件一覧に実在する投入者の一覧（五十音順。AI自動投入は末尾） */
export function creatorOptionsOf(cases: CaseCreatorFields[]): string[] {
  const names = Array.from(new Set(cases.map(creatorNameOf)))
  const people = names.filter((n) => n !== AI_CREATOR_LABEL).sort((a, b) => a.localeCompare(b, 'ja'))
  return names.includes(AI_CREATOR_LABEL) ? [...people, AI_CREATOR_LABEL] : people
}

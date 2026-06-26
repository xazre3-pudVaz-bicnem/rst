/**
 * CallLogFormModal の自動サマリー生成。
 * 接触/非接触で組み立てが変わる（MIGRATION_GUIDE 1.7）。
 */
export interface SummaryInput {
  contactType: '接触' | '非接触'
  repName?: string // 代表者名（接触時）
  receiverAttr?: string // 受電者属性（非接触時）
  gender?: string
  age?: string
  result?: string
}

export function generateSummary(input: SummaryInput): string {
  const { contactType, repName, receiverAttr, gender, age, result } = input

  if (contactType === '接触') {
    const who = repName?.trim() || '代表'
    const line1 = [who, gender, age].filter(Boolean).join(' ')
    return [line1, result].filter(Boolean).join('\n')
  }

  // 非接触
  const line1Parts = [receiverAttr, gender, age].filter(Boolean)
  const line1 = line1Parts.length > 0 ? line1Parts.join(' ') : '非接触'
  return [line1, result].filter(Boolean).join('\n')
}

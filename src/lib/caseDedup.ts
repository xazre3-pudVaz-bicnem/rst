// ============================================================
// 案件の電話番号重複チェック（サーバー専用）。
// 別々の探索経路（連番探索 / marketplace / SERP / エキテン / Instagram 等）から
// 同一店舗が二重に案件化されるのを防ぐ。保存形式（ハイフン有無）に依存せず、
// 数字の末尾10桁で確実に照合する。
// ============================================================

/** 電話番号から数字のみ抽出 */
function digitsOf(phone?: string | null): string {
  return String(phone || '').replace(/[^0-9]/g, '')
}

/**
 * 同一電話番号の既存案件IDを返す（無ければ null）。
 * @param admin Supabase(admin) クライアント
 * @param phone 照合したい電話番号（任意形式）
 */
export async function findCaseIdByPhone(admin: any, phone?: string | null): Promise<string | null> {
  const digits = digitsOf(phone)
  if (digits.length < 10) return null
  const dial = digits.slice(-10)
  const last4 = digits.slice(-4)
  // 候補をゆるく取得: eq(そのままの形式) ＋ 連続10桁ilike（数字のみ保存向け）＋ 末尾4桁ilike。
  // ※『03-1234-5678』等ハイフン付き保存は連続10桁のilikeに一致しない（重複を見逃して二重案件を作っていた）ため、
  //   ハイフンを跨がない末尾4桁の後方一致で粗く引き、下の数字正規化で厳密照合する。
  const { data } = await admin
    .from('cases')
    .select('id,phone1,phone2,phone3')
    .or(`phone1.eq.${phone},phone2.eq.${phone},phone3.eq.${phone},phone1.ilike.%${dial}%,phone1.ilike.%${last4},phone2.ilike.%${last4},phone3.ilike.%${last4}`)
    .limit(60)
  // 最終判定は数字末尾10桁の一致で確実に行う
  const hit = (data || []).find((c: any) =>
    [c.phone1, c.phone2, c.phone3].some((p) => digitsOf(p).slice(-10) === dial),
  )
  return hit?.id || null
}

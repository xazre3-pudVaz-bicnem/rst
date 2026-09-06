// ============================================================
// ユーザー（profiles）→ 従業員（employees）の自動同期。
//  方針: 営業担当は全員そのまま従業員として扱う。ユーザーを作れば従業員マスタにも必ず載る。
//  冪等: user_id で突き合わせ、無ければメール/氏名一致の既存行に user_id を付けてリンク、
//        それも無ければ新規作成する。employees(user_id) は部分ユニーク索引で二重作成を防止。
// ============================================================
import type { Profile } from './types'

/** アプリのアカウントロール → 労務ロール（employees.role） */
function laborRoleOf(role?: string | null): string {
  switch (role) {
    case 'admin': return '管理者'
    case 'manager': return '労務管理者'
    case 'viewer': return '閲覧専用'
    default: return '従業員'   // sales / member / 未設定
  }
}

/** profiles の表示名（従業員名に使う） */
export function profileDisplayName(p: Profile): string {
  return String(p.full_name || p.username || p.email || '').trim()
}

export interface EmployeeSyncResult {
  created: string[]   // 新規作成した従業員名
  linked: string[]    // 既存従業員に user_id を紐付けた名前
  skipped: number     // 既に紐付け済み
}

/**
 * profiles を employees へ同期する。
 * @param db supabase クライアント（画面のanonクライアント / スクリプトのservice roleどちらでも可）
 * @param opts.includeInactive 無効ユーザー（is_active=false）も対象にする（既定false）
 */
export async function syncEmployeesFromProfiles(
  db: any,
  opts: { includeInactive?: boolean } = {},
): Promise<EmployeeSyncResult> {
  const out: EmployeeSyncResult = { created: [], linked: [], skipped: 0 }

  const { data: profiles, error: pe } = await db.from('profiles').select('*').limit(500)
  if (pe) throw new Error(pe.message)
  const { data: employees, error: ee } = await db.from('employees').select('id,user_id,name,email').limit(2000)
  if (ee) throw new Error(ee.message)

  const byUserId = new Map<string, any>()
  const byEmail = new Map<string, any>()
  const byName = new Map<string, any>()
  for (const e of employees || []) {
    if (e.user_id) byUserId.set(e.user_id, e)
    if (e.email) byEmail.set(String(e.email).toLowerCase(), e)
    if (e.name) byName.set(String(e.name).trim(), e)
  }

  for (const p of (profiles || []) as Profile[]) {
    if (!opts.includeInactive && p.is_active === false) continue
    const name = profileDisplayName(p)
    if (!name) continue                       // 氏名もメールも無いプロフィールは作れない（employees.name は NOT NULL）
    if (byUserId.has(p.id)) { out.skipped++; continue }

    // ユーザー未紐付けの既存従業員（先に手入力していた場合）はメール→氏名の順で拾ってリンクする
    const existing = (p.email && byEmail.get(String(p.email).toLowerCase())) || byName.get(name)
    if (existing && !existing.user_id) {
      const { error } = await db.from('employees').update({ user_id: p.id, email: existing.email || p.email || null }).eq('id', existing.id)
      if (error) throw new Error(error.message)
      byUserId.set(p.id, existing)
      out.linked.push(name)
      continue
    }

    const { error } = await db.from('employees').insert({
      user_id: p.id,
      name,
      email: p.email || null,
      role: laborRoleOf(p.role),
      status: '在籍中',
      // 雇用形態・所定労働時間・締め支払日はテーブル既定値（正社員 / 09:00-18:00 / 休憩60分 / 週5 / 末締め25日払い）。
      // 実態と違う場合は従業員マスタで個別に直す。
    })
    if (error) throw new Error(error.message)
    out.created.push(name)
  }
  return out
}

// ============================================================
// POST /api/admin/users … 管理者専用のユーザー操作（action ディスパッチ）
//   action: 'list' | 'create' | 'reset-password' | 'approve' | 'reject'
// service role はサーバー側のみ。呼び出し元JWTで admin 判定（固定adminメール or role=admin）。
// Supabase Auth Admin API でユーザー作成/パスワード設定（平文保存しない）。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'

const FIXED_ADMIN_EMAIL = 'odaharuki129@gmail.com'

async function verifyAdmin(admin: any, token: string): Promise<{ ok: boolean; user?: any; error?: string }> {
  if (!token) return { ok: false, error: 'ログインが必要です' }
  const { data } = await admin.auth.getUser(token)
  const u = data?.user
  if (!u) return { ok: false, error: 'セッションが無効です' }
  if ((u.email || '').toLowerCase() === FIXED_ADMIN_EMAIL) return { ok: true, user: u }
  const { data: prof } = await admin.from('profiles').select('role').eq('id', u.id).maybeSingle()
  if (prof?.role === 'admin') return { ok: true, user: u }
  return { ok: false, error: '管理者権限が必要です' }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ ok: false, error: 'SUPABASE env 未設定' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const auth = await verifyAdmin(admin, token)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const action = body?.action

  try {
    if (action === 'list') {
      const { data, error } = await admin.from('profiles').select('*').order('created_date', { ascending: true })
      if (error) throw new Error(error.message)
      return res.status(200).json({ ok: true, users: data || [] })
    }

    if (action === 'create' || action === 'approve') {
      const email = String(body.email || '').trim().toLowerCase()
      const password = String(body.password || '')
      const display_name = String(body.display_name || '').trim()
      const username = String(body.username || '').trim()
      let role = String(body.role || 'sales')
      const is_sales_assignee = body.is_sales_assignee !== false
      if (!email || !password) return res.status(400).json({ ok: false, error: 'メールとパスワードは必須です' })
      if (password.length < 6) return res.status(400).json({ ok: false, error: 'パスワードは6文字以上にしてください' })
      if (email === FIXED_ADMIN_EMAIL) role = 'admin' // 固定adminは常にadmin

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: display_name || email },
      })
      if (cErr) return res.status(200).json({ ok: false, error: 'Auth作成に失敗: ' + cErr.message })
      const uid = created?.user?.id
      if (uid) {
        await admin.from('profiles').upsert({
          id: uid, email, full_name: display_name || null, username: username || null,
          role, is_active: true, is_sales_assignee, created_by: auth.user.id, updated_date: new Date().toISOString(),
        }, { onConflict: 'id' })
      }
      if (body.requestId) await admin.from('signup_requests').update({ status: 'approved' }).eq('id', body.requestId)
      return res.status(200).json({ ok: true, action: 'create', userId: uid, email })
    }

    if (action === 'reset-password') {
      const userId = String(body.userId || '')
      const password = String(body.password || '')
      if (!userId || password.length < 6) return res.status(400).json({ ok: false, error: 'userId と6文字以上のパスワードが必要です' })
      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) return res.status(200).json({ ok: false, error: error.message })
      return res.status(200).json({ ok: true, action: 'reset-password', userId })
    }

    if (action === 'reject') {
      const requestId = String(body.requestId || '')
      if (!requestId) return res.status(400).json({ ok: false, error: 'requestId が必要です' })
      await admin.from('signup_requests').update({ status: 'rejected' }).eq('id', requestId)
      return res.status(200).json({ ok: true, action: 'reject', requestId })
    }

    return res.status(400).json({ ok: false, error: '不明な action です' })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return {} } }

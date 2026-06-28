// ============================================================
// GET  /api/admin/regional-media/sources … 一覧＋件数
// POST /api/admin/regional-media/sources … 追加/更新（base_urlでupsert）
//   body.action='seed' で初期ソースを一括upsert
// 認可: X-Admin-Secret(=ADMIN_SECRET/CRON_SECRET) もしくは ログインJWT。
// 書き込みは service role（サーバー側のみ）。
// ============================================================
import { getAdminClient } from '../../../src/lib/googlePlacesRun.js'
import { authorizeAdmin, sanitizeSitePayload, normalizeUrl, INITIAL_SOURCES } from '../../../src/lib/regionalAdmin.js'

export default async function handler(req: any, res: any) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(400).json({ ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定' })
  }
  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  const auth = await authorizeAdmin(admin, req.headers)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  if (req.method === 'GET') {
    const { data, error } = await admin.from('source_sites').select('*').order('is_active', { ascending: false }).order('reliability_score', { ascending: false }).order('name')
    if (error) return res.status(200).json({ ok: false, error: error.message, sources: [], sites: [], total: 0, active: 0, inactive: 0 })
    const sites = data || []
    const active = sites.filter((s: any) => s.is_active).length
    // sources/sites は同一配列（呼び出し側互換のため両方返す）
    return res.status(200).json({ ok: true, sources: sites, sites, total: sites.length, active, inactive: sites.length - active })
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})

    // 初期ソース一括登録（base_url重複はupsert＝エラーにしない）
    if (body?.action === 'seed') {
      const rows = INITIAL_SOURCES.map((s) => ({ ...s, base_url: normalizeUrl(s.base_url), list_url: normalizeUrl(s.list_url), updated_at: new Date().toISOString() }))
      const { error } = await admin.from('source_sites').upsert(rows, { onConflict: 'base_url' })
      if (error) return res.status(200).json({ ok: false, error: error.message })
      const { count: active } = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true)
      return res.status(200).json({ ok: true, action: 'seed', upserted: rows.length, seeded: rows.length, active: active || 0 })
    }

    const sane = sanitizeSitePayload(body)
    if (!sane.ok) return res.status(400).json({ ok: false, error: sane.error })
    const { error, data } = await admin.from('source_sites')
      .upsert({ ...sane.value, updated_at: new Date().toISOString() }, { onConflict: 'base_url' })
      .select('id').single()
    if (error) return res.status(200).json({ ok: false, error: error.message })
    return res.status(200).json({ ok: true, id: data?.id })
  }

  return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return {} } }

// ============================================================
// PATCH /api/admin/regional-media/sources/:id … 編集（is_active切替/list_url/信頼度 等）
// 認可: X-Admin-Secret もしくは ログインJWT。削除は不可（is_active=falseで無効化）。
// ============================================================
import { getAdminClient } from '../../../../src/lib/googlePlacesRun.js'
import { authorizeAdmin, normalizeUrl, isValidHttpUrl, MEDIA_FAMILIES, SOURCE_TYPES, CATEGORY_LABELS } from '../../../../src/lib/regionalAdmin.js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'PATCH') return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ ok: false, error: 'SUPABASE env 未設定' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  const auth = await authorizeAdmin(admin, req.headers)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  const id = String(req.query?.id || '')
  if (!id) return res.status(400).json({ ok: false, error: 'id が必要です' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const patch: any = { updated_at: new Date().toISOString() }
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
  if (typeof body.list_url === 'string') {
    const lu = normalizeUrl(body.list_url)
    if (lu && !isValidHttpUrl(lu)) return res.status(400).json({ ok: false, error: 'list_url が不正です' })
    patch.list_url = lu || null
  }
  if (body.reliability_score != null) patch.reliability_score = Math.max(0, Math.min(100, Number(body.reliability_score) || 0))
  if (body.crawl_interval_hours != null) patch.crawl_interval_hours = Math.max(1, Number(body.crawl_interval_hours) || 24)
  if (MEDIA_FAMILIES.includes(body.media_family)) patch.media_family = body.media_family
  if (SOURCE_TYPES.includes(body.source_type)) patch.source_type = body.source_type
  if (CATEGORY_LABELS.includes(body.category_label)) patch.category_label = body.category_label

  const { error } = await admin.from('source_sites').update(patch).eq('id', id)
  if (error) return res.status(200).json({ ok: false, error: error.message })
  return res.status(200).json({ ok: true, id, patched: Object.keys(patch).filter((k) => k !== 'updated_at') })
}

function safeParse(s: string) { try { return JSON.parse(s) } catch { return {} } }

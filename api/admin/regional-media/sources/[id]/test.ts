// ============================================================
// POST /api/admin/regional-media/sources/:id/test … そのサイトだけ巡回テスト
// DB書き込みなし・cases投入なし。記事URL/タイトル/公開日/3日以内/新店判定を返す。
// ============================================================
import { getAdminClient } from '../../../../../src/lib/googlePlacesRun.js'
import { authorizeAdmin } from '../../../../../src/lib/regionalAdmin.js'
import { testCrawlSite } from '../../../../../src/lib/regionalMediaRun.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ ok: false, error: 'SUPABASE env 未設定' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  const auth = await authorizeAdmin(admin, req.headers)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  const id = String(req.query?.id || '')
  if (!id) return res.status(400).json({ ok: false, error: 'id が必要です' })

  const { data: site, error } = await admin.from('source_sites').select('*').eq('id', id).maybeSingle()
  if (error) return res.status(200).json({ ok: false, error: error.message })
  if (!site) return res.status(404).json({ ok: false, error: 'サイトが見つかりません' })

  try {
    const result = await testCrawlSite(site, 8, 3)
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

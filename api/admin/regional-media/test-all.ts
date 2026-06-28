// ============================================================
// POST /api/admin/regional-media/test-all … 全有効サイトをテスト巡回
// DB書き込みなし・cases投入なし。集計と各サイトの成否を返す。
// ============================================================
import { getAdminClient } from '../../../src/lib/googlePlacesRun.js'
import { authorizeAdmin } from '../../../src/lib/regionalAdmin.js'
import { testCrawlAll } from '../../../src/lib/regionalMediaRun.js'

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(400).json({ ok: false, error: 'SUPABASE env 未設定' })

  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  const auth = await authorizeAdmin(admin, req.headers)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  try {
    const result = await testCrawlAll(admin, 5, 3)
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

// ============================================================
// /api/cron/auto-lead-crawl … 全取得元の自動巡回（2時間おき Cron / 手動実行 共通）
//   - Cron(Vercel): GET ＋ Authorization: Bearer ${CRON_SECRET} もしくは ?secret=${CRON_SECRET}
//   - 手動(UI):     POST ＋ Authorization: Bearer <ユーザーJWT>（要ログイン）。?only= / body.only で取得元を限定
// 取得元: Google Places / 地域メディア(全サイト) / Instagram Web / 連番URL探索(全有効ソース)
// ロジックは UI の個別実行と同じ run 関数を共通利用（二重化しない）。詳細は src/lib/autoCrawl.ts。
// Vercel Pro: vercel.json で2時間おき（0 23,1,3,5,7,9 * * * = JST 8/10/12/14/16/18時）・maxDuration 300s。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { runAutoCrawl, type CrawlOnly } from '../../src/lib/autoCrawl.js'

export const config = { maxDuration: 300 }

const VALID_ONLY: CrawlOnly[] = ['all', 'places', 'regional', 'instagram', 'sequential', 'failed']

export default async function handler(req: any, res: any) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(400).json({ ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です' })
  }
  let admin: any
  try { admin = getAdminClient() } catch (e: any) { return res.status(500).json({ ok: false, error: String(e?.message || e) }) }

  const secret = process.env.CRON_SECRET
  const auth = String(req.headers.authorization || '')
  const qsecret = String(req.query?.secret || '')
  const isCron = !!secret && (auth === `Bearer ${secret}` || qsecret === secret)

  let trigger: 'cron' | 'manual' = 'cron'
  let userId: string | null = null

  if (!isCron) {
    // 手動実行: ユーザーJWTを検証（CRON_SECRETを知らない外部からは叩けない）
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ ok: false, error: 'unauthorized（CRON_SECRET もしくは ログインが必要です）' })
    const { data: userData } = await admin.auth.getUser(token)
    if (!userData?.user) return res.status(401).json({ ok: false, error: 'unauthorized（セッション切れの可能性）' })
    trigger = 'manual'
    userId = userData.user.id
  }

  const onlyRaw = String((req.body && req.body.only) || req.query?.only || 'all')
  const only: CrawlOnly = (VALID_ONLY as string[]).includes(onlyRaw) ? (onlyRaw as CrawlOnly) : 'all'

  try {
    const result = await runAutoCrawl(admin, process.env, { trigger, only, userId })
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

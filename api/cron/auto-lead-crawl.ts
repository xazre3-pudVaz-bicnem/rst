// ============================================================
// /api/cron/auto-lead-crawl … 全取得元の自動巡回（2時間おき Cron / 手動実行 共通）
//   - Cron(Vercel): GET ＋ Authorization: Bearer ${CRON_SECRET} もしくは ?secret=${CRON_SECRET}
//   - 手動(UI):     POST ＋ Authorization: Bearer <ユーザーJWT>（要ログイン）。?only= / body.only で取得元を限定
// 取得元: Google Places / 地域メディア(全サイト) / Instagram Web / 連番URL探索(全有効ソース)
// ついでに「退勤打刻忘れの自動退勤」も毎回チェックする（20分おきに回るため、
// 専用のCronを増やさずに締め時刻を過ぎた勤怠を閉じられる。Vercelの関数数制限を増やさない）。
// ロジックは UI の個別実行と同じ run 関数を共通利用（二重化しない）。詳細は src/lib/autoCrawl.ts。
// Vercel Pro: vercel.json で2時間おき終日（0 */2 * * *＝1日12回）・maxDuration 300s。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { runAutoCrawl, type CrawlOnly } from '../../src/lib/autoCrawl.js'
import { runAutoClockOut } from '../../src/lib/autoClockOut.js'

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
    // 自動退勤は巡回より先に。巡回が時間切れになっても勤怠は閉じるようにする。
    const clockOut = await runAutoClockOut(admin).catch((e: any) => ({ ok: false, closed: 0, details: [], error: String(e?.message || e) }))
    const result = await runAutoCrawl(admin, process.env, { trigger, only, userId })
    return res.status(200).json({ ...result, autoClockOut: { closed: clockOut.closed, skipped: (clockOut as any).skipped, error: clockOut.error } })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}

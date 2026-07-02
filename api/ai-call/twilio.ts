// ============================================================
// /api/ai-call/twilio … AIテレアポ Twilio実発信（サーバー専用・12関数枠内で1関数に集約）
//   GET                       … 接続状態（configured / provider / 未設定env）。秘密は返さない。
//   POST ?action=start        … 要ログイン(管理者)。テスト番号へ1件発信。ai_call_jobs作成→Twilio発信。
//   POST ?action=twiml        … Twilioが通話時に取得するTwiML(固定メッセージ)。認証なし。
//   POST ?action=callback     … Twilioの状態通知(開始/終了/通話時間/失敗)。ai_call_jobsへ保存。認証なし。
// 安全: AI_CALL_PROVIDER=twilio かつ Twilio環境変数が揃うときのみ実発信。NG案件は発信不可。二重発信防止。
// まずは管理者が指定したテスト番号への1件発信のみ（営業リスト一括発信は未実装）。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { getProviderMode, isTwilioConfigured, missingTwilioEnv, initiateTwilioCall, buildTwiml, mapTwilioStatus, preflight } from '../../src/lib/twilioCall.js'

export const config = { maxDuration: 30 }

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

function baseUrl(req: any): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}
function formBody(req: any): Record<string, string> {
  const b = req.body
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b as any
  const raw = typeof b === 'string' ? b : ''
  const out: Record<string, string> = {}
  new URLSearchParams(raw).forEach((v, k) => { out[k] = v })
  return out
}

export default async function handler(req: any, res: any) {
  const action = String(req.query?.action || '')

  // ---- 接続状態（秘密は返さない。マスク済みデバッグ＋検証結果を返す） ----
  if (req.method === 'GET') {
    const pf = preflight('') // toは空だが from/SID の検証とマスク情報を得る
    return res.status(200).json({
      ok: true, provider: getProviderMode(), configured: isTwilioConfigured(),
      missingEnv: missingTwilioEnv(), realCallEnabled: getProviderMode() === 'twilio' && isTwilioConfigured(),
      fromEnvUsed: pf.debug.fromEnvUsed, accountSidMasked: pf.debug.accountSidMasked, from: pf.debug.from,
      checks: { sidPrefixOk: pf.debug.sidPrefixOk, sidLenOk: pf.debug.sidLenOk, sidLen: pf.debug.sidLen, tokenPresent: pf.debug.tokenPresent, tokenLen: pf.debug.tokenLen, fromE164: pf.debug.fromE164 },
    })
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' })

  // ---- Twilioが呼ぶTwiML（認証なし・固定メッセージ） ----
  if (action === 'twiml') {
    const msg = String(req.query?.msg || 'こちらはアールエスティーのテスト発信です。')
    res.setHeader('Content-Type', 'text/xml; charset=utf-8')
    return res.status(200).send(buildTwiml(msg))
  }

  const admin = (() => { try { return getAdminClient() } catch { return null } })()
  if (!admin) return res.status(500).json({ ok: false, error: 'SUPABASE未設定（サーバー）' })

  // ---- Twilioの状態通知（認証なし・CallSidで既存ジョブに紐付け） ----
  if (action === 'callback') {
    const b = formBody(req)
    const sid = b.CallSid
    const jobId = String(req.query?.jobId || '')
    if (!sid && !jobId) return res.status(200).json({ ok: true })
    const status = mapTwilioStatus(b.CallStatus)
    const durationSec = b.CallDuration ? Number(b.CallDuration) : null
    const patch: any = { status, updated_date: new Date().toISOString() }
    if (durationSec != null && !Number.isNaN(durationSec)) patch.duration_sec = durationSec
    if (b.CallStatus) patch.provider_call_sid = sid
    if (['failed', 'busy', 'no-answer', 'canceled'].includes(String(b.CallStatus).toLowerCase())) patch.error = `Twilio: ${b.CallStatus}${b.ErrorMessage ? ' / ' + b.ErrorMessage : ''}`
    // ai_summary/next_action はモックのようなAI要約が無いため、実結果の素の情報を要約に入れる
    if (String(b.CallStatus).toLowerCase() === 'completed') patch.ai_summary = `Twilio実通話 完了（${durationSec ?? '?'}秒）。文字起こし/要約は音声AI接続後に反映。`
    const q = admin.from('ai_call_jobs').update(patch)
    const { error } = jobId ? await q.eq('id', jobId) : await q.eq('provider_call_sid', sid)
    if (error) return res.status(200).json({ ok: false, error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ---- テスト発信（要管理者） ----
  if (action === 'start') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const auth = await verifyAdmin(admin, token)
    if (!auth.ok) return res.status(auth.error === '管理者権限が必要です' ? 403 : 401).json({ ok: false, error: auth.error })

    // 安全: providerがtwilioでなければ実発信しない（既定mockのまま）
    if (getProviderMode() !== 'twilio') {
      return res.status(400).json({ ok: false, error: 'AI_CALL_PROVIDER=mock のため実発信しません。Vercelで AI_CALL_PROVIDER=twilio に設定してください。' })
    }
    if (!isTwilioConfigured()) {
      return res.status(400).json({ ok: false, error: `Twilio環境変数が未設定です: ${missingTwilioEnv().join(', ')}（Vercelに設定して再デプロイ）` })
    }

    const b = req.body || {}
    const phone = String(b.phone || '').trim()
    const caseId = b.caseId ? String(b.caseId) : null
    const message = String(b.message || 'こちらはアールエスティーのテスト発信です。').slice(0, 300)
    // 送信直前チェック（SID/token/from/to）。失敗はマスク済みデバッグ付きで返す。
    const pf = preflight(phone)
    if (!pf.ok) return res.status(400).json({ ok: false, error: '発信前チェックに失敗しました', errors: pf.errors, debug: pf.debug })

    // NG案件には発信しない
    if (caseId) {
      const { data: kase } = await admin.from('cases').select('do_not_call,name').eq('id', caseId).maybeSingle()
      if (kase?.do_not_call) return res.status(400).json({ ok: false, error: 'この案件はNG指定のため発信できません。' })
    }
    // 二重発信防止: 同番号で発信中ジョブが直近90秒以内にあれば拒否
    const since = new Date(Date.now() - 90_000).toISOString()
    const { data: dup } = await admin.from('ai_call_jobs').select('id').eq('phone', phone).eq('status', '発信中').gte('created_date', since).limit(1)
    if (dup?.[0]) return res.status(409).json({ ok: false, error: '同じ番号への発信が進行中です。完了までお待ちください。' })

    // 発信中ジョブ作成
    const nowIso = new Date().toISOString()
    const { data: job, error: je } = await admin.from('ai_call_jobs').insert({
      case_id: caseId, case_name: caseId ? null : 'Twilio接続テスト', phone, status: '発信中', provider: 'twilio', called_at: nowIso, created_by_id: auth.user.id,
    }).select('id').single()
    if (je || !job) return res.status(500).json({ ok: false, error: je?.message || 'ジョブ作成に失敗' })

    // Twilio発信（公式SDK・TwiMLはインライン、状態通知は自ドメイン＋jobId）
    const cbUrl = `${baseUrl(req)}/api/ai-call/twilio?action=callback&jobId=${job.id}`
    const r = await initiateTwilioCall({ toRaw: phone, twiml: buildTwiml(message), statusCallbackUrl: cbUrl })
    if (!r.ok) {
      await admin.from('ai_call_jobs').update({ status: '通話完了', error: String(r.error).slice(0, 300), updated_date: nowIso }).eq('id', job.id).then(() => {}, () => {})
      return res.status(r.status || r.code ? 502 : 400).json({ ok: false, error: r.error, code: r.code, status: r.status, moreInfo: r.moreInfo, detail: r.detail, debug: r.debug, jobId: job.id })
    }
    await admin.from('ai_call_jobs').update({ provider_call_sid: r.sid, updated_date: nowIso }).eq('id', job.id).then(() => {}, () => {})
    return res.status(200).json({ ok: true, jobId: job.id, sid: r.sid, to: r.debug.to, debug: r.debug })
  }

  return res.status(400).json({ ok: false, error: '不明なaction' })
}

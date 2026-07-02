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
import { getProviderMode, isTwilioConfigured, missingTwilioEnv, initiateTwilioCall, buildTwiml, mapTwilioStatus, preflight, transcribeRecording, summarizeTranscript, isTranscriptionConfigured, isSummaryConfigured, missingVoiceAiEnv, transcriptionProvider, summaryProvider } from '../../src/lib/twilioCall.js'

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
      // 音声AI（録音→文字起こし→AI要約）の設定状況
      voiceAi: { transcription: isTranscriptionConfigured(), summary: isSummaryConfigured(), transcriptionProvider: transcriptionProvider(), summaryProvider: summaryProvider(), missingEnv: missingVoiceAiEnv() },
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
    // 実通話の素の結果を要約欄に記録（文字起こし/AI要約は未使用）
    if (String(b.CallStatus).toLowerCase() === 'completed') patch.ai_summary = `Twilio実通話 完了（${durationSec ?? '?'}秒）`
    const q = admin.from('ai_call_jobs').update(patch)
    const { error } = jobId ? await q.eq('id', jobId) : await q.eq('provider_call_sid', sid)
    if (error) return res.status(200).json({ ok: false, error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ---- Twilio録音完了通知（認証なし・jobIdで紐付け。録音URL/SID/秒数を保存） ----
  if (action === 'recording') {
    const b = formBody(req)
    const jobId = String(req.query?.jobId || '')
    if (!jobId) return res.status(200).json({ ok: true })
    const patch: any = { updated_date: new Date().toISOString() }
    if (String(b.RecordingStatus || '').toLowerCase() === 'completed' && b.RecordingUrl) {
      patch.recording_url = b.RecordingUrl
      patch.recording_sid = b.RecordingSid || null
      patch.recording_duration_sec = b.RecordingDuration ? Number(b.RecordingDuration) : null
      patch.processing_status = '未処理'
    } else if (b.RecordingStatus && String(b.RecordingStatus).toLowerCase() !== 'completed') {
      patch.recording_error = `録音ステータス: ${b.RecordingStatus}`
    }
    await admin.from('ai_call_jobs').update(patch).eq('id', jobId).then(() => {}, () => {})
    return res.status(200).json({ ok: true })
  }

  // ---- 録音プロキシ（要ログイン）。Twilio Basic認証はサーバーのみ。ブラウザにトークンを出さない。 ----
  if (action === 'recording-audio') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ ok: false, error: 'ログインが必要です' })
    const { data: ud } = await admin.auth.getUser(token)
    if (!ud?.user) return res.status(401).json({ ok: false, error: 'セッションが無効です' })
    const jobId = String(req.query?.jobId || (req.body && req.body.jobId) || '')
    if (!jobId) return res.status(400).json({ ok: false, error: 'jobId がありません' })
    const { data: job } = await admin.from('ai_call_jobs').select('recording_url').eq('id', jobId).maybeSingle()
    const recUrl = job?.recording_url
    if (!recUrl) return res.status(404).json({ ok: false, error: 'この通話に録音がありません（通話完了後に録音コールバックが必要）' })
    if (!isTwilioConfigured()) return res.status(400).json({ ok: false, error: `Twilio環境変数が未設定です: ${missingTwilioEnv().join(', ')}` })
    try {
      const sid = String(process.env.TWILIO_ACCOUNT_SID).trim(), tok = String(process.env.TWILIO_AUTH_TOKEN).trim()
      const mp3 = String(recUrl).endsWith('.mp3') || String(recUrl).endsWith('.wav') ? String(recUrl) : String(recUrl) + '.mp3'
      const aRes = await fetch(mp3, { headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') } })
      if (!aRes.ok) return res.status(502).json({ ok: false, error: `録音取得に失敗しました（Twilio HTTP ${aRes.status}）。${aRes.status === 401 || aRes.status === 403 ? '認証情報(SID/Token)を確認してください。' : aRes.status === 404 ? '録音がまだ生成されていない/削除された可能性があります。' : ''}`, status: aRes.status })
      const buf = Buffer.from(await aRes.arrayBuffer())
      res.setHeader('Content-Type', aRes.headers.get('content-type') || 'audio/mpeg')
      res.setHeader('Content-Disposition', 'inline; filename="recording.mp3"')
      res.setHeader('Cache-Control', 'private, max-age=300')
      return res.status(200).send(buf)
    } catch (e: any) { return res.status(502).json({ ok: false, error: '録音取得中にエラー: ' + String(e?.message || e) }) }
  }

  // ---- 文字起こし＆AI要約の実行（要管理者・手動トリガー） ----
  if (action === 'process') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const auth = await verifyAdmin(admin, token)
    if (!auth.ok) return res.status(auth.error === '管理者権限が必要です' ? 403 : 401).json({ ok: false, error: auth.error })
    const jobId = String((req.body && req.body.jobId) || '')
    if (!jobId) return res.status(400).json({ ok: false, error: 'jobId がありません' })
    const { data: job } = await admin.from('ai_call_jobs').select('id,recording_url,transcript,case_name,provider').eq('id', jobId).maybeSingle()
    if (!job) return res.status(404).json({ ok: false, error: 'ジョブが見つかりません' })
    if (!isTranscriptionConfigured() && !isSummaryConfigured()) {
      await admin.from('ai_call_jobs').update({ processing_status: '未設定', processing_error: `音声AI未設定: ${missingVoiceAiEnv().join(', ')}` }).eq('id', jobId)
      return res.status(400).json({ ok: false, error: `音声AI未設定です: ${missingVoiceAiEnv().join(', ')}（Vercelに設定して再デプロイ）` })
    }
    await admin.from('ai_call_jobs').update({ processing_status: '処理中', processing_error: null }).eq('id', jobId).then(() => {}, () => {})

    // 1) 文字起こし（録音があれば）。既存transcriptがモック注記のみの場合も上書き。
    let transcript = String(job.transcript || '')
    let transError: string | null = null
    if (job.recording_url && isTranscriptionConfigured()) {
      const tr = await transcribeRecording(String(job.recording_url))
      if (tr.ok && tr.text) transcript = tr.text
      else transError = tr.error || '文字起こし失敗'
    } else if (!job.recording_url) {
      transError = '録音がありません（通話完了後に録音コールバックが必要）'
    }

    // 2) AI要約・温度感・推奨ステータス
    const patch: any = { transcript: transcript || null, updated_date: new Date().toISOString() }
    if (transError) patch.processing_error = transError
    if (transcript && transcript.trim().length >= 5 && isSummaryConfigured()) {
      const sm = await summarizeTranscript(transcript, job.case_name || undefined)
      if (sm.ok && sm.data) {
        patch.ai_summary = sm.data.summary || null
        patch.ai_reaction = sm.data.reaction || null
        patch.temperature = sm.data.temperature || null
        patch.next_action = sm.data.next_action || null
        patch.ai_needs_recall = sm.data.needs_recall
        patch.ai_should_ng = sm.data.should_ng
        patch.recommended_status = sm.data.recommended_status || null
        patch.processing_status = '完了'
      } else {
        patch.processing_status = '失敗'
        patch.processing_error = [transError, sm.error].filter(Boolean).join(' / ')
      }
    } else {
      patch.processing_status = transError ? '失敗' : '完了'
    }
    await admin.from('ai_call_jobs').update(patch).eq('id', jobId)
    const { data: updated } = await admin.from('ai_call_jobs').select('*').eq('id', jobId).maybeSingle()
    return res.status(200).json({ ok: !patch.processing_error || patch.processing_status === '完了', job: updated, error: patch.processing_error || null })
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
    const phone = String(b.phone || '').trim()          // 案件フロー: 案件の電話番号（記録用の意図した発信先）
    const caseId = b.caseId ? String(b.caseId) : null
    const testMode = b.testMode !== false               // 既定ON（安全側）。ONなら実際は testNumber へ差し替え
    const testNumber = String(b.testNumber || '').trim()
    const message = String(b.message || 'こちらはアールエスティーのテスト発信です。').slice(0, 300)

    // 案件フロー(caseId)ではテストモードON時に発信先を管理者テスト番号へ差し替える。
    // 接続テスト(caseIdなし)は phone をそのまま発信。
    const intended = phone                              // ログに残す「本来の発信先」
    const dial = (caseId && testMode) ? testNumber : phone   // Twilioが実際にダイヤルする番号
    if (caseId && testMode && !testNumber) return res.status(400).json({ ok: false, error: 'テストモードONです。差し替え先のテスト番号（あなたの番号）を入力してください。' })
    if (!intended) return res.status(400).json({ ok: false, error: '発信先の電話番号がありません。' })

    // 送信直前チェックは「実際にダイヤルする番号(dial)」で行う。失敗はマスク済みデバッグ付き。
    const pf = preflight(dial)
    if (!pf.ok) return res.status(400).json({ ok: false, error: '発信前チェックに失敗しました', errors: pf.errors, debug: pf.debug })

    // NG案件には絶対に発信しない
    let caseName: string | null = caseId ? null : 'Twilio接続テスト'
    if (caseId) {
      const { data: kase } = await admin.from('cases').select('do_not_call,name').eq('id', caseId).maybeSingle()
      if (kase?.do_not_call) return res.status(400).json({ ok: false, error: 'この案件はNG指定のため発信できません。' })
      caseName = kase?.name ?? null
    }
    // 二重発信防止: 同じ「本来の発信先」で発信中ジョブが直近90秒以内にあれば拒否
    const since = new Date(Date.now() - 90_000).toISOString()
    const { data: dup } = await admin.from('ai_call_jobs').select('id').eq('phone', intended).eq('status', '発信中').gte('created_date', since).limit(1)
    if (dup?.[0]) return res.status(409).json({ ok: false, error: '同じ番号への発信が進行中です。完了までお待ちください。' })

    // 発信中ジョブ作成（案件に紐付け・phoneは本来の発信先を記録）
    const nowIso = new Date().toISOString()
    const redirectNote = (caseId && testMode) ? `※テストモード: 実際の発信先は ${dial}（案件番号 ${intended} には発信していません）` : ''
    const { data: job, error: je } = await admin.from('ai_call_jobs').insert({
      case_id: caseId, case_name: caseName, phone: intended, status: '発信中', provider: 'twilio', called_at: nowIso, created_by_id: auth.user.id,
      transcript: redirectNote || null,
    }).select('id').single()
    if (je || !job) return res.status(500).json({ ok: false, error: je?.message || 'ジョブ作成に失敗' })

    // Twilio発信（公式SDK・TwiMLはインライン、状態通知＋録音完了通知は自ドメイン＋jobId）
    const base = baseUrl(req)
    const cbUrl = `${base}/api/ai-call/twilio?action=callback&jobId=${job.id}`
    const recUrl = `${base}/api/ai-call/twilio?action=recording&jobId=${job.id}`
    const r = await initiateTwilioCall({ toRaw: dial, twiml: buildTwiml(message), statusCallbackUrl: cbUrl, recordingCallbackUrl: recUrl })
    if (!r.ok) {
      await admin.from('ai_call_jobs').update({ status: '通話完了', error: String(r.error).slice(0, 300), updated_date: nowIso }).eq('id', job.id).then(() => {}, () => {})
      return res.status(r.status || r.code ? 502 : 400).json({ ok: false, error: r.error, code: r.code, status: r.status, moreInfo: r.moreInfo, detail: r.detail, guidance: r.guidance, debug: r.debug, jobId: job.id })
    }
    await admin.from('ai_call_jobs').update({ provider_call_sid: r.sid, updated_date: nowIso }).eq('id', job.id).then(() => {}, () => {})
    return res.status(200).json({ ok: true, jobId: job.id, sid: r.sid, to: r.debug.to, intended, redirected: !!(caseId && testMode), debug: r.debug })
  }

  return res.status(400).json({ ok: false, error: '不明なaction' })
}

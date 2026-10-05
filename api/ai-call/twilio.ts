// ============================================================
// /api/ai-call/twilio … AIテレアポ Twilio実発信（サーバー専用・12関数枠内で1関数に集約）
//   GET                       … 接続状態（configured / provider / 未設定env）。秘密は返さない。
//   POST ?action=start        … 要ログイン(管理者)。テスト番号へ1件発信。ai_call_jobs作成→Twilio発信。
//   POST ?action=twiml        … Twilioが通話時に取得するTwiML(固定メッセージ)。認証なし。
//   POST ?action=callback     … Twilioの状態通知(開始/終了/通話時間/失敗)。ai_call_jobsへ保存。認証なし。
//   POST ?action=dialer-*     … パワーダイヤラー（繋がるまで自動・話すのは人）。dialer_sessions で進行管理。
// 安全: AI_CALL_PROVIDER=twilio かつ Twilio環境変数が揃うときのみ実発信。NG案件は発信不可。二重発信防止。
// まずは管理者が指定したテスト番号への1件発信のみ（営業リスト一括発信は未実装）。
// ============================================================
import { getAdminClient } from '../../src/lib/googlePlacesRun.js'
import { getProviderMode, isTwilioConfigured, missingTwilioEnv, initiateTwilioCall, buildTwiml, mapTwilioStatus, preflight, transcribeRecording, summarizeTranscript, isTranscriptionConfigured, isSummaryConfigured, missingVoiceAiEnv, transcriptionProvider, summaryProvider, getCallMode, isRealtimeConfigured, isRealtimeAvailable, realtimeServerUrlMasked, buildStreamTwiml, buildConferenceTwiml, buildHangupTwiml, hangupTwilioCall, isHumanAnswer, createVoiceToken, browserIdentity, isBrowserVoiceConfigured, missingBrowserVoiceEnv } from '../../src/lib/twilioCall.js'
import { createCalendarEvent, getAvailableSlots, isCalendarConfigured } from '../../src/lib/googleCalendar.js'
import { isCallBlocked, CALL_BLOCKED_MESSAGE } from '../../src/lib/constants.js'

// サーバー間シークレット認証（realtime音声サーバーからのツール呼び出し用）
function verifyServerSecret(req: any): boolean {
  const s = String(process.env.AI_CALL_SERVER_SECRET || '')
  return !!s && String(req.headers.authorization || '') === `Bearer ${s}`
}

// realtime音声AIに渡すトークスクリプトを解決する。job.script_id を優先、無ければ既定(is_default)。
// 構造化した全項目を返す（realtimeサーバーが固定ガードレールと合成してinstructionsを組む）。
const SCRIPT_FIELDS = 'id,name,target_product,opening_talk,contact_talk,reception_talk,interest_talk,pricing_answer,rejection_handling,absent_handling,appointment_confirm_talk,ng_words,forbidden_actions,conversation_goal,temperature_rule,appointment_rule'
async function resolveScript(admin: any, jobId: string | null): Promise<any | null> {
  try {
    let scriptId: string | null = null
    if (jobId) { const { data: j } = await admin.from('ai_call_jobs').select('script_id').eq('id', jobId).maybeSingle(); scriptId = j?.script_id || null }
    if (scriptId) {
      const { data: s } = await admin.from('ai_call_scripts').select(SCRIPT_FIELDS).eq('id', scriptId).eq('is_active', true).maybeSingle()
      if (s) return s
    }
    const { data: def } = await admin.from('ai_call_scripts').select(SCRIPT_FIELDS).eq('is_active', true).order('is_default', { ascending: false }).order('updated_date', { ascending: false }).limit(1)
    return def?.[0] || null
  } catch { return null }
}

// AIが渡す日時はTZ未指定(例 "2026-07-03T10:00")のことが多い。VercelはUTCで動くため
// TZ未指定を素で new Date() すると10時→UTC10時→JST表示19時にズレる。未指定はJST(+09:00)として解釈する。
function toJstIso(input: string): string {
  const raw = String(input || '').trim().replace(' ', 'T')
  if (!raw) return new Date().toISOString()
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(raw)
  const d = new Date(hasTz ? raw : `${raw}+09:00`)
  if (isNaN(d.getTime())) { const f = new Date(raw); return isNaN(f.getTime()) ? new Date().toISOString() : f.toISOString() }
  return d.toISOString()
}

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


// ============================================================
// パワーダイヤラー（AIは「繋がるまで」担当・話すのは人）
//   1) 担当者のケータイを呼び、カンファレンスに無音で待機させる
//   2) その裏でリストへ1件ずつ発信。留守電判定で「人」と分かった瞬間だけカンファレンスへ合流
//   3) 留守電・不在・話中は自動で次へ。記録すべき内容は pending_outcomes に積み、画面側が
//      既存のコール履歴ロジック（ステータス変更・再コール設定を含む）で書き込む
// ============================================================
const DIALER_RING_SEC = 20          // 呼び出し秒数。20秒で出なければ不在として次へ
const DIALER_AMD_TIMEOUT_SEC = 12   // 留守電判定の上限。既定30秒は長く、出た人を待たせてしまう
const DIALER_SKIP_MAX = 30          // 1回の実行で飛ばせる件数（電話番号なし等）。無限ループ防止

function dialerUrl(req: any, action: string, sessionId: string): string {
  return `${baseUrl(req)}/api/ai-call/twilio?action=${action}&session=${sessionId}`
}
/** 結果の待ち行列に1件積む。画面側が拾って既存ロジックでコール履歴に書く。 */
function dialerOutcome(caseId: string | null, caseName: string | null, phone: string | null, kind: string, note: string) {
  return { id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), caseId, caseName, phone, kind, note }
}
function bumpStats(stats: any, key: string) {
  const s = { ...(stats || {}) }
  s[key] = Number(s[key] || 0) + 1
  return s
}
async function loadDialerSession(admin: any, id: string): Promise<any | null> {
  if (!id) return null
  const { data } = await admin.from('dialer_sessions').select('*').eq('id', id).maybeSingle()
  return data || null
}
async function saveDialerSession(admin: any, id: string, patch: any): Promise<void> {
  await admin.from('dialer_sessions').update({ ...patch, updated_date: new Date().toISOString() }).eq('id', id).then(() => {}, () => {})
}

/**
 * キューの次の案件へ発信する。発信できない案件（番号なし/NG指定/対象外）は理由を積んで飛ばす。
 * キューが尽きたら status='通話待機' のままで done を返す（担当者の通話は切らない）。
 */
async function dialerDialNext(admin: any, req: any, session: any): Promise<{ ok: boolean; done?: boolean; error?: string; caseId?: string | null }> {
  const queue: string[] = Array.isArray(session.queue) ? session.queue : []
  let cursor = Number(session.cursor || 0)
  let stats = session.stats || {}
  const pending: any[] = Array.isArray(session.pending_outcomes) ? [...session.pending_outcomes] : []
  let skipped = 0

  while (cursor < queue.length && skipped < DIALER_SKIP_MAX) {
    const caseId = queue[cursor]
    cursor += 1
    const { data: kase } = await admin.from('cases').select('id,name,phone1,phone2,phone3,do_not_call,status').eq('id', caseId).maybeSingle()
    if (!kase) { pending.push(dialerOutcome(caseId, null, null, 'skip', '案件が見つかりません')); stats = bumpStats(stats, 'skipped'); skipped++; continue }
    // 代表番号(phone1)優先。空なら2番目・3番目を使う
    const phone = [kase.phone1, kase.phone2, kase.phone3].map((x: any) => String(x || '').trim()).find(Boolean) || ''
    if (kase.do_not_call) { pending.push(dialerOutcome(caseId, kase.name, phone, 'skip', 'NG指定のため発信しません')); stats = bumpStats(stats, 'skipped'); skipped++; continue }
    if (isCallBlocked(kase.status)) { pending.push(dialerOutcome(caseId, kase.name, phone, 'skip', CALL_BLOCKED_MESSAGE)); stats = bumpStats(stats, 'skipped'); skipped++; continue }
    if (!phone) { pending.push(dialerOutcome(caseId, kase.name, null, 'skip', '電話番号がありません')); stats = bumpStats(stats, 'skipped'); skipped++; continue }

    // テストモードON時は、案件の番号ではなく確認用番号へ発信する（実店舗を鳴らさない）
    const dial = session.test_mode ? String(session.test_number || '').trim() : phone
    if (!dial) {
      await saveDialerSession(admin, session.id, { cursor: cursor - 1, pending_outcomes: pending, stats, status: '通話待機', last_note: 'テストモードONですが確認用番号が未設定です' })
      return { ok: false, error: 'テストモードONです。確認用の番号（自分の番号）を設定してください。' }
    }
    const pf = preflight(dial)
    if (!pf.ok) { pending.push(dialerOutcome(caseId, kase.name, phone, 'skip', '発信前チェックに失敗: ' + pf.errors.join(' / '))); stats = bumpStats(stats, 'skipped'); skipped++; continue }

    const amd = String(session.amd_mode || 'sync')
    const r = await initiateTwilioCall({
      toRaw: dial,
      // 相手が出た時のTwiMLはURLで取る。留守電判定(sync)なら AnsweredBy が付いて来るので
      // 「人なら担当者へ繋ぐ / 留守電なら切る」をその応答で分岐できる。
      twimlUrl: dialerUrl(req, 'dialer-answer', session.id),
      statusCallbackUrl: dialerUrl(req, 'dialer-callback', session.id),
      record: false,
      timeout: DIALER_RING_SEC,
      machineDetection: amd === 'off' ? undefined : 'Enable',
      machineDetectionTimeout: DIALER_AMD_TIMEOUT_SEC,
      asyncAmd: amd === 'async',
      asyncAmdUrl: dialerUrl(req, 'dialer-amd', session.id),
    })
    if (!r.ok) {
      pending.push(dialerOutcome(caseId, kase.name, phone, 'error', String(r.error || '発信に失敗しました').slice(0, 200)))
      stats = bumpStats(stats, 'failed'); skipped++
      continue
    }
    await saveDialerSession(admin, session.id, {
      cursor, pending_outcomes: pending, stats: bumpStats(stats, 'dialed'), status: '発信中',
      current_case_id: kase.id, current_case_name: kase.name, current_phone: phone,
      current_call_sid: r.sid, current_started_at: new Date().toISOString(),
      last_note: session.test_mode ? `テストモード: 実際の発信先は確認用番号です（${kase.name} には鳴っていません）` : null,
    })
    return { ok: true, caseId: kase.id }
  }

  const done = cursor >= queue.length
  await saveDialerSession(admin, session.id, {
    cursor, pending_outcomes: pending, stats, status: '通話待機',
    current_case_id: null, current_case_name: null, current_phone: null, current_call_sid: null, current_started_at: null,
    last_note: done ? 'リストの最後まで発信しました' : null,
  })
  return { ok: true, done }
}

/** 自動結果（留守電/不在/話中/失敗）を積んで、自動で次へ進む。 */
async function dialerAutoAdvance(admin: any, req: any, session: any, kind: string, note: string, statKey: string): Promise<void> {
  const pending: any[] = Array.isArray(session.pending_outcomes) ? [...session.pending_outcomes] : []
  pending.push(dialerOutcome(session.current_case_id, session.current_case_name, session.current_phone, kind, note))
  await saveDialerSession(admin, session.id, {
    pending_outcomes: pending, stats: bumpStats(session.stats, statKey), status: '通話待機',
    current_case_id: null, current_case_name: null, current_phone: null, current_call_sid: null, current_started_at: null, last_note: note,
  })
  if (!session.auto_next) return
  const fresh = await loadDialerSession(admin, session.id)
  if (!fresh || fresh.status === '停止' || !fresh.rep_call_sid) return
  await dialerDialNext(admin, req, fresh).catch(() => {})
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
      // リアルタイム音声AI会話モード
      callMode: getCallMode(), realtimeEnabled: isRealtimeConfigured(),
      realtimeAvailable: isRealtimeAvailable(), realtimeServerUrlMasked: realtimeServerUrlMasked(),
      // ブラウザ通話（ヘッドセット待機）。ダイヤラーの待機を携帯からPCに移すと通話料が約1/25になる
      browserVoice: { configured: isBrowserVoiceConfigured(), missingEnv: missingBrowserVoiceEnv() },
      japanesePromptEnabled: true, initialGreeting: 'Japanese',
      realtimeMissingEnv: [
        getCallMode() === 'realtime' ? null : 'AI_CALL_MODE=realtime',
        process.env.REALTIME_VOICE_SERVER_URL ? null : 'REALTIME_VOICE_SERVER_URL',
        process.env.AI_CALL_SERVER_SECRET ? null : 'AI_CALL_SERVER_SECRET',
      ].filter(Boolean),
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

  // ---- realtime音声サーバーからのツール呼び出し（サーバー間シークレット認証） ----
  if (action.startsWith('tool-')) {
    if (!verifyServerSecret(req)) return res.status(401).json({ ok: false, error: 'server secret 不一致' })
    const b = req.body || {}
    let caseId = b.caseId ? String(b.caseId) : null
    const jobId = b.jobId ? String(b.jobId) : null
    if (!caseId && jobId) { const { data: j } = await admin.from('ai_call_jobs').select('case_id').eq('id', jobId).maybeSingle(); caseId = j?.case_id || null }
    const nowIso = new Date().toISOString()

    if (action === 'tool-context') {
      // 相手先情報（caseIdがあれば）＋ 使用するトークスクリプトを返す。
      // スクリプトは job.script_id を優先、無ければ既定（is_default）を採用。realtimeサーバーがinstructionsに反映する。
      const script = await resolveScript(admin, jobId)
      if (!caseId) return res.status(200).json({ ok: true, context: null, script })
      const { data: c } = await admin.from('cases').select('name,industry,address,phone1,hp1,memo').eq('id', caseId).maybeSingle()
      return res.status(200).json({ ok: true, context: c ? { name: c.name, industry: c.industry, address: c.address, phone: c.phone1, website: c.hp1, memo: c.memo } : null, script })
    }
    if (action === 'tool-slots') {
      const slots = isCalendarConfigured() ? await getAvailableSlots(3, 6) : []
      return res.status(200).json({ ok: true, slots, calendarConfigured: isCalendarConfigured() })
    }
    if (action === 'tool-appointment') {
      if (!caseId || !b.datetime) return res.status(400).json({ ok: false, error: 'caseId/datetime がありません' })
      const { data: c } = await admin.from('cases').select('id,name,address,sales_rep,do_not_call').eq('id', caseId).maybeSingle()
      if (!c) return res.status(404).json({ ok: false, error: '案件が見つかりません' })
      const appoIso = toJstIso(b.datetime)
      const memo = ['【AIテレアポ アポ確定】', b.contactName ? `担当: ${b.contactName}` : '', b.memo || ''].filter(Boolean).join('\n')
      const { data: appt } = await admin.from('appointments').insert({ case_id: c.id, case_name: c.name, address: c.address || null, sales_rep: c.sales_rep || null, appo_at: appoIso, memo }).select('id').single()
      let calResult = 'カレンダー未設定'
      if (isCalendarConfigured()) {
        try { const eid = await createCalendarEvent({ summary: `訪問: ${c.name}`, description: memo, location: c.address || '', startIso: appoIso, durationMin: 60 }); if (appt?.id) await admin.from('appointments').update({ google_event_id: eid, google_synced_at: nowIso }).eq('id', appt.id); calResult = 'Googleカレンダー登録済み' }
        catch (e: any) { calResult = 'カレンダー登録失敗: ' + String(e?.message || e) }
      }
      await admin.from('cases').update({ status: 'アポ', ai_call_status: 'アポ確定', ai_call_next_action: `訪問予定 ${new Date(appoIso).toLocaleString('ja-JP')}`, last_ai_call_at: nowIso }).eq('id', c.id)
      if (jobId) await admin.from('ai_call_jobs').update({ status: 'アポ確定', appointment_id: appt?.id || null, appo_at: appoIso, ai_contact_name: b.contactName || null, calendar_result: calResult, next_action: '訪問予定を実施' }).eq('id', jobId)
      await admin.from('call_logs').insert({ case_id: c.id, case_name: c.name, call_at: nowIso, contact_type: '接触', result: 'AIテレアポ: アポ確定', memo: `${memo}\n${calResult}`, summary: 'AIテレアポでアポ確定', appo_at: appoIso, next_status: 'アポ' }).then(() => {}, () => {})
      return res.status(200).json({ ok: true, appointmentId: appt?.id, calendar: calResult, appoAt: appoIso })
    }
    if (action === 'tool-callback') {
      if (!caseId || !b.datetime) return res.status(400).json({ ok: false, error: 'caseId/datetime がありません' })
      const nextIso = toJstIso(b.datetime)
      await admin.from('cases').update({ status: '再コール', ai_call_status: '再架電', next_ai_call_at: nextIso, ai_call_next_action: `${new Date(nextIso).toLocaleString('ja-JP')} に再架電`, last_ai_call_at: nowIso }).eq('id', caseId)
      if (jobId) await admin.from('ai_call_jobs').update({ status: '再架電', next_action: `${new Date(nextIso).toLocaleString('ja-JP')} に再架電` }).eq('id', jobId)
      return res.status(200).json({ ok: true })
    }
    if (action === 'tool-nointerest') {
      if (!caseId) return res.status(400).json({ ok: false, error: 'caseId がありません' })
      // ※NGは人が確認（do_not_callは立てない）。興味なしまで。
      await admin.from('cases').update({ ai_call_status: '興味なし', ai_call_next_action: b.reason ? `興味なし: ${b.reason}` : '興味なし', last_ai_call_at: nowIso }).eq('id', caseId)
      if (jobId) await admin.from('ai_call_jobs').update({ status: '興味なし', next_action: b.reason || '興味なし' }).eq('id', jobId)
      await admin.from('call_logs').insert({ case_id: caseId, call_at: nowIso, contact_type: '接触', result: 'AIテレアポ: 興味なし', memo: b.reason || null }).then(() => {}, () => {})
      return res.status(200).json({ ok: true })
    }
    if (action === 'tool-summary' || action === 'tool-result') {
      if (jobId) await admin.from('ai_call_jobs').update({ ai_summary: b.summary || null, next_action: b.nextAction || null, status: b.result || undefined, call_mode: 'realtime' }).eq('id', jobId).then(() => {}, () => {})
      if (caseId) await admin.from('cases').update({ ai_call_status: b.result || null, ai_call_next_action: b.nextAction || null, last_ai_call_at: nowIso }).eq('id', caseId).then(() => {}, () => {})
      if (action === 'tool-result' && caseId) await admin.from('call_logs').insert({ case_id: caseId, call_at: nowIso, contact_type: '接触', result: `AIテレアポ(realtime): ${b.result || '通話完了'}`, memo: b.summary || null, summary: b.summary || null }).then(() => {}, () => {})
      return res.status(200).json({ ok: true })
    }
    return res.status(400).json({ ok: false, error: 'unknown tool action' })
  }

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
    const scriptId = b.scriptId ? String(b.scriptId) : null   // 使用するトークスクリプト（realtime時にjobへ保存→tool-contextで解決）

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
      const { data: kase } = await admin.from('cases').select('do_not_call,name,status').eq('id', caseId).maybeSingle()
      if (kase?.do_not_call) return res.status(400).json({ ok: false, error: 'この案件はNG指定のため発信できません。' })
      // 対象外案件には発信しない（画面側でも止めているが、API直叩きでも発信させない）
      if (isCallBlocked(kase?.status)) return res.status(400).json({ ok: false, error: CALL_BLOCKED_MESSAGE })
      caseName = kase?.name ?? null
    }
    // 二重発信防止: 同じ「本来の発信先」で発信中ジョブが直近90秒以内にあれば拒否
    const since = new Date(Date.now() - 90_000).toISOString()
    const { data: dup } = await admin.from('ai_call_jobs').select('id').eq('phone', intended).eq('status', '発信中').gte('created_date', since).limit(1)
    if (dup?.[0]) return res.status(409).json({ ok: false, error: '同じ番号への発信が進行中です。完了までお待ちください。' })

    // 通話モード:
    //   - body.mode==='fixed'    → 必ず固定音声
    //   - body.mode==='realtime' → URL/シークレットが揃っていれば realtime（AI_CALL_MODEに依存せずUIから強制可）
    //   - 指定なし               → AI_CALL_MODE=realtime かつ設定済みなら realtime
    const reqMode = req.body?.mode
    const useRealtime = reqMode !== 'fixed' && isRealtimeAvailable() && (reqMode === 'realtime' || getCallMode() === 'realtime')

    // 発信中ジョブ作成（案件に紐付け・phoneは本来の発信先を記録）
    const nowIso = new Date().toISOString()
    const redirectNote = (caseId && testMode) ? `※テストモード: 実際の発信先は ${dial}（案件番号 ${intended} には発信していません）` : ''
    const { data: job, error: je } = await admin.from('ai_call_jobs').insert({
      case_id: caseId, case_name: caseName, phone: intended, status: '発信中', provider: 'twilio', call_mode: useRealtime ? 'realtime' : 'fixed', called_at: nowIso, created_by_id: auth.user.id,
      script_id: scriptId, transcript: redirectNote || null,
    }).select('id').single()
    if (je || !job) return res.status(500).json({ ok: false, error: je?.message || 'ジョブ作成に失敗' })

    // Twilio発信（公式SDK・TwiMLはインライン、状態通知＋録音完了通知は自ドメイン＋jobId）
    // realtime: <Connect><Stream> で音声を中継サーバーへ双方向ストリーム。fixed: 固定メッセージ読み上げ。
    const base = baseUrl(req)
    const cbUrl = `${base}/api/ai-call/twilio?action=callback&jobId=${job.id}`
    const recUrl = `${base}/api/ai-call/twilio?action=recording&jobId=${job.id}`
    const twiml = useRealtime ? buildStreamTwiml(job.id, caseId || '') : buildTwiml(message)
    // realtime(<Connect><Stream>)では通話録音を無効化（録音が双方向ストリームに干渉するのを避ける）。fixedは録音ON。
    const r = await initiateTwilioCall({ toRaw: dial, twiml, statusCallbackUrl: cbUrl, recordingCallbackUrl: recUrl, record: !useRealtime })
    if (!r.ok) {
      await admin.from('ai_call_jobs').update({ status: '通話完了', error: String(r.error).slice(0, 300), updated_date: nowIso }).eq('id', job.id).then(() => {}, () => {})
      return res.status(r.status || r.code ? 502 : 400).json({ ok: false, error: r.error, code: r.code, status: r.status, moreInfo: r.moreInfo, detail: r.detail, guidance: r.guidance, debug: r.debug, jobId: job.id })
    }
    await admin.from('ai_call_jobs').update({ provider_call_sid: r.sid, updated_date: nowIso }).eq('id', job.id).then(() => {}, () => {})
    return res.status(200).json({ ok: true, jobId: job.id, sid: r.sid, to: r.debug.to, intended, redirected: !!(caseId && testMode), mode: useRealtime ? 'realtime' : 'fixed', realtimeAvailable: isRealtimeAvailable(), callModeEnv: getCallMode(), debug: r.debug })
  }


  // ============================================================
  // パワーダイヤラー
  // ============================================================

  // ---- 相手が出た時のTwiML（Twilioが取得・認証なし。sessionはUUIDなので推測不可）----
  //   留守電判定(sync)の AnsweredBy で分岐: 人 → カンファレンスへ合流 / 留守電・FAX → 即切って次へ
  if (action === 'dialer-answer') {
    const b = formBody(req)
    const sessionId = String(req.query?.session || '')
    const sid = String(b.CallSid || '')
    const session = await loadDialerSession(admin, sessionId)
    res.setHeader('Content-Type', 'text/xml; charset=utf-8')
    // 停止後や、既に見捨てた発信（スキップ後の遅い応答）は繋がず切る
    if (!session || session.status === '停止' || (session.current_call_sid && sid && session.current_call_sid !== sid)) {
      return res.status(200).send(buildHangupTwiml())
    }
    const answeredBy = String(b.AnsweredBy || '')
    if (String(session.amd_mode || 'sync') === 'sync' && !isHumanAnswer(answeredBy)) {
      const note = answeredBy.startsWith('fax') ? 'FAXでした（自動判定）' : '留守番電話でした（自動判定）'
      res.status(200).send(buildHangupTwiml())
      await dialerAutoAdvance(admin, req, session, 'machine', note, 'machine').catch(() => {})
      return
    }
    // 人が出た → 待機している担当者と即つなぐ
    await saveDialerSession(admin, sessionId, { status: '通話中', last_note: null })
    return res.status(200).send(buildConferenceTwiml(session.conference_name, { endOnExit: false }))
  }

  // ---- Twilioの状態通知（認証なし・sessionとCallSidで担当者側/発信先側を判定）----
  if (action === 'dialer-callback') {
    const b = formBody(req)
    const sessionId = String(req.query?.session || '')
    const sid = String(b.CallSid || '')
    const st = String(b.CallStatus || '').toLowerCase()
    const session = await loadDialerSession(admin, sessionId)
    if (!session || session.status === '停止') return res.status(200).json({ ok: true })

    // 担当者（自分のケータイ）側
    if (sid && sid === session.rep_call_sid) {
      if (st === 'in-progress' || st === 'answered') {
        await saveDialerSession(admin, sessionId, { status: '通話待機', last_note: null })
        if (session.auto_next && session.status !== '発信中' && session.status !== '通話中') {
          const fresh = await loadDialerSession(admin, sessionId)
          if (fresh) await dialerDialNext(admin, req, fresh).catch(() => {})
        }
        return res.status(200).json({ ok: true })
      }
      if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(st)) {
        // 担当者が切った/出なかった → ダイヤラー終了。裏で鳴らしている相手も止める
        if (session.current_call_sid) await hangupTwilioCall(session.current_call_sid).catch(() => {})
        const note = st === 'completed' ? '終了しました' : `あなたの電話に繋がりませんでした（${st}）`
        await saveDialerSession(admin, sessionId, { status: '停止', current_call_sid: null, last_note: note })
      }
      return res.status(200).json({ ok: true })
    }

    // 発信先（リスト）側。見捨てた発信の遅い通知は無視する
    if (!sid || sid !== session.current_call_sid) return res.status(200).json({ ok: true })
    if (st === 'no-answer') { await dialerAutoAdvance(admin, req, session, 'noanswer', '呼び出しに出ませんでした（不在）', 'noanswer').catch(() => {}); return res.status(200).json({ ok: true }) }
    if (st === 'busy') { await dialerAutoAdvance(admin, req, session, 'busy', '話中でした', 'busy').catch(() => {}); return res.status(200).json({ ok: true }) }
    if (st === 'failed' || st === 'canceled') { await dialerAutoAdvance(admin, req, session, 'error', `発信できませんでした（${st}）${b.ErrorMessage ? ' / ' + b.ErrorMessage : ''}`, 'failed').catch(() => {}); return res.status(200).json({ ok: true }) }
    if (st === 'completed') {
      // 人と話した通話が終わった → 結果の入力を待つ（勝手に次へ進めない）
      if (session.status === '通話中') {
        const dur = b.CallDuration ? Number(b.CallDuration) : null
        await saveDialerSession(admin, sessionId, { status: '結果待ち', current_call_sid: null, stats: bumpStats(session.stats, 'talked'), last_note: dur ? `${dur}秒 通話しました。結果を登録してください` : '結果を登録してください' })
      }
      return res.status(200).json({ ok: true })
    }
    return res.status(200).json({ ok: true })
  }

  // ---- 留守電判定の非同期結果（amd_mode=async のとき。即つないだ後に判定が届く）----
  if (action === 'dialer-amd') {
    const b = formBody(req)
    const sessionId = String(req.query?.session || '')
    const sid = String(b.CallSid || '')
    const session = await loadDialerSession(admin, sessionId)
    if (!session || session.status === '停止') return res.status(200).json({ ok: true })
    if (!sid || sid !== session.current_call_sid) return res.status(200).json({ ok: true })
    if (isHumanAnswer(String(b.AnsweredBy || ''))) return res.status(200).json({ ok: true })
    await hangupTwilioCall(sid).catch(() => {})
    await dialerAutoAdvance(admin, req, session, 'machine', '留守番電話でした（自動判定）', 'machine').catch(() => {})
    return res.status(200).json({ ok: true })
  }

  // ---- 開始（要管理者）: 自分のケータイを呼び、カンファレンスで待機させる ----
  if (action === 'dialer-start') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const auth = await verifyAdmin(admin, token)
    if (!auth.ok) return res.status(auth.error === '管理者権限が必要です' ? 403 : 401).json({ ok: false, error: auth.error })
    if (getProviderMode() !== 'twilio') return res.status(400).json({ ok: false, error: 'AI_CALL_PROVIDER=mock のため実発信しません。Vercelで AI_CALL_PROVIDER=twilio に設定してください。' })
    if (!isTwilioConfigured()) return res.status(400).json({ ok: false, error: `Twilio環境変数が未設定です: ${missingTwilioEnv().join(', ')}（Vercelに設定して再デプロイ）` })

    const b = req.body || {}
    // 待機先: browser=パソコンのヘッドセット（安い） / phone=担当者のケータイ
    const repMode = String(b.repMode) === 'browser' ? 'browser' : 'phone'
    const repPhone = String(b.repPhone || '').trim()
    const caseIds: string[] = Array.isArray(b.caseIds) ? b.caseIds.map((x: any) => String(x)).filter(Boolean) : []
    const testMode = b.testMode !== false
    const testNumber = String(b.testNumber || '').trim()
    const amdMode = ['sync', 'async', 'off'].includes(String(b.amdMode)) ? String(b.amdMode) : 'sync'
    if (repMode === 'phone' && !repPhone) return res.status(400).json({ ok: false, error: 'あなたのケータイ番号を入力してください。' })
    if (repMode === 'browser' && !isBrowserVoiceConfigured()) return res.status(400).json({ ok: false, error: `ブラウザ通話の環境変数が未設定です: ${missingBrowserVoiceEnv().join(', ')}（Vercelに設定して再デプロイ）` })
    if (!caseIds.length) return res.status(400).json({ ok: false, error: '発信するリストが空です。' })
    if (testMode && !testNumber) return res.status(400).json({ ok: false, error: 'テストモードONです。確認用の番号（自分の番号）を入力してください。' })
    // 待機に使う電話と確認用の発信先が同じ番号だと、2本目が話中になりテストにならない（ブラウザ待機なら起きない）
    const sameNum = (a: string, b: string) => a.replace(/[^\d]/g, '').slice(-10) === b.replace(/[^\d]/g, '').slice(-10)
    if (repMode === 'phone' && testMode && sameNum(repPhone, testNumber)) return res.status(400).json({ ok: false, error: '確認用の番号は、待機に使う電話とは別の番号にしてください（同じ番号だと2本目が話中になります）。' })
    // ブラウザ待機のときは client:〜 宛。電話番号ではないので番号形式の検査は通さない
    const repTarget = repMode === 'browser' ? 'client:' + browserIdentity(auth.user.id) : repPhone
    const pf = preflight(repTarget)
    if (!pf.ok) return res.status(400).json({ ok: false, error: repMode === 'browser' ? 'ブラウザ通話の発信前チェックに失敗しました' : 'あなたの番号の発信前チェックに失敗しました', errors: pf.errors, debug: pf.debug })

    // 同じ人の進行中セッションは止める（自分のケータイが二重に鳴るのを防ぐ）
    const { data: olds } = await admin.from('dialer_sessions').select('id,rep_call_sid,current_call_sid').eq('user_id', auth.user.id).neq('status', '停止')
    for (const o of olds || []) {
      if (o.current_call_sid) await hangupTwilioCall(o.current_call_sid).catch(() => {})
      if (o.rep_call_sid) await hangupTwilioCall(o.rep_call_sid).catch(() => {})
      await saveDialerSession(admin, o.id, { status: '停止', last_note: '新しいダイヤラーを開始したため終了しました' })
    }

    const conference = 'rst-dialer-' + Math.random().toString(36).slice(2, 10)
    const { data: session, error: se } = await admin.from('dialer_sessions').insert({
      user_id: auth.user.id, rep_name: String(b.repName || '').trim() || null, rep_phone: repPhone || null, rep_mode: repMode,
      conference_name: conference, status: '接続中', amd_mode: amdMode, test_mode: testMode, test_number: testNumber || null,
      auto_next: b.autoNext !== false, queue: caseIds, cursor: 0, stats: {},
    }).select('*').single()
    if (se || !session) return res.status(500).json({ ok: false, error: se?.message || 'セッション作成に失敗' })

    const r = await initiateTwilioCall({
      toRaw: repTarget,
      // ブラウザ待機は画面が自動で出るので読み上げ不要（無言で合流させる）
      twiml: buildConferenceTwiml(conference, { endOnExit: true, say: repMode === 'browser' ? '' : 'ダイヤラーに接続しました。このまま、お待ちください。' }),
      statusCallbackUrl: dialerUrl(req, 'dialer-callback', session.id),
      record: false, timeout: 40,
    })
    if (!r.ok) {
      await saveDialerSession(admin, session.id, { status: '停止', last_note: String(r.error || '').slice(0, 200) })
      return res.status(502).json({ ok: false, error: r.error, code: r.code, guidance: r.guidance, debug: r.debug })
    }
    await saveDialerSession(admin, session.id, { rep_call_sid: r.sid })
    return res.status(200).json({ ok: true, sessionId: session.id, sid: r.sid, total: caseIds.length, testMode, amdMode, repMode })
  }

  // ---- 状態取得・次へ・スキップ・結果の消化・停止（要管理者）----
  if (action.startsWith('dialer-')) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const auth = await verifyAdmin(admin, token)
    if (!auth.ok) return res.status(auth.error === '管理者権限が必要です' ? 403 : 401).json({ ok: false, error: auth.error })
    const b = req.body || {}

    // ブラウザ（ヘッドセット）で待機するためのアクセストークン。着信のみ許可。
    if (action === 'dialer-token') {
      const t = await createVoiceToken(auth.user.id, 3600)
      if (!t.ok) return res.status(400).json({ ok: false, error: t.error })
      return res.status(200).json({ ok: true, token: t.token, identity: t.identity })
    }

    if (action === 'dialer-state') {
      // sessionId 未指定なら、その人の最後のセッションを返す（画面を開き直しても続けられる）
      let session = b.sessionId ? await loadDialerSession(admin, String(b.sessionId)) : null
      if (!session) {
        const { data } = await admin.from('dialer_sessions').select('*').eq('user_id', auth.user.id).order('created_date', { ascending: false }).limit(1)
        session = data?.[0] || null
      }
      if (!session) return res.status(200).json({ ok: true, session: null })
      if (session.user_id && session.user_id !== auth.user.id) return res.status(403).json({ ok: false, error: '他の人のダイヤラーです' })
      return res.status(200).json({ ok: true, session })
    }

    const session = await loadDialerSession(admin, String(b.sessionId || ''))
    if (!session) return res.status(404).json({ ok: false, error: 'ダイヤラーが見つかりません' })
    if (session.user_id && session.user_id !== auth.user.id) return res.status(403).json({ ok: false, error: '他の人のダイヤラーです' })

    // 画面がコール履歴に書き終えた自動結果を待ち行列から外す
    if (action === 'dialer-ack') {
      const ids: string[] = Array.isArray(b.ids) ? b.ids.map((x: any) => String(x)) : []
      const rest = (Array.isArray(session.pending_outcomes) ? session.pending_outcomes : []).filter((o: any) => !ids.includes(String(o.id)))
      await saveDialerSession(admin, session.id, { pending_outcomes: rest })
      return res.status(200).json({ ok: true, remaining: rest.length })
    }

    if (action === 'dialer-next' || action === 'dialer-skip') {
      if (session.status === '停止') return res.status(400).json({ ok: false, error: 'ダイヤラーは終了しています。もう一度開始してください。' })
      if (!session.rep_call_sid) return res.status(400).json({ ok: false, error: 'あなたの電話が繋がっていません。' })
      if (session.status === '通話中') return res.status(409).json({ ok: false, error: '通話中です。通話を終えてから次へ進んでください。' })
      // 呼び出し中の相手がいれば止めてから次へ（スキップ）
      if (session.current_call_sid) {
        await hangupTwilioCall(session.current_call_sid).catch(() => {})
        await saveDialerSession(admin, session.id, { current_call_sid: null })
      }
      const fresh = (await loadDialerSession(admin, session.id)) || session
      const r = await dialerDialNext(admin, req, fresh)
      return res.status(r.ok ? 200 : 400).json(r)
    }

    if (action === 'dialer-stop') {
      if (session.current_call_sid) await hangupTwilioCall(session.current_call_sid).catch(() => {})
      if (session.rep_call_sid) await hangupTwilioCall(session.rep_call_sid).catch(() => {})
      await saveDialerSession(admin, session.id, { status: '停止', current_call_sid: null, last_note: '停止しました' })
      return res.status(200).json({ ok: true })
    }

    if (action === 'dialer-config') {
      // 進行中に「自動で次へ」「留守電判定」を切り替える／リストを足す
      const patch: any = {}
      if (typeof b.autoNext === 'boolean') patch.auto_next = b.autoNext
      if (['sync', 'async', 'off'].includes(String(b.amdMode))) patch.amd_mode = String(b.amdMode)
      if (Array.isArray(b.caseIds)) patch.queue = [...(Array.isArray(session.queue) ? session.queue : []), ...b.caseIds.map((x: any) => String(x))]
      await saveDialerSession(admin, session.id, patch)
      return res.status(200).json({ ok: true })
    }
  }

  return res.status(400).json({ ok: false, error: '不明なaction' })
}

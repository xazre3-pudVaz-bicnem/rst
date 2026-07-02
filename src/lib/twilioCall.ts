// ============================================================
// Twilio 実発信（サーバー専用・公式SDK使用）。キーはVercel環境変数から読む。
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / (TWILIO_PHONE_NUMBER または TWILIO_NUMBER) / AI_CALL_PROVIDER
// AI_CALL_PROVIDER=twilio のときのみ実発信。既定(mock)は実発信しない。
// 発信前に厳密な検証を行い、失敗時はマスク済みデバッグ情報とTwilioエラー詳細を返す。
// ※ Twilio SDK は「発信時のみ」動的importで読み込む（先頭importにすると状態確認GET等でも
//   SDKロードが走り、環境によっては関数全体がクラッシュ(FUNCTION_INVOCATION_FAILED)するため）。
// ============================================================

export function getProviderMode(): 'mock' | 'twilio' {
  return process.env.AI_CALL_PROVIDER === 'twilio' ? 'twilio' : 'mock'
}

// 通話モード: fixed=固定メッセージ / realtime=リアルタイム音声AI会話（別サーバー）。既定fixed（安全）。
export function getCallMode(): 'fixed' | 'realtime' {
  return process.env.AI_CALL_MODE === 'realtime' ? 'realtime' : 'fixed'
}
export function realtimeServerUrl(): string {
  return trim(process.env.REALTIME_VOICE_SERVER_URL) // 例: wss://rst-voice.onrender.com
}
/** realtime中継サーバーのURL+シークレットが揃っているか（AI_CALL_MODEに依存しない）。 */
export function isRealtimeAvailable(): boolean {
  return !!realtimeServerUrl() && !!trim(process.env.AI_CALL_SERVER_SECRET)
}
/** realtimeモードが有効か（AI_CALL_MODE=realtime かつ URL/シークレット設定済み）。 */
export function isRealtimeConfigured(): boolean {
  return getCallMode() === 'realtime' && isRealtimeAvailable()
}
/** 表示用: realtimeサーバーURLを伏せ字化（ホスト先頭数文字のみ）。 */
export function realtimeServerUrlMasked(): string {
  const u = realtimeServerUrl()
  if (!u) return ''
  const host = u.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  if (host.length <= 8) return host.slice(0, 2) + '***'
  return host.slice(0, 6) + '***' + host.slice(-6)
}
/**
 * realtimeモードのTwiML: <Connect><Stream> で音声を中継サーバーへ双方向ストリーム。
 * ※Twilioの<Stream>はURLクエリ付きだと接続に失敗することがあるため、URLはクエリなしのクリーンな
 *   wssにし、jobId/caseId/secret は <Parameter> で渡す（中継サーバーは start イベントの customParameters から受け取る）。
 */
export function buildStreamTwiml(jobId: string, caseId: string): string {
  const base = realtimeServerUrl().replace(/^https?:\/\//, (m) => (m === 'http://' ? 'ws://' : 'wss://'))
  const wss = /^wss?:\/\//.test(base) ? base : 'wss://' + base
  const url = `${wss.replace(/\/+$/, '')}/twilio-stream`
  const secret = trim(process.env.AI_CALL_SERVER_SECRET)
  const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${esc(url)}"><Parameter name="jobId" value="${esc(jobId)}"/><Parameter name="caseId" value="${esc(caseId)}"/><Parameter name="secret" value="${esc(secret)}"/></Stream></Connect></Response>`
}

const trim = (v?: string | null) => String(v || '').trim()

/** 発信元番号: TWILIO_PHONE_NUMBER を優先、無ければ TWILIO_NUMBER。どちらを読んだかも返す。 */
export function fromNumberEnv(): { value: string; envUsed: string } {
  if (trim(process.env.TWILIO_PHONE_NUMBER)) return { value: trim(process.env.TWILIO_PHONE_NUMBER), envUsed: 'TWILIO_PHONE_NUMBER' }
  if (trim(process.env.TWILIO_NUMBER)) return { value: trim(process.env.TWILIO_NUMBER), envUsed: 'TWILIO_NUMBER' }
  return { value: '', envUsed: '(未設定)' }
}

export function isTwilioConfigured(): boolean {
  return !!(trim(process.env.TWILIO_ACCOUNT_SID) && trim(process.env.TWILIO_AUTH_TOKEN) && fromNumberEnv().value)
}

export function missingTwilioEnv(): string[] {
  const out: string[] = []
  if (!trim(process.env.TWILIO_ACCOUNT_SID)) out.push('TWILIO_ACCOUNT_SID')
  if (!trim(process.env.TWILIO_AUTH_TOKEN)) out.push('TWILIO_AUTH_TOKEN')
  if (!fromNumberEnv().value) out.push('TWILIO_PHONE_NUMBER（またはTWILIO_NUMBER）')
  return out
}

/** E.164 目安の簡易正規化。日本の 0始まり10/11桁は +81 に変換。既に + なら維持。 */
export function toE164(raw: string): string {
  const s = trim(raw).replace(/[\s-()]/g, '')
  if (/^\+\d{8,15}$/.test(s)) return s
  const d = s.replace(/[^\d]/g, '')
  if (/^0\d{9,10}$/.test(d)) return '+81' + d.slice(1)
  if (/^81\d{9,10}$/.test(d)) return '+' + d
  return d ? '+' + d : ''
}
function isE164(s: string): boolean { return /^\+[1-9]\d{7,14}$/.test(String(s || '')) }

/** 固定メッセージのTwiML（日本語read）。SDKの twiml パラメータにそのまま渡す。 */
export function buildTwiml(message: string): string {
  const safe = String(message || 'こちらはテスト発信です。')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="ja-JP" voice="Polly.Mizuki">${safe}</Say><Pause length="1"/><Say language="ja-JP" voice="Polly.Mizuki">以上でテストを終了します。</Say></Response>`
}

export interface TwilioDebug {
  accountSidMasked: string; from: string; to: string; provider: string; endpoint: string; fromEnvUsed: string
  sidPrefixOk: boolean; sidLenOk: boolean; sidLen: number; tokenPresent: boolean; tokenLen: number; fromE164: boolean; toE164: boolean
}
export interface Preflight { ok: boolean; errors: string[]; debug: TwilioDebug; sid: string; token: string; from: string; to: string }

/** 送信直前チェック。SID(AC先頭/34桁)・token・from/toのE.164を検証し、マスク済みデバッグを返す。 */
export function preflight(toRaw: string): Preflight {
  const sid = trim(process.env.TWILIO_ACCOUNT_SID)
  const token = trim(process.env.TWILIO_AUTH_TOKEN)
  const fromEnv = fromNumberEnv()
  const from = toE164(fromEnv.value)
  const to = toE164(toRaw)
  const errors: string[] = []
  const sidPrefixOk = sid.startsWith('AC')
  const sidLenOk = sid.length === 34
  const tokenPresent = token.length > 0

  if (!sid) errors.push('TWILIO_ACCOUNT_SID が空です')
  else {
    if (!sidPrefixOk) errors.push('Account SIDが「AC」で始まっていません（APIキーSK... やSubaccount/testSIDの誤設定、または改行混入の可能性）')
    if (!sidLenOk) errors.push(`Account SIDの長さが不正です（${sid.length}文字・正しくは34文字。コピペ時の空白/改行混入に注意）`)
  }
  if (!tokenPresent) errors.push('TWILIO_AUTH_TOKEN が空です')
  else if (token.length < 32) errors.push(`Auth Tokenが短い可能性（${token.length}文字・通常32文字）`)
  if (!fromEnv.value) errors.push('発信元番号（TWILIO_PHONE_NUMBER / TWILIO_NUMBER）が空です')
  else if (!isE164(from)) errors.push(`発信元番号がE.164形式ではありません: ${from}（例 +815012345678）`)
  if (!to) errors.push('発信先番号が空です')
  else if (!isE164(to)) errors.push(`発信先番号がE.164形式ではありません: ${to}（例 +819012345678）`)

  const debug: TwilioDebug = {
    accountSidMasked: sid ? `${sid.slice(0, 6)}…${sid.slice(-4)}` : '(空)',
    from, to, provider: getProviderMode(),
    endpoint: `https://api.twilio.com/2010-04-01/Accounts/${sid ? sid.slice(0, 6) + '…' : '(空)'}/Calls.json`,
    fromEnvUsed: fromEnv.envUsed,
    sidPrefixOk, sidLenOk, sidLen: sid.length, tokenPresent, tokenLen: token.length, fromE164: isE164(from), toE164: isE164(to),
  }
  return { ok: errors.length === 0, errors, debug, sid, token, from, to }
}

export interface InitiateResult {
  ok: boolean; sid?: string; error?: string
  code?: number | string; status?: number; moreInfo?: string; detail?: string; guidance?: string
  debug: TwilioDebug
}

/** Twilioエラーコード → 具体的な対処案内（日本語）。 */
export function twilioErrorGuidance(code?: number | string, status?: number): string {
  const c = Number(code)
  if ([21219, 21210, 13223, 13224].includes(c)) {
    return 'Twilioトライアル（無料）アカウントは「認証済み番号」にしか発信できません。対処: ①Twilioコンソール → Phone Numbers → Manage → Verified Caller IDs で発信先番号を認証する（SMS/音声で本人確認）／②または有料アカウントにアップグレードする。まずはご自身の携帯を認証して発信テストしてください。'
  }
  if ([21606, 21601, 21212, 21611].includes(c)) return '発信元番号(From)がTwilioで購入済み・音声通話対応の番号か確認してください（TWILIO_PHONE_NUMBER）。'
  if (c === 21211) return '発信先番号(To)の形式が不正です。E.164（+81…）で指定してください。'
  if (c === 21610) return '発信先が受信を拒否（オプトアウト）しています。'
  if (status === 401 || status === 404 || c === 20003 || c === 20404) return 'Twilioの認証情報(Account SID / Auth Token)の組み合わせ、またはtest/live資格情報の混在を確認してください。'
  return ''
}

/** Twilio公式SDKで発信。twiml(読み上げ)・statusCallback(状態通知)・recordingCallback(録音完了通知)。録音は既定ON。 */
export async function initiateTwilioCall(opts: { toRaw: string; twiml: string; statusCallbackUrl: string; recordingCallbackUrl?: string; record?: boolean }): Promise<InitiateResult> {
  const pf = preflight(opts.toRaw)
  if (!pf.ok) return { ok: false, error: '発信前チェックに失敗: ' + pf.errors.join(' / '), debug: pf.debug }
  try {
    // Twilio SDK は発信時のみ動的import（ロード失敗をこの関数内に閉じ込める）
    const mod: any = await import('twilio')
    const twilioFn: any = mod?.default || mod
    if (typeof twilioFn !== 'function') return { ok: false, error: 'Twilio SDKの読み込みに失敗しました（twilioパッケージ未インストール/バンドル不可の可能性）', debug: pf.debug }
    const client: any = twilioFn(pf.sid, pf.token)
    const params: any = {
      to: pf.to, from: pf.from, twiml: opts.twiml,
      statusCallback: opts.statusCallbackUrl, statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: opts.record !== false, // 既定ON（fixed用の録音）。realtime(<Connect><Stream>)では干渉回避のためOFFにできる
    }
    if (opts.recordingCallbackUrl) {
      params.recordingStatusCallback = opts.recordingCallbackUrl
      params.recordingStatusCallbackMethod = 'POST'
      params.recordingStatusCallbackEvent = ['completed']
    }
    const call = await client.calls.create(params)
    return { ok: true, sid: call.sid, debug: pf.debug }
  } catch (e: any) {
    const code = e?.code
    const status = e?.status
    const moreInfo = e?.moreInfo || e?.more_info
    const detail = e?.detail || (typeof e?.details === 'string' ? e.details : undefined)
    let error = e?.message ? String(e.message) : String(e)
    // test/live混在・認証不一致の推定（404/401/20003/20404）
    if (status === 404 || status === 401 || code === 20003 || code === 20404) {
      error = `Twilio認証情報が不一致の可能性（Account SIDとAuth Tokenの組み合わせ、またはtest/live資格情報の混在）。元エラー: ${error}`
    }
    return { ok: false, error, code, status, moreInfo, detail, guidance: twilioErrorGuidance(code, status), debug: pf.debug }
  }
}

/** TwilioのCallStatus → RSTのAI架電ステータス。 */
export function mapTwilioStatus(callStatus: string): string {
  switch (String(callStatus || '').toLowerCase()) {
    case 'completed': return '通話完了'
    case 'no-answer': return '不在'
    case 'busy': return '不在'
    case 'failed': return '通話完了'
    case 'canceled': return '不在'
    case 'in-progress': case 'answered': return '発信中'
    case 'ringing': case 'initiated': case 'queued': return '発信中'
    default: return '発信中'
  }
}

// ===== 音声AI（第一段階: 録音→文字起こし→AI要約/判定）=====
export function transcriptionProvider(): string { return process.env.AI_CALL_TRANSCRIPTION_PROVIDER || 'openai' }
export function summaryProvider(): string { return process.env.AI_CALL_SUMMARY_PROVIDER || 'anthropic' }
function sttKey(): string { return trim(process.env.SPEECH_TO_TEXT_API_KEY) || trim(process.env.OPENAI_API_KEY) }
function summaryKey(): string { return trim(process.env.AI_SUMMARY_API_KEY) || trim(process.env.ANTHROPIC_API_KEY) || trim(process.env.OPENAI_API_KEY) }
export function isTranscriptionConfigured(): boolean { return !!sttKey() }
export function isSummaryConfigured(): boolean { return !!summaryKey() }
/** 音声AIで未設定の環境変数（画面表示用）。 */
export function missingVoiceAiEnv(): string[] {
  const out: string[] = []
  if (!sttKey()) out.push('SPEECH_TO_TEXT_API_KEY（またはOPENAI_API_KEY）')
  if (!summaryKey()) out.push('AI_SUMMARY_API_KEY（またはANTHROPIC_API_KEY）')
  return out
}

/** Twilio録音を取得してSTTで文字起こし。未設定/失敗時は理由を返す（例外は投げない）。 */
export async function transcribeRecording(recordingUrl: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!isTranscriptionConfigured()) return { ok: false, error: '文字起こし未設定（SPEECH_TO_TEXT_API_KEY）' }
  if (!recordingUrl) return { ok: false, error: '録音URLがありません' }
  try {
    // Twilioの録音はBasic認証で取得（mp3）
    const sid = trim(process.env.TWILIO_ACCOUNT_SID), token = trim(process.env.TWILIO_AUTH_TOKEN)
    const mp3 = recordingUrl.endsWith('.mp3') || recordingUrl.endsWith('.wav') ? recordingUrl : recordingUrl + '.mp3'
    const aRes = await fetch(mp3, { headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') } })
    if (!aRes.ok) return { ok: false, error: `録音取得失敗(HTTP ${aRes.status})` }
    const buf = Buffer.from(await aRes.arrayBuffer())
    if (buf.length < 1000) return { ok: false, error: '録音が短すぎる/空です' }
    if (transcriptionProvider() === 'openai') {
      const fd = new FormData()
      fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'call.mp3')
      fd.append('model', 'whisper-1')
      fd.append('language', 'ja')
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${sttKey()}` }, body: fd as any })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, error: j?.error?.message || `文字起こしAPIエラー(HTTP ${r.status})` }
      return { ok: true, text: String(j.text || '').trim() }
    }
    return { ok: false, error: `未対応の文字起こしプロバイダ: ${transcriptionProvider()}` }
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
}

export interface CallSummary {
  summary: string; reaction: string; interested: boolean | null; temperature: '高' | '中' | '低' | null
  next_action: string; needs_recall: boolean | null; should_ng: boolean | null; recommended_status: string
}
const VALID_STATUSES = ['興味あり', '再架電', '担当者不在', '不在', '興味なし', 'NG']

/** 文字起こしからAI要約・温度感・推奨ステータスを生成。未設定/失敗時は理由を返す。 */
export async function summarizeTranscript(transcript: string, caseName?: string): Promise<{ ok: boolean; data?: CallSummary; error?: string }> {
  if (!isSummaryConfigured()) return { ok: false, error: 'AI要約未設定（AI_SUMMARY_API_KEY）' }
  if (!transcript || transcript.trim().length < 5) return { ok: false, error: '文字起こしが短く要約できません' }
  const prompt = `あなたは営業電話の分析アシスタントです。以下は${caseName ? `「${caseName}」への` : ''}営業電話の文字起こしです。内容を分析し、次のキーを持つJSONのみを日本語で出力してください（前後に説明文を付けない）。
{"summary":"通話の要約(120字以内)","reaction":"相手の反応(60字以内)","interested":true or false,"temperature":"高" or "中" or "低","next_action":"次回アクション(60字以内)","needs_recall":true or false,"should_ng":true or false,"recommended_status":"興味あり|再架電|担当者不在|不在|興味なし|NG のいずれか"}
文字起こし:
${transcript.slice(0, 6000)}`
  try {
    if (summaryProvider() === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': summaryKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
      })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, error: j?.error?.message || `要約APIエラー(HTTP ${r.status})` }
      const text = (j?.content?.[0]?.text || '').trim()
      return parseSummary(text)
    }
    if (summaryProvider() === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${summaryKey()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 700, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
      })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, error: j?.error?.message || `要約APIエラー(HTTP ${r.status})` }
      return parseSummary(j?.choices?.[0]?.message?.content || '')
    }
    return { ok: false, error: `未対応の要約プロバイダ: ${summaryProvider()}` }
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
}

function parseSummary(text: string): { ok: boolean; data?: CallSummary; error?: string } {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return { ok: false, error: 'AI応答をJSONとして解釈できません' }
    const o = JSON.parse(m[0])
    const temp = ['高', '中', '低'].includes(o.temperature) ? o.temperature : null
    const rec = VALID_STATUSES.includes(o.recommended_status) ? o.recommended_status : '再架電'
    return { ok: true, data: {
      summary: String(o.summary || '').slice(0, 300), reaction: String(o.reaction || '').slice(0, 200),
      interested: typeof o.interested === 'boolean' ? o.interested : null, temperature: temp,
      next_action: String(o.next_action || '').slice(0, 200),
      needs_recall: typeof o.needs_recall === 'boolean' ? o.needs_recall : null,
      should_ng: typeof o.should_ng === 'boolean' ? o.should_ng : null, recommended_status: rec,
    } }
  } catch (e: any) { return { ok: false, error: 'AI応答の解析に失敗: ' + String(e?.message || e) } }
}

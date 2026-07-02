// ============================================================
// Twilio 実発信（サーバー専用・公式SDK使用）。キーはVercel環境変数から読む。
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / (TWILIO_PHONE_NUMBER または TWILIO_NUMBER) / AI_CALL_PROVIDER
// AI_CALL_PROVIDER=twilio のときのみ実発信。既定(mock)は実発信しない。
// 発信前に厳密な検証を行い、失敗時はマスク済みデバッグ情報とTwilioエラー詳細を返す。
// ============================================================
import twilio from 'twilio'

export function getProviderMode(): 'mock' | 'twilio' {
  return process.env.AI_CALL_PROVIDER === 'twilio' ? 'twilio' : 'mock'
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
  code?: number | string; status?: number; moreInfo?: string; detail?: string
  debug: TwilioDebug
}

/** Twilio公式SDKで発信。twiml(読み上げ)とstatusCallback(状態通知)を渡す。 */
export async function initiateTwilioCall(opts: { toRaw: string; twiml: string; statusCallbackUrl: string }): Promise<InitiateResult> {
  const pf = preflight(opts.toRaw)
  if (!pf.ok) return { ok: false, error: '発信前チェックに失敗: ' + pf.errors.join(' / '), debug: pf.debug }
  try {
    // クライアントは any 型で受ける（Twilio SDKのメジャーバージョン差でビルドが壊れないように）
    const client: any = twilio(pf.sid, pf.token)
    const call = await client.calls.create({
      to: pf.to, from: pf.from, twiml: opts.twiml,
      statusCallback: opts.statusCallbackUrl, statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    })
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
    return { ok: false, error, code, status, moreInfo, detail, debug: pf.debug }
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

// ============================================================
// Twilio 実発信（サーバー専用）。キーはVercel環境変数から読む。
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER / AI_CALL_PROVIDER
// AI_CALL_PROVIDER=twilio のときのみ実発信。既定(mock)は実発信しない。
// まずは固定メッセージを流すだけ（TwiMLの<Say>）。営業先ではなくテスト番号への1件発信を想定。
// ============================================================

export function getProviderMode(): 'mock' | 'twilio' {
  return process.env.AI_CALL_PROVIDER === 'twilio' ? 'twilio' : 'mock'
}

/** Twilioの必須環境変数が揃っているか。 */
export function isTwilioConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER)
}

/** 未設定の環境変数名を返す（画面に「何が足りないか」を明確表示するため）。 */
export function missingTwilioEnv(): string[] {
  const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER']
  return need.filter((k) => !process.env[k])
}

/** E.164 目安の簡易正規化。日本の 0始まり10/11桁は +81 に変換。既に + なら維持。 */
export function toE164(raw: string): string {
  const s = String(raw || '').trim()
  if (/^\+\d{8,15}$/.test(s.replace(/[\s-]/g, ''))) return s.replace(/[\s-]/g, '')
  const d = s.replace(/[^\d]/g, '')
  if (/^0\d{9,10}$/.test(d)) return '+81' + d.slice(1)
  if (/^81\d{9,10}$/.test(d)) return '+' + d
  return d ? '+' + d : ''
}

/** 固定メッセージのTwiML（日本語read）。voice/languageは後で差し替え可能。 */
export function buildTwiml(message: string): string {
  const safe = String(message || 'こちらはテスト発信です。')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="ja-JP" voice="Polly.Mizuki">${safe}</Say><Pause length="1"/><Say language="ja-JP" voice="Polly.Mizuki">以上でテストを終了します。</Say></Response>`
}

export interface InitiateResult { ok: boolean; sid?: string; error?: string; status?: number }

/** Twilioに発信を依頼。twimlUrl(通話時に読むTwiML)とstatusCallbackUrl(状態通知先)を渡す。 */
export async function initiateTwilioCall(opts: { to: string; twimlUrl: string; statusCallbackUrl: string }): Promise<InitiateResult> {
  if (!isTwilioConfigured()) return { ok: false, error: `Twilio環境変数が未設定です: ${missingTwilioEnv().join(', ')}` }
  const sid = process.env.TWILIO_ACCOUNT_SID as string
  const token = process.env.TWILIO_AUTH_TOKEN as string
  const from = process.env.TWILIO_PHONE_NUMBER as string
  const to = toE164(opts.to)
  if (!to) return { ok: false, error: '発信先の電話番号が不正です' }
  const body = new URLSearchParams({
    To: to, From: from, Url: opts.twimlUrl, Method: 'POST',
    StatusCallback: opts.statusCallbackUrl, StatusCallbackMethod: 'POST',
    // 主要イベントを受信（開始/呼び出し/応答/終了）
    StatusCallbackEvent: 'initiated ringing answered completed',
  })
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: j?.message || `Twilio APIエラー(HTTP ${res.status})`, status: res.status }
    return { ok: true, sid: j.sid }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** TwilioのCallStatus → RSTのAI架電ステータスへの対応。 */
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

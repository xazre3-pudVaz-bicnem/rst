// ============================================================
// AIテレアポ サービス層（クライアント）。
//  - スクリプト/架電ジョブのCRUD
//  - runTestCall: 1件テスト発信（モック）→結果保存→NGなら再架電防止→ログ化
//  - createInterestAppointment: 興味あり→訪問予定を作成し、既存のGoogleカレンダー同期を再利用
// 既存機能は変更しない。実通話はプロバイダ層(aiCallProvider)で差し替え可能。
// ============================================================
import { supabase } from './supabaseClient'
import type { AiCallScript, AiCallJob, AiCallStatus, Appointment, Case } from './types'
import { getCallProvider } from './aiCallProvider'
import { syncAppointmentResult, type SyncResult } from './calendarSync'
import { CallLogApi, CaseApi } from './api'

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message)
  return (data ?? ([] as unknown)) as T
}

export const AiCallScriptApi = {
  async list(): Promise<AiCallScript[]> {
    const { data, error } = await supabase.from('ai_call_scripts').select('*').eq('is_active', true).order('is_default', { ascending: false }).order('updated_date', { ascending: false })
    return unwrap(data, error)
  },
  async getDefault(): Promise<AiCallScript | null> {
    const { data } = await supabase.from('ai_call_scripts').select('*').eq('is_active', true).order('is_default', { ascending: false }).order('updated_date', { ascending: false }).limit(1)
    return data?.[0] ?? null
  },
  async create(payload: Partial<AiCallScript>): Promise<AiCallScript> {
    const { data, error } = await supabase.from('ai_call_scripts').insert({ ...payload, updated_date: new Date().toISOString() }).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<AiCallScript>): Promise<void> {
    const { error } = await supabase.from('ai_call_scripts').update({ ...payload, updated_date: new Date().toISOString() }).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    // 論理削除（is_active=false）。物理削除はしない（ジョブから参照されるため）
    const { error } = await supabase.from('ai_call_scripts').update({ is_active: false, updated_date: new Date().toISOString() }).eq('id', id)
    if (error) throw new Error(error.message)
  },
}

// Twilio実発信（サーバー /api/ai-call/twilio 経由。キーはサーバーのみ）。まずはテスト番号への1件発信用。
export const TwilioApi = {
  async status(): Promise<{ ok: boolean; provider?: string; configured?: boolean; missingEnv?: string[]; realCallEnabled?: boolean }> {
    try { const r = await fetch('/api/ai-call/twilio', { cache: 'no-store' }); return await r.json() } catch { return { ok: false, configured: false } }
  },
  async testCall(phone: string, message: string, caseId?: string | null): Promise<any> {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return { ok: false, error: 'ログインが必要です' }
    const r = await fetch('/api/ai-call/twilio?action=start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ phone, message, caseId: caseId ?? null }),
    })
    return r.json().catch(() => ({ ok: false, error: 'サーバー応答なし' }))
  },
  /** 案件から実発信。testMode=true(既定)なら案件番号ではなくtestNumberへ差し替え。ジョブはcaseIdに紐付く。 */
  async caseCall(opts: { caseId: string; phone: string; testMode: boolean; testNumber?: string; message?: string }): Promise<any> {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return { ok: false, error: 'ログインが必要です' }
    const r = await fetch('/api/ai-call/twilio?action=start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ caseId: opts.caseId, phone: opts.phone, testMode: opts.testMode, testNumber: opts.testNumber ?? '', message: opts.message ?? '' }),
    })
    return r.json().catch(() => ({ ok: false, error: 'サーバー応答なし' }))
  },
  /** 録音をサーバープロキシ経由で取得しBlob URLを返す（Twilio認証はサーバーのみ・ブラウザにトークンを出さない）。 */
  async recordingBlobUrl(jobId: string): Promise<{ ok: boolean; url?: string; error?: string; status?: number }> {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return { ok: false, error: 'ログインが必要です' }
    // POSTで送る（GETだとサーバーのGET=接続状態ハンドラに横取りされJSONが返るため）
    const r = await fetch('/api/ai-call/twilio?action=recording-audio', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }),
    })
    const ct = r.headers.get('content-type') || ''
    if (r.ok && ct.includes('audio')) { const b = await r.blob(); return { ok: true, url: URL.createObjectURL(b) } }
    const j = await r.json().catch(() => ({}))
    return { ok: false, status: r.status, error: (j as any)?.error || `録音取得に失敗しました (HTTP ${r.status})` }
  },
  /** 録音の文字起こし＆AI要約を実行（管理者・手動）。 */
  async process(jobId: string): Promise<any> {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return { ok: false, error: 'ログインが必要です' }
    const r = await fetch('/api/ai-call/twilio?action=process', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId }),
    })
    return r.json().catch(() => ({ ok: false, error: 'サーバー応答なし' }))
  },
}

/** AI推奨ステータスを案件へ反映（管理者確認後）。recordCallOutcome を通し、ジョブに反映済みフラグを立てる。 */
export async function applyAiJudgment(job: AiCallJob, kase: Case, opts: { nextAtIso?: string | null; salesRep?: string | null; userId?: string | null } = {}): Promise<string> {
  const outcome = (job.recommended_status || '再架電') as AiCallStatus
  await recordCallOutcome(job, kase, outcome, opts)
  await AiCallJobApi.update(job.id, { ai_applied: true }).catch(() => {})
  return outcome
}

// 通話後の結果(6種)→ ジョブ/案件/コール履歴に反映。営業ステータスにもマップ。
const OUTCOME_STATUS: Record<string, string | undefined> = { 興味あり: '見込み', 再架電: '再コール', NG: '対象外案件' }
const OUTCOME_TEMP: Record<string, '高' | '中' | '低'> = { 興味あり: '高', 再架電: '中', 担当者不在: '中', 不在: '低', 興味なし: '低', NG: '低' }

export async function recordCallOutcome(job: AiCallJob, kase: Case, outcome: AiCallStatus, opts: { nextAtIso?: string | null; salesRep?: string | null; userId?: string | null } = {}): Promise<void> {
  const now = new Date().toISOString()
  const contactType: '接触' | '非接触' = (outcome === '不在' || outcome === '担当者不在') ? '非接触' : '接触'
  const nextStatus = OUTCOME_STATUS[outcome]
  const nextAction = outcome === '興味あり' ? '訪問/商談アポを設定' : opts.nextAtIso ? `${new Date(opts.nextAtIso).toLocaleString('ja-JP')} に再架電` : outcome === 'NG' ? '再架電しない（NG）' : ''
  // 1) コール履歴(call_logs)へ記録（右側コール履歴パネルに反映）
  await CallLogApi.create({
    case_id: kase.id, case_name: kase.name, call_at: now, contact_type: contactType,
    result: `AI架電: ${outcome}`, memo: [job.transcript || '', job.duration_sec != null ? `通話${job.duration_sec}秒` : ''].filter(Boolean).join(' / ') || null,
    summary: `AI架電結果: ${outcome}`, prev_status: kase.status, next_status: nextStatus ?? null,
    next_recall_at: opts.nextAtIso ?? null, sales_rep: opts.salesRep ?? kase.sales_rep ?? null, created_by_id: opts.userId ?? null,
  }).catch(() => {})
  // 2) 架電ジョブ更新
  await AiCallJobApi.update(job.id, { status: outcome, next_action: nextAction || null }).catch(() => {})
  // 3) 案件更新（AI架電ステータス/温度感/次回アクション＋必要ならステータス・NG・次回架電日）
  const cu: any = { ai_call_status: outcome, ai_call_temperature: OUTCOME_TEMP[outcome] ?? null, ai_call_next_action: nextAction || null, last_ai_call_at: now }
  if (outcome === 'NG') cu.do_not_call = true
  if (opts.nextAtIso) cu.next_ai_call_at = opts.nextAtIso
  if (nextStatus) cu.status = nextStatus
  await CaseApi.update(kase.id, cu)
}

export const AiCallJobApi = {
  async listByCase(caseId: string, limit = 30): Promise<AiCallJob[]> {
    const { data, error } = await supabase.from('ai_call_jobs').select('*').eq('case_id', caseId).order('created_date', { ascending: false }).limit(limit)
    return unwrap(data, error)
  },
  async recent(limit = 100): Promise<AiCallJob[]> {
    const { data, error } = await supabase.from('ai_call_jobs').select('*').order('created_date', { ascending: false }).limit(limit)
    return unwrap(data, error)
  },
  // Twilio実発信（接続テスト含む）の最近のログ。※接続テストは case_id=null のため案件別ログには出ない。
  async recentTwilio(limit = 10): Promise<AiCallJob[]> {
    const { data, error } = await supabase.from('ai_call_jobs').select('*').eq('provider', 'twilio').order('created_date', { ascending: false }).limit(limit)
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<AiCallJob>): Promise<void> {
    const { error } = await supabase.from('ai_call_jobs').update({ ...payload, updated_date: new Date().toISOString() }).eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export interface RunTestCallOpts { userId?: string | null; forceStatus?: AiCallStatus; provider?: string }

/** 1件テスト発信（モック）。発信中ジョブ作成→プロバイダ実行→結果保存→NGは再架電防止。 */
export async function runTestCall(kase: Case, script: AiCallScript | null, opts: RunTestCallOpts = {}): Promise<AiCallJob> {
  if ((kase as any).do_not_call) throw new Error('この会社はNG（再架電しない）に設定されています。架電できません。')
  const phone = kase.phone1 || ''
  if (!phone) throw new Error('電話番号が未登録のため架電できません。')

  // 1) 発信中ジョブを作成
  const nowIso = new Date().toISOString()
  const { data: job, error: je } = await supabase.from('ai_call_jobs').insert({
    case_id: kase.id, case_name: kase.name, phone, script_id: script?.id ?? null,
    status: '発信中' as AiCallStatus, provider: opts.provider || 'mock', called_at: nowIso, created_by_id: opts.userId ?? null,
  }).select().single()
  if (je || !job) throw new Error(je?.message || 'ジョブ作成に失敗しました')

  try {
    // 2) プロバイダ実行（既定モック）
    const provider = getCallProvider(opts.provider || 'mock')
    const result = await provider.placeCall({ phone, caseName: kase.name, script: script?.body || '', forceStatus: opts.forceStatus })

    // 3) 結果を保存
    await AiCallJobApi.update(job.id, {
      status: result.status, called_at: nowIso, duration_sec: result.durationSec,
      transcript: result.transcript, ai_summary: result.aiSummary, temperature: result.temperature,
      next_action: result.nextAction, provider_call_sid: result.providerCallSid, provider: result.provider, error: result.error ?? null,
    })

    // 4) 案件側: 最新架電ステータス/温度感/次回アクションを反映（一覧表示用）＋NGなら再架電防止
    const caseUpdate: any = { last_ai_call_at: nowIso, ai_call_status: result.status, ai_call_temperature: result.temperature ?? null, ai_call_next_action: result.nextAction ?? null }
    if (result.status === 'NG') caseUpdate.do_not_call = true
    await supabase.from('cases').update(caseUpdate).eq('id', kase.id).then(() => {}, () => {})

    return { ...(job as AiCallJob), ...result, called_at: nowIso }
  } catch (e: any) {
    await AiCallJobApi.update(job.id, { status: '通話完了', error: String(e?.message || e).slice(0, 300) }).catch(() => {})
    throw e
  }
}

/** 次回架電予定日を設定（不在/担当者不在/再架電）。案件の next_ai_call_at と状態を更新し、ジョブにも記録。 */
export async function setNextCall(kase: Case, job: AiCallJob | null, nextAtIso: string): Promise<void> {
  await supabase.from('cases').update({ next_ai_call_at: nextAtIso, ai_call_status: job?.status ?? kase.ai_call_status ?? null }).eq('id', kase.id).then(() => {}, () => {})
  if (job?.id) await AiCallJobApi.update(job.id, { next_action: `${new Date(nextAtIso).toLocaleString('ja-JP')} に再架電` }).catch(() => {})
}

/** NG解除（管理者）: 再架電可能に戻す。 */
export async function releaseNg(caseId: string): Promise<void> {
  const { error } = await supabase.from('cases').update({ do_not_call: false, ai_call_status: null }).eq('id', caseId)
  if (error) throw new Error(error.message)
}

/** 興味あり→訪問予定を作成し、既存のGoogleカレンダー同期を再利用。カレンダー反映の成否も返す。 */
export async function createInterestAppointment(job: AiCallJob, kase: Case, appoAtIso: string, salesRep: string | null, userId: string | null): Promise<{ appointment: Appointment; sync: SyncResult }> {
  const memo = [
    '【AIテレアポ 興味ありから登録】',
    job.ai_summary ? `要約: ${job.ai_summary}` : '',
    job.temperature ? `温度感: ${job.temperature}` : '',
    job.next_action ? `次回アクション: ${job.next_action}` : '',
  ].filter(Boolean).join('\n')
  const { data: appt, error } = await supabase.from('appointments').insert({
    case_id: kase.id, case_name: kase.name, address: kase.address || null, sales_rep: salesRep || null,
    appo_at: appoAtIso, memo, created_by_id: userId,
  }).select().single()
  if (error || !appt) throw new Error(error?.message || '訪問予定の作成に失敗しました')
  // 既存のGoogleカレンダー同期を再利用（設定ON＆サービスアカウント設定時のみ反映）。成否を返す。
  const sync = await syncAppointmentResult(appt as Appointment, kase)
  // ジョブに紐付け（訪問予定登録済みの印）
  await AiCallJobApi.update(job.id, { appointment_id: (appt as any).id }).catch(() => {})
  return { appointment: appt as Appointment, sync }
}

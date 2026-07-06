import { supabase } from './supabaseClient'
import type {
  Appointment,
  AuditLog,
  Case,
  CallLog,
  CallSession,
  ImportBatch,
  LeadCandidate,
  Profile,
  Recall,
  SignupRequest,
  Template,
  Employee,
  AttendanceRecord,
  WorkShift,
  LeaveBalance,
  LeaveRequest,
  ApprovalRequest,
  LaborAlert,
  LaborDocument,
  LaborSettings,
  LaborAuditLog,
} from './types'

/**
 * Base44 の entities.* を Supabase に置換したデータアクセス層。
 * 画面側はこのオブジェクト経由で CRUD する。
 */

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message)
  return data as T
}

export const CaseApi = {
  async list(limit = 500): Promise<Case[]> {
    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .order('created_date', { ascending: false })
      .limit(limit)
    return unwrap(data, error)
  },
  /** 店舗名・住所・電話で部分一致検索（コマンドパレット用・サーバー側 ilike） */
  async search(term: string, limit = 20): Promise<Case[]> {
    const t = term.trim()
    if (!t) return []
    const digits = t.replace(/[^0-9]/g, '')
    const ors = [`name.ilike.%${t}%`, `address.ilike.%${t}%`]
    if (digits) {
      ors.push(`phone1.ilike.%${digits}%`, `phone2.ilike.%${digits}%`, `phone3.ilike.%${digits}%`)
    }
    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .or(ors.join(','))
      .limit(limit)
    if (error) {
      console.warn('[Case] search', error.message)
      return []
    }
    return data as Case[]
  },
  /** 件数のみ取得（head リクエスト） */
  async count(): Promise<number> {
    const { count, error } = await supabase
      .from('cases')
      .select('*', { count: 'exact', head: true })
    if (error) throw new Error(error.message)
    return count ?? 0
  },
  /**
   * 全件をサーバーサイドページングで取得する。
   * Supabase の 1リクエスト上限（既定1000行）を超える場合も range で順次取得。
   * maxPages で暴走を防止（既定 30 ページ = 最大 30,000 件）。
   */
  async listAll(pageSize = 1000, maxPages = 30): Promise<Case[]> {
    const all: Case[] = []
    for (let page = 0; page < maxPages; page++) {
      const from = page * pageSize
      const to = from + pageSize - 1
      const { data, error } = await supabase
        .from('cases')
        .select('*')
        .order('created_date', { ascending: false })
        .range(from, to)
      if (error) throw new Error(error.message)
      const rows = data ?? []
      all.push(...rows)
      if (rows.length < pageSize) break
    }
    return all
  },
  async create(payload: Partial<Case>): Promise<Case> {
    const { data, error } = await supabase.from('cases').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<Case>): Promise<void> {
    const { error } = await supabase.from('cases').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('cases').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
  async bulkUpdate(ids: string[], payload: Partial<Case>): Promise<void> {
    if (ids.length === 0) return
    const { error } = await supabase.from('cases').update(payload).in('id', ids)
    if (error) throw new Error(error.message)
  },
  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const { error } = await supabase.from('cases').delete().in('id', ids)
    if (error) throw new Error(error.message)
  },
}

/** 監査ログ（テーブルが無くても失敗させない） */
export const AuditApi = {
  async list(limit = 200): Promise<AuditLog[]> {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_date', { ascending: false })
      .limit(limit)
    if (error) {
      console.warn('[Audit] list skipped:', error.message)
      return []
    }
    return data as AuditLog[]
  },
  async log(payload: Partial<AuditLog>): Promise<void> {
    try {
      const { error } = await supabase.from('audit_logs').insert(payload)
      if (error) console.warn('[Audit] log skipped:', error.message)
    } catch (e) {
      console.warn('[Audit] log error:', e)
    }
  },
}

/** AI投入リスト候補（テーブルが無くても失敗させない） */
export const LeadCandidateApi = {
  async list(limit = 500): Promise<LeadCandidate[]> {
    const { data, error } = await supabase
      .from('lead_candidates')
      .select('*')
      .order('created_date', { ascending: false })
      .limit(limit)
    if (error) {
      console.warn('[Lead] list skipped:', error.message)
      return []
    }
    return data as LeadCandidate[]
  },
  async create(payload: Partial<LeadCandidate>): Promise<LeadCandidate | null> {
    const { data, error } = await supabase.from('lead_candidates').insert(payload).select().single()
    if (error) {
      console.warn('[Lead] create skipped:', error.message)
      return null
    }
    return data as LeadCandidate
  },
  async update(id: string, payload: Partial<LeadCandidate>): Promise<void> {
    const { error } = await supabase.from('lead_candidates').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('lead_candidates').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

/** 自動取得設定（Cronが参照する app_config） */
export const AppConfigApi = {
  async get(key: string): Promise<any | null> {
    const { data, error } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle()
    if (error) { console.warn('[AppConfig] get skipped:', error.message); return null }
    return (data as any)?.value ?? null
  },
  async set(key: string, value: any): Promise<void> {
    const { error } = await supabase.from('app_config').upsert({ key, value, updated_date: new Date().toISOString() }, { onConflict: 'key' })
    if (error) throw new Error(error.message)
  },
}

/** クエリ実行履歴（巡回進捗の表示用） */
export const LeadQueryLogApi = {
  /** 直近 days 日に実行したクエリ履歴（都県別進捗の集計に使用） */
  async recent(days = 7, limit = 5000): Promise<{ query: string; prefecture: string | null; area: string | null; last_run_at: string; hot_count: number; places_count: number }[]> {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const { data, error } = await supabase
      .from('lead_query_log')
      .select('query,prefecture,area,last_run_at,hot_count,places_count')
      .gte('last_run_at', since)
      .order('last_run_at', { ascending: false })
      .limit(limit)
    if (error) { console.warn('[LeadQueryLog] recent skipped:', error.message); return [] }
    return (data as any[]) || []
  },
}

/** 新規登録申請（ログイン前でも anon で作成可。一覧/承認は管理者） */
export const SignupRequestApi = {
  async create(input: { email: string; display_name?: string; memo?: string }): Promise<void> {
    const email = input.email.trim().toLowerCase()
    if (!email) throw new Error('メールアドレスを入力してください')
    const { data: existing } = await supabase.from('signup_requests').select('id').eq('email', email).eq('status', 'pending').limit(1)
    if (existing && existing[0]) throw new Error('既にこのメールアドレスで申請済みです（管理者の確認待ち）')
    const { error } = await supabase.from('signup_requests').insert({
      email, display_name: input.display_name?.trim() || null, memo: input.memo?.trim() || null, status: 'pending',
    })
    if (error) throw new Error(error.message)
  },
  async list(status?: string): Promise<SignupRequest[]> {
    let q = supabase.from('signup_requests').select('*').order('created_at', { ascending: false }).limit(200)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) { console.warn('[SignupRequest] list', error.message); return [] }
    return (data as SignupRequest[]) || []
  },
  async setStatus(id: string, status: string): Promise<void> {
    const { error } = await supabase.from('signup_requests').update({ status }).eq('id', id)
    if (error) throw new Error(error.message)
  },
}

/** 管理ユーザーAPI（service role はサーバー側のみ。JWTで admin 判定） */
export const AdminUserApi = {
  async call(action: string, payload: any): Promise<any> {
    const { data: sess } = await supabase.auth.getSession()
    const token = sess.session?.access_token
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action, ...payload }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${res.status}`)
    return json
  },
}

/** プロフィール / ユーザー管理 */
export const ProfileApi = {
  async list(limit = 200): Promise<Profile[]> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_date', { ascending: true })
      .limit(limit)
    if (error) {
      console.warn('[Profile] list skipped:', error.message)
      return []
    }
    return data as Profile[]
  },
  async me(id: string): Promise<Profile | null> {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle()
    if (error) {
      console.warn('[Profile] me skipped:', error.message)
      return null
    }
    return (data as Profile) ?? null
  },
  async update(id: string, payload: Partial<Profile>): Promise<void> {
    const { error } = await supabase.from('profiles').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const CallLogApi = {
  async list(limit = 1000): Promise<CallLog[]> {
    const { data, error } = await supabase
      .from('call_logs')
      .select('*')
      .order('call_at', { ascending: false })
      .limit(limit)
    return unwrap(data, error)
  },
  async listAll(pageSize = 1000, maxPages = 30): Promise<CallLog[]> {
    const all: CallLog[] = []
    for (let page = 0; page < maxPages; page++) {
      const from = page * pageSize
      const { data, error } = await supabase
        .from('call_logs')
        .select('*')
        .order('call_at', { ascending: false })
        .range(from, from + pageSize - 1)
      if (error) throw new Error(error.message)
      const rows = data ?? []
      all.push(...rows)
      if (rows.length < pageSize) break
    }
    return all
  },
  async create(payload: Partial<CallLog>): Promise<CallLog> {
    const { data, error } = await supabase.from('call_logs').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<CallLog>): Promise<void> {
    const { error } = await supabase.from('call_logs').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('call_logs').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const AppointmentApi = {
  async list(limit = 500): Promise<Appointment[]> {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .order('appo_at')
      .limit(limit)
    return unwrap(data, error)
  },
  async listAll(pageSize = 1000, maxPages = 30): Promise<Appointment[]> {
    const all: Appointment[] = []
    for (let page = 0; page < maxPages; page++) {
      const from = page * pageSize
      const { data, error } = await supabase
        .from('appointments')
        .select('*')
        .order('appo_at')
        .range(from, from + pageSize - 1)
      if (error) throw new Error(error.message)
      const rows = data ?? []
      all.push(...rows)
      if (rows.length < pageSize) break
    }
    return all
  },
  async create(payload: Partial<Appointment>): Promise<Appointment> {
    const { data, error } = await supabase.from('appointments').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<Appointment>): Promise<void> {
    const { error } = await supabase.from('appointments').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('appointments').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const RecallApi = {
  async list(limit = 500): Promise<Recall[]> {
    const { data, error } = await supabase
      .from('recalls')
      .select('*')
      .order('target_at')
      .limit(limit)
    return unwrap(data, error)
  },
  async listAll(pageSize = 1000, maxPages = 30): Promise<Recall[]> {
    const all: Recall[] = []
    for (let page = 0; page < maxPages; page++) {
      const from = page * pageSize
      const { data, error } = await supabase
        .from('recalls')
        .select('*')
        .order('target_at')
        .range(from, from + pageSize - 1)
      if (error) throw new Error(error.message)
      const rows = data ?? []
      all.push(...rows)
      if (rows.length < pageSize) break
    }
    return all
  },
  async create(payload: Partial<Recall>): Promise<Recall> {
    const { data, error } = await supabase.from('recalls').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<Recall>): Promise<void> {
    const { error } = await supabase.from('recalls').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('recalls').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const ImportBatchApi = {
  async list(limit = 50): Promise<ImportBatch[]> {
    const { data, error } = await supabase
      .from('import_batches')
      .select('*')
      .order('created_date', { ascending: false })
      .limit(limit)
    return unwrap(data, error)
  },
  async create(payload: Partial<ImportBatch>): Promise<ImportBatch | null> {
    // import_batches テーブルが無くても取込自体は失敗させない
    const { data, error } = await supabase
      .from('import_batches')
      .insert(payload)
      .select()
      .single()
    if (error) {
      console.warn('[ImportBatch] create skipped:', error.message)
      return null
    }
    return data as ImportBatch
  },
}

export const TemplateApi = {
  async list(limit = 300): Promise<Template[]> {
    const { data, error } = await supabase
      .from('templates')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_date', { ascending: true })
      .limit(limit)
    if (error) {
      console.warn('[Template] list skipped:', error.message)
      return []
    }
    return data as Template[]
  },
  async create(payload: Partial<Template>): Promise<Template | null> {
    const { data, error } = await supabase.from('templates').insert(payload).select().single()
    if (error) {
      console.warn('[Template] create skipped:', error.message)
      return null
    }
    return data as Template
  },
  async update(id: string, payload: Partial<Template>): Promise<void> {
    const { error } = await supabase.from('templates').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('templates').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
  /** templates が空のときに既定の定型文を投入する */
  async seedDefaults(
    defaults: { category: string; title: string; body: string; status?: string }[],
  ): Promise<number> {
    const existing = await this.list(1)
    if (existing.length > 0) return 0
    let n = 0
    for (let i = 0; i < defaults.length; i++) {
      const d = defaults[i]
      const created = await this.create({ ...d, sort_order: i })
      if (created) n++
    }
    return n
  },
}

/**
 * 案件ステータスを変更し、call_logs に変更履歴を残す。
 * 変更前/変更後ステータス・担当者・日時を保存する。
 */
export async function changeCaseStatus(
  c: Case,
  nextStatus: string,
  opts: {
    sales_rep?: string | null
    memo?: string | null
    userId?: string | null
    actorName?: string | null
  } = {},
): Promise<void> {
  const prev = c.status
  if (prev === nextStatus && opts.sales_rep === undefined) return
  await CaseApi.update(c.id, {
    status: nextStatus,
    ...(opts.sales_rep !== undefined ? { sales_rep: opts.sales_rep } : {}),
  })
  if (prev !== nextStatus) {
    await CallLogApi.create({
      case_id: c.id,
      case_name: c.name,
      call_at: new Date().toISOString(),
      contact_type: '非接触',
      result: `ステータス変更: ${prev} → ${nextStatus}`,
      memo: opts.memo ?? null,
      summary: `ステータス: ${prev} → ${nextStatus}`,
      prev_status: prev,
      next_status: nextStatus,
      sales_rep: opts.sales_rep ?? c.sales_rep ?? null,
      created_by_id: opts.userId ?? null,
    })
    AuditApi.log({
      action: 'status_change',
      entity: 'case',
      entity_id: c.id,
      entity_name: c.name,
      detail: `${prev} → ${nextStatus}`,
      actor_id: opts.userId ?? null,
      actor_name: opts.actorName ?? null,
    })
  }
}

export const CallSessionApi = {
  /** session_key で1件取得（最新） */
  async getByKey(key: string): Promise<CallSession | null> {
    const { data, error } = await supabase
      .from('call_sessions')
      .select('*')
      .eq('session_key', key)
      .order('updated_date', { ascending: false })
      .limit(1)
    if (error) throw new Error(error.message)
    return data && data.length > 0 ? data[0] : null
  },
  /** session_key で upsert（PC側の案件選択ごとに呼ぶ） */
  async upsert(payload: Partial<CallSession> & { session_key: string }): Promise<CallSession> {
    const { data, error } = await supabase
      .from('call_sessions')
      .upsert(payload, { onConflict: 'session_key' })
      .select()
      .single()
    return unwrap(data, error)
  },
}

// ============================================================
// 労務管理（Labor / HR）データアクセス層
// すべて Supabase 直アクセス（Vercel Function は増やさない）。
// テーブル未適用環境でも一覧系は空配列で握りつぶし、画面を壊さない。
// ============================================================

/** テーブル未作成でも落ちない一覧取得の共通ヘルパ */
async function safeList<T>(table: string, orderCol: string, ascending = false, limit = 1000): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .order(orderCol, { ascending })
    .limit(limit)
  if (error) {
    console.warn(`[Labor] ${table} list skipped:`, error.message)
    return []
  }
  return (data ?? []) as T[]
}

export const EmployeeApi = {
  list: (limit = 1000) => safeList<Employee>('employees', 'created_at', true, limit),
  async get(id: string): Promise<Employee | null> {
    const { data, error } = await supabase.from('employees').select('*').eq('id', id).maybeSingle()
    if (error) { console.warn('[Employee] get', error.message); return null }
    return (data as Employee) ?? null
  },
  async create(payload: Partial<Employee>): Promise<Employee> {
    const { data, error } = await supabase.from('employees').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<Employee>): Promise<void> {
    const { error } = await supabase.from('employees').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('employees').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const AttendanceApi = {
  list: (limit = 1000) => safeList<AttendanceRecord>('attendance_records', 'work_date', false, limit),
  async listByDate(date: string): Promise<AttendanceRecord[]> {
    const { data, error } = await supabase
      .from('attendance_records').select('*').eq('work_date', date)
    if (error) { console.warn('[Attendance] listByDate', error.message); return [] }
    return (data ?? []) as AttendanceRecord[]
  },
  async listByMonth(month: string): Promise<AttendanceRecord[]> {
    // month = 'YYYY-MM'
    const { data, error } = await supabase
      .from('attendance_records').select('*')
      .gte('work_date', `${month}-01`).lte('work_date', `${month}-31`)
      .order('work_date', { ascending: false })
    if (error) { console.warn('[Attendance] listByMonth', error.message); return [] }
    return (data ?? []) as AttendanceRecord[]
  },
  async listByEmployee(employeeId: string, limit = 200): Promise<AttendanceRecord[]> {
    const { data, error } = await supabase
      .from('attendance_records').select('*').eq('employee_id', employeeId)
      .order('work_date', { ascending: false }).limit(limit)
    if (error) { console.warn('[Attendance] listByEmployee', error.message); return [] }
    return (data ?? []) as AttendanceRecord[]
  },
  async getForDay(employeeId: string, date: string): Promise<AttendanceRecord | null> {
    const { data, error } = await supabase
      .from('attendance_records').select('*')
      .eq('employee_id', employeeId).eq('work_date', date).maybeSingle()
    if (error) { console.warn('[Attendance] getForDay', error.message); return null }
    return (data as AttendanceRecord) ?? null
  },
  /** 打刻を1件 upsert（employee_id + work_date で一意） */
  async upsert(payload: Partial<AttendanceRecord> & { employee_id: string; work_date: string }): Promise<AttendanceRecord> {
    const { data, error } = await supabase
      .from('attendance_records')
      .upsert(payload, { onConflict: 'employee_id,work_date' })
      .select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<AttendanceRecord>): Promise<void> {
    const { error } = await supabase.from('attendance_records').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('attendance_records').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const ShiftApi = {
  list: (limit = 1000) => safeList<WorkShift>('work_shifts', 'shift_date', false, limit),
  async listByMonth(month: string): Promise<WorkShift[]> {
    const { data, error } = await supabase
      .from('work_shifts').select('*')
      .gte('shift_date', `${month}-01`).lte('shift_date', `${month}-31`)
      .order('shift_date', { ascending: true })
    if (error) { console.warn('[Shift] listByMonth', error.message); return [] }
    return (data ?? []) as WorkShift[]
  },
  async create(payload: Partial<WorkShift>): Promise<WorkShift> {
    const { data, error } = await supabase.from('work_shifts').insert(payload).select().single()
    return unwrap(data, error)
  },
  async upsert(payload: Partial<WorkShift> & { employee_id: string; shift_date: string }): Promise<WorkShift> {
    const { data, error } = await supabase
      .from('work_shifts').upsert(payload, { onConflict: 'employee_id,shift_date' }).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<WorkShift>): Promise<void> {
    const { error } = await supabase.from('work_shifts').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('work_shifts').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const LeaveBalanceApi = {
  list: (limit = 1000) => safeList<LeaveBalance>('leave_balances', 'fiscal_year', false, limit),
  async upsert(payload: Partial<LeaveBalance> & { employee_id: string; fiscal_year: number }): Promise<LeaveBalance> {
    const { data, error } = await supabase
      .from('leave_balances').upsert(payload, { onConflict: 'employee_id,fiscal_year' }).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<LeaveBalance>): Promise<void> {
    const { error } = await supabase.from('leave_balances').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const LeaveRequestApi = {
  list: (limit = 1000) => safeList<LeaveRequest>('leave_requests', 'requested_at', false, limit),
  async create(payload: Partial<LeaveRequest>): Promise<LeaveRequest> {
    const { data, error } = await supabase.from('leave_requests').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<LeaveRequest>): Promise<void> {
    const { error } = await supabase.from('leave_requests').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('leave_requests').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const ApprovalApi = {
  list: (limit = 1000) => safeList<ApprovalRequest>('approval_requests', 'requested_at', false, limit),
  async listPending(): Promise<ApprovalRequest[]> {
    const { data, error } = await supabase
      .from('approval_requests').select('*').eq('status', 'pending')
      .order('requested_at', { ascending: true })
    if (error) { console.warn('[Approval] listPending', error.message); return [] }
    return (data ?? []) as ApprovalRequest[]
  },
  async create(payload: Partial<ApprovalRequest>): Promise<ApprovalRequest> {
    const { data, error } = await supabase.from('approval_requests').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<ApprovalRequest>): Promise<void> {
    const { error } = await supabase.from('approval_requests').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('approval_requests').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const LaborAlertApi = {
  list: (limit = 1000) => safeList<LaborAlert>('labor_alerts', 'created_at', false, limit),
  async listOpen(): Promise<LaborAlert[]> {
    const { data, error } = await supabase
      .from('labor_alerts').select('*').eq('status', 'open')
      .order('created_at', { ascending: false })
    if (error) { console.warn('[Alert] listOpen', error.message); return [] }
    return (data ?? []) as LaborAlert[]
  },
  async create(payload: Partial<LaborAlert>): Promise<LaborAlert> {
    const { data, error } = await supabase.from('labor_alerts').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<LaborAlert>): Promise<void> {
    const { error } = await supabase.from('labor_alerts').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('labor_alerts').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const LaborDocumentApi = {
  list: (limit = 1000) => safeList<LaborDocument>('labor_documents', 'created_at', false, limit),
  async create(payload: Partial<LaborDocument>): Promise<LaborDocument> {
    const { data, error } = await supabase.from('labor_documents').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<LaborDocument>): Promise<void> {
    const { error } = await supabase.from('labor_documents').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('labor_documents').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

export const LaborSettingsApi = {
  /** 会社全体設定（先頭1行を運用）。無ければ null。 */
  async get(): Promise<LaborSettings | null> {
    const { data, error } = await supabase
      .from('labor_settings').select('*').order('created_at', { ascending: true }).limit(1)
    if (error) { console.warn('[LaborSettings] get', error.message); return null }
    return data && data.length > 0 ? (data[0] as LaborSettings) : null
  },
  async create(payload: Partial<LaborSettings>): Promise<LaborSettings> {
    const { data, error } = await supabase.from('labor_settings').insert(payload).select().single()
    return unwrap(data, error)
  },
  async update(id: string, payload: Partial<LaborSettings>): Promise<void> {
    const { error } = await supabase.from('labor_settings').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  },
}

/** 労務監査ログ（テーブルが無くても失敗させない） */
export const LaborAuditApi = {
  list: (limit = 300) => safeList<LaborAuditLog>('labor_audit_logs', 'created_at', false, limit),
  async log(payload: Partial<LaborAuditLog>): Promise<void> {
    try {
      const { error } = await supabase.from('labor_audit_logs').insert(payload)
      if (error) console.warn('[LaborAudit] log skipped:', error.message)
    } catch (e) {
      console.warn('[LaborAudit] log error:', e)
    }
  },
}

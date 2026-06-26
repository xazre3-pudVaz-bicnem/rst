import { supabase } from './supabaseClient'
import type { Appointment, Case, CallLog, CallSession, Recall } from './types'

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

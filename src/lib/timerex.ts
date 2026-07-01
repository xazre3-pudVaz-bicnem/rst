// ============================================================
// TimeRex連携: アポ代行会社に「こちらの空き日程」を共有するためのURL管理。
// ※営業先へ送るものではない。Googleカレンダー連携・Webhookは行わない（URL管理・共有文・表示のみ）。
// ============================================================
import { supabase } from './supabaseClient'

export interface TimeRexSetting {
  id: string
  user_id: string | null
  name: string
  timerex_schedule_url: string | null
  memo: string | null
  is_enabled: boolean
  sort_order: number | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export const TimeRexApi = {
  /** 全件（並び順）。テーブル未作成でも失敗させない。 */
  async list(): Promise<TimeRexSetting[]> {
    const { data, error } = await supabase.from('timerex_settings').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) { console.warn('[TimeRex] list skipped:', error.message); return [] }
    return (data || []) as TimeRexSetting[]
  },
  /** 有効なもののみ（各画面の表示用）。 */
  async listEnabled(): Promise<TimeRexSetting[]> {
    const { data, error } = await supabase.from('timerex_settings').select('*').eq('is_enabled', true).not('timerex_schedule_url', 'is', null).order('sort_order', { ascending: true })
    if (error) { console.warn('[TimeRex] listEnabled skipped:', error.message); return [] }
    return (data || []) as TimeRexSetting[]
  },
  async create(payload: Partial<TimeRexSetting>, userId: string | null): Promise<TimeRexSetting | null> {
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('timerex_settings').insert({ ...payload, created_by: userId, updated_by: userId, updated_at: now }).select().single()
    if (error) throw new Error(error.message)
    return data as TimeRexSetting
  },
  async update(id: string, payload: Partial<TimeRexSetting>, userId: string | null): Promise<void> {
    const { error } = await supabase.from('timerex_settings').update({ ...payload, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) throw new Error(error.message)
  },
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('timerex_settings').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}

// ===== アポ代行会社向け 共有文（営業先向けではない） =====
export type ShareVariant = 'normal' | 'short' | 'slack' | 'mail'
export function buildAgencyShareText(url: string, variant: ShareVariant = 'normal', label?: string): string {
  const u = url || '（TimeRex URL未設定）'
  const title = label ? `【${label}】\n` : ''
  switch (variant) {
    case 'short':
      return `${title}アポ取得時はこちらの空き日程をご確認ください。\n${u}\n\n確定した日時はRSTの訪問予定へ登録してください。`
    case 'slack':
      return `${title}📅 アポ取得時の空き日程確認用（アポ代行会社向け）\n${u}\nアポ確定後は、確定日時・店舗名・担当者名・電話番号・住所をRSTの訪問予定に登録してください。`
    case 'mail':
      return `${title}お世話になっております。\n\nアポ取得時の日程調整については、下記TimeRexの空き日程をご確認ください。\n${u}\n\nお客様と日程が合いましたら、確定日時・店舗名・担当者名・電話番号・住所をRSTにご登録いただけますようお願いいたします。\n\n※こちらは弊社の空き日程確認用URLです。営業先へ直接お送りいただくものではございません。`
    default:
      return `${title}アポ取得時の日程調整については、下記TimeRexの空き日程をご確認ください。\n\n${u}\n\nお客様と日程が合った場合は、確定日時・店舗名・担当者名・電話番号・住所をRSTに登録してください。`
  }
}

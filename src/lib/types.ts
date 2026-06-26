export interface Case {
  id: string
  name: string
  address: string
  phone1: string
  phone2?: string | null
  phone3?: string | null
  industry?: string | null
  representative?: string | null
  status: string
  sales_rep?: string | null
  hp1?: string | null
  hp2?: string | null
  instagram?: string | null
  source_urls?: string | null
  memo?: string | null
  /** タグ（複数） */
  tags?: string[] | null
  /** 優先度: 高 / 中 / 低 */
  priority?: string | null
  /** マルチテナント対応（任意・既存データ互換のため nullable） */
  organization_id?: string | null
  created_by_id?: string | null
  assigned_to?: string | null
  created_date: string
  updated_date: string
}

export interface Appointment {
  id: string
  case_id: string
  case_name: string
  address?: string | null
  sales_rep?: string | null
  appo_at: string
  memo?: string | null
  organization_id?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

export interface Recall {
  id: string
  case_id: string
  case_name: string
  target_at: string
  /** 完了済みフラグ（完了ボタンで true 化） */
  done?: boolean | null
  memo?: string | null
  organization_id?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

export interface CallLog {
  id: string
  case_id: string
  case_name: string
  call_at: string
  contact_type: '接触' | '非接触'
  result?: string | null
  memo?: string | null
  summary?: string | null
  /** ステータス変更履歴 */
  prev_status?: string | null
  next_status?: string | null
  /** このコールで設定した次回再コール日時 */
  next_recall_at?: string | null
  /** 担当者（記録者） */
  sales_rep?: string | null
  organization_id?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

export interface CallSession {
  id: string
  session_key: string
  case_id?: string | null
  case_name?: string | null
  address?: string | null
  status?: string | null
  phone1?: string | null
  phone2?: string | null
  phone3?: string | null
  created_date: string
  updated_date: string
}

/** CSV取込バッチ履歴 */
export interface ImportBatch {
  id: string
  source: string
  file_name?: string | null
  total_rows: number
  added_count: number
  duplicate_count: number
  error_count: number
  detail?: string | null
  organization_id?: string | null
  created_by_id?: string | null
  created_date: string
}

/** 通話メモ等のテンプレート */
export interface Template {
  id: string
  category: string
  title: string
  body: string
  /** ステータスに紐づく定型文（任意） */
  status?: string | null
  /** 並び順／使用頻度（小さいほど上位） */
  sort_order?: number | null
  organization_id?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

/** ユーザープロフィール（auth.users と 1:1） */
export interface Profile {
  id: string
  full_name?: string | null
  organization_id?: string | null
  /** 'admin' | 'member' | 'viewer' */
  role: string
  created_date: string
  updated_date: string
}

/** 監査ログ */
export interface AuditLog {
  id: string
  action: string
  entity: string
  entity_id?: string | null
  entity_name?: string | null
  detail?: string | null
  actor_id?: string | null
  actor_name?: string | null
  organization_id?: string | null
  created_date: string
}

/** Auto search settings stored in localStorage */
export interface AutoSearchSettings {
  enabled: boolean
  intervalMinutes: number
}

/** Shop extracted by LLM search */
export interface ExtractedShop {
  name: string
  address?: string
  phone1?: string
  phone2?: string
  industry?: string
  representative?: string
  hp1?: string
  hp2?: string
  instagram?: string
  source_urls?: string
  memo?: string
}

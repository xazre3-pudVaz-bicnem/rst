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

/** AI投入リスト候補 */
export type LeadTemperature = 'HOT' | 'WARM' | 'HOLD' | 'EXCLUDED'

export interface LeadCandidate {
  id: string
  name: string
  address?: string | null
  industry?: string | null
  phone_number?: string | null
  phone_normalized?: string | null
  website_url?: string | null
  instagram_url?: string | null
  place_id?: string | null
  source_type?: string | null
  first_seen_at: string
  last_seen_at: string
  is_new_gbp: boolean
  is_new_instagram: boolean
  is_new_website: boolean
  is_new_ad_listing: boolean
  is_new_corporation: boolean
  detected_signals?: string[] | null
  is_chain_store: boolean
  is_large_franchise: boolean
  is_in_shopping_mall: boolean
  is_in_station_building: boolean
  is_large_company_branch: boolean
  owner_reachability_score: number
  exclusion_reason?: string | null
  should_exclude_from_call_list: boolean
  auto_import_reason?: string | null
  ai_comment?: string | null
  lead_temperature: LeadTemperature
  imported_to_cases: boolean
  imported_at?: string | null
  duplicate_of_case_id?: string | null
  // Google Places 由来
  google_place_id?: string | null
  google_maps_uri?: string | null
  rating?: number | null
  user_rating_count?: number | null
  business_status?: string | null
  place_types?: string[] | null
  primary_type?: string | null
  raw_payload?: unknown
  search_query?: string | null
  source_run_id?: string | null
  organization_id?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

/** 自動取得バッチの実行ログ */
export interface LeadRun {
  id: string
  source: string
  status: string
  started_at: string
  finished_at?: string | null
  search_queries_count: number
  fetched_count: number
  hot_count: number
  hold_count: number
  excluded_count: number
  imported_count: number
  duplicate_count: number
  error_count: number
  error_message?: string | null
  created_date: string
}

/** スクレイプ等で取得した生候補（判定前） */
export interface RawLead {
  name: string
  address?: string
  industry?: string
  phone_number?: string
  website_url?: string
  instagram_url?: string
  place_id?: string
  source_type?: string
  is_new_gbp?: boolean
  is_new_instagram?: boolean
  is_new_website?: boolean
  is_new_ad_listing?: boolean
  is_new_corporation?: boolean
  review_count?: number
  business_status?: string
}

/** 判定の閾値（口コミ件数など） */
export interface ClassifyOpts {
  hotMaxReviews?: number   // これ以下ならHOT候補（既定5）
  warmMaxReviews?: number  // これ以下ならWARM/HOLD（既定15）
  exclude100?: boolean     // 口コミ100件以上は自動除外（既定true）
  unknownHold?: boolean    // 口コミ件数不明はHOLD（既定true）
}

/** AI投入リストの設定（localStorage） */
export interface LeadImportSettings {
  autoImport: boolean       // HOTをcasesへ自動投入
  placesEnabled: boolean    // Google Places実行ON/OFF
  fetchLimit: number        // 1回あたりの取得上限
  dailyCap: number          // 1日あたりの投入上限
  areas: string             // 改行/読点区切り
  industries: string        // 改行/読点区切り
  hotMaxReviews: number     // HOT判定の最大口コミ数（既定5）
  warmMaxReviews: number    // WARM判定の最大口コミ数（既定15）
  exclude100: boolean       // 口コミ100件以上は自動除外
  unknownHold: boolean      // 口コミ件数不明はHOLD
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

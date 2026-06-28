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
  // 新規店舗の複合判定
  opening_date?: string | null
  opening_date_source?: string | null
  is_new_opening_candidate?: boolean | null
  newness_reason?: string | null
  days_since_first_seen?: number | null
  from_new_open_query?: boolean | null
  // 口コミ投稿日による判定（新店判定は oldest を重視）
  latest_review_publish_time?: string | null
  oldest_review_publish_time?: string | null
  latest_review_days_ago?: number | null
  oldest_review_days_ago?: number | null
  oldest_review_is_recent?: boolean | null
  review_dates_checked?: boolean | null
  review_newness_reason?: string | null
  // Instagram 由来
  lead_source?: string | null
  instagram_media_id?: string | null
  instagram_permalink?: string | null
  instagram_caption?: string | null
  instagram_timestamp?: string | null
  instagram_account_url?: string | null
  source_hashtag?: string | null
  extracted_shop_name?: string | null
  extracted_area?: string | null
  extracted_industry?: string | null
  extracted_address?: string | null
  extracted_phone?: string | null
  extracted_url?: string | null
  extracted_line_url?: string | null
  extracted_reservation_url?: string | null
  matched_google_place_id?: string | null
  match_confidence?: number | null
  instagram_newness_reason?: string | null
  ig_classification?: string | null
  gbp_unregistered_candidate?: boolean | null
  ig_phone_reachable_score?: number | null
  ig_newness_score?: number | null
  ig_auto_importable?: boolean | null
  // 地域メディア由来
  source_article_url?: string | null
  source_article_title?: string | null
  source_site_name?: string | null
  regional_media_detected_at?: string | null
  extracted_open_date?: string | null
  regional_media_newness_reason?: string | null
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
  /** Google Places の開店日（YYYY-MM-DD 等） */
  opening_date?: string
  /** RST初回発見からの経過日数（新規発見は0） */
  first_seen_days?: number
  /** 「新規オープン」系クエリで取得されたか */
  from_new_open_query?: boolean
  /** 取得できたレビューの中で最新の publishTime（RFC3339） */
  latest_review_publish_time?: string
  /** 取得できたレビューの中で最古の publishTime（RFC3339）。新店判定に使用 */
  oldest_review_publish_time?: string
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
  // エリアプリセット & ローテーション
  areaPreset: string        // 'ittokensanken' | 'tokyo' | ... | 'custom'
  maxQueriesPerDay: number  // 1日あたり最大クエリ数（既定50）
  maxPerQuery: number       // 1クエリあたり最大取得件数（既定10）
  rotation: boolean         // 未実行/古いクエリから巡回
  autoFetch: boolean        // 毎朝6:00のCron自動取得ON/OFF（app_configに保存）
  // Instagram新店取得
  igEnabled: boolean        // Instagram取得ON/OFF
  igAutoImport: boolean     // IG単体HOT候補をcasesへ自動投入（初期OFF）
  igRequirePhone: boolean   // 自動投入は電話番号必須（初期ON）
  igAllowWithoutPlace: boolean // Places未照合でも自動投入可（初期OFF）
  igRequireOpenWord: boolean   // 新規オープン文言必須（初期ON）
  igRequireArea: boolean       // 一都三県エリア情報必須（初期ON）
  igPeriodDays: number         // 対象投稿期間（既定14日）
  igMaxHashtagsPerDay: number  // 1日のハッシュタグ検索数（既定5・7日30ユニーク制限内）
  // 地域メディア巡回
  regionalEnabled: boolean     // 地域メディア取得ON/OFF
  regionalMaxSites: number     // 1日の巡回サイト数（既定3）
  regionalMaxArticles: number  // 1サイトの最大記事数（既定5）
  regionalPeriodDays: number   // 記事公開の対象期間（既定30日）
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

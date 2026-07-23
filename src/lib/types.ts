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
  /** 営業時間（AI投入時に判明したもの。不明は null） */
  business_hours?: string | null
  source_urls?: string | null
  memo?: string | null
  /** タグ（複数） */
  tags?: string[] | null
  /** 優先度: 高 / 中 / 低 */
  priority?: string | null
  /** マルチテナント対応（任意・既存データ互換のため nullable） */
  organization_id?: string | null
  created_by_id?: string | null
  /** リスト作成者名（作成時に固定。営業担当 sales_rep とは別管理） */
  created_by_name?: string | null
  assigned_to?: string | null
  // ユーザーID単位の担当/作成/投入（作成者・投入者は固定、担当は可変）
  assigned_user_id?: string | null
  assigned_user_name?: string | null
  created_by_user_id?: string | null
  created_by_user_name?: string | null
  imported_by_user_id?: string | null
  imported_by_user_name?: string | null
  // AIテレアポ（denormalize: 一覧表示・フィルタ用）
  do_not_call?: boolean | null
  last_ai_call_at?: string | null
  ai_call_status?: string | null
  next_ai_call_at?: string | null
  ai_call_temperature?: string | null
  ai_call_next_action?: string | null
  created_date: string
  updated_date: string
}

export interface Appointment {
  id: string
  // 案件に紐づかない予定（社内MTG等）も登録できるため null 許容
  case_id?: string | null
  case_name?: string | null
  address?: string | null
  sales_rep?: string | null
  appo_at: string
  /** アポ形式。'zoom'=1時間枠 / '対面'(既定)=2時間枠 */
  meeting_type?: 'zoom' | '対面' | null
  memo?: string | null
  organization_id?: string | null
  created_by_id?: string | null
  google_event_id?: string | null
  google_synced_at?: string | null
  google_sync_error?: string | null
  created_date: string
  updated_date: string
}

// ===== 訪問結果（成約/失注）＋契約詳細 =====
export interface VisitReport {
  id: string
  case_id: string
  case_name?: string | null
  appointment_id?: string | null
  visited_at: string
  result: '成約' | '失注'
  lost_reason?: string | null
  memo?: string | null
  contract_date?: string | null
  min_contract_months?: number | null
  payment_method?: string | null
  hp_price?: number | null
  hp_payment_type?: '一括' | '分割' | null
  hp_installments?: number | null
  maintenance_price?: number | null
  seo_price?: number | null
  meo_price?: number | null
  total_price?: number | null
  created_by_id?: string | null
  created_date?: string
  updated_date?: string
}

// 月次KPI目標。sales_rep='' = 全体、氏名 = 営業マン毎
export interface KpiTarget {
  id?: string
  month: string            // 'YYYY-MM'
  sales_rep: string        // '' = 全体
  call_target: number      // コール（架電）
  appo_target: number      // アポ
  action_target: number    // 行動（訪問実施）
  contract_target: number  // 契約（成約）
  updated_date?: string
}

// ===== AIテレアポ MVP =====
export type AiCallStatus = '未架電' | '発信中' | '通話完了' | '不在' | '担当者不在' | '興味あり' | '興味なし' | '再架電' | 'NG'

export interface AiCallScript {
  id: string
  name: string
  body: string
  // ↓ 管理画面から編集する構造化トーク項目（realtime音声AIのinstructionsに反映）
  target_product?: string | null            // 対象商材
  opening_talk?: string | null              // 冒頭トーク（AIの最初の発話）
  contact_talk?: string | null              // 担当者につながった時のトーク
  reception_talk?: string | null            // 受付対応トーク
  interest_talk?: string | null             // 興味あり時のトーク
  pricing_answer?: string | null            // 料金を聞かれた時の回答
  rejection_handling?: string | null        // 断られた時の対応
  absent_handling?: string | null           // 担当者不在時の対応
  appointment_confirm_talk?: string | null  // アポ取得時の確認トーク
  ng_words?: string | null                  // 禁止ワード
  forbidden_actions?: string | null         // AIに絶対させない行動
  conversation_goal?: string | null         // 会話のゴール
  temperature_rule?: string | null          // 温度感判定ルール
  appointment_rule?: string | null          // アポ登録ルール
  is_default?: boolean | null
  is_active?: boolean | null
  created_by_id?: string | null
  created_date?: string
  updated_date?: string
}

export interface AiCallJob {
  id: string
  case_id?: string | null
  case_name?: string | null
  phone?: string | null
  script_id?: string | null
  status: AiCallStatus
  provider?: string | null
  provider_call_sid?: string | null
  called_at?: string | null
  duration_sec?: number | null
  transcript?: string | null
  ai_summary?: string | null
  temperature?: string | null
  next_action?: string | null
  appointment_id?: string | null
  error?: string | null
  // 音声AI（録音→文字起こし→AI要約/判定）
  recording_url?: string | null
  recording_sid?: string | null
  recording_duration_sec?: number | null
  recording_error?: string | null
  recommended_status?: string | null
  ai_reaction?: string | null
  ai_needs_recall?: boolean | null
  ai_should_ng?: boolean | null
  ai_applied?: boolean | null
  processing_status?: string | null
  processing_error?: string | null
  // リアルタイム音声AI会話
  call_mode?: string | null
  ai_contact_name?: string | null
  appo_at?: string | null
  calendar_result?: string | null
  created_by_id?: string | null
  created_date?: string
  updated_date?: string
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
  /** このコールで獲得したアポの日時（結果がアポの場合） */
  appo_at?: string | null
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
  /** 'admin' | 'manager' | 'sales' | 'viewer'（'member' は旧データ互換） */
  role: string
  email?: string | null
  username?: string | null
  is_active?: boolean | null
  is_sales_assignee?: boolean | null
  last_login?: string | null
  created_by?: string | null
  created_date: string
  updated_date: string
}

/** 新規登録申請 */
export interface SignupRequest {
  id: string
  email: string
  display_name?: string | null
  memo?: string | null
  status: string // pending | approved | rejected
  created_at: string
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
  // Instagram Web検索 由来（search_query は既出のため再宣言しない）
  source?: string | null
  search_title?: string | null
  search_snippet?: string | null
  line_url?: string | null
  reservation_url?: string | null
  official_url?: string | null
  anthropic_judgement?: unknown
  newness_type?: string | null
  extracted_prefecture?: string | null
  extracted_city?: string | null
  recommended_status?: string | null
  rule_filter_result?: string | null
  skipped_reason?: string | null
  api_run_id?: string | null
  // 外部情報補完
  enrichment_status?: string | null
  enrichment_sources?: unknown
  enriched_phone?: string | null
  enriched_address?: string | null
  enriched_prefecture?: string | null
  enriched_city?: string | null
  enriched_official_url?: string | null
  enriched_reservation_url?: string | null
  enriched_line_url?: string | null
  enriched_google_place_id?: string | null
  enriched_instagram_url?: string | null
  enrichment_reason?: string | null
  enrichment_confidence?: number | null
  last_enriched_at?: string | null
  // 取得元・信頼度
  enriched_phone_source?: string | null
  enriched_address_source?: string | null
  enriched_google_maps_url?: string | null
  enrichment_profile_fetched?: boolean | null
  enrichment_fail_reason?: string | null
  source_post_title?: string | null
  shop_name_source?: string | null
  enrichment_rejected?: { field: string; value: string; reason: string }[] | null
  enrichment_region_conflict?: boolean | null
  // 地域メディア記事由来（元情報）
  source_article_excerpt?: string | null
  source_media_family?: string | null
  extracted_shop_name_from_article?: string | null
  extracted_area_from_article?: string | null
  extracted_open_date_from_article?: string | null
  // Google openingDate / businessStatus
  google_opening_date_year?: number | null
  google_opening_date_month?: number | null
  google_opening_date_day?: number | null
  google_opening_date_raw?: string | null
  google_business_status?: string | null
  has_google_opening_date?: boolean | null
  opening_date_confidence?: number | null
  days_until_opening?: number | null
  days_since_opening?: number | null
  google_places_checked_at?: string | null
  opening_date_checked_at?: string | null
  // HOT未達理由（なぜHOTにしなかったか）
  hot_reject_reasons?: string[] | null
  hot_reject_summary?: string | null
  hot_check_result?: Record<string, any> | null
  hot_missing_requirements?: string[] | null
  hot_blocking_reason?: string | null
  hot_required_score?: number | null
  hot_tier?: 'A' | 'B' | null
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
  hotRequiredScore?: number // HOT基準点（既定75）
  aiInjectMode?: 'strict' | 'standard' | 'aggressive' // 自動投入モード
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
  // Google Places 全国・新店系ワード検索（エリア/業種で絞らない）
  placesNationwide: boolean
  placesMaxQueriesPerDay: number // 既定30
  placesPerQuery: number         // 既定20
  placesMaxDetailsPerDay: number // 既定100
  placesDetailsLimitPerRun: number // 1回あたりPlace Details上限（既定100）
  placesSkipDetailsIfReviewsOver: number // 口コミN件以上はDetailsスキップ（既定100）
  placesOpeningDatePriority: boolean // openingDate最優先（既定true）
  placesPagesPerQuery: number // 1クエリのページ取得数（既定3）
  placesResultsPerQueryLimit: number // 1クエリの最大件数（既定60）
  // 自動投入モード・上限
  aiInjectMode: 'strict' | 'standard' | 'aggressive'
  autoImportPerRun: number       // 既定50
  autoImportPerDay: number       // 既定200
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
  regionalBatchSites: number   // 全サイト巡回の1バッチあたりサイト数（既定8）
  horbyMaxDetails: number      // HORBY等で1回に詳細クリック取得するカード数（既定2・60s制限）
  probeDailyCap: number        // 連番URL探索の1日最大probe件数（既定500）
  regionalMaxArticles: number  // 1サイトの最大記事数（既定5）
  regionalPeriodDays: number   // 記事公開の対象期間（既定30日）
  regionalEnrichEnabled: boolean   // 地域メディアの外部情報補完ON/OFF
  regionalEnrichMaxQueries: number // 1候補の補完検索数（既定3）
  regionalEnrichPerQuery: number   // 補完1クエリ取得件数（既定5）
  regionalEnrichDailyCap: number   // 1日最大補完候補数（既定100）
  // Instagram Web検索
  iwEnabled: boolean
  iwSearchMode: 'serper_free' | 'bing_advanced' | 'serper_paid' // 検索モード
  iwAllowNoPhone: boolean      // 電話番号なしでもHOT許可（初期OFF）
  iwAutoImport: boolean        // HOT自動投入（初期OFF）
  iwRequirePhone: boolean      // 電話番号必須（初期OFF）
  iwPlacesRequired: boolean    // Google Places照合必須（初期OFF）
  iwAnthropic: boolean         // Anthropic判定（初期ON）
  iwMaxQueriesPerDay: number   // 1日最大検索クエリ数（既定120）
  iwMaxQueriesPerRun: number   // 1回最大クエリ数（既定30・最大50）
  iwProvider: 'serper' | 'bing' | 'both'  // 検索プロバイダ
  iwSameQuerySkipDays: number  // 同一クエリのスキップ日数（既定0）
  iwSameUrlSkipDays: number    // 同一URLのスキップ日数（既定7）
  iwPerQuery: number           // 1クエリ取得件数（既定10）
  iwMaxRunsPerDay: number      // 1日最大実行回数（既定4）
  iwPerRun: number             // 1回最大クエリ数（既定20）
  iwAnthropicDailyCap: number  // 1日最大AI判定件数（既定100）
  iwEnrichEnabled: boolean     // 外部情報補完ON/OFF
  iwEnrichMaxQueries: number   // 1候補あたり追加検索の最大クエリ数（既定3）
  iwEnrichPerQuery: number     // 補完1クエリの取得件数（既定5）
  iwEnrichDailyCap: number     // 1日最大補完候補数（既定100）
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

// ============================================================
// 労務管理（Labor / HR）
// すべて Supabase テーブルと 1:1。土台のため nullable を広めに取る。
// ============================================================

export interface Employee {
  id: string
  user_id?: string | null
  employee_code?: string | null
  name: string
  name_kana?: string | null
  email?: string | null
  phone?: string | null
  employment_type?: string | null
  department?: string | null
  position?: string | null
  role?: string | null
  hire_date?: string | null
  resignation_date?: string | null
  status?: string | null
  work_style?: string | null
  base_salary?: number | null
  hourly_wage?: number | null
  fixed_overtime_hours?: number | null
  fixed_overtime_pay?: number | null
  standard_work_start?: string | null
  standard_work_end?: string | null
  standard_break_minutes?: number | null
  weekly_work_days?: number | null
  closing_day?: number | null
  payment_day?: number | null
  trial_period_end_date?: string | null
  contract_start_date?: string | null
  contract_end_date?: string | null
  emergency_contact_name?: string | null
  emergency_contact_phone?: string | null
  bank_name?: string | null
  branch_name?: string | null
  account_type?: string | null
  account_number?: string | null
  account_holder?: string | null
  social_insurance_status?: string | null
  employment_insurance_status?: string | null
  memo?: string | null
  created_at?: string
  updated_at?: string
}

export interface AttendanceRecord {
  id: string
  employee_id: string
  work_date: string
  clock_in_at?: string | null
  clock_out_at?: string | null
  break_start_at?: string | null
  break_end_at?: string | null
  total_break_minutes?: number | null
  work_minutes?: number | null
  overtime_minutes?: number | null
  late_night_minutes?: number | null
  holiday_work_minutes?: number | null
  status?: string | null
  work_location_type?: string | null
  clock_in_method?: string | null
  clock_out_method?: string | null
  clock_in_ip?: string | null
  clock_out_ip?: string | null
  clock_in_lat?: number | null
  clock_in_lng?: number | null
  clock_out_lat?: number | null
  clock_out_lng?: number | null
  is_late?: boolean | null
  is_early_leave?: boolean | null
  note?: string | null
  approved_by?: string | null
  approved_at?: string | null
  created_at?: string
  updated_at?: string
}

export interface WorkShift {
  id: string
  employee_id: string
  shift_date: string
  planned_start_at?: string | null
  planned_end_at?: string | null
  planned_break_minutes?: number | null
  shift_type?: string | null
  status?: string | null
  note?: string | null
  created_by?: string | null
  approved_by?: string | null
  approved_at?: string | null
  created_at?: string
  updated_at?: string
}

export interface LeaveBalance {
  id: string
  employee_id: string
  fiscal_year: number
  paid_leave_granted_days?: number | null
  paid_leave_used_days?: number | null
  paid_leave_remaining_days?: number | null
  paid_leave_expire_date?: string | null
  required_5days_used?: number | null
  created_at?: string
  updated_at?: string
}

export interface LeaveRequest {
  id: string
  employee_id: string
  leave_type?: string | null
  start_date?: string | null
  end_date?: string | null
  days?: number | null
  hours?: number | null
  reason?: string | null
  status?: string | null
  requested_at?: string | null
  approved_by?: string | null
  approved_at?: string | null
  rejected_reason?: string | null
  created_at?: string
  updated_at?: string
}

export interface ApprovalRequest {
  id: string
  employee_id: string
  request_type: string
  target_table?: string | null
  target_id?: string | null
  title?: string | null
  reason?: string | null
  before_data?: unknown
  after_data?: unknown
  status?: string | null
  requested_at?: string | null
  approved_by?: string | null
  approved_at?: string | null
  rejected_by?: string | null
  rejected_at?: string | null
  rejected_reason?: string | null
  comment?: string | null
  created_at?: string
  updated_at?: string
}

export interface LaborAlert {
  id: string
  employee_id?: string | null
  alert_type: string
  severity?: string | null
  title?: string | null
  message?: string | null
  target_date?: string | null
  target_month?: string | null
  status?: string | null
  resolved_by?: string | null
  resolved_at?: string | null
  created_at?: string
}

export interface LaborDocument {
  id: string
  employee_id: string
  document_type: string
  title?: string | null
  file_url?: string | null
  status?: string | null
  signed_at?: string | null
  expires_at?: string | null
  uploaded_by?: string | null
  created_at?: string
  updated_at?: string
}

export interface LaborSettings {
  id: string
  company_name?: string | null
  standard_work_start?: string | null
  standard_work_end?: string | null
  standard_break_minutes?: number | null
  scheduled_daily_minutes?: number | null
  holiday_weekdays?: number[] | null
  closing_day?: number | null
  payment_day?: number | null
  overtime_alert_monthly_hours?: number | null
  overtime_alert_weekly_hours?: number | null
  paid_leave_grant_rule?: string | null
  require_approval_attendance_edit?: boolean | null
  require_approval_leave?: boolean | null
  gps_clock_enabled?: boolean | null
  ip_restriction_enabled?: boolean | null
  csv_format?: string | null
  created_at?: string
  updated_at?: string
}

export interface LaborAuditLog {
  id: string
  actor_user_id?: string | null
  actor_name?: string | null
  employee_id?: string | null
  action: string
  target_table?: string | null
  target_id?: string | null
  before_data?: unknown
  after_data?: unknown
  ip_address?: string | null
  user_agent?: string | null
  created_at?: string
}

// ============================================================
// 労務管理 拡張（給与計算本体・年末調整・社会保険・マイナンバー・電子申請・社労士連携）
// ============================================================

export interface PayrollRun {
  id: string
  target_month: string
  title?: string | null
  status?: string | null
  run_by?: string | null
  run_at?: string | null
  closed_at?: string | null
  note?: string | null
  created_at?: string
  updated_at?: string
}

export interface Payslip {
  id: string
  payroll_run_id?: string | null
  employee_id: string
  target_month: string
  work_days?: number | null
  work_minutes?: number | null
  overtime_minutes?: number | null
  late_night_minutes?: number | null
  holiday_work_minutes?: number | null
  paid_leave_days?: number | null
  absent_days?: number | null
  base_salary?: number | null
  overtime_pay?: number | null
  late_night_pay?: number | null
  holiday_pay?: number | null
  fixed_overtime_pay?: number | null
  commute_allowance?: number | null
  position_allowance?: number | null
  other_allowance?: number | null
  gross_pay?: number | null
  health_insurance?: number | null
  long_term_care_insurance?: number | null
  pension_insurance?: number | null
  employment_insurance?: number | null
  income_tax?: number | null
  resident_tax?: number | null
  other_deduction?: number | null
  total_deduction?: number | null
  net_pay?: number | null
  status?: string | null
  note?: string | null
  created_at?: string
  updated_at?: string
}

export interface YearEndAdjustment {
  id: string
  employee_id: string
  fiscal_year: number
  total_income?: number | null
  total_withholding?: number | null
  social_insurance_deduction?: number | null
  life_insurance_deduction?: number | null
  earthquake_insurance_deduction?: number | null
  spouse_deduction?: number | null
  dependent_deduction?: number | null
  basic_deduction?: number | null
  housing_loan_deduction?: number | null
  taxable_income?: number | null
  calculated_tax?: number | null
  settlement_amount?: number | null
  status?: string | null
  note?: string | null
  created_at?: string
  updated_at?: string
}

export interface SocialInsuranceProcedure {
  id: string
  employee_id: string
  procedure_type: string
  status?: string | null
  insurer?: string | null
  target_date?: string | null
  submitted_at?: string | null
  reference_number?: string | null
  standard_monthly_wage?: number | null
  note?: string | null
  created_at?: string
  updated_at?: string
}

export interface MyNumber {
  id: string
  employee_id: string
  holder_type?: string | null
  holder_name?: string | null
  masked_number?: string | null
  collection_status?: string | null
  purpose?: string | null
  stored_location?: string | null
  collected_at?: string | null
  disposed_at?: string | null
  note?: string | null
  created_at?: string
  updated_at?: string
}

export interface EApplication {
  id: string
  employee_id?: string | null
  application_type: string
  status?: string | null
  submission_target?: string | null
  reference_number?: string | null
  submitted_at?: string | null
  completed_at?: string | null
  note?: string | null
  created_at?: string
  updated_at?: string
}

export interface SharoshiShare {
  id: string
  title: string
  share_type?: string | null
  status?: string | null
  target_month?: string | null
  assigned_to?: string | null
  message?: string | null
  response?: string | null
  shared_by?: string | null
  responded_at?: string | null
  note?: string | null
  created_at?: string
  updated_at?: string
}

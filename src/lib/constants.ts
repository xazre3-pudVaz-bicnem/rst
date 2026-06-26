export const SALES_REPS = [
  '織田春樹',
  'ユーザー1',
  'ユーザー2',
  'ユーザー3',
  'ユーザー4',
  'ユーザー5',
] as const

export const STATUSES = [
  '新規',
  '再コール',
  '見込み',
  '激アツ',
  '特別保有',
  '仮アポ',
  '仮アポ流れ',
  'アポ',
  '契約',
  '成約',
  '仮失注',
  '完失注',
  'シャドーリスト',
  '他社受注',
  '対象外案件',
  'クレーマー',
  '留番',
  'リレ近跡',
] as const

export const INDUSTRIES = ['飲食', '美容', '健康', '建設', 'その他'] as const

export const CONTACT_RESULTS = [
  'アポ',
  '興味なし',
  '忙しい',
  'タイミング違い',
  '金をかけたくない',
] as const

export const NO_CONTACT_RESULTS = ['不在', '忙しい', '断られた', '代表いません'] as const

export const RECEIVER_ATTRS = ['配偶者', '子供', '親', '店長', '受付'] as const

export const AGES = ['20代', '30代', '40代', '50代', '60代', '70代以上'] as const

export const GENDERS = ['男', '女'] as const

/** 案件一覧で薄緑背景にするステータス */
export const HIGHLIGHT_STATUSES = ['アポ', '仮アポ', '成約', '契約'] as const

/** Analytics の成約扱いステータス */
export const DEAL_STATUSES = ['成約', '契約', '完失注'] as const

/** タウンページ検索の対象開始日 */
export const TOWNPAGE_CUTOFF = '2026-06-18'

/** localStorage キー */
export const LS_PC_SESSION_KEY = 'rst_pc_session_key'
export const LS_CALL_SESSION_KEY = 'rst_call_session_key'
export const LS_AUTO_SEARCH = 'autoSearchSettings'

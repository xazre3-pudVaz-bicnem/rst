export const SALES_REPS = [
  '織田春樹',
  'ユーザー1',
  'ユーザー2',
  'ユーザー3',
  'ユーザー4',
  'ユーザー5',
] as const

/**
 * 標準ステータス（実運用版）。
 * 旧データ（新規/アポ など）も編集できるよう LEGACY_STATUSES を併せて保持する。
 */
export const STANDARD_STATUSES = [
  '未架電',
  '不在',
  '受付NG',
  '担当者不在',
  '資料送付',
  '折返し待ち',
  'アポ獲得',
  '見込み',
  '失注',
  '再コール',
  '契約済み',
] as const

/** 旧Base44由来のステータス（移行データ互換用） */
export const LEGACY_STATUSES = [
  '新規',
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

/** ステータス選択肢（標準＋互換のため旧も末尾に表示） */
export const STATUSES = [...STANDARD_STATUSES, ...LEGACY_STATUSES] as const

/** 新規案件のデフォルトステータス */
export const DEFAULT_STATUS = '未架電'

/** ステータスごとの表示色（バッジ・一覧背景。ダークモード対応） */
export const STATUS_COLORS: Record<string, string> = {
  未架電: 'bg-slate-100 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200',
  不在: 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300',
  受付NG: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-200',
  担当者不在: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/20 dark:text-yellow-300',
  資料送付: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  折返し待ち: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  アポ獲得: 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300',
  見込み: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  失注: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
  再コール: 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300',
  契約済み: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-200',
  // legacy
  新規: 'bg-slate-100 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200',
  アポ: 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300',
  成約: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-200',
  契約: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-200',
}

export function statusColor(status?: string | null): string {
  return (status && STATUS_COLORS[status]) || 'bg-muted text-muted-foreground'
}

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

/** 案件一覧で強調（薄緑背景）にするステータス */
export const HIGHLIGHT_STATUSES = ['アポ獲得', '契約済み', 'アポ', '仮アポ', '成約', '契約'] as const

/** アポ扱いステータス（KPI集計用） */
export const APPO_STATUSES = ['アポ獲得', 'アポ', '仮アポ'] as const

/** 成約/契約扱いステータス（KPI集計用） */
export const DEAL_STATUSES = ['契約済み', '成約', '契約'] as const

/** 失注扱いステータス */
export const LOST_STATUSES = ['失注', '完失注', '仮失注', '他社受注'] as const

/** 資料送付扱い */
export const DOC_SENT_STATUSES = ['資料送付'] as const

/** 見込み扱い */
export const PROSPECT_STATUSES = ['見込み', '激アツ', '特別保有'] as const

/** 未架電扱い */
export const UNCALLED_STATUSES = ['未架電', '新規'] as const

/** よく使うクイックフィルター定義 */
export type QuickFilterKey =
  | 'all'
  | 'todayCall'
  | 'uncalled'
  | 'recall'
  | 'overdueRecall'
  | 'prospect'
  | 'appo'
  | 'docSent'
  | 'notLost'
  | 'mine'

export const QUICK_FILTERS: { key: QuickFilterKey; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'todayCall', label: '今日やる' },
  { key: 'uncalled', label: '未架電' },
  { key: 'recall', label: '再コール' },
  { key: 'overdueRecall', label: '期限切れ' },
  { key: 'prospect', label: '見込み' },
  { key: 'appo', label: 'アポ' },
  { key: 'docSent', label: '資料送付済み' },
  { key: 'notLost', label: '失注以外' },
  { key: 'mine', label: '自分の担当' },
]

/** 再コール扱いステータス */
export const RECALL_STATUSES = ['再コール', '折返し待ち'] as const

/** 優先度 */
export const PRIORITIES = ['高', '中', '低'] as const
export const PRIORITY_COLORS: Record<string, string> = {
  高: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/30',
  中: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/30',
  低: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-700/50 dark:text-slate-300 dark:border-slate-600',
}

/** タグのプリセット（自由入力も可） */
export const TAG_PRESETS = [
  '高優先度',
  '要追客',
  '見込み高',
  '競合利用中',
  '決裁者待ち',
  '資料送付済み',
] as const

/** ユーザーロール */
export const ROLES = [
  { value: 'admin', label: '管理者' },
  { value: 'member', label: '営業担当' },
  { value: 'viewer', label: '閲覧のみ' },
] as const

export function roleLabel(role?: string | null): string {
  return ROLES.find((r) => r.value === role)?.label ?? '営業担当'
}

/** 通話メモ定型文の初期データ（templates が空のとき投入） */
export const DEFAULT_TEMPLATES: { category: string; title: string; body: string; status?: string }[] = [
  { category: 'memo', title: '不在', body: '不在でした。時間を変えて再架電。', status: '不在' },
  { category: 'memo', title: '担当者不在', body: '担当者不在のため再コール予定。', status: '担当者不在' },
  { category: 'memo', title: '受付NG', body: '受付段階でお断り。', status: '受付NG' },
  { category: 'memo', title: '資料送付希望', body: '資料送付を希望。送付後に再連絡。', status: '資料送付' },
  { category: 'memo', title: '興味あり', body: '興味あり。後日あらためて連絡する約束。', status: '見込み' },
  { category: 'memo', title: '折返し待ち', body: '折返しの連絡を待つ。', status: '折返し待ち' },
  { category: 'memo', title: '現在不要', body: '現時点では不要とのこと。', status: '失注' },
  { category: 'memo', title: '他社利用中', body: '他社サービス利用中。契約更新時期に再アプローチ。', status: '見込み' },
  { category: 'memo', title: '予算が合わない', body: '予算が合わず。条件を変えて再提案検討。' },
  { category: 'memo', title: '決裁者確認待ち', body: '決裁者の確認待ち。' },
  { category: 'memo', title: 'アポ獲得', body: '訪問アポイントを獲得。', status: 'アポ獲得' },
]

// ============================================================
// AI投入リスト（lead_candidates）
// ============================================================
export const LEAD_TEMP_COLORS: Record<string, string> = {
  HOT: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
  WARM: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  HOLD: 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300',
  EXCLUDED: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700/60 dark:text-zinc-300',
}
export const LEAD_TEMP_LABELS: Record<string, string> = {
  HOT: 'HOT（即投入）', WARM: 'WARM（参考）', HOLD: 'HOLD（保留）', EXCLUDED: 'EXCLUDED（除外）',
}

/** 新規シグナルのラベル */
export const SIGNAL_LABELS = {
  is_new_gbp: '新規GBP',
  is_new_instagram: '新規Instagram',
  is_new_website: '新規HP',
  is_new_ad_listing: '新規広告',
  is_new_corporation: '新設法人',
} as const

/** 大手チェーン/フランチャイズ名（部分一致で除外判定。随時追加可） */
export const CHAIN_NAMES = [
  'マクドナルド', 'スターバックス', 'スタバ', 'ケンタッキー', 'モスバーガー', 'ロッテリア',
  'ガスト', 'サイゼリヤ', 'バーミヤン', 'ジョナサン', '吉野家', 'すき家', '松屋', 'なか卯',
  'ドトール', 'タリーズ', 'コメダ', 'プロント', 'サンマルク', '丸亀製麺', 'はなまるうどん',
  'ユニクロ', 'ジーユー', 'GU', 'しまむら', '無印良品', 'ニトリ', 'カインズ', 'コーナン',
  'セブンイレブン', 'ファミリーマート', 'ローソン', 'ミニストップ', 'ヤマダ電機', 'ビックカメラ',
  'ヨドバシ', 'ケーズデンキ', 'エディオン', 'ブックオフ', 'ハードオフ', 'ゲオ', 'GEO', 'TSUTAYA',
  'QBハウス', 'TBC', 'たかの友梨', 'ミュゼ', 'ライザップ', 'RIZAP', 'エニタイム', 'カーブス',
  'ゴールドジム', 'チョコザップ', 'chocoZAP', 'ホリデイスポーツ', 'コナミスポーツ',
  '明光義塾', '公文', 'KUMON', '東進', '河合塾', '駿台', '個別教室のトライ', 'ビッグエコー',
  'カラオケ館', 'まねきねこ', 'ほっともっと', 'オリジン弁当', '大戸屋', 'やよい軒',
  'アパマンショップ', 'エイブル', 'ミニミニ', 'ハウスドゥ', '大東建託', 'ホットペッパー',
  'ほぐしの達人', 'りらくる', 'カラダファクトリー', '大手', '大黒屋',
]

/** 大型商業施設・百貨店・駅ビル名（住所/店名の部分一致で除外判定） */
export const MALL_KEYWORDS = [
  'イオンモール', 'イオン', 'ららぽーと', 'アリオ', 'ラゾーナ', 'テラスモール', 'グランツリー',
  'コクーン', 'ダイバーシティ', 'ヴィーナスフォート', 'アウトレット', 'プレミアムアウトレット',
  'ルミネ', 'アトレ', 'マルイ', '丸井', 'パルコ', 'PARCO', '高島屋', '三越', '伊勢丹', 'そごう',
  '西武', '東武百貨店', '大丸', '松坂屋', '京王', '小田急百貨店', '東急百貨店', 'ヒカリエ',
  'コレド', 'グランスタ', 'エキュート', 'グランデュオ', 'ペリエ', 'セレオ', 'アピタ', 'ピアゴ',
  'ゆめタウン', 'モラージュ', 'ビバモール', 'ステラタウン', 'ショッピングモール', 'ショッピングセンター',
  'ショッピングタウン', '百貨店', '駅ビル', '○○店内', '館内',
]

/** 駅ビル系（参考。MALL_KEYWORDS に含まれるが個別フラグ用） */
export const STATION_KEYWORDS = ['駅ビル', 'エキュート', 'アトレ', 'ルミネ', 'グランスタ', 'セレオ', 'ペリエ', 'グランデュオ', '駅directly', '駅ナカ', '駅構内']

/** 支店・営業所などの大手企業拠点 */
export const BRANCH_KEYWORDS = ['支店', '営業所', '支社', '出張所', '本部', '事業所']

/** 明らかに営業対象外（業種・施設名） */
export const EXCLUDED_NAME_KEYWORDS = ['市役所', '区役所', '町役場', '公民館', '消防署', '警察署', '小学校', '中学校', '高等学校', '大学', '病院', '診療所', 'クリニック（総合）', '図書館', '郵便局', '銀行', '信用金庫']

/** AI投入リスト設定（localStorage） */
export const LS_LEAD_SETTINGS = 'rst_lead_settings'
export const DEFAULT_LEAD_SETTINGS = {
  autoImport: true,
  dailyCap: 30,
  areas: '東京・神奈川・埼玉・千葉・茨城・栃木・群馬',
  industries: '飲食・美容・健康・整体・サロン・カフェ・ジム',
}

/** タウンページ検索の対象開始日 */
export const TOWNPAGE_CUTOFF = '2026-06-18'

/** localStorage キー */
export const LS_PC_SESSION_KEY = 'rst_pc_session_key'
export const LS_CALL_SESSION_KEY = 'rst_call_session_key'
export const LS_AUTO_SEARCH = 'autoSearchSettings'

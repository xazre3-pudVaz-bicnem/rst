// ============================================================
// 巡回サイト管理（source_sites）の共通ヘルパー。サーバー専用。
// 認可: ADMIN_SECRET / CRON_SECRET ヘッダ もしくは ログイン中ユーザーのJWT。
// フロントには service role を出さず、必ずこのAPI経由で書き込む。
// ============================================================
export const MEDIA_FAMILIES = ['goguynet', 'kaitenheiten', 'tsushin', 'saikohkunavi', 'horby', 'local_blog', 'local_news', 'local_directory', 'other']
// openclose_article=記事型 / local_directory_new_listing=店舗ディレクトリ型 / hybrid=両方
export const SOURCE_TYPES = ['openclose_article', 'local_directory_new_listing', 'hybrid', 'html_list', 'rss', 'sitemap', 'category_page']
export const CATEGORY_LABELS = ['開店閉店', '新店情報', '地域ニュース', '店舗情報', '店舗新着']

/** URL正規化: 前後空白除去・末尾スラッシュ削除（比較/保存の一貫性のため） */
export function normalizeUrl(u: string): string {
  let s = String(u || '').trim()
  if (!s) return ''
  s = s.replace(/\s+/g, '')
  s = s.replace(/\/+$/, '') // 末尾スラッシュ削除
  return s
}

export function isValidHttpUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' } catch { return false }
}

/** 入力を許可カラムのみに整形（任意SQL/未知キーを混ぜない） */
export function sanitizeSitePayload(body: any): { ok: boolean; error?: string; value?: any } {
  const name = String(body?.name || '').trim()
  const base_url = normalizeUrl(body?.base_url)
  let list_url = normalizeUrl(body?.list_url)
  if (!name) return { ok: false, error: 'サイト名は必須です' }
  if (!base_url || !isValidHttpUrl(base_url)) return { ok: false, error: 'base_url が不正です（http/httpsのURL）' }
  if (!list_url) list_url = base_url // 空なら base_url を自動セット
  if (!isValidHttpUrl(list_url)) return { ok: false, error: 'list_url が不正です' }

  const media_family = MEDIA_FAMILIES.includes(body?.media_family) ? body.media_family : 'other'
  const source_type = SOURCE_TYPES.includes(body?.source_type) ? body.source_type : 'html_list'
  const category_label = CATEGORY_LABELS.includes(body?.category_label) ? body.category_label : '開店閉店'
  const reliability_score = Math.max(0, Math.min(100, Number(body?.reliability_score) || 50))
  const crawl_interval_hours = Math.max(1, Number(body?.crawl_interval_hours) || 24)
  const is_active = body?.is_active === true || body?.is_active === 'true'

  return {
    ok: true,
    value: { name, base_url, list_url, media_family, source_type, category_label, reliability_score, crawl_interval_hours, is_active },
  }
}

/** 認可: 管理シークレット or ログインJWT。{ok, userId} を返す */
export async function authorizeAdmin(admin: any, headers: any): Promise<{ ok: boolean; userId: string | null; error?: string }> {
  const provided = String(headers?.['x-admin-secret'] || headers?.['X-Admin-Secret'] || '').trim()
  const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET
  if (secret && provided && provided === secret) return { ok: true, userId: null }
  const token = String(headers?.authorization || headers?.Authorization || '').replace(/^Bearer\s+/i, '')
  if (token) {
    try { const { data } = await admin.auth.getUser(token); if (data?.user) return { ok: true, userId: data.user.id } } catch { /* fallthrough */ }
  }
  return { ok: false, userId: null, error: 'unauthorized（ログイン または X-Admin-Secret が必要）' }
}

/** 初期ソース（「初期ソースを登録」ボタン / setup CLI 用・コードに固定）
 *  号外NETは地域別サブドメインの「開店・閉店」カテゴリ(list_url)を巡回対象にする。
 *  ポータル(goguynet.jp)は記事一覧が無いため is_active=false。地域URLはUIから追加可。 */
export const INITIAL_SOURCES = [
  { name: '開店閉店.com', base_url: 'https://kaiten-heiten.com/', list_url: 'https://kaiten-heiten.com/', media_family: 'kaitenheiten', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 85, crawl_interval_hours: 24 },
  { name: '号外NET（ポータル）', base_url: 'https://goguynet.jp/', list_url: 'https://goguynet.jp/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: false, reliability_score: 60, crawl_interval_hours: 24 },
  { name: '号外NET 葛飾区', base_url: 'https://katsushika.goguynet.jp/', list_url: 'https://katsushika.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 江戸川区', base_url: 'https://edogawa.goguynet.jp/', list_url: 'https://edogawa.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 足立区', base_url: 'https://adachi.goguynet.jp/', list_url: 'https://adachi.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '埼北つうしん', base_url: 'https://saikou-tsushin.com/', list_url: 'https://saikou-tsushin.com/', media_family: 'tsushin', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  // 彩北なび: 店舗ディレクトリ型（一覧 sort=newest → 店舗詳細 /shop/shop.shtml?s=xxxx を巡回）
  { name: '彩北なび', base_url: 'https://www.saikohkunavi.net/', list_url: 'https://www.saikohkunavi.net/shop/?sort=newest', media_family: 'saikohkunavi', source_type: 'local_directory_new_listing', category_label: '店舗新着', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  // HORBY: マーケットプレイス型（検索結果の店舗カードから新規掲載を抽出）。list_url は新着順の検索結果URLをUIで設定。
  { name: 'HORBY', base_url: 'https://h-word.com/', list_url: 'https://h-word.com/horby/store/searchResult?sortType=new', media_family: 'horby', source_type: 'marketplace_listing', category_label: '店舗新着', is_active: false, reliability_score: 60, crawl_interval_hours: 24 },
]

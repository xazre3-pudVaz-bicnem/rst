// ============================================================
// 巡回サイト管理（source_sites）の共通ヘルパー。サーバー専用。
// 認可: ADMIN_SECRET / CRON_SECRET ヘッダ もしくは ログイン中ユーザーのJWT。
// フロントには service role を出さず、必ずこのAPI経由で書き込む。
// ============================================================
export const MEDIA_FAMILIES = ['goguynet', 'kaitenheiten', 'tsushin', 'local_blog', 'local_news', 'local_directory', 'other']
export const SOURCE_TYPES = ['html_list', 'rss', 'sitemap', 'category_page']
export const CATEGORY_LABELS = ['開店閉店', '新店情報', '地域ニュース', '店舗情報']

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

/** 初期ソース（「初期ソースを登録」ボタン / setup CLI 用・コードに固定） */
export const INITIAL_SOURCES = [
  { name: '開店閉店.com', base_url: 'https://kaiten-heiten.com/', list_url: 'https://kaiten-heiten.com/', media_family: 'kaitenheiten', source_type: 'html_list', category_label: '開店閉店', is_active: true, reliability_score: 85, crawl_interval_hours: 24 },
  { name: '号外NET', base_url: 'https://goguynet.jp/', list_url: 'https://goguynet.jp/', media_family: 'goguynet', source_type: 'html_list', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '埼北つうしん', base_url: 'https://saikou-tsushin.com/', list_url: 'https://saikou-tsushin.com/', media_family: 'tsushin', source_type: 'html_list', category_label: '開店閉店', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  { name: '彩北なび', base_url: 'https://saihokunavi.net/', list_url: 'https://saihokunavi.net/', media_family: 'local_directory', source_type: 'html_list', category_label: '店舗情報', is_active: false, reliability_score: 40, crawl_interval_hours: 72 },
]

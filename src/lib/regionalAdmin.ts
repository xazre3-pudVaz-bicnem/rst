// ============================================================
// 巡回サイト管理（source_sites）の共通ヘルパー。サーバー専用。
// 認可: ADMIN_SECRET / CRON_SECRET ヘッダ もしくは ログイン中ユーザーのJWT。
// フロントには service role を出さず、必ずこのAPI経由で書き込む。
// ============================================================
export const MEDIA_FAMILIES = ['goguynet', 'kaitenheiten', 'tsushin', 'saikohkunavi', 'horby', 'jalan', 'tabelog', 'epark', 'hotpepper', 'local_blog', 'local_news', 'local_directory', 'other']
// openclose_article=記事型 / local_directory_new_listing=店舗ディレクトリ型 / marketplace_listing=検索結果カード型 / sequential_id_probe=連番探索 / generic_page_text_scan=汎用本文
export const SOURCE_TYPES = ['openclose_article', 'local_directory_new_listing', 'marketplace_listing', 'sequential_id_probe', 'generic_page_text_scan', 'hybrid', 'html_list', 'rss', 'sitemap', 'category_page']
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
  const rendering_mode = ['static', 'auto', 'browser'].includes(body?.rendering_mode) ? body.rendering_mode : 'auto'
  const parser_type = typeof body?.parser_type === 'string' && body.parser_type ? String(body.parser_type).slice(0, 40) : undefined
  // 詳細ページ取得設定
  const detail_fetch_enabled = body?.detail_fetch_enabled !== false && body?.detail_fetch_enabled !== 'false'
  const detail_rendering_mode = ['static', 'auto', 'browser'].includes(body?.detail_rendering_mode) ? body.detail_rendering_mode : 'auto'
  const detail_parser_type = typeof body?.detail_parser_type === 'string' && body.detail_parser_type ? String(body.detail_parser_type).slice(0, 40) : null
  const click_required = body?.click_required === true || body?.click_required === 'true'
  const card_selector = typeof body?.card_selector === 'string' ? String(body.card_selector).slice(0, 200) || null : null
  const detail_click_selector = typeof body?.detail_click_selector === 'string' ? String(body.detail_click_selector).slice(0, 100) || null : null
  const max_detail_pages_per_run = Math.max(0, Math.min(50, Number(body?.max_detail_pages_per_run) || 20))

  return {
    ok: true,
    value: { name, base_url, list_url, media_family, source_type, category_label, reliability_score, crawl_interval_hours, is_active, rendering_mode, detail_fetch_enabled, detail_rendering_mode, detail_parser_type, click_required, card_selector, detail_click_selector, max_detail_pages_per_run, ...(parser_type ? { parser_type } : {}) },
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
  { name: '開店閉店.com', base_url: 'https://kaiten-heiten.com/', list_url: 'https://kaiten-heiten.com/', media_family: 'kaitenheiten', source_type: 'openclose_article', parser_type: 'openclose_article', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 90, crawl_interval_hours: 24 },
  { name: '号外NET（ポータル）', base_url: 'https://goguynet.jp/', list_url: 'https://goguynet.jp/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: false, reliability_score: 60, crawl_interval_hours: 24 },
  { name: '号外NET 葛飾区', base_url: 'https://katsushika.goguynet.jp/', list_url: 'https://katsushika.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 江戸川区', base_url: 'https://edogawa.goguynet.jp/', list_url: 'https://edogawa.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 足立区', base_url: 'https://adachi.goguynet.jp/', list_url: 'https://adachi.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '埼北つうしん', base_url: 'https://saikou-tsushin.com/', list_url: 'https://saikou-tsushin.com/', media_family: 'tsushin', source_type: 'openclose_article', category_label: '開店閉店', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  // 彩北なび: 店舗ディレクトリ型（一覧 sort=newest → 店舗詳細 /shop/shop.shtml?s=xxxx を巡回）
  { name: '彩北なび', base_url: 'https://www.saikohkunavi.net/', list_url: 'https://www.saikohkunavi.net/shop/?sort=newest', media_family: 'saikohkunavi', source_type: 'local_directory_new_listing', category_label: '店舗新着', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  // HORBY 新規加盟店舗: Angular SPA（api.u-word.com の認証付きAPIで描画）。静的fetchでは0件のため rendering_mode=browser（要レンダリングAPI）。/horby を優先URLに。
  { name: 'HORBY 新規加盟店舗', base_url: 'https://u-word.com/horby', list_url: 'https://u-word.com/horby', media_family: 'horby', source_type: 'marketplace_listing', parser_type: 'horby_new_salon', rendering_mode: 'browser', category_label: '新規加盟店舗', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  // ===== 追加初期候補（新店/開店閉店/ニューオープンが出やすいサイト） =====
  { name: '食べログ ニューオープン 全国', base_url: 'https://s.tabelog.com/rstLst/cond16-00-00/', list_url: 'https://s.tabelog.com/rstLst/cond16-00-00/', media_family: 'tabelog', source_type: 'marketplace_listing', category_label: '店舗新着', parser_type: 'tabelog_newopen_list', is_active: false, reliability_score: 75, crawl_interval_hours: 24 },
  { name: '食べログ 東京ニューオープン', base_url: 'https://s.tabelog.com/tokyo/rstLst/cond16-00-00/', list_url: 'https://s.tabelog.com/tokyo/rstLst/cond16-00-00/', media_family: 'tabelog', source_type: 'marketplace_listing', category_label: '店舗新着', parser_type: 'tabelog_newopen_list', is_active: false, reliability_score: 75, crawl_interval_hours: 24 },
  { name: 'まいぷれ 全国', base_url: 'https://mypl.net/', list_url: 'https://mypl.net/', media_family: 'mypl', source_type: 'local_directory_new_listing', category_label: '店舗新着', parser_type: 'mypl_newopen_discovery', is_active: false, reliability_score: 60, crawl_interval_hours: 24 },
  { name: '市川にゅ～す 開店・閉店', base_url: 'https://ichi-24.jp/archives/category/cat_1117144', list_url: 'https://ichi-24.jp/archives/category/cat_1117144', media_family: 'tsushin', source_type: 'openclose_article', category_label: '開店閉店', parser_type: 'openclose_article', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  { name: '葛飾つうしん 開店・閉店', base_url: 'https://katsushika-tsushin.com/openclosed', list_url: 'https://katsushika-tsushin.com/openclosed', media_family: 'tsushin', source_type: 'openclose_article', category_label: '開店閉店', parser_type: 'openclose_article', is_active: true, reliability_score: 70, crawl_interval_hours: 24 },
  { name: 'アミーカ千葉 ニューオープン', base_url: 'https://www.amica-chiba.com/NewOpen/', list_url: 'https://www.amica-chiba.com/NewOpen/', media_family: 'local_directory', source_type: 'local_directory_new_listing', category_label: '店舗新着', parser_type: 'local_directory_new_listing', is_active: true, reliability_score: 65, crawl_interval_hours: 24 },
  { name: '吉祥寺ファンページ', base_url: 'https://kichifan.com/', list_url: 'https://kichifan.com/', media_family: 'local_blog', source_type: 'openclose_article', category_label: '開店閉店', parser_type: 'openclose_article', is_active: true, reliability_score: 60, crawl_interval_hours: 24 },
  // ダイヤモンド・チェーンストア: スーパー/小売/大手チェーン中心。チェーン除外を強める（営業対象外が多い）
  { name: 'ダイヤモンド・チェーンストア 新店情報', base_url: 'https://diamond-rm.net/store/newopen/', list_url: 'https://diamond-rm.net/store/newopen/', media_family: 'local_news', source_type: 'openclose_article', category_label: '開店閉店', parser_type: 'openclose_article', is_active: false, reliability_score: 50, crawl_interval_hours: 24 },

  // ===== 大量追加 seed（A.全国/広域・B.号外NET開店閉店・C.千葉東葛・D.東京・E.神奈川・F.埼玉・G.地方優良） =====
  // A. 全国・広域
  { name: '開店閉店.com 東京', base_url: 'https://kaiten-heiten.com/category/tokyo/', list_url: 'https://kaiten-heiten.com/category/tokyo/', media_family: 'kaitenheiten', source_type: 'openclose_article', parser_type: 'openclose_article', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 90, crawl_interval_hours: 24 },
  { name: '開店閉店.com 埼玉', base_url: 'https://kaiten-heiten-24.com/category/category/saitama/', list_url: 'https://kaiten-heiten-24.com/category/category/saitama/', media_family: 'kaitenheiten', source_type: 'openclose_article', parser_type: 'openclose_article', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 90, crawl_interval_hours: 24 },
  { name: '開店閉店.com 神奈川', base_url: 'https://kaiten-heiten.com/category/category/kanagawa/', list_url: 'https://kaiten-heiten.com/category/category/kanagawa/', media_family: 'kaitenheiten', source_type: 'openclose_article', parser_type: 'openclose_article', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 90, crawl_interval_hours: 24 },
  { name: '号外NET 東京', base_url: 'https://goguynet.jp/tokyo/', list_url: 'https://goguynet.jp/tokyo/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_area_discovery', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 85, crawl_interval_hours: 24 },
  { name: '号外NET 埼玉', base_url: 'https://goguynet.jp/saitama/', list_url: 'https://goguynet.jp/saitama/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_area_discovery', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 85, crawl_interval_hours: 24 },
  // B. 号外NET 開店閉店カテゴリ
  { name: '号外NET 東京都北区 開店閉店', base_url: 'https://tokyokita.goguynet.jp/category/cat_openclose/', list_url: 'https://tokyokita.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 85, crawl_interval_hours: 24 },
  { name: '号外NET 大阪市 開店閉店', base_url: 'https://osaka.goguynet.jp/category/cat_openclose/', list_url: 'https://osaka.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 奈良市 開店閉店', base_url: 'https://nara.goguynet.jp/category/cat_openclose/', list_url: 'https://nara.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 住吉・東住吉 開店閉店', base_url: 'https://sumiyoshi-higashisumiyoshi.goguynet.jp/category/cat_openclose/', list_url: 'https://sumiyoshi-higashisumiyoshi.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 鶴見・城東 開店閉店', base_url: 'https://tsurumi-joto.goguynet.jp/category/cat_openclose/', list_url: 'https://tsurumi-joto.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '号外NET 守口・門真 開店閉店', base_url: 'https://moriguchikadoma.goguynet.jp/category/cat_openclose/', list_url: 'https://moriguchikadoma.goguynet.jp/category/cat_openclose/', media_family: 'goguynet', source_type: 'openclose_article', parser_type: 'goguynet_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 80, crawl_interval_hours: 24 },
  // C. 千葉・東葛
  { name: '松戸つうしん 開店・閉店', base_url: 'https://matsudo-tsushin.com/openclosed', list_url: 'https://matsudo-tsushin.com/openclosed', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'tsushin_openclosed', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 88, crawl_interval_hours: 24 },
  { name: '船橋つうしん 開店・閉店', base_url: 'https://funabashi-tsushin.com/openclosed', list_url: 'https://funabashi-tsushin.com/openclosed', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'tsushin_openclosed', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 88, crawl_interval_hours: 24 },
  { name: '柏つうしん 開店・閉店', base_url: 'https://kashiwa-tsushin.com/openclosed', list_url: 'https://kashiwa-tsushin.com/openclosed', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'tsushin_openclosed', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 88, crawl_interval_hours: 24 },
  { name: '流山つうしん', base_url: 'https://nagareyama-tsushin.com/', list_url: 'https://nagareyama-tsushin.com/', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'tsushin_openclosed', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 82, crawl_interval_hours: 24 },
  { name: '三郷ぐらし 開店・閉店', base_url: 'https://misato-gurashi.com/openclosed', list_url: 'https://misato-gurashi.com/openclosed', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'tsushin_openclosed', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 82, crawl_interval_hours: 24 },
  { name: '松戸ロード', base_url: 'https://wl29.net/', list_url: 'https://wl29.net/', media_family: 'local_blog', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 78, crawl_interval_hours: 24 },
  { name: 'まいぷれ 千葉ニューオープン', base_url: 'https://chiba.mypl.net/article/newopen_chiba', list_url: 'https://chiba.mypl.net/article/newopen_chiba', media_family: 'mypl', source_type: 'local_directory_new_listing', parser_type: 'mypl_newopen_list', rendering_mode: 'auto', category_label: '店舗新着', is_active: true, reliability_score: 85, crawl_interval_hours: 24 },
  { name: 'こうのす広場 新店特集', base_url: 'https://kounosu-portal.jp/article/newopen_kounosu', list_url: 'https://kounosu-portal.jp/article/newopen_kounosu', media_family: 'mypl', source_type: 'local_directory_new_listing', parser_type: 'mypl_newopen_list', rendering_mode: 'auto', category_label: '店舗新着', is_active: true, reliability_score: 82, crawl_interval_hours: 24 },
  // D. 東京
  { name: '府中でみいつけた', base_url: 'https://mikke-fuchu.com/', list_url: 'https://mikke-fuchu.com/', media_family: 'local_blog', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 78, crawl_interval_hours: 24 },
  { name: 'しんじゅく通信', base_url: 'https://shinjukuku2shin.com/', list_url: 'https://shinjukuku2shin.com/', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '中野区つーしん', base_url: 'https://nakanoku2shin.com/', list_url: 'https://nakanoku2shin.com/', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 78, crawl_interval_hours: 24 },
  { name: 'リビング東京Web', base_url: 'https://mrs.living.jp/tokyo', list_url: 'https://mrs.living.jp/tokyo', media_family: 'local_news', source_type: 'regional_media', parser_type: 'living_web_newopen', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 75, crawl_interval_hours: 24 },
  { name: 'リビングむさしのWeb', base_url: 'https://mrs.living.jp/musashino', list_url: 'https://mrs.living.jp/musashino', media_family: 'local_news', source_type: 'regional_media', parser_type: 'living_web_newopen', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 75, crawl_interval_hours: 24 },
  { name: 'リビング多摩Web', base_url: 'https://mrs.living.jp/tama', list_url: 'https://mrs.living.jp/tama', media_family: 'local_news', source_type: 'regional_media', parser_type: 'living_web_newopen', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 75, crawl_interval_hours: 24 },
  // E. 神奈川
  { name: 'リビング横浜Web 開店・閉店', base_url: 'https://mrs.living.jp/yokohama/newopen', list_url: 'https://mrs.living.jp/yokohama/newopen', media_family: 'local_news', source_type: 'openclose_article', parser_type: 'living_web_newopen', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 82, crawl_interval_hours: 24 },
  { name: 'リビング田園都市Web', base_url: 'https://mrs.living.jp/denen', list_url: 'https://mrs.living.jp/denen', media_family: 'local_news', source_type: 'regional_media', parser_type: 'living_web_newopen', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 75, crawl_interval_hours: 24 },
  { name: '湘南人 開店・閉店', base_url: 'https://shonanjin.com/category/shop-open-close/', list_url: 'https://shonanjin.com/category/shop-open-close/', media_family: 'local_blog', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 82, crawl_interval_hours: 24 },
  // F. 埼玉・大阪
  { name: 'さいたまっぷる ニューオープン', base_url: 'https://jutaro123.com/2019-09-open-saitama', list_url: 'https://jutaro123.com/2019-09-open-saitama', media_family: 'local_blog', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 82, crawl_interval_hours: 24 },
  { name: '埼玉マガジン 開店情報', base_url: 'https://saitama-city-marathon.jp/category/kaiten/', list_url: 'https://saitama-city-marathon.jp/category/kaiten/', media_family: 'local_blog', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: true, reliability_score: 80, crawl_interval_hours: 24 },
  { name: 'まいぷれ 大阪市住吉区・東住吉区', base_url: 'https://sumiyoshi-osaka.mypl.net/', list_url: 'https://sumiyoshi-osaka.mypl.net/', media_family: 'mypl', source_type: 'local_directory_new_listing', parser_type: 'mypl_area_discovery', rendering_mode: 'auto', category_label: '店舗新着', is_active: false, reliability_score: 75, crawl_interval_hours: 24 },
  // G. 地方優良（登録のみ・既定OFF）
  { name: '滋賀つーしん', base_url: 'https://shiga2.jp/', list_url: 'https://shiga2.jp/', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 80, crawl_interval_hours: 24 },
  { name: '関西ニューオープン情報 滋賀', base_url: 'https://kansai-kaiten.com/kaitenheiten2026_shiga/', list_url: 'https://kansai-kaiten.com/kaitenheiten2026_shiga/', media_family: 'local_blog', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 78, crawl_interval_hours: 24 },
  { name: 'PHRASE OITA 開店閉店まとめ', base_url: 'https://phrase-oita.com/36716/', list_url: 'https://phrase-oita.com/36716/', media_family: 'local_blog', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 78, crawl_interval_hours: 24 },
  { name: '仙台南つうしん 名取・岩沼開店閉店まとめ', base_url: 'https://sendaiminami-tusin.com/natori-open/', list_url: 'https://sendaiminami-tusin.com/natori-open/', media_family: 'tsushin', source_type: 'openclose_article', parser_type: 'regional_blog_openclose', rendering_mode: 'static', category_label: '開店閉店', is_active: false, reliability_score: 78, crawl_interval_hours: 24 },
  // 情報提供フォーム（新店シグナル・本文は薄いので低信頼・OFF）
  { name: 'まいぷれ 船橋等 新店舗情報提供', base_url: 'https://funabashi.mypl.net/inquiry/entry?fid=3542', list_url: 'https://funabashi.mypl.net/inquiry/entry?fid=3542', media_family: 'mypl', source_type: 'local_directory_new_listing', parser_type: 'mypl_submission_signal', rendering_mode: 'static', category_label: '店舗新着', is_active: false, reliability_score: 60, crawl_interval_hours: 48 },
  { name: '上尾桶川鴻巣伊奈 新店舗情報提供', base_url: 'https://ina-navi.net/inquiry/entry?fid=3867', list_url: 'https://ina-navi.net/inquiry/entry?fid=3867', media_family: 'mypl', source_type: 'local_directory_new_listing', parser_type: 'mypl_submission_signal', rendering_mode: 'static', category_label: '店舗新着', is_active: false, reliability_score: 60, crawl_interval_hours: 48 },
]

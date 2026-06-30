// ============================================================
// 新規リスト取得元レジストリ（27 source_type）。サーバー/クライアント共通の定義のみ（副作用なし）。
// mode: 'serp'=Google/Serper検索駆動の汎用ディスカバリ / 'places'=Google Places派生 /
//       'existing'=既存エンジン(エキテン等) / 'foundation'=外部API土台(初期OFF・本実装は段階導入)
// 件数より質。電話なし/住所なしはHOT禁止。日本国内のみ。大手チェーン/公共/閉店/重複は除外。
// ============================================================
export type DiscoveryMode = 'serp' | 'places' | 'existing' | 'foundation'
export interface DiscoverySourceDef {
  type: string
  label: string
  group: string
  mode: DiscoveryMode
  defaultEnabled: boolean
  signalType: string          // この取得元が付与する lead_signals.signal_type
  queries?: string[]          // serpモードの検索クエリ雛形（{date} は過去日付に展開）
  note?: string
}

// 過去N日の日付文字列（YYYY/MM/DD と YYYY年M月D日）
export function pastDates(n: number): { slash: string; jp: string }[] {
  const out: { slash: string; jp: string }[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86400000)
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate()
    out.push({ slash: `${y}/${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}`, jp: `${y}年${m}月${day}日` })
  }
  return out
}

export const DISCOVERY_SOURCES: DiscoverySourceDef[] = [
  { type: 'google_serp_new_opening', label: 'Google検索 新規オープン横断', group: '新規候補', mode: 'serp', defaultEnabled: true, signalType: 'new_article',
    queries: ['新規オープン 店舗 電話番号', 'ニューオープン 店舗 住所', 'グランドオープン 店舗', 'プレオープン 店舗', '開店しました 店舗', '開業しました 店舗', '開院しました クリニック', '近日オープン 店舗', '新店舗 オープン', '移転オープン', 'リニューアルオープン 店舗'] },
  { type: 'job_opening_search', label: 'オープニングスタッフ求人', group: '求人由来', mode: 'serp', defaultEnabled: true, signalType: 'job_opening',
    queries: ['オープニングスタッフ 店舗 電話番号', 'オープニングスタッフ 新規オープン', '新規オープン スタッフ募集', 'オープニングスタッフ 飲食店', 'オープニングスタッフ 美容室', 'オープニングスタッフ 整体', '新規開院 スタッフ募集', '開業予定 クリニック 求人'] },
  { type: 'press_release_search', label: 'プレスリリース', group: 'プレスリリース由来', mode: 'serp', defaultEnabled: true, signalType: 'press_release',
    queries: ['site:prtimes.jp 新店舗 オープン', 'site:prtimes.jp 新規オープン 店舗', 'site:prtimes.jp グランドオープン', 'site:prtimes.jp 開業', 'site:prtimes.jp 開院', 'site:atpress.ne.jp 新規オープン', 'site:value-press.com 新店舗 オープン'] },
  { type: 'portal_published_date_search', label: 'エキテン公開日7日以内', group: '公開日7日以内', mode: 'existing', defaultEnabled: true, signalType: 'portal_published_date', note: '既存のエキテン公開日探索を使用' },
  { type: 'official_site_news_crawl', label: '公式サイト新着情報', group: '公式サイト新着', mode: 'serp', defaultEnabled: true, signalType: 'official_news',
    queries: ['"新規オープン" "公式サイト"', '"グランドオープン" "公式"', '"開院のお知らせ"', '"開業のお知らせ"', '"移転オープンのお知らせ"', '"リニューアルオープンのお知らせ"', '"プレオープンのお知らせ"'] },
  { type: 'rss_sitemap_crawl', label: 'RSS / sitemap差分', group: '新店シグナル', mode: 'foundation', defaultEnabled: true, signalType: 'official_news', note: 'RSS/sitemap/WP REST差分。対象URL登録後に有効化' },
  { type: 'construction_opening_signal_search', label: '看板・内装・開業準備ワード', group: '新店シグナル', mode: 'serp', defaultEnabled: true, signalType: 'construction_signal',
    queries: ['看板がつきました オープン', '内装工事中 オープン予定', '店舗準備中 オープン', '開店準備中', '物件決まりました 店舗', 'まもなくオープン', 'プレオープン準備中', '予約受付開始 新店'] },
  { type: 'chamber_commerce_new_member_crawl', label: '商工会議所・商店街 新入会員', group: '新店シグナル', mode: 'serp', defaultEnabled: true, signalType: 'chamber_new_member',
    queries: ['商工会議所 新入会員 店舗', '商工会 新入会員', '商店街 新規加盟店', '新規会員紹介 店舗', '会員紹介 新規オープン', '商店会 新店舗'] },
  { type: 'review_low_count_places', label: '口コミ0〜5件のGBP', group: '新規候補', mode: 'places', defaultEnabled: true, signalType: 'low_review_count', note: 'MEO営業向き候補（新店確定ではない）' },
  { type: 'website_missing_scan', label: 'HP未整備・Web弱者判定', group: '簡易HP利用', mode: 'places', defaultEnabled: true, signalType: 'website_missing', note: '既存候補のWeb弱点を判定' },
  { type: 'construction_case_opening_crawl', label: '内装/看板/工務店 施工事例', group: '施工事例由来', mode: 'serp', defaultEnabled: true, signalType: 'construction_case',
    queries: ['"店舗内装" "施工事例" "新規オープン"', '"看板施工" "新規オープン"', '"美容室 内装 施工事例 オープン"', '"飲食店 内装 施工事例 オープン"', '"クリニック 内装 施工事例 開院"', '"看板が完成しました" "オープン"'] },
  { type: 'new_official_site_discovery', label: '新しい公式サイト検出', group: '公式サイト新着', mode: 'serp', defaultEnabled: true, signalType: 'official_news',
    queries: ['"ホームページを公開しました" 店舗', '"公式サイトを公開しました" 店舗', '"サイトオープンしました" 店舗', '"ホームページ開設のお知らせ"', '"公式ホームページを開設しました"'] },
  { type: 'weak_builder_site_scan', label: '簡易HP(Wix/ペライチ等)検出', group: '簡易HP利用', mode: 'serp', defaultEnabled: true, signalType: 'weak_builder_site',
    queries: ['site:wixsite.com "新規オープン" 店舗', 'site:jimdofree.com "新規オープン"', 'site:peraichi.com 整体', 'site:studio.site 美容室', 'site:amebaownd.com サロン', 'site:sites.google.com 店舗 オープン'] },
  { type: 'instagram_only_business_scan', label: 'Instagramのみ店舗', group: 'Instagramのみ', mode: 'places', defaultEnabled: true, signalType: 'instagram_only' },
  { type: 'new_review_signal_scan', label: '口コミ急増・新規口コミ監視', group: '口コミ急増', mode: 'places', defaultEnabled: true, signalType: 'new_review_delta', note: 'place_idスナップショット差分' },
  // ---- 初期OFF（高負荷・要調整・外部API確認が必要） ----
  { type: 'yahoo_local_search_delta', label: 'Yahooローカルサーチ差分', group: '新規候補', mode: 'foundation', defaultEnabled: false, signalType: 'new_gbp', note: 'Yahoo Local API。土台のみ' },
  { type: 'corporation_new_registration', label: '法人番号/gBizINFO新規法人', group: '法人番号由来', mode: 'foundation', defaultEnabled: false, signalType: 'corporation_new', note: '国税庁法人番号/gBizINFO API。土台のみ' },
  { type: 'public_open_data_crawl', label: '自治体オープンデータ/営業許可', group: '新店シグナル', mode: 'foundation', defaultEnabled: false, signalType: 'public_permit', note: 'CSV/Excel/PDF許可情報。土台のみ' },
  { type: 'sns_web_search', label: 'SNS横断Web検索', group: '新店シグナル', mode: 'serp', defaultEnabled: false, signalType: 'sns_opening',
    queries: ['site:instagram.com "新規オープンしました"', 'site:instagram.com "オープン準備中"', 'site:tiktok.com "新規オープン"', 'site:threads.net "新規オープン"', '"看板がつきました" "オープン"', '"内装工事中" "オープン予定"'] },
  { type: 'category_specific_portal_crawl', label: 'カテゴリ別ポータル', group: '公開日7日以内', mode: 'foundation', defaultEnabled: false, signalType: 'portal_published_date', note: '食べログ/楽天ビューティ/Caloo等。robots確認後に有効化' },
  { type: 'web_agency_portfolio_crawl', label: 'HP制作会社の制作実績', group: '施工事例由来', mode: 'serp', defaultEnabled: false, signalType: 'construction_case',
    queries: ['"制作実績" "新規オープン" 店舗', '"ホームページ制作実績" 美容室', '"ホームページ制作実績" 整体院', '"Web制作実績" クリニック', '"新規開業" "ホームページ制作"'] },
  { type: 'subsidy_awardee_crawl', label: '補助金採択事業者', group: '補助金採択', mode: 'serp', defaultEnabled: false, signalType: 'subsidy_awardee',
    queries: ['"採択者一覧" 小規模事業者持続化補助金', '"採択者一覧" IT導入補助金', '創業補助金 採択者 店舗', '販路開拓 補助金 採択者', 'DX補助金 採択事業者'] },
  { type: 'crowdfunding_opening_search', label: 'クラウドファンディング新店', group: 'クラファン由来', mode: 'serp', defaultEnabled: false, signalType: 'crowdfunding',
    queries: ['site:camp-fire.jp 新店舗 オープン', 'site:camp-fire.jp 開業 店舗', 'site:makuake.com 新店舗 オープン', 'site:readyfor.jp 開業 カフェ', 'クラウドファンディング 新規オープン 店舗'] },
  { type: 'business_transfer_renewal_search', label: 'M&A/事業承継/リニューアル', group: '事業承継/リニューアル', mode: 'serp', defaultEnabled: false, signalType: 'business_transfer',
    queries: ['"事業承継" "リニューアルオープン"', '"店舗譲渡" "リニューアルオープン"', '"引き継ぎました" 店舗', '"新体制でオープン"', '"移転リニューアルオープン"', '"屋号変更" オープン'] },
  { type: 'tenant_property_opening_signal_search', label: '居抜き/跡地→新店候補', group: '居抜き/跡地由来', mode: 'serp', defaultEnabled: false, signalType: 'tenant_property',
    queries: ['"居抜き" "オープン予定"', '"テナント成約" "新店舗"', '"店舗物件" "新規オープン"', '"閉店跡地" "新店舗"', '"近日オープン" 跡地'] },
  { type: 'local_event_vendor_crawl', label: '地域イベント出店者', group: '地域イベント由来', mode: 'serp', defaultEnabled: false, signalType: 'local_event_vendor',
    queries: ['"マルシェ 出店者" "新規オープン"', 'キッチンカー 新店舗', 'ポップアップストア オープン', '"出店者一覧" Instagram 店舗', 'ハンドメイドマルシェ 出店者'] },
  { type: 'paid_ads_weak_site_scan', label: '広告出稿中だがHP弱い', group: '広告出稿中', mode: 'foundation', defaultEnabled: false, signalType: 'paid_ads_weak_site', note: '広告/LP弱者判定。土台のみ' },
]

// 追加しない（明示除外）source_type
export const EXCLUDED_SOURCE_TYPES = ['shopping_mall_new_shop_crawl', 'google_places_no_website_scan', 'gbp_content_weakness_scan', 'brand_serp_weakness_scan', 'reservation_portal_dependency_scan', 'franchise_new_store_search', 'competitor_gap_scan']

export function defaultSourceToggles(): Record<string, boolean> {
  const o: Record<string, boolean> = {}
  for (const s of DISCOVERY_SOURCES) o[s.type] = s.defaultEnabled
  return o
}
export function getSourceDef(type: string): DiscoverySourceDef | undefined { return DISCOVERY_SOURCES.find((s) => s.type === type) }

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
  // ---- 取得元別の追加ゲート（serpエンジンが解釈） ----
  recencyDays?: number        // HOT要件: 根拠日（HP公開/開設日）がこの日数以内であること
  requireOfficialUrl?: boolean // HOT要件: 公式サイトURLが取れていること
  freshness?: 'week' | 'month' // 検索APIの期間フィルタ（serper tbs=qdr:w/m・bing freshness=Week/Month）
  hpPublish?: boolean         // 新HP公開検出モード（公開日抽出＋簡易Web品質＋営業角度メモ生成）
}

// 過去N日の日付文字列（YYYY/MM/DD・YYYY年M月D日・M月D日）
export function pastDates(n: number): { slash: string; jp: string; md: string }[] {
  const out: { slash: string; jp: string; md: string }[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86400000)
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate()
    out.push({ slash: `${y}/${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}`, jp: `${y}年${m}月${day}日`, md: `${m}月${day}日` })
  }
  return out
}

export const DISCOVERY_SOURCES: DiscoverySourceDef[] = [
  // 直近7日以内に新しくHPを公開した店舗・事業者（HP制作後のSEO/MEO/AIO/運用提案リスト）
  { type: 'new_homepage_published_within_7days', label: '新規HP公開7日以内', group: '新規HP公開', mode: 'serp', defaultEnabled: true, signalType: 'new_homepage_published',
    recencyDays: 7, requireOfficialUrl: true, freshness: 'week', hpPublish: true,
    queries: [
      // 基本（公開/開設/リニューアルのお知らせ）
      '"ホームページを公開しました" 店舗', '"ホームページを開設しました" 店舗', '"公式ホームページを公開しました"',
      '"公式サイトを公開しました"', '"公式サイトを開設しました"', '"Webサイトを公開しました"', '"Webサイトを開設しました"',
      '"ホームページ開設のお知らせ"', '"公式サイト開設のお知らせ"', '"サイト公開のお知らせ"',
      '"ホームページをリニューアルしました" 店舗', '"サイトをリニューアルしました" 店舗', '"ホームページができました" 店舗',
      '"ホームページ完成しました" 店舗', '"新しいホームページ" 公開 店舗',
      '"新店舗" "ホームページ公開"', '"新規オープン" "公式サイト" 公開', '"開業" "ホームページ公開"', '"開院" "ホームページ公開"',
      '"新規開院" "公式サイト"', '"オープンに合わせて" ホームページ 公開', '"ホームページ公開" "新規オープン"', '"Webサイト公開" "新規オープン"',
      // 業種別
      '"美容室" "ホームページを公開しました"', '"整体院" "ホームページを公開しました"', '"歯科医院" "公式サイトを公開しました"',
      '"クリニック" "ホームページ開設のお知らせ"', '"カフェ" "公式サイトを公開しました"', '"居酒屋" "ホームページを開設しました"',
      '"サロン" "ホームページ公開"', '"エステ" "公式サイト開設"', '"動物病院" "ホームページ公開"', '"ペットサロン" "公式サイト公開"',
      '"ハウスクリーニング" "ホームページ公開"', '"リフォーム" "ホームページ公開"', '"学習塾" "ホームページ開設"', '"パーソナルジム" "公式サイト公開"',
      // 制作会社の制作実績由来
      '"制作実績" "ホームページ公開" "新規オープン"', '"制作実績" "公式サイト公開" "店舗"', '"ホームページ制作実績" "新規開業"',
      '"Web制作実績" "新規オープン"', '"店舗サイト制作" "公開しました"', '"お客様のホームページを公開しました"',
      '"新規サイトを公開しました" "店舗"', '"ホームページ制作" "公開しました" "美容室"', '"ホームページ制作" "公開しました" "整体院"',
      '"ホームページ制作" "公開しました" "クリニック"', '"ホームページ制作" "公開しました" "飲食店"',
    ] },
  { type: 'google_serp_new_opening', label: 'Google検索 新規オープン横断', group: '新規候補', mode: 'serp', defaultEnabled: true, signalType: 'new_article', freshness: 'month',
    queries: [
      // 汎用・連絡先バイアス（電話/住所が載るページを優先的に拾う）
      '新規オープン 店舗 電話番号', 'ニューオープン 店舗 住所', 'グランドオープン 店舗 電話', 'プレオープン 店舗 予約',
      '開店しました 店舗 住所', '開業しました 電話番号', '近日オープン 店舗 予約受付', '新店舗 オープン 電話番号',
      '移転オープン 店舗 住所', 'リニューアルオープン 店舗 電話',
      // 業種別（飲食）
      '新規オープン カフェ 電話番号', 'グランドオープン 飲食店 住所', '新規オープン 居酒屋', '新規オープン ラーメン',
      'オープンしました 焼肉 店舗', 'テイクアウト 新規オープン 電話', 'キッチンカー 開業 電話番号',
      // 業種別（美容・リラク）
      '新規オープン 美容室 電話番号', '新規オープン ネイルサロン 住所', 'オープンしました エステサロン 予約',
      '新規オープン 整体院 電話', '開業しました 鍼灸院', 'パーソナルジム オープン 新規 電話',
      // 業種別（医療・ペット・教室・その他）
      '開院しました 歯科 電話番号', '開院しました クリニック 住所', '開院しました 動物病院',
      'ペットサロン 新規オープン 電話', '教室 新規開業 電話番号', 'リフォーム 新規開業 電話',
    ] },
  // 開店・閉店まとめ系ポータル（新店を日次で網羅的に掲載＝熱いリストの宝庫）
  { type: 'kaiten_heiten_portal_search', label: '開店閉店まとめサイト', group: '新規候補', mode: 'serp', defaultEnabled: true, signalType: 'new_article', freshness: 'week',
    queries: ['site:kaiten-heiten.com オープン', 'site:kaiten-heiten.com 開店 予定', '"開店閉店" "オープン予定" 店舗', '"開店情報" オープン 電話番号', '"開店予定" 店舗 住所 電話'] },
  // グルメ/美容ポータルの「ニューオープン」ページ（詳細ページに電話・住所が載る）
  { type: 'portal_newopen_page_scan', label: 'グルメ/美容ポータル新店ページ', group: '新規候補', mode: 'serp', defaultEnabled: true, signalType: 'portal_new_listing', freshness: 'month',
    queries: ['site:tabelog.com "ニューオープン"', 'site:tabelog.com "オープンしました"', 'site:beauty.hotpepper.jp "ニューオープン"', 'site:beauty.hotpepper.jp "NEW OPEN"', 'site:hotpepper.jp "ニューオープン"', 'site:ekiten.jp "新規オープン"', 'site:r.gnavi.co.jp "ニューオープン"', 'site:retty.me "ニューオープン"', 'site:retty.me "オープンしました"', 'site:epark.jp "新規オープン"', 'site:beauty.epark.jp "NEW OPEN"', 'site:restaurant.ikyu.com "ニューオープン"', 'site:ozmall.co.jp "ニューオープン"'] },
  // 個人開業ブログ（アメブロ=個人サロン系が非常に多い / note=開業エッセイ）。店名から Places で電話・住所補完
  { type: 'blog_opening_search', label: '個人開業ブログ(アメブロ/note)', group: '新規候補', mode: 'serp', defaultEnabled: true, signalType: 'sns_opening', freshness: 'month',
    queries: ['site:ameblo.jp "オープンしました" サロン', 'site:ameblo.jp "新規オープン" 電話', 'site:ameblo.jp "開業しました"', 'site:ameblo.jp "オープン予定" 店舗', 'site:note.com "開業しました" 店舗', 'site:note.com "オープンします" 店舗'] },
  // 地域ニュース/タウン情報サイトの新店記事（号外NET/まいぷれ/タウンニュース/みん経 等）
  { type: 'local_news_opening_search', label: '地域ニュース/タウン情報 新店', group: '新規候補', mode: 'serp', defaultEnabled: true, signalType: 'new_article', freshness: 'week',
    queries: ['"号外NET" オープン', '"まいぷれ" 新規オープン', '"タウンニュース" オープン 店舗', '"みんなの経済新聞" オープン', '地域ニュース 新規オープン 電話番号', '"オープンしました" ニュース 店舗 住所'] },
  // 日付指定オープン検索: 「7月4日オープン」等、過去7日の日付を展開して直近オープンをピンポイントで拾う
  { type: 'dated_opening_search', label: '日付指定オープン検索(過去7日)', group: '新規候補', mode: 'serp', defaultEnabled: true, signalType: 'new_article', freshness: 'week',
    queries: ['"{md}オープン" 店舗', '"{md} オープン" 電話', '"{md}にオープン"', '"{md}グランドオープン"', '"{md} 開院"'] },
  // Googleニュース RSS（キー不要・Serper消費ゼロ）: 直近7日の新店ニュースを直接取込
  { type: 'google_news_rss_opening', label: 'Googleニュース新店(RSS)', group: '新規候補', mode: 'foundation', defaultEnabled: true, signalType: 'new_article', note: '本稼働: Googleニュース RSSで直近7日の新店記事を取込（検索APIキー不要・Serper消費ゼロ）' },
  // 開業予定日キュー: Google確認済みの開業予定/開業直後の候補を最優先HOT-Aで投入（開業前後が営業の黄金期）
  { type: 'opening_soon_promotion', label: '開業予定日キュー(HOT-A)', group: '新規候補', mode: 'foundation', defaultEnabled: true, signalType: 'new_gbp', note: '本稼働: FUTURE_OPENING/開業予定日45日以内/開業30日以内の候補（Google openingDate裏取り済み）をHOT-A・優先度高で自動投入' },
  { type: 'job_opening_search', label: 'オープニングスタッフ求人', group: '求人由来', mode: 'serp', defaultEnabled: true, signalType: 'job_opening', freshness: 'month',
    queries: ['オープニングスタッフ 店舗 電話番号', 'オープニングスタッフ 新規オープン 住所', '新規オープン スタッフ募集 電話', 'オープニングスタッフ 飲食店 開店', 'オープニングスタッフ カフェ 開業', 'オープニングスタッフ 美容室 新規', 'オープニングスタッフ ネイルサロン', 'オープニングスタッフ 整体院', 'オープニングスタッフ エステ 開業', '新規開院 スタッフ募集 歯科', '開業予定 クリニック 求人', 'オープニングスタッフ 動物病院', 'オープニングスタッフ ジム 開業'] },
  { type: 'press_release_search', label: 'プレスリリース', group: 'プレスリリース由来', mode: 'serp', defaultEnabled: true, signalType: 'press_release', freshness: 'month',
    queries: ['site:prtimes.jp 新店舗 オープン', 'site:prtimes.jp 新規オープン 店舗', 'site:prtimes.jp グランドオープン', 'site:prtimes.jp 開業', 'site:prtimes.jp 開院', 'site:atpress.ne.jp 新規オープン', 'site:value-press.com 新店舗 オープン'] },
  // 既定OFF: 検索クエリの `site:ekiten.jp/shop_` が1件もヒットせず構造的に0件（Serper復活後に実測）。
  //   `site:ekiten.jp/shop_ 公開日`（最も緩い形）でも0件。`site:ekiten.jp 新規オープン` は successful.ekiten.jp の
  //   集客コラムしか返さず店舗ページではない。実績も30日で616クエリ消費・取得0・投入0。
  //   復活させるにはクエリの作り直し（店舗ページの実URL形式の再調査）が必要。
  { type: 'portal_published_date_search', label: 'エキテン公開日7日以内', group: '公開日7日以内', mode: 'existing', defaultEnabled: false, signalType: 'portal_published_date', note: 'クエリが構造的に0件のため無効化（要クエリ再設計）' },
  { type: 'official_site_news_crawl', label: '公式サイト新着情報', group: '公式サイト新着', mode: 'serp', defaultEnabled: true, signalType: 'official_news', freshness: 'month',
    queries: ['"新規オープン" "公式サイト"', '"グランドオープン" "公式"', '"開院のお知らせ"', '"開業のお知らせ"', '"移転オープンのお知らせ"', '"リニューアルオープンのお知らせ"', '"プレオープンのお知らせ"'] },
  { type: 'rss_sitemap_crawl', label: 'RSS / sitemap差分', group: '新店シグナル', mode: 'foundation', defaultEnabled: true, signalType: 'official_news', note: 'RSS/sitemap/WP REST差分。対象URL登録後に有効化' },
  { type: 'construction_opening_signal_search', label: '看板・内装・開業準備ワード', group: '新店シグナル', mode: 'serp', defaultEnabled: true, signalType: 'construction_signal', freshness: 'month',
    queries: ['看板がつきました オープン', '内装工事中 オープン予定', '店舗準備中 オープン', '開店準備中', '物件決まりました 店舗', 'まもなくオープン', 'プレオープン準備中', '予約受付開始 新店'] },
  { type: 'chamber_commerce_new_member_crawl', label: '商工会議所・商店街 新入会員', group: '新店シグナル', mode: 'serp', defaultEnabled: true, signalType: 'chamber_new_member',
    queries: ['商工会議所 新入会員 店舗', '商工会 新入会員', '商店街 新規加盟店', '新規会員紹介 店舗', '会員紹介 新規オープン', '商店会 新店舗'] },
  { type: 'review_low_count_places', label: '口コミ0〜5件のGBP', group: '新規候補', mode: 'places', defaultEnabled: true, signalType: 'low_review_count', note: 'MEO営業向き候補（新店確定ではない）' },
  { type: 'website_missing_scan', label: 'HP未整備・Web弱者判定', group: '簡易HP利用', mode: 'places', defaultEnabled: true, signalType: 'website_missing', note: '既存候補のWeb弱点を判定' },
  { type: 'construction_case_opening_crawl', label: '内装/看板/工務店 施工事例', group: '施工事例由来', mode: 'serp', defaultEnabled: true, signalType: 'construction_case', freshness: 'month',
    queries: ['"店舗内装" "施工事例" "新規オープン"', '"看板施工" "新規オープン"', '"美容室 内装 施工事例 オープン"', '"飲食店 内装 施工事例 オープン"', '"クリニック 内装 施工事例 開院"', '"看板が完成しました" "オープン"'] },
  { type: 'new_official_site_discovery', label: '新しい公式サイト検出', group: '公式サイト新着', mode: 'serp', defaultEnabled: true, signalType: 'official_news', freshness: 'month',
    queries: ['"ホームページを公開しました" 店舗', '"公式サイトを公開しました" 店舗', '"サイトオープンしました" 店舗', '"ホームページ開設のお知らせ"', '"公式ホームページを開設しました"'] },
  { type: 'weak_builder_site_scan', label: '簡易HP(Wix/ペライチ等)検出', group: '簡易HP利用', mode: 'serp', defaultEnabled: true, signalType: 'weak_builder_site', freshness: 'month',
    queries: ['site:wixsite.com "新規オープン" 店舗', 'site:wixsite.com "オープンしました" 電話', 'site:jimdofree.com "新規オープン"', 'site:jimdosite.com "オープンしました"', 'site:peraichi.com 整体 オープン', 'site:peraichi.com サロン 新規オープン', 'site:studio.site 美容室 オープン', 'site:amebaownd.com サロン 開業', 'site:sites.google.com 店舗 新規オープン', 'site:localinfo.jp 新規オープン', 'site:crayonsite.com 店舗 オープン', 'site:goope.jp 新規オープン 店舗'] },
  { type: 'instagram_only_business_scan', label: 'Instagramのみ店舗', group: 'Instagramのみ', mode: 'places', defaultEnabled: true, signalType: 'instagram_only' },
  { type: 'new_review_signal_scan', label: '口コミ急増・新規口コミ監視', group: '口コミ急増', mode: 'places', defaultEnabled: true, signalType: 'new_review_delta', note: 'place_idスナップショット差分' },
  // ---- 初期OFF（高負荷・要調整・外部API確認が必要） ----
  { type: 'yahoo_local_search_delta', label: 'Yahooローカルサーチ差分', group: '新規候補', mode: 'foundation', defaultEnabled: false, signalType: 'new_gbp', note: 'Yahoo Local API。土台のみ' },
  { type: 'corporation_new_registration', label: '法人番号/gBizINFO新規法人', group: '法人番号由来', mode: 'foundation', defaultEnabled: false, signalType: 'corporation_new', note: '国税庁法人番号/gBizINFO API。土台のみ' },
  { type: 'public_open_data_crawl', label: '保健所 新規営業許可（オープンデータ）', group: '新店シグナル', mode: 'foundation', defaultEnabled: true, signalType: 'public_permit', note: '本稼働: 保健所の食品営業許可CSV（台東=月次新規/江東・港・中央・新宿・中野=標準台帳）から直近45日の新規許可を取込。行政一次データ＝誤検知ほぼゼロ・許可日≒開業日' },
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

  // ================= 新規リスト強化（追加取得元） =================
  // --- 新規HP・ドメイン系 ---
  { type: 'wordpress_first_post_scan', label: 'WordPress初回投稿検出', group: '新規HP公開', mode: 'foundation', defaultEnabled: true, signalType: 'wordpress_first_post', note: '/wp-json/wp/v2/posts・/feed・sitemapの初回/最新投稿日で新規HP判定。専用エンジン整備後に本稼働（現在は土台）' },
  { type: 'sitemap_recent_url_scan', label: 'sitemap直近更新URL監視', group: '新規HP公開', mode: 'foundation', defaultEnabled: true, signalType: 'sitemap_recent_url', note: 'sitemap.xmlのlastmodが直近7日以内のURLを検出。専用エンジン整備後に本稼働（現在は土台）' },
  { type: 'new_ssl_certificate_domain_scan', label: 'SSL新規発行ドメイン監視', group: '新規HP公開', mode: 'foundation', defaultEnabled: false, signalType: 'new_ssl_certificate', note: 'crt.sh等のCertificate Transparencyから新規ドメイン検出。外部API確認後に有効化（土台）' },
  { type: 'new_domain_registration_scan', label: '新規ドメイン登録日チェック', group: '新規HP公開', mode: 'foundation', defaultEnabled: false, signalType: 'new_domain_registration', note: 'RDAP/WHOISで登録日を確認（補助根拠のみ）。外部API確認後に有効化（土台）' },

  // --- 開業前後シグナル（SERP・共通pipelineで即稼働） ---
  { type: 'open_house_event_search', label: '内覧会検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: true, signalType: 'open_house_event', freshness: 'month',
    queries: ['"内覧会" "新規開院"', '"内覧会" "クリニック" 電話', '"内覧会" "歯科"', '"内覧会" "整体院"', '"内覧会" "サロン" オープン', '"開院前" "内覧会"', '"内覧会" "オープン" 住所'] },
  { type: 'opening_campaign_search', label: 'オープンキャンペーン検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: true, signalType: 'opening_campaign', freshness: 'month',
    queries: ['"オープンキャンペーン" "新規オープン"', '"OPEN記念" 店舗 電話', '"オープン記念キャンペーン" 住所', '"初回キャンペーン" "新規オープン"', '"グランドオープンキャンペーン"', '"開業記念キャンペーン"'] },
  { type: 'trial_lesson_opening_search', label: '無料体験・体験会開始検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: true, signalType: 'trial_lesson', freshness: 'month',
    queries: ['"無料体験" "新規オープン"', '"体験会" "オープン" 電話', '"無料体験受付中" "開業"', '"体験レッスン" "新規開校"', '"初回体験" "新店舗"'] },
  { type: 'reservation_start_signal_search', label: '予約受付開始検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: true, signalType: 'reservation_start', freshness: 'month',
    queries: ['"予約受付開始" "新規オープン"', '"予約受付開始" "開院"', '"予約開始" "クリニック" 電話', '"予約開始" "サロン"', '"受付開始" "開業"', '"初回予約開始"'] },
  { type: 'staff_recruitment_start_search', label: 'スタッフ募集開始検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: true, signalType: 'staff_recruitment_start', freshness: 'month',
    queries: ['"スタッフ募集開始" "新規オープン"', '"採用開始" "新店舗"', '"新店舗スタッフ募集" 電話', '"オープニングスタッフ募集開始"', '"開業に伴いスタッフ募集"'] },
  { type: 'first_post_opening_signal_search', label: '初投稿×開業シグナル', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'sns_opening',
    queries: ['"初投稿" "新規オープン" 電話', '"はじめまして" "開業準備"', '"初投稿" "開店しました"', '"はじめまして" "新店舗"'] },
  { type: 'independent_opening_search', label: '独立・開業検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'independent_opening',
    queries: ['"独立しました" "開業" 電話', '"退職して開業"', '"独立開業しました" 店舗', '"のれん分け" 開業'] },
  { type: 'career_change_opening_search', label: '転身・開業検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'independent_opening',
    queries: ['"脱サラ" "開業" 店舗', '"転職して開業"', '"未経験から開業" 店舗'] },
  { type: 'business_name_decided_signal_search', label: '屋号決定シグナル', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'pre_opening',
    queries: ['"屋号が決まりました"', '"店名が決まりました" オープン', '"屋号決定" 開業'] },
  { type: 'store_property_contract_signal_search', label: '物件契約シグナル', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'pre_opening',
    queries: ['"物件契約しました" "店舗"', '"物件が決まりました" "オープン"', '"テナント契約" 開業'] },
  { type: 'permit_approved_signal_search', label: '許可取得シグナル', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'permit_approved',
    queries: ['"保健所の許可が下りました"', '"営業許可が下りました" オープン', '"飲食店営業許可" 開業'] },
  { type: 'business_license_obtained_search', label: '営業許可取得検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'permit_approved',
    queries: ['"営業許可取得" 店舗', '"許可取得しました" オープン', '"開業届" 店舗'] },
  { type: 'opening_gift_signal_search', label: '開業祝いシグナル', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'reception_event',
    queries: ['"開業祝い" "新規オープン"', '"開店祝い" "店舗" 電話', '"開院祝い" クリニック'] },
  { type: 'reception_event_opening_search', label: 'レセプション検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'reception_event',
    queries: ['"レセプション開催" "オープン"', '"内覧レセプション" 開業', '"オープニングレセプション"'] },
  { type: 'pre_opening_business_search', label: 'プレ営業検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'pre_opening',
    queries: ['"プレ営業" "オープン"', '"プレオープン営業" 店舗', '"ソフトオープン" 新店'] },
  { type: 'opening_training_signal_search', label: 'オープン研修シグナル', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'pre_opening',
    queries: ['"オープン研修" 新店舗', '"研修中" "新店舗" オープン', '"開業前研修"'] },
  { type: 'opening_flyer_pdf_search', label: '開業チラシPDF検索', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'opening_campaign',
    queries: ['filetype:pdf "新規オープン" 店舗 電話', 'filetype:pdf "グランドオープン" チラシ', 'filetype:pdf "開院のお知らせ"'] },
  { type: 'local_flyer_ad_crawl', label: '地域チラシ・広告', group: '開業前後シグナル', mode: 'serp', defaultEnabled: false, signalType: 'opening_campaign',
    queries: ['"新規オープン" チラシ 地域 電話', '"折込チラシ" 新規オープン 店舗', '"オープンチラシ" 店舗'] },

  // --- SNS/プロフィール ---
  { type: 'line_official_only_scan', label: 'LINE公式のみ店舗', group: 'SNS/プロフィール', mode: 'serp', defaultEnabled: true, signalType: 'line_official_only', freshness: 'month',
    queries: ['"lin.ee" "新規オープン" 店舗', '"line.me" 予約 "新規オープン"', '"LINE予約" "オープンしました" 電話', '"公式LINE" "新規オープン" サロン'] },
  { type: 'profile_link_only_business_scan', label: 'プロフィールリンクのみ店舗', group: 'SNS/プロフィール', mode: 'serp', defaultEnabled: true, signalType: 'profile_link_only', freshness: 'month',
    queries: ['"lit.link" "新規オープン" 店舗', '"linktr.ee" "新規オープン"', '"lit.link" サロン オープン 電話', '"linktr.ee" 開業 店舗'] },
  { type: 'sns_profile_opening_bio_scan', label: 'SNSプロフィールOPEN検出', group: 'SNS/プロフィール', mode: 'serp', defaultEnabled: true, signalType: 'sns_opening', freshness: 'month',
    queries: ['site:instagram.com "近日OPEN"', 'site:instagram.com "OPEN予定"', 'site:instagram.com "開業準備中"', '"OPEN予定" instagram 店舗 電話', '"オープン準備中" instagram 住所'] },
  { type: 'tiktok_opening_web_search', label: 'TikTok新店Web検索', group: 'SNS/プロフィール', mode: 'serp', defaultEnabled: false, signalType: 'sns_opening',
    queries: ['site:tiktok.com "新規オープン"', 'site:tiktok.com "オープン予定"', 'site:tiktok.com "開業しました" 店舗'] },
  { type: 'x_opening_signal_search', label: 'X(Twitter)新店検索', group: 'SNS/プロフィール', mode: 'serp', defaultEnabled: false, signalType: 'sns_opening',
    queries: ['site:x.com "新規オープン" "店舗"', 'site:x.com "開業しました"', 'site:twitter.com "新規オープン" 電話'] },
  { type: 'facebook_opening_web_search', label: 'Facebook新店検索', group: 'SNS/プロフィール', mode: 'serp', defaultEnabled: false, signalType: 'sns_opening',
    queries: ['site:facebook.com "新規オープン"', 'site:facebook.com "開業しました"', 'site:facebook.com "オープンしました" 店舗'] },
  { type: 'instagram_bio_link_expander', label: 'Instagram bioリンク展開', group: 'SNS/プロフィール', mode: 'foundation', defaultEnabled: false, signalType: 'profile_link_only', note: 'プロフィール外部リンク(lit.link/LINE/予約)を展開し電話・住所補完。専用エンジン整備後に本稼働（土台）' },
  { type: 'instagram_comment_contact_extract', label: 'Instaコメント連絡先抽出', group: 'SNS/プロフィール', mode: 'foundation', defaultEnabled: false, signalType: 'sns_opening', note: 'コメント欄から電話/住所を補完。専用エンジン整備後に本稼働（土台）' },

  // --- 求人/創業/補助金 ---
  { type: 'job_company_to_place_enrichment', label: '求人会社名→店舗照合', group: '求人/創業/補助金', mode: 'foundation', defaultEnabled: false, signalType: 'job_opening', note: '会社名+勤務地住所をPlaces/公式照合し実店舗化。専用エンジン整備後に本稼働（土台）' },
  { type: 'job_opening_deadline_signal', label: '求人締切×開業シグナル', group: '求人/創業/補助金', mode: 'serp', defaultEnabled: false, signalType: 'staff_recruitment_start',
    queries: ['"オープニングスタッフ" 締切 新規オープン', '"開業前" 求人 締切 店舗'] },
  { type: 'startup_support_case_crawl', label: '創業支援事例', group: '求人/創業/補助金', mode: 'serp', defaultEnabled: false, signalType: 'startup_support_case',
    queries: ['"創業者紹介" "店舗"', '"創業支援事例" "開業"', '"開業支援事例" "店舗" 電話'] },
  { type: 'commerce_startup_member_crawl', label: '商工会 新入会員紹介', group: '求人/創業/補助金', mode: 'serp', defaultEnabled: false, signalType: 'startup_support_case',
    queries: ['"新入会員紹介" "商工会"', '"商工会議所" "新入会員" 店舗', '"商店会" "新規加盟"'] },
  { type: 'bank_startup_case_crawl', label: '金融機関 創業支援事例', group: '求人/創業/補助金', mode: 'serp', defaultEnabled: false, signalType: 'startup_support_case',
    queries: ['"信用金庫" "創業支援事例"', '"銀行" "開業支援事例" 店舗', '"創業融資" 事例 開業'] },
  { type: 'subsidy_case_story_crawl', label: '補助金活用事例', group: '求人/創業/補助金', mode: 'serp', defaultEnabled: false, signalType: 'subsidy_case',
    queries: ['"補助金 活用事例" "ホームページ"', '"補助金 活用事例" "販路開拓" 店舗', '"小規模事業者持続化補助金" "ホームページ"'] },
  { type: 'it_subsidy_implementation_case_scan', label: 'IT導入事例', group: '求人/創業/補助金', mode: 'serp', defaultEnabled: false, signalType: 'subsidy_case',
    queries: ['"IT導入補助金" "導入事例" 店舗', '"IT導入補助金" 美容室', '"DX" 補助金 事例 店舗'] },

  // --- ポータル/予約/メニュー ---
  { type: 'portal_new_listing_recent_scan', label: 'ポータル新規掲載', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'portal_new_listing',
    queries: ['"掲載開始しました" "整体"', '"掲載開始" "歯科"', '"EPARKに掲載されました"', '"食べログ掲載開始"', '"ペットライフ 掲載"'] },
  { type: 'portal_listing_start_search', label: 'ポータル掲載開始', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'portal_new_listing',
    queries: ['"掲載開始" "新規オープン" 店舗', '"予約サイト 掲載開始"', '"Caloo 掲載" クリニック'] },
  { type: 'portal_listing_announcement_search', label: 'ポータル掲載告知', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'portal_new_listing',
    queries: ['"に掲載されました" "オープン" 店舗', '"掲載開始のお知らせ" 新規オープン'] },
  { type: 'new_menu_published_search', label: 'メニュー公開検索', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'new_menu_published',
    queries: ['"メニュー公開" "新規オープン"', '"メニューができました" "オープン"', '"施術メニュー公開" "サロン"', '"診療メニュー公開" "クリニック"'] },
  { type: 'new_price_page_published_search', label: '料金表公開検索', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'new_price_page',
    queries: ['"料金表を公開しました"', '"価格表公開" "開業"', '"料金表" "新規オープン" 店舗'] },
  { type: 'new_reservation_page_scan', label: '予約ページ新規公開', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'reservation_page_published',
    queries: ['"予約ページを公開しました"', '"予約受付開始" "RESERVA"', '"STORES予約" "新規オープン"'] },
  { type: 'reserva_new_business_scan', label: 'RESERVA新規事業者', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'reservation_page_published',
    queries: ['site:reserva.be "新規オープン"', 'site:reserva.be オープン 店舗', 'site:coubic.com "新規オープン"'] },
  { type: 'stores_reservation_new_scan', label: 'STORES予約新規', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'reservation_page_published',
    queries: ['"STORES予約" "新規オープン"', '"stores.jp" 予約 開業 店舗'] },
  { type: 'airreserve_business_scan', label: 'Airリザーブ事業者', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'reservation_page_published',
    queries: ['site:airrsv.net "新規オープン"', 'site:airrsv.net オープン 店舗'] },
  { type: 'mosh_business_scan', label: 'MOSH事業者', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'reservation_page_published',
    queries: ['site:mosh.jp "開業"', 'site:mosh.jp オープン 教室'] },
  { type: 'simple_ec_with_local_business_scan', label: 'BASE/STORES ECだけ店舗', group: 'ポータル/予約/メニュー', mode: 'serp', defaultEnabled: false, signalType: 'portal_new_listing',
    queries: ['site:base.ec "新規オープン" 店舗 電話', 'site:stores.jp "新規オープン" 店舗', '"BASE" 実店舗 オープン 電話'] },

  // --- イベント/手動/ファイル取込 ---
  { type: 'event_vendor_announcement_crawl', label: 'イベント出店者発表', group: 'イベント/取込', mode: 'serp', defaultEnabled: false, signalType: 'local_event_vendor',
    queries: ['"出店者発表" "マルシェ"', '"出店者一覧" "店舗" 電話', '"イベント出店者" instagram', '"ポップアップ出店" 店舗', '"キッチンカー 出店者一覧"'] },
  { type: 'manual_url_bulk_import', label: '手動URL一括インポート', group: 'イベント/取込', mode: 'foundation', defaultEnabled: true, signalType: 'manual_import', note: '複数URL貼付で候補化。単一URLの手動インポートはInstagram検索パネルで稼働中。一括版は整備後に本稼働（土台）' },
  { type: 'screenshot_to_lead_import', label: 'スクショ取込', group: 'イベント/取込', mode: 'foundation', defaultEnabled: false, signalType: 'document_import', note: '画像OCRは未対応。スマホ等でテキスト化→「テキスト貼り付けインポート」で代替可' },
  { type: 'document_to_lead_import', label: 'PDF/Excel/CSV取込(テキスト貼付)', group: 'イベント/取込', mode: 'foundation', defaultEnabled: true, signalType: 'document_import', note: 'PDF/Excel/リストの内容をコピーして「テキスト貼り付けインポート」に貼るだけで候補化（本稼働）' },
  { type: 'event_vendor_list_import', label: 'イベント出店者リスト取込', group: 'イベント/取込', mode: 'foundation', defaultEnabled: true, signalType: 'document_import', note: '出店者一覧をコピーして「テキスト貼り付けインポート」へ（本稼働）' },

  // --- 再評価/補完キュー ---
  { type: 'hold_reason_reprocess_queue', label: 'HOLD理由別 再補完', group: '再評価/補完', mode: 'foundation', defaultEnabled: true, signalType: 'missing_phone_rechecked', note: 'HOLDを理由別(電話なし/住所なし/店名未確定)に再補完。既存「HOLD救済(電話補完→HOT昇格)」で一部稼働（フルキューは整備後）' },
  { type: 'missing_phone_recheck_queue', label: '電話なし再チェック', group: '再評価/補完', mode: 'foundation', defaultEnabled: false, signalType: 'missing_phone_rechecked', note: '電話なし候補をPlaces/検索で再補完。既存HOLD救済で一部稼働（土台）' },
  { type: 'phone_to_address_enrichment_queue', label: '電話→住所補完', group: '再評価/補完', mode: 'foundation', defaultEnabled: false, signalType: 'phone_to_address_enriched', note: '電話番号から住所を逆補完。専用エンジン整備後に本稼働（土台）' },
  { type: 'places_recheck_queue', label: 'Places再評価キュー', group: '再評価/補完', mode: 'foundation', defaultEnabled: false, signalType: 'first_review_detected', note: 'openingDate未取得等を7/30日後に再評価。既存の30日再取得で一部稼働（土台）' },
  { type: 'first_review_detected_scan', label: '初回口コミ検出', group: '再評価/補完', mode: 'foundation', defaultEnabled: false, signalType: 'first_review_detected', note: 'Google口コミ0→1件化を検出（新規稼働の兆候）。専用エンジン整備後に本稼働（土台）' },

  // --- スコアリング/学習 ---
  { type: 'lead_freshness_scoring', label: '鮮度スコアリング', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: true, signalType: 'lead_freshness', note: '根拠日の新しさをスコア化。既存の営業優先度計算(applySalesScore)に統合予定（土台）' },
  { type: 'callability_score_engine', label: '架電容易性スコア', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: true, signalType: 'lead_freshness', note: '電話/住所/実体の揃い具合をスコア化。既存の営業優先度に統合予定（土台）' },
  { type: 'multi_signal_priority_boost', label: '複数シグナル優先度加点', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: true, signalType: 'lead_freshness', note: 'lead_signalsが複数重なる候補をS/Aへ引上げ。既存applySalesScoreで一部稼働（土台）' },
  { type: 'successful_query_expander', label: '成功クエリ学習拡張', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: true, signalType: 'lead_freshness', note: '本稼働: SERP全取得元でHOTが出たクエリを自動優先（未実行/2週間未実行は再探索・0件続きは後回し）。IWも優先度ローテ稼働' },
  { type: 'lead_exclusion_classifier', label: '除外分類器', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: false, signalType: 'lead_freshness', note: '大手/公共/EC/求人のみを自動分類除外。既存の除外ゲートで一部稼働（土台）' },
  { type: 'sales_angle_classifier', label: '営業角度分類', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: false, signalType: 'lead_freshness', note: 'HP/MEO/SEO/AIO/LINE導線の提案角度を分類。専用エンジン整備後に本稼働（土台）' },
  { type: 'calling_priority_queue', label: '架電優先キュー', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: false, signalType: 'lead_freshness', note: 'S/A/B/Cで架電順に並べる。既存の営業優先度並替で一部代替（土台）' },
  { type: 'industry_fit_score', label: '業種適合スコア', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: false, signalType: 'lead_freshness', note: 'MEO/HP営業に向く業種を加点。専用エンジン整備後に本稼働（土台）' },
  { type: 'ai_duplicate_merge', label: 'AI重複マージ', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: false, signalType: 'lead_freshness', note: '電話/住所/店名/place_idで重複を統合。既存の重複判定で一部稼働（土台）' },
  { type: 'area_hotspot_expansion', label: '地域ホットスポット拡張', group: 'スコアリング/学習', mode: 'foundation', defaultEnabled: false, signalType: 'lead_freshness', note: 'HOTが出た地域の探索を強化。専用エンジン整備後に本稼働（土台）' },
]

// 追加しない（明示除外）source_type
export const EXCLUDED_SOURCE_TYPES = ['shopping_mall_new_shop_crawl', 'google_places_no_website_scan', 'gbp_content_weakness_scan', 'brand_serp_weakness_scan', 'reservation_portal_dependency_scan', 'franchise_new_store_search', 'competitor_gap_scan']

// 専用エンジンで本稼働している source_type（run.ts が newSourceEngines.runEngineSource に振り分ける）。
// UIでは「土台」ではなく「本稼働」バッジを出す。ここに無い foundation は真の土台（OCR/Meta API等・整備中）。
export const ENGINE_SOURCE_TYPES = [
  'new_ssl_certificate_domain_scan', 'new_domain_registration_scan', 'wordpress_first_post_scan', 'sitemap_recent_url_scan',
  'document_to_lead_import', 'event_vendor_list_import', 'google_news_rss_opening', 'opening_soon_promotion', 'public_open_data_crawl',
  'hold_reason_reprocess_queue', 'missing_phone_recheck_queue', 'phone_to_address_enrichment_queue', 'places_recheck_queue', 'first_review_detected_scan',
  'lead_freshness_scoring', 'callability_score_engine', 'multi_signal_priority_boost', 'successful_query_expander',
  'lead_exclusion_classifier', 'sales_angle_classifier', 'calling_priority_queue', 'industry_fit_score', 'ai_duplicate_merge', 'area_hotspot_expansion',
]

export function defaultSourceToggles(): Record<string, boolean> {
  const o: Record<string, boolean> = {}
  for (const s of DISCOVERY_SOURCES) o[s.type] = s.defaultEnabled
  return o
}
export function getSourceDef(type: string): DiscoverySourceDef | undefined { return DISCOVERY_SOURCES.find((s) => s.type === type) }

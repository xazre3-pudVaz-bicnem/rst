-- ============================================================
-- RST CRM: 地域情報サイト巡回による新店リスト取得
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル・既存RLSは変更しません（追加のみ）。
-- 記事本文は保存しない。保存はURL/タイトル/公開日/短い抜粋/抽出結果/判定理由のみ。
-- ============================================================

-- 巡回対象サイト
CREATE TABLE IF NOT EXISTS source_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'category_page',  -- rss / category_page / sitemap / html_list / search_api
  prefecture TEXT,
  area TEXT,
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  crawl_interval_days INTEGER NOT NULL DEFAULT 1,
  last_crawled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE source_sites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON source_sites;
CREATE POLICY rst_all_authenticated ON source_sites FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 取得記事（本文は保存しない）
CREATE TABLE IF NOT EXISTS source_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site_id UUID REFERENCES source_sites(id) ON DELETE SET NULL,
  article_url TEXT NOT NULL,
  article_url_hash TEXT NOT NULL UNIQUE,
  title TEXT,
  published_at TIMESTAMPTZ,
  detected_type TEXT,                 -- open / close / reopen / event / unknown
  raw_excerpt TEXT,                   -- 短い抜粋のみ（〜300字）
  processed_status TEXT NOT NULL DEFAULT 'pending', -- pending / processed / skipped / error
  extracted_shop_name TEXT,
  extracted_area TEXT,
  extracted_address TEXT,
  extracted_open_date TEXT,
  extracted_industry TEXT,
  exclusion_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_articles_site ON source_articles(source_site_id);
CREATE INDEX IF NOT EXISTS idx_source_articles_created ON source_articles(created_at);
ALTER TABLE source_articles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON source_articles;
CREATE POLICY rst_all_authenticated ON source_articles FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- lead_candidates に地域メディア由来カラム
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_article_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_article_title TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_site_name TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS regional_media_detected_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS regional_media_newness_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_candidates_article_url ON lead_candidates(source_article_url);

-- 初期ソース（base_url は実URLに合わせて適宜編集してください。確認できないものは is_active=false）
INSERT INTO source_sites (name, base_url, source_type, prefecture, category, is_active, crawl_interval_days) VALUES
  ('号外NET（開店・開業）', 'https://goguynet.jp/category/%E9%96%8B%E5%BA%97%E3%83%BB%E9%96%89%E5%BA%97/', 'category_page', NULL, 'open_close', false, 1),
  ('埼北つうしん', 'https://saihoku-tsushin.com/', 'category_page', '埼玉県', 'open_close', false, 1),
  ('彩北なび', 'https://saihoku-navi.com/', 'html_list', '埼玉県', 'shop_info', false, 2)
ON CONFLICT (base_url) DO NOTHING;

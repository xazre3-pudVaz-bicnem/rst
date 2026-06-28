-- ============================================================
-- RST CRM: source_sites を画面管理できるよう列を追加
-- Supabase SQL Editor で1回実行。冪等・再実行安全。既存RLSは変更しません。
-- ============================================================
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS list_url TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS media_family TEXT;          -- goguynet/kaitenheiten/tsushin/local_blog/local_news/local_directory/other
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS category_label TEXT;        -- 開店閉店/新店情報/地域ニュース/店舗情報
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS reliability_score INTEGER NOT NULL DEFAULT 50;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS crawl_interval_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_crawl_result TEXT;

-- list_url 未設定は base_url で埋める
UPDATE source_sites SET list_url = base_url WHERE list_url IS NULL OR list_url = '';

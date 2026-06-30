-- ============================================================
-- RST CRM: 店舗ディレクトリ型サイト（彩北なび等）対応のカラム追加
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_site_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_listing_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_detail_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_title TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_snippet TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS newness_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date_text TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_month INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_day INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date_confidence TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS map_url TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS category_label TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_candidates_detail_url ON lead_candidates(source_detail_url);

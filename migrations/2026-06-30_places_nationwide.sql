-- ============================================================
-- RST CRM: Google Places を全国・新店系ワード検索に変更（エリア/業種を検索条件にしない）
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS places_search_query TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS places_search_mode TEXT;     -- nationwide_new_open_query / area_industry(旧)
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_primary_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_types TEXT[];
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_website_uri TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_rating NUMERIC;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_user_rating_count INTEGER;

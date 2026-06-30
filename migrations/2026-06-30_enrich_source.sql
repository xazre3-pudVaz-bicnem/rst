-- ============================================================
-- RST CRM: 住所/電話の取得元・Google Mapsリンクを保存
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_phone_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_address_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_google_maps_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_profile_fetched BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_fail_reason TEXT;

-- ============================================================
-- RST CRM: Google Places openingDate / businessStatus を強く活用
-- lead_candidates に開業日・営業状態カラムを追加。冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_year INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_month INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_day INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_raw TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_business_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS has_google_opening_date BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS days_until_opening INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS days_since_opening INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_places_checked_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_checked_at TIMESTAMPTZ;
-- cases にも参考用（任意）
ALTER TABLE cases ADD COLUMN IF NOT EXISTS google_business_status TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS google_opening_date_raw TEXT;

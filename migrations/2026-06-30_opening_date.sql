ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_band TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS is_new_gbp_priority BOOLEAN DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS has_opening_date_badge BOOLEAN DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_precision TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_primary_type_display_name TEXT;

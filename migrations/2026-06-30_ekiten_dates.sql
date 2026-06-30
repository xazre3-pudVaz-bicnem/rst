ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_published_date DATE;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_updated_date DATE;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_date_type TEXT;

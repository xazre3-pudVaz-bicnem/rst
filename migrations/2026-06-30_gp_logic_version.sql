ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_places_logic_version INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_details_fetched_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ;

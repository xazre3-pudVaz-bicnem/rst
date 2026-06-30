-- HOT tier (A/B)
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hot_tier TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS recommended_status TEXT;

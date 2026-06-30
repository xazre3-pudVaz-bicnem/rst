ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS name_unconfirmed_hot BOOLEAN DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS phone_confidence TEXT;

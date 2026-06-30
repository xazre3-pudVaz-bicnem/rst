-- 自動投入の試行ログ（HOT件数と案件投入数の整合性）
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_attempted BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_success BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_skipped_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_error TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_case_id UUID;

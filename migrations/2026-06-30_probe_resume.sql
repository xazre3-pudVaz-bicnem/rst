-- 連番探索の再開位置・統計
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_valid_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_invalid_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_probe_started_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_probe_finished_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS total_checked_count BIGINT DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS total_valid_count BIGINT DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS total_invalid_count BIGINT DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS forward_scan_count INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS backfill_scan_count INTEGER DEFAULT 5;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS start_probe_id BIGINT;

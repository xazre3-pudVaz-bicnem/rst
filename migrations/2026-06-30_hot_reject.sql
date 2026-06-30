-- ============================================================
-- RST CRM: HOT未達理由（なぜHOTにしなかったか）を保存
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hot_reject_reasons JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hot_reject_summary TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hot_check_result JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hot_missing_requirements JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hot_blocking_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hot_required_score INTEGER;

-- ============================================================
-- RST CRM: Instagram Web検索 全国検索化（地域/業種をクエリに入れない）
-- 抽出結果用カラムを追加。冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_prefecture TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_city TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS recommended_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS rule_filter_result TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS skipped_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS api_run_id UUID;

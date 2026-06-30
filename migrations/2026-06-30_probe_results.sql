-- 連番探索ログ（valid/invalid/文字化けを記録。lead_candidatesにはvalidのみ保存）
CREATE TABLE IF NOT EXISTS sequential_probe_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site_id UUID, run_id UUID, probed_id BIGINT, probed_url TEXT,
  http_status INTEGER, valid_page BOOLEAN, invalid_reason TEXT,
  charset_detected TEXT, decode_method TEXT, decode_success BOOLEAN, mojibake_detected BOOLEAN, mojibake_rate NUMERIC,
  extracted_name TEXT, extracted_address TEXT, extracted_phone TEXT, parser_used TEXT,
  saved_candidate_id UUID, created_case_id UUID, error_message TEXT, checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sequential_probe_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON sequential_probe_results;
CREATE POLICY rst_all_authenticated ON sequential_probe_results FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS charset_detected TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS mojibake_detected BOOLEAN;

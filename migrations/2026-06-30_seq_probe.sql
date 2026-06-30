-- ============================================================
-- RST CRM: 連番URL探索クロール（sequential_id_probe）
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS url_template TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS id_padding INTEGER;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS current_probe_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_checked_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_found_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS scan_direction TEXT DEFAULT 'forward';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_batch_size INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS max_probe_per_run INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS valid_page_pattern TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS invalid_page_pattern TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS parser_type TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_enabled BOOLEAN DEFAULT true;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_result_summary TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS consecutive_not_found_count INTEGER DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS max_consecutive_not_found INTEGER DEFAULT 10;

ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probed_id BIGINT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probed_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probe_valid BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probe_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS first_discovered_at TIMESTAMPTZ;

-- 連番探索ログ（30日以内の再テスト回避・1日上限の集計）
CREATE TABLE IF NOT EXISTS sequential_probe_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site_id UUID,
  probed_url TEXT NOT NULL UNIQUE,
  probed_id BIGINT,
  valid BOOLEAN,
  status TEXT,
  last_probed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sequential_probe_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON sequential_probe_log;
CREATE POLICY rst_all_authenticated ON sequential_probe_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

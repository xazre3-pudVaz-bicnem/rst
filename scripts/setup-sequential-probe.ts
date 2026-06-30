/* ============================================================
 * 連番URL探索（sequential_id_probe）のDBセットアップ（CLIで完結）
 *   npm run setup:sequential-probe
 * 冪等。SUPABASE_DB_URL で Postgres 直結。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'

const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || ''

const DDL = `
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS url_template TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS id_padding INTEGER;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS current_probe_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_checked_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_found_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_valid_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_invalid_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS scan_direction TEXT DEFAULT 'forward';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_batch_size INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS max_probe_per_run INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS forward_scan_count INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS backfill_scan_count INTEGER DEFAULT 5;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS start_probe_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS valid_page_pattern TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS invalid_page_pattern TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS parser_type TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_probe_started_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_probe_finished_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_enabled BOOLEAN DEFAULT true;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_result_summary TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS consecutive_not_found_count INTEGER DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS max_consecutive_not_found INTEGER DEFAULT 10;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS total_checked_count BIGINT DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS total_valid_count BIGINT DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS total_invalid_count BIGINT DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_mode TEXT DEFAULT 'safe';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS same_id_retry_limit INTEGER DEFAULT 3;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS invalid_retry_interval_hours INTEGER DEFAULT 24;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS normalized_url_template TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS region_label TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS prefecture TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS disabled_by TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_error_type TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_error_message TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS review_flag BOOLEAN DEFAULT false;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS rendering_mode TEXT DEFAULT 'auto';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS needs_improvement BOOLEAN DEFAULT false;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS improvement_hint TEXT;
UPDATE source_sites SET normalized_url_template = regexp_replace(regexp_replace(url_template, '\{ID\}', '', 'g'), '/+$', ''), source_key = regexp_replace(regexp_replace(url_template, '\{ID\}', '', 'g'), '/+$', '') || '|' || COALESCE(parser_type, 'generic_detail_page') WHERE source_type = 'sequential_id_probe' AND url_template IS NOT NULL AND (normalized_url_template IS NULL OR normalized_url_template = '');
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probed_id BIGINT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probed_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probe_valid BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probe_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS charset_detected TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS mojibake_detected BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS first_discovered_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS sequential_probe_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_site_id UUID, run_id UUID, probed_id BIGINT, probed_url TEXT,
  http_status INTEGER, valid_page BOOLEAN, invalid_reason TEXT, charset_detected TEXT, decode_method TEXT, decode_success BOOLEAN,
  mojibake_detected BOOLEAN, mojibake_rate NUMERIC, extracted_name TEXT, extracted_address TEXT, extracted_phone TEXT, parser_used TEXT,
  saved_candidate_id UUID, created_case_id UUID, error_message TEXT, checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sequential_probe_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON sequential_probe_results;
CREATE POLICY rst_all_authenticated ON sequential_probe_results FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_probe_results_url ON sequential_probe_results(probed_url);
-- じゃらん観光スポット（連番探索）のseed（既定OFF・UIで有効化）
INSERT INTO source_sites (name, base_url, list_url, media_family, source_type, parser_type, category_label, is_active, reliability_score, crawl_interval_hours, url_template, id_padding, current_probe_id, start_probe_id, scan_direction, probe_batch_size, max_probe_per_run, forward_scan_count, backfill_scan_count, max_consecutive_not_found, probe_enabled, updated_at)
VALUES ('じゃらん観光スポット', 'https://www.jalan.net/kankou/', 'https://www.jalan.net/kankou/', 'jalan', 'sequential_id_probe', 'jalan_spot_detail', '店舗新着', false, 60, 24, 'https://www.jalan.net/kankou/spt_guide{ID}/', 12, 231369, 231369, 'forward', 20, 20, 20, 5, 10, true, now())
ON CONFLICT (base_url) DO UPDATE SET source_type='sequential_id_probe', parser_type='jalan_spot_detail', url_template=EXCLUDED.url_template, id_padding=12, forward_scan_count=20, backfill_scan_count=5, max_consecutive_not_found=10, updated_at=now();
`

async function main() {
  console.log('=== RST 連番URL探索 セットアップ ===')
  if (!DB_URL) { console.error('✗ SUPABASE_DB_URL が未設定です（.env）。'); process.exit(1) }
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    console.log('• カラム/テーブル/seed を適用中（冪等）...')
    await client.query(DDL)
    const sites = await client.query("SELECT count(*)::int AS c FROM source_sites WHERE source_type='sequential_id_probe'")
    console.log(`  ✓ 連番探索ソース: ${sites.rows[0].c}件`)
    console.log('\n✅ セットアップ完了 — npm run build → RST「AI投入」連番URL探索タブで確認')
  } finally { await client.end() }
}
main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

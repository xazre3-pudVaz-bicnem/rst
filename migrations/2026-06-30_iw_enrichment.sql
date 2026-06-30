-- ============================================================
-- RST CRM: Instagram Web検索 外部情報補完（電話/住所を関連サイトから補完）
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_status TEXT;            -- not_started/searched/enriched/failed
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_sources JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_phone TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_prefecture TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_city TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

-- 補完検索クエリの実行履歴（7日スキップ用）
CREATE TABLE IF NOT EXISTS ig_enrich_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL UNIQUE,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  runs INTEGER NOT NULL DEFAULT 0,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ig_enrich_log_last ON ig_enrich_log(last_run_at);
ALTER TABLE ig_enrich_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON ig_enrich_log;
CREATE POLICY rst_all_authenticated ON ig_enrich_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

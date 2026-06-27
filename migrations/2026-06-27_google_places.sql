-- ============================================================
-- RST CRM AI投入リスト Phase2: Google Places 対応
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル・既存RLSは厳しくしません（追加のみ）。
-- 前提: 先に migrations/2026-06-27_lead_candidates.sql を実行済みであること。
-- ============================================================

-- lead_candidates に Google Places 由来の項目を追加
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_maps_uri TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS rating NUMERIC;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS user_rating_count INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS business_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS place_types TEXT[];
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS primary_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS raw_payload JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_query TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_run_id UUID;

CREATE INDEX IF NOT EXISTS idx_lead_candidates_place ON lead_candidates(google_place_id);

-- ============================================================
-- 自動取得バッチの実行ログ
-- ============================================================
CREATE TABLE IF NOT EXISTS auto_lead_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'google_places',
  status TEXT NOT NULL DEFAULT 'running',     -- running / success / error
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  search_queries_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  hot_count INTEGER NOT NULL DEFAULT 0,
  hold_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by_id UUID REFERENCES auth.users(id),
  organization_id UUID,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auto_lead_runs_created ON auto_lead_runs(created_date DESC);

-- RLS（既存と同じ「認証済みは全操作可」。サーバーはservice roleで実行＝RLSバイパス）
ALTER TABLE auto_lead_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON auto_lead_runs;
CREATE POLICY rst_all_authenticated ON auto_lead_runs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Realtime（任意）
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE auto_lead_runs; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

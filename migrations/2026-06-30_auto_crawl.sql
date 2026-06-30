-- 二重実行防止ロック
CREATE TABLE IF NOT EXISTS auto_crawl_lock (
  lock_key   TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  run_id     UUID
);

-- 自動巡回の実行ログ（1実行=1行）
CREATE TABLE IF NOT EXISTS auto_crawl_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  trigger_type TEXT NOT NULL DEFAULT 'cron',     -- cron / manual
  only_filter  TEXT,                              -- all / places / regional / instagram / sequential / failed
  status TEXT NOT NULL DEFAULT 'running',         -- running / success / partial / error / skipped
  total_sources INT DEFAULT 0, success_sources INT DEFAULT 0, failed_sources INT DEFAULT 0,
  google_places_count INT DEFAULT 0, regional_media_count INT DEFAULT 0, instagram_count INT DEFAULT 0, sequential_count INT DEFAULT 0,
  lead_saved_count INT DEFAULT 0, hot_a_count INT DEFAULT 0, hot_b_count INT DEFAULT 0, hold_count INT DEFAULT 0, excluded_count INT DEFAULT 0, cases_inserted_count INT DEFAULT 0,
  error_message TEXT,
  created_by_id UUID
);

-- 取得元ごとの明細ログ
CREATE TABLE IF NOT EXISTS auto_crawl_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES auto_crawl_runs(id) ON DELETE CASCADE,
  source_type TEXT,            -- google_places / regional_media / instagram_web / sequential_probe
  source_name TEXT,
  status TEXT,                 -- success / error / skipped
  error_kind TEXT,             -- fetch_failed/parser_failed/api_error/timeout/rate_limit/...
  fetched_count INT DEFAULT 0, valid_count INT DEFAULT 0, hot_count INT DEFAULT 0, hold_count INT DEFAULT 0, excluded_count INT DEFAULT 0, saved_count INT DEFAULT 0, inserted_count INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auto_crawl_runs_started ON auto_crawl_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_crawl_run_items_run ON auto_crawl_run_items(run_id);

-- source_sites: スケジューリング補助列（last_crawled_at 等は既存）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS priority INT DEFAULT 100;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS error_count INT DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- RLS（認証ユーザーは閲覧可。書き込みはservice role）
ALTER TABLE auto_crawl_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_crawl_run_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY rst_acr_sel ON auto_crawl_runs FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY rst_acri_sel ON auto_crawl_run_items FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

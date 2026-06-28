-- ============================================================
-- RST CRM AI投入リスト: クエリ実行履歴（ローテーション巡回用）
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル・既存RLSは変更しません（追加のみ）。
-- 一都三県を毎日全部回さず、未実行/古いクエリから1日上限まで巡回するために使用。
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_query_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'google_places',
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  runs INTEGER NOT NULL DEFAULT 0,
  places_count INTEGER NOT NULL DEFAULT 0,
  hot_count INTEGER NOT NULL DEFAULT 0,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_query_log_last_run ON lead_query_log(last_run_at);

ALTER TABLE lead_query_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON lead_query_log;
CREATE POLICY rst_all_authenticated ON lead_query_log
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

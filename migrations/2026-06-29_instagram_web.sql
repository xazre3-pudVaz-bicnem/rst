-- ============================================================
-- RST CRM: Instagram Web検索（Meta API不使用・Web検索API＋Anthropic判定）
-- Supabase SQL Editor 手貼り不要。npm run setup:instagram-web で自動適用。
-- 冪等・再実行安全。既存RLSは変更しません（追加のみ）。
-- 保存は URL/タイトル/スニペット/抽出結果/判定理由のみ（本文の大量保存はしない）。
-- ============================================================

-- lead_candidates に Instagram Web検索 由来カラム
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source TEXT;                 -- 'instagram_web_search' 等
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_query TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_title TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_snippet TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS anthropic_judgement JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS newness_type TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_candidates_source ON lead_candidates(source);

-- 検索クエリ実行履歴（7日以内の同一クエリスキップ・ローテーション）
CREATE TABLE IF NOT EXISTS ig_web_query_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL UNIQUE,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  runs INTEGER NOT NULL DEFAULT 0,
  results INTEGER NOT NULL DEFAULT 0,
  hot_count INTEGER NOT NULL DEFAULT 0,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ig_web_query_log_last ON ig_web_query_log(last_run_at);
ALTER TABLE ig_web_query_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON ig_web_query_log;
CREATE POLICY rst_all_authenticated ON ig_web_query_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 自動取得設定（初期はHOT自動投入OFF）
INSERT INTO app_config (key, value) VALUES
  ('instagram_web_auto', '{"iwEnabled": true, "iwAutoImport": false, "iwRequirePhone": false, "iwPlacesRequired": false, "iwAnthropic": true, "iwMaxQueriesPerDay": 30, "iwPerQuery": 10}'::jsonb)
ON CONFLICT (key) DO NOTHING;

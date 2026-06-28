-- ============================================================
-- RST CRM AI投入リスト: 自動取得設定(app_config) ＋ クエリ履歴の都県列
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル・既存RLSは変更しません（追加のみ）。
-- ============================================================

-- Cron(毎朝6:00)が参照する自動取得設定（UIから保存）
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON app_config;
CREATE POLICY rst_all_authenticated ON app_config
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- クエリ実行履歴に都県/エリアを追加（都県別の巡回進捗表示用）
ALTER TABLE lead_query_log ADD COLUMN IF NOT EXISTS prefecture TEXT;
ALTER TABLE lead_query_log ADD COLUMN IF NOT EXISTS area TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_query_log_pref ON lead_query_log(prefecture);

-- ============================================================
-- RST CRM 追加マイグレーション（Phase 2）
-- すでに schema.sql(Phase1) を適用済みの環境に対し、差分のみを適用します。
-- 何度実行しても安全（IF NOT EXISTS / 例外無視）。
-- Supabase SQL Editor に貼り付けて Run してください。
-- ※ schema.sql を最新版で再実行しても同じ結果になります（どちらでも可）。
-- ============================================================

-- 1) 案件にタグ・優先度を追加
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE cases ADD COLUMN IF NOT EXISTS priority TEXT;
CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority);

-- 2) テンプレートに status / 並び順を追加
ALTER TABLE templates ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 100;

-- 3) 監査ログテーブル
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  entity_name TEXT,
  detail TEXT,
  actor_id UUID REFERENCES auth.users(id),
  actor_name TEXT,
  organization_id UUID,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);

-- 4) profiles に role が無い場合に備える（Phase1で作成済みなら何もしない）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organization_id UUID;

-- 完了。既存データはそのまま保持されます。

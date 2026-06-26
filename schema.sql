-- ============================================================
-- RST CRM Supabase スキーマ
-- Supabase SQL Editor に貼り付けて実行してください。
-- （開発用に RLS は無効のままです。本番運用時はポリシー追加を推奨）
-- ============================================================

-- 案件
CREATE TABLE IF NOT EXISTS cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone1 TEXT NOT NULL,
  phone2 TEXT,
  phone3 TEXT,
  industry TEXT,
  representative TEXT,
  status TEXT NOT NULL DEFAULT '新規',
  sales_rep TEXT,
  hp1 TEXT,
  hp2 TEXT,
  instagram TEXT,
  source_urls TEXT,
  memo TEXT,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 訪問予定
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  address TEXT,
  sales_rep TEXT,
  appo_at TIMESTAMPTZ NOT NULL,
  memo TEXT,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 再コール予定
CREATE TABLE IF NOT EXISTS recalls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  target_at TIMESTAMPTZ NOT NULL,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- コール履歴
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  call_at TIMESTAMPTZ NOT NULL,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('接触','非接触')),
  result TEXT,
  memo TEXT,
  summary TEXT,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- スマホ連動セッション
CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key TEXT NOT NULL UNIQUE,
  case_id UUID,
  case_name TEXT,
  phone1 TEXT,
  phone2 TEXT,
  phone3 TEXT,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- updated_date 自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_date()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_date = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cases_updated ON cases;
CREATE TRIGGER trg_cases_updated BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();

DROP TRIGGER IF EXISTS trg_appointments_updated ON appointments;
CREATE TRIGGER trg_appointments_updated BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();

DROP TRIGGER IF EXISTS trg_recalls_updated ON recalls;
CREATE TRIGGER trg_recalls_updated BEFORE UPDATE ON recalls
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();

DROP TRIGGER IF EXISTS trg_call_logs_updated ON call_logs;
CREATE TRIGGER trg_call_logs_updated BEFORE UPDATE ON call_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();

DROP TRIGGER IF EXISTS trg_call_sessions_updated ON call_sessions;
CREATE TRIGGER trg_call_sessions_updated BEFORE UPDATE ON call_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();

-- インデックス
CREATE INDEX IF NOT EXISTS idx_cases_sales_rep ON cases(sales_rep);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_created_date ON cases(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_appo_at ON appointments(appo_at);
CREATE INDEX IF NOT EXISTS idx_appointments_sales_rep ON appointments(sales_rep);
CREATE INDEX IF NOT EXISTS idx_recalls_target_at ON recalls(target_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_case_id ON call_logs(case_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_call_at ON call_logs(call_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_session_key ON call_sessions(session_key);

-- Realtime 有効化（既に追加済みの場合はエラーを無視してください）
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE call_sessions;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE cases;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE call_logs;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE recalls;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE appointments;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

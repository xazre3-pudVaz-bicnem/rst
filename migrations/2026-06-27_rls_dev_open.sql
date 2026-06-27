-- ============================================================
-- RST CRM 開発用RLS（認証済みユーザーは全件 SELECT/INSERT/UPDATE/DELETE 可）
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- FOR ALL = SELECT / INSERT / UPDATE / DELETE すべてを許可します。
-- ============================================================

-- cases
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON cases;
CREATE POLICY rst_all_authenticated ON cases
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- appointments
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON appointments;
CREATE POLICY rst_all_authenticated ON appointments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- call_logs
ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON call_logs;
CREATE POLICY rst_all_authenticated ON call_logs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- recalls
ALTER TABLE recalls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON recalls;
CREATE POLICY rst_all_authenticated ON recalls
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON profiles;
CREATE POLICY rst_all_authenticated ON profiles
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON organizations;
CREATE POLICY rst_all_authenticated ON organizations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- templates
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON templates;
CREATE POLICY rst_all_authenticated ON templates
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- audit_logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON audit_logs;
CREATE POLICY rst_all_authenticated ON audit_logs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- import_batches
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON import_batches;
CREATE POLICY rst_all_authenticated ON import_batches
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- call_sessions（スマホ連動：匿名(anon)も読み書き必要）
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_session_anon ON call_sessions;
CREATE POLICY rst_session_anon ON call_sessions
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

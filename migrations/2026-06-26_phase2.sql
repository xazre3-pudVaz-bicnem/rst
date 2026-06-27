-- ============================================================
-- 【お知らせ】このファイルは単体実行用に「完全版」へ統合されました。
-- ------------------------------------------------------------
-- 以前の phase2 は「Phase1適用済み」を前提に ALTER していたため、
-- templates / organizations 未作成の環境ではエラーになりました。
--
-- 今後はリポジトリ直下の schema.sql（完全版・冪等・依存順）を1回実行すれば
-- すべてのテーブル/列/トリガー/インデックス/Realtime が揃います。
-- 下記は schema.sql と同一内容なので、このファイルを実行してもOKです。
-- ============================================================

-- ============================================================
-- 1. 組織
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. プロフィール（auth.users と 1:1 / organizations を参照）
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  organization_id UUID REFERENCES organizations(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

-- ============================================================
-- 3. 案件
-- ============================================================
CREATE TABLE IF NOT EXISTS cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone1 TEXT NOT NULL,
  phone2 TEXT,
  phone3 TEXT,
  industry TEXT,
  representative TEXT,
  status TEXT NOT NULL DEFAULT '未架電',
  sales_rep TEXT,
  hp1 TEXT,
  hp2 TEXT,
  instagram TEXT,
  source_urls TEXT,
  memo TEXT,
  tags TEXT[],
  priority TEXT,
  organization_id UUID,
  created_by_id UUID REFERENCES auth.users(id),
  assigned_to UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS phone2 TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS phone3 TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS representative TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS sales_rep TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS hp1 TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS hp2 TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS source_urls TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE cases ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS created_by_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS assigned_to UUID;

-- ============================================================
-- 4. 訪問予定
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  address TEXT,
  sales_rep TEXT,
  appo_at TIMESTAMPTZ NOT NULL,
  memo TEXT,
  organization_id UUID,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS sales_rep TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_by_id UUID;

-- ============================================================
-- 5. 再コール予定
-- ============================================================
CREATE TABLE IF NOT EXISTS recalls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  target_at TIMESTAMPTZ NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  memo TEXT,
  organization_id UUID,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE recalls ADD COLUMN IF NOT EXISTS done BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recalls ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE recalls ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE recalls ADD COLUMN IF NOT EXISTS created_by_id UUID;

-- ============================================================
-- 6. コール履歴
-- ============================================================
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  call_at TIMESTAMPTZ NOT NULL,
  contact_type TEXT NOT NULL DEFAULT '非接触' CHECK (contact_type IN ('接触','非接触')),
  result TEXT,
  memo TEXT,
  summary TEXT,
  prev_status TEXT,
  next_status TEXT,
  next_recall_at TIMESTAMPTZ,
  sales_rep TEXT,
  organization_id UUID,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS result TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS prev_status TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS next_status TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS next_recall_at TIMESTAMPTZ;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS sales_rep TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS created_by_id UUID;

-- ============================================================
-- 7. スマホ連動セッション
-- ============================================================
CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key TEXT NOT NULL UNIQUE,
  case_id UUID,
  case_name TEXT,
  address TEXT,
  status TEXT,
  phone1 TEXT,
  phone2 TEXT,
  phone3 TEXT,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS phone2 TEXT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS phone3 TEXT;

-- ============================================================
-- 8. CSV取込バッチ履歴
-- ============================================================
CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'csv',
  file_name TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  added_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  organization_id UUID,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 9. テンプレート
-- ============================================================
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL DEFAULT 'memo',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT,
  sort_order INTEGER DEFAULT 100,
  organization_id UUID,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 100;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS organization_id UUID;

-- ============================================================
-- 10. 監査ログ
-- ============================================================
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

-- ============================================================
-- 11. updated_date 自動更新トリガー
-- ============================================================
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
DROP TRIGGER IF EXISTS trg_templates_updated ON templates;
CREATE TRIGGER trg_templates_updated BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();
DROP TRIGGER IF EXISTS trg_profiles_updated ON profiles;
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();
DROP TRIGGER IF EXISTS trg_organizations_updated ON organizations;
CREATE TRIGGER trg_organizations_updated BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();

-- ============================================================
-- 12. 新規ユーザー作成時に profiles を自動生成 ＋ 既存ユーザー補完
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

INSERT INTO public.profiles (id, full_name)
SELECT u.id, COALESCE(u.raw_user_meta_data->>'full_name', u.email)
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 13. インデックス
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_cases_sales_rep ON cases(sales_rep);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_created_date ON cases(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_cases_org ON cases(organization_id);
CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority);
CREATE INDEX IF NOT EXISTS idx_appointments_appo_at ON appointments(appo_at);
CREATE INDEX IF NOT EXISTS idx_appointments_sales_rep ON appointments(sales_rep);
CREATE INDEX IF NOT EXISTS idx_recalls_target_at ON recalls(target_at);
CREATE INDEX IF NOT EXISTS idx_recalls_done ON recalls(done);
CREATE INDEX IF NOT EXISTS idx_call_logs_case_id ON call_logs(case_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_call_at ON call_logs(call_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_session_key ON call_sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_import_batches_created ON import_batches(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);

-- ============================================================
-- 14. Realtime 有効化（重複は握りつぶす）
-- ============================================================
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_sessions; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE cases;         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_logs;     EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE recalls;       EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE appointments;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE audit_logs;    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 完了。既存データは保持されます。

-- ============================================================
-- RST CRM Supabase スキーマ（実運用版）
-- Supabase SQL Editor に貼り付けて実行してください。
-- 既存環境にも安全に再実行できるよう、すべて IF NOT EXISTS / 例外無視で記述。
-- ============================================================

-- ============================================================
-- 0. マルチテナント（組織 / プロフィール）
--    将来複数会社で使えるよう organization_id を各テーブルに保持。
--    既存データ互換のため nullable（NULL = デフォルト組織）。
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- auth.users と 1:1 のプロフィール（表示名・所属組織・権限）
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  organization_id UUID REFERENCES organizations(id),
  role TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 1. 案件
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
-- 既存テーブルへの追加列（再実行安全）
ALTER TABLE cases ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS assigned_to UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE cases ADD COLUMN IF NOT EXISTS priority TEXT;

-- ============================================================
-- 2. 訪問予定
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
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS organization_id UUID;

-- ============================================================
-- 3. 再コール予定
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

-- ============================================================
-- 4. コール履歴（ステータス変更履歴も保持）
-- ============================================================
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  call_at TIMESTAMPTZ NOT NULL,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('接触','非接触')),
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
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS prev_status TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS next_status TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS next_recall_at TIMESTAMPTZ;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS sales_rep TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS organization_id UUID;

-- ============================================================
-- 5. スマホ連動セッション
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

-- ============================================================
-- 6. CSV取込バッチ履歴
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
-- 7. テンプレート（通話メモ等）
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

-- ============================================================
-- 8. 監査ログ（重要操作の記録）
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,          -- create / update / delete / status_change / import / bulk / recall_done ...
  entity TEXT NOT NULL,          -- case / call_log / recall / import / user ...
  entity_id UUID,
  entity_name TEXT,
  detail TEXT,
  actor_id UUID REFERENCES auth.users(id),
  actor_name TEXT,
  organization_id UUID,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- updated_date 自動更新トリガー
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

-- ============================================================
-- 新規ユーザー作成時に profiles を自動生成
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

-- ============================================================
-- インデックス
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_cases_sales_rep ON cases(sales_rep);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_created_date ON cases(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_cases_org ON cases(organization_id);
CREATE INDEX IF NOT EXISTS idx_appointments_appo_at ON appointments(appo_at);
CREATE INDEX IF NOT EXISTS idx_appointments_sales_rep ON appointments(sales_rep);
CREATE INDEX IF NOT EXISTS idx_recalls_target_at ON recalls(target_at);
CREATE INDEX IF NOT EXISTS idx_recalls_done ON recalls(done);
CREATE INDEX IF NOT EXISTS idx_call_logs_case_id ON call_logs(case_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_call_at ON call_logs(call_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_session_key ON call_sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_import_batches_created ON import_batches(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);

-- ============================================================
-- Realtime 有効化（既に追加済みの場合はエラーを無視）
-- ============================================================
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_sessions; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE cases; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_logs; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE recalls; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE appointments; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- RLS ポリシー案（本番運用時に有効化）
-- ------------------------------------------------------------
-- 開発中は RLS 無効のままでも動作します。本番では以下を有効化し、
-- 「ログイン済みユーザーのみ全データ操作可」を最低ラインとして適用してください。
-- 組織単位で分離する場合は USING 句を organization_id ベースに変更します。
-- ============================================================
--
-- ALTER TABLE cases          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE appointments   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE recalls        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE call_logs      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE templates      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE profiles       ENABLE ROW LEVEL SECURITY;
--
-- -- (A) シンプル版：ログイン済みユーザーは全操作可
-- CREATE POLICY "authenticated full access" ON cases
--   FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- -- 他テーブルも同様に作成（cases を appointments/recalls/call_logs/templates に置換）
--
-- -- call_sessions はスマホ側が匿名(anon)で読むため別ポリシー
-- ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "session anon access" ON call_sessions
--   FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
--
-- -- profiles：本人のみ参照・更新
-- CREATE POLICY "own profile" ON profiles
--   FOR ALL TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
--
-- -- (B) 組織分離版（profiles.organization_id を基準に同一組織のみ）
-- -- CREATE POLICY "same org" ON cases FOR ALL TO authenticated
-- --   USING (organization_id IS NULL OR organization_id = (
-- --     SELECT organization_id FROM profiles WHERE id = auth.uid()))
-- --   WITH CHECK (true);

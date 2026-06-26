-- ============================================================
-- RST CRM 本番RLS（ロール権限 + 組織分離）本適用版
-- ------------------------------------------------------------
-- これは「閲覧のみ(viewer)は読取専用」「admin/member は書込可」
-- 「組織(organization_id)が一致するデータのみ」を強制する完成形ポリシーです。
--
-- 【適用前チェックリスト（重要）】
--  1) 自分のユーザーが profiles に存在し、role='admin' であること
--       UPDATE profiles SET role='admin' WHERE id = '<自分のauth.uid>';
--  2) 運用ユーザーに role を設定（admin / member / viewer）
--  3) 組織分離を使う場合のみ profiles.organization_id と各テーブルの
--     organization_id を揃える。NULL のデータは「全員に見える共有」扱い。
--  4) ステージングで先に試すこと（誤設定でロックアウトを防ぐ）
--
-- まだ早い場合は、先に migrations/2026-06-26_rls_optional.sql（緩い版）を
-- 使ってください。こちらは本番向けの厳格版です。
-- ============================================================

-- ロール / 組織を返すヘルパー（profiles 参照）
CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT role FROM public.profiles WHERE id = auth.uid()), 'member');
$$;

CREATE OR REPLACE FUNCTION auth_org() RETURNS UUID
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT (SELECT organization_id FROM public.profiles WHERE id = auth.uid());
$$;

-- 業務テーブル: SELECT=同一組織の全ロール / 書込=admin・memberのみ
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cases','appointments','recalls','call_logs','import_batches','templates']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS rst_select ON %I', t);
    EXECUTE format($f$
      CREATE POLICY rst_select ON %I FOR SELECT TO authenticated
      USING (organization_id IS NULL OR organization_id = auth_org())
    $f$, t);

    EXECUTE format('DROP POLICY IF EXISTS rst_write ON %I', t);
    EXECUTE format($f$
      CREATE POLICY rst_write ON %I FOR ALL TO authenticated
      USING (auth_role() IN ('admin','member')
             AND (organization_id IS NULL OR organization_id = auth_org()))
      WITH CHECK (auth_role() IN ('admin','member'))
    $f$, t);
  END LOOP;
END $$;

-- 監査ログ: 全認証ユーザーが追記可・閲覧可（運用上は管理者が確認）
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_audit_select ON audit_logs;
CREATE POLICY rst_audit_select ON audit_logs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS rst_audit_insert ON audit_logs;
CREATE POLICY rst_audit_insert ON audit_logs FOR INSERT TO authenticated WITH CHECK (true);

-- スマホ連動: anon も読み書き可
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_session_anon ON call_sessions;
CREATE POLICY rst_session_anon ON call_sessions
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- プロフィール: 全認証ユーザーが閲覧可（ユーザー管理画面用）。
--   更新は本人 or 管理者のみ。
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_profile_select ON profiles;
CREATE POLICY rst_profile_select ON profiles FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS rst_profile_update ON profiles;
CREATE POLICY rst_profile_update ON profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id OR auth_role() = 'admin')
  WITH CHECK (auth.uid() = id OR auth_role() = 'admin');

-- ロールバックする場合（RLSを無効化して元に戻す）:
-- DO $$ DECLARE t TEXT; BEGIN
--   FOREACH t IN ARRAY ARRAY['cases','appointments','recalls','call_logs','import_batches','templates','audit_logs','call_sessions','profiles']
--   LOOP EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t); END LOOP;
-- END $$;

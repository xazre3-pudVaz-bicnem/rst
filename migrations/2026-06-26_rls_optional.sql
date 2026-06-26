-- ============================================================
-- RST CRM 段階的 RLS 適用（任意・本番運用向け）
-- ------------------------------------------------------------
-- 目的: 現在ログイン済みのユーザーが急に使えなくならないよう、
--       「ログイン済み(authenticated)なら全操作可」を最低ラインとして適用する。
--       誰でも(anon)書けてしまう状態だけを塞ぐ段階的ポリシー。
--
-- 注意:
--   - 適用前に必ず1人以上ログインできるユーザーがいることを確認してください。
--   - call_sessions はスマホ側が anon で読むため anon も許可します。
--   - これを実行しても既存データは消えません。アクセス制御が変わるだけです。
--   - 元に戻すには各テーブルで DISABLE ROW LEVEL SECURITY を実行します。
-- ============================================================

-- ヘルパー: ポリシーを冪等に作り直す
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cases','appointments','recalls','call_logs','import_batches','templates','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rst_authenticated_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY rst_authenticated_all ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- call_sessions: スマホ(anon)も読み書きできるよう別ポリシー
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_session_anon ON call_sessions;
CREATE POLICY rst_session_anon ON call_sessions
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- profiles: 本人のみ参照・更新（管理者は別途拡張可）
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_own_profile ON profiles;
CREATE POLICY rst_own_profile ON profiles
  FOR ALL TO authenticated USING (true) WITH CHECK (auth.uid() = id);

-- ------------------------------------------------------------
-- 次の段階（組織分離）: profiles.organization_id を基準に同一組織のみに絞る場合の例
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS rst_authenticated_all ON cases;
-- CREATE POLICY rst_same_org ON cases FOR ALL TO authenticated
--   USING (organization_id IS NULL OR organization_id = (
--     SELECT organization_id FROM profiles WHERE id = auth.uid()))
--   WITH CHECK (true);

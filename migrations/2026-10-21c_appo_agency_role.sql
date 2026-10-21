-- ============================================================
-- アポ代行会社（role='appo'）の権限をデータベース側で縛る。
--
--   画面で隠すだけでは不十分。社外の会社にログインを渡すため、
--   ブラウザの開発者ツールやAPI直叩きで全リスト・給与・マイナンバーまで
--   読めてしまう状態を、RLS（行レベルセキュリティ）で塞ぐ。
--
--   アポ代行にできること:
--     - 訪問予定（appointments）… 全員の予定を見る（予定共有）＋自分の予定の追加/編集/削除
--     - 案件（cases）           … 新規登録と、自分が登録した案件の閲覧/編集のみ
--     - 担当者名（profiles）    … 読むだけ（訪問予定の担当プルダウン用）
--     - 監査ログ（audit_logs）  … 書き込みのみ（何を登録したかを残す。読めない）
--   それ以外のテーブル（コール履歴・成約/歩合・労務・給与・マイナンバー・
--   AI投入リスト等）は一切アクセスできない。
--
--   注意: cases / appointments / call_logs / recalls は RLS が無効のままで、
--   ポリシーがあっても効いていなかった。ここで有効化する。
--   このうち cases / call_logs / recalls は未ログインのスマホ連動画面
--   （/mobile-call）が anon で書き込むため、anon の権限は今までどおり残す。
-- 冪等: 何度流しても同じ結果。
-- ============================================================

-- ログイン中のユーザーがアポ代行かどうか。
-- SECURITY DEFINER にしないと profiles 自身のRLSを再帰的に評価してしまう。
CREATE OR REPLACE FUNCTION public.rst_is_appo() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT role = 'appo' FROM profiles WHERE id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION public.rst_is_appo() FROM public;
GRANT EXECUTE ON FUNCTION public.rst_is_appo() TO anon, authenticated;

-- ---- ポリシーが効いていなかった4テーブルのRLSを有効化 ----
ALTER TABLE cases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE recalls      ENABLE ROW LEVEL SECURITY;

-- スマホ連動（未ログイン）が書き込む3テーブルは anon の権限を今までどおり残す
ALTER POLICY rst_all_authenticated ON cases     TO anon, authenticated;
ALTER POLICY rst_all_authenticated ON call_logs TO anon, authenticated;
ALTER POLICY rst_all_authenticated ON recalls   TO anon, authenticated;

-- ---- 既存の「全員フルアクセス」ポリシーを “アポ代行以外” に限定 ----
--   qual が true のポリシーだけを対象にする（既に絞ってあるものには触れない＝冪等）。
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND 'authenticated' = ANY (string_to_array(trim(both '{}' FROM roles::text), ','))
      AND qual = 'true'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.%I USING (NOT public.rst_is_appo())', p.policyname, p.tablename);
    IF p.with_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (NOT public.rst_is_appo())', p.policyname, p.tablename);
    END IF;
  END LOOP;
END $$;

-- ---- ここからアポ代行に許可する分だけを足す ----

-- 案件: 新規登録と、自分が登録した案件だけ
DROP POLICY IF EXISTS cases_appo_select ON cases;
CREATE POLICY cases_appo_select ON cases FOR SELECT TO authenticated
  USING (public.rst_is_appo() AND created_by_id = auth.uid());
DROP POLICY IF EXISTS cases_appo_insert ON cases;
CREATE POLICY cases_appo_insert ON cases FOR INSERT TO authenticated
  WITH CHECK (public.rst_is_appo() AND created_by_id = auth.uid());
DROP POLICY IF EXISTS cases_appo_update ON cases;
CREATE POLICY cases_appo_update ON cases FOR UPDATE TO authenticated
  USING (public.rst_is_appo() AND created_by_id = auth.uid())
  WITH CHECK (created_by_id = auth.uid());

-- 訪問予定: 予定共有のため全員ぶんを見られる。書けるのは自分が入れた予定だけ
DROP POLICY IF EXISTS appointments_appo_select ON appointments;
CREATE POLICY appointments_appo_select ON appointments FOR SELECT TO authenticated
  USING (public.rst_is_appo());
DROP POLICY IF EXISTS appointments_appo_insert ON appointments;
CREATE POLICY appointments_appo_insert ON appointments FOR INSERT TO authenticated
  WITH CHECK (public.rst_is_appo() AND created_by_id = auth.uid());
DROP POLICY IF EXISTS appointments_appo_update ON appointments;
CREATE POLICY appointments_appo_update ON appointments FOR UPDATE TO authenticated
  USING (public.rst_is_appo() AND created_by_id = auth.uid())
  WITH CHECK (created_by_id = auth.uid());
DROP POLICY IF EXISTS appointments_appo_delete ON appointments;
CREATE POLICY appointments_appo_delete ON appointments FOR DELETE TO authenticated
  USING (public.rst_is_appo() AND created_by_id = auth.uid());

-- 担当者名: 訪問予定の担当プルダウンと自分のロール判定に必要。読むだけ
DROP POLICY IF EXISTS profiles_appo_select ON profiles;
CREATE POLICY profiles_appo_select ON profiles FOR SELECT TO authenticated
  USING (public.rst_is_appo());

-- 監査ログ: 何を登録したかを残すため書き込みのみ許可（読み出しは不可）
DROP POLICY IF EXISTS audit_logs_appo_insert ON audit_logs;
CREATE POLICY audit_logs_appo_insert ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (public.rst_is_appo());

-- ---- RLSが無効のまま残っていた内部テーブルも閉じる ----
--   auto_crawl_lock / discovery_seen_urls はサーバー（service_role）しか触らないので
--   ポリシー無し＝ログインユーザーからは読めない状態にする。
--   import_batches は画面からも使うため、上で絞ったポリシーがそのまま効く。
ALTER TABLE auto_crawl_lock      ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_seen_urls  ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches       ENABLE ROW LEVEL SECURITY;

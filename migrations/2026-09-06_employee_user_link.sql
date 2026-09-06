-- ============================================================
-- 従業員とユーザー(profiles/auth.users)の紐付けを一意にする。
--   営業担当（ユーザー）は全員 employees に自動同期するため、同じユーザーの
--   従業員レコードが二重作成されると勤怠・給与が重複する。user_id で一意にして防ぐ。
--   user_id が無い従業員（ユーザーアカウント未発行の人）は対象外＝複数行を許す。
-- 冪等: IF NOT EXISTS。
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_user_id
  ON employees(user_id) WHERE user_id IS NOT NULL;

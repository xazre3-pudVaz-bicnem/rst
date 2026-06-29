-- ============================================================
-- RST CRM: 案件のリスト作成者名を保持（営業担当 sales_rep とは別管理）
-- 冪等・再実行安全。npm run db:apply -- migrations/2026-06-29_case_creator.sql で適用。
-- ============================================================
ALTER TABLE cases ADD COLUMN IF NOT EXISTS created_by_name TEXT;

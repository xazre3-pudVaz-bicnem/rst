-- ============================================================
-- RST CRM: 営業時間（business_hours）カラム追加
-- AI投入リストで営業時間が判明した案件に表示する。
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE cases ADD COLUMN IF NOT EXISTS business_hours TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS business_hours TEXT;

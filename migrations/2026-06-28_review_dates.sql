-- ============================================================
-- RST CRM AI投入リスト: 口コミ投稿日(publishTime)による新規判定フィールド追加
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル・既存RLSは変更しません（列の追加のみ）。
-- 新店判定は「取得できた口コミの中で一番古い投稿日(oldest)が30日以内か」を重視。
-- ============================================================

ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS latest_review_publish_time TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS oldest_review_publish_time TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS latest_review_days_ago INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS oldest_review_days_ago INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS oldest_review_is_recent BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS review_dates_checked BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS review_newness_reason TEXT;

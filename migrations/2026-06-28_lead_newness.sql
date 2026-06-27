-- ============================================================
-- RST CRM AI投入リスト: 新規店舗の複合判定フィールド追加
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル・既存RLSは変更しません（列の追加のみ）。
-- 前提: 先に lead_candidates / google_places のマイグレーションを適用済み。
-- ============================================================

ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS is_new_opening_candidate BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS newness_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS days_since_first_seen INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS from_new_open_query BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_lead_candidates_newcand ON lead_candidates(is_new_opening_candidate);

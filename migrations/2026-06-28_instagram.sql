-- ============================================================
-- RST CRM: Instagram新店リスト（ハッシュタグ検索→AI抽出→Places照合は任意）
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル・既存RLSは変更しません（列/テーブルの追加のみ）。
-- ============================================================

-- lead_candidates に Instagram 由来カラムを追加
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS lead_source TEXT;                  -- 'google_places' | 'instagram_hashtag'
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_media_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_permalink TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_caption TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_timestamp TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_account_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_hashtag TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_shop_name TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_area TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_industry TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_phone TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS matched_google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS match_confidence INTEGER;          -- 0-100
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_newness_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS ig_classification TEXT;             -- 'google_match_hot'|'ig_only_hot'|'hold'|'excluded'
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS gbp_unregistered_candidate BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS ig_phone_reachable_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS ig_newness_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS ig_auto_importable BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_lead_candidates_lead_source ON lead_candidates(lead_source);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_candidates_ig_media ON lead_candidates(instagram_media_id) WHERE instagram_media_id IS NOT NULL;

-- ハッシュタグ検索のローテーション履歴（IGは7日で30ユニークtagまで）
CREATE TABLE IF NOT EXISTS ig_hashtag_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hashtag TEXT NOT NULL UNIQUE,
  hashtag_id TEXT,
  last_searched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  searches INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ig_hashtag_log_last ON ig_hashtag_log(last_searched_at);

ALTER TABLE ig_hashtag_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON ig_hashtag_log;
CREATE POLICY rst_all_authenticated ON ig_hashtag_log
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

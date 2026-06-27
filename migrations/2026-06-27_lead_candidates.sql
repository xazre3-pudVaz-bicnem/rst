-- ============================================================
-- RST CRM AI投入リスト（lead_candidates）
-- Supabase SQL Editor にそのまま貼り付けて実行。冪等・再実行安全。
-- 既存テーブル(cases等)・既存RLSは変更しません。新テーブルのみ追加します。
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  industry TEXT,
  -- 連絡先
  phone_number TEXT,
  phone_normalized TEXT,
  website_url TEXT,
  instagram_url TEXT,
  place_id TEXT,
  -- 取得元 / 検出時刻
  source_type TEXT DEFAULT 'AI自動投入',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 新規シグナル
  is_new_gbp BOOLEAN NOT NULL DEFAULT false,
  is_new_instagram BOOLEAN NOT NULL DEFAULT false,
  is_new_website BOOLEAN NOT NULL DEFAULT false,
  is_new_ad_listing BOOLEAN NOT NULL DEFAULT false,
  is_new_corporation BOOLEAN NOT NULL DEFAULT false,
  detected_signals TEXT[],
  -- 営業対象外（チェーン/大型施設内/支店）判定
  is_chain_store BOOLEAN NOT NULL DEFAULT false,
  is_large_franchise BOOLEAN NOT NULL DEFAULT false,
  is_in_shopping_mall BOOLEAN NOT NULL DEFAULT false,
  is_in_station_building BOOLEAN NOT NULL DEFAULT false,
  is_large_company_branch BOOLEAN NOT NULL DEFAULT false,
  owner_reachability_score INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  should_exclude_from_call_list BOOLEAN NOT NULL DEFAULT false,
  -- 判定結果
  auto_import_reason TEXT,
  ai_comment TEXT,
  lead_temperature TEXT NOT NULL DEFAULT 'HOLD',  -- HOT / WARM / HOLD / EXCLUDED
  -- 投入状態
  imported_to_cases BOOLEAN NOT NULL DEFAULT false,
  imported_at TIMESTAMPTZ,
  duplicate_of_case_id UUID,
  -- 共通
  organization_id UUID,
  created_by_id UUID REFERENCES auth.users(id),
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 既存環境への追加列（再実行安全）
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS detected_signals TEXT[];
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS exclusion_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS duplicate_of_case_id UUID;

-- インデックス
CREATE INDEX IF NOT EXISTS idx_lead_candidates_phone ON lead_candidates(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_lead_candidates_temp ON lead_candidates(lead_temperature);
CREATE INDEX IF NOT EXISTS idx_lead_candidates_created ON lead_candidates(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_lead_candidates_imported ON lead_candidates(imported_to_cases);

-- updated_date 自動更新（update_updated_date は schema.sql で作成済み。無い場合に備え定義）
CREATE OR REPLACE FUNCTION update_updated_date()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_date = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_lead_candidates_updated ON lead_candidates;
CREATE TRIGGER trg_lead_candidates_updated BEFORE UPDATE ON lead_candidates
  FOR EACH ROW EXECUTE FUNCTION update_updated_date();

-- RLS（既存と同じ「認証済みは全操作可」。厳しくしません）
ALTER TABLE lead_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON lead_candidates;
CREATE POLICY rst_all_authenticated ON lead_candidates
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Realtime（任意・重複は握りつぶす）
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE lead_candidates; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

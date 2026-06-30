-- ============================================================
-- RST CRM: 地域メディア巡回にも外部情報補完を追加（IWと共通の補完カラム＋記事由来カラム）
-- 冪等。npm run db:apply で適用。enrichment_* の多くはIW移行で作成済み。
-- ============================================================
-- 補完（IWと共通。未作成なら作成）
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_sources JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_phone TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_prefecture TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_city TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_instagram_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;
-- 記事由来（元情報と補完情報を区別）
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_article_excerpt TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_media_family TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_shop_name_from_article TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_area_from_article TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date_from_article TEXT;

-- 補完検索クエリ履歴（IWと共通テーブルを使用。未作成なら作成）
CREATE TABLE IF NOT EXISTS ig_enrich_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL UNIQUE,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  runs INTEGER NOT NULL DEFAULT 0,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ig_enrich_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON ig_enrich_log;
CREATE POLICY rst_all_authenticated ON ig_enrich_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

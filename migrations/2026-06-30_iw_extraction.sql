-- Instagram Web検索の抽出精度（店名/補完元/地域矛盾）
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_post_title TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS shop_name_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_rejected JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_region_conflict BOOLEAN;

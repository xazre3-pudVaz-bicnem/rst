-- 詳細ページ取得の汎用設定（全カード型サイト共通）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS detail_fetch_enabled BOOLEAN DEFAULT true;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS detail_rendering_mode TEXT DEFAULT 'auto';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS detail_link_selector TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS detail_click_selector TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS card_selector TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS click_required BOOLEAN DEFAULT false;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS detail_parser_type TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS max_detail_pages_per_run INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS detail_timeout_ms INTEGER;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_detail_fetch_result TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_detail_fetch_error TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS phone_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS detail_rendering_mode TEXT;
-- HORBY: クリック遷移必須・詳細はbrowserレンダリング
UPDATE source_sites SET detail_fetch_enabled=true, detail_rendering_mode='browser', detail_parser_type='horby_detail', click_required=true, card_selector='.new_salon_list .new_salon_item', detail_click_selector='a', max_detail_pages_per_run=2, updated_at=now()
WHERE (name ILIKE '%HORBY%' OR base_url ILIKE '%u-word.com%') AND source_type='sequential_id_probe' IS NOT TRUE;
-- まいぷれ: 詳細auto・href辿り
UPDATE source_sites SET detail_fetch_enabled=true, detail_rendering_mode='auto', detail_parser_type='mypl_detail', click_required=false, updated_at=now()
WHERE name ILIKE '%まいぷれ%' OR base_url ILIKE '%mypl.net%';
-- 食べログ系（地域メディア側）: 詳細auto
UPDATE source_sites SET detail_fetch_enabled=true, detail_rendering_mode='auto', detail_parser_type='tabelog_detail', click_required=false, updated_at=now()
WHERE (name ILIKE '%食べログ%' OR base_url ILIKE '%tabelog.com%') AND source_type='marketplace_listing';

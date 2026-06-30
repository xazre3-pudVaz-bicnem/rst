-- 巡回サイト自動発見の候補テーブル
CREATE TABLE IF NOT EXISTS source_site_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_url TEXT, normalized_url TEXT UNIQUE, domain TEXT, title TEXT, snippet TEXT,
  source_discovery_query TEXT, detected_source_type TEXT, detected_parser_type TEXT, detected_media_family TEXT,
  confidence_score INTEGER, test_fetch_status TEXT, test_http_status INTEGER, html_length INTEGER, text_length INTEGER,
  article_link_count INTEGER, shop_card_count INTEGER, newness_keyword_count INTEGER, phone_found_count INTEGER, address_found_count INTEGER,
  sample_candidates JSONB, valid_page_pattern_found BOOLEAN, invalid_reason TEXT, already_registered BOOLEAN DEFAULT false,
  recommended_action TEXT, is_registered BOOLEAN DEFAULT false, registered_source_site_id UUID,
  first_discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_tested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE source_site_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON source_site_candidates;
CREATE POLICY rst_all_authenticated ON source_site_candidates FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS created_by TEXT;

-- ============================================================
-- RST CRM: マーケットプレイス/汎用カード型パーサー用カラム
-- 冪等。npm run db:apply で適用。
-- ============================================================
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS parser_used TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_list_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS candidate_block_text_short TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS detail_fetch_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS matched_keywords TEXT[];

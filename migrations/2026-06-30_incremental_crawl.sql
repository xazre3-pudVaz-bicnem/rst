-- 地域メディア/ポータルの差分巡回カーソル
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS latest_item_url TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS latest_item_published_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_seen_article_url TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_seen_article_title TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_seen_article_date TIMESTAMPTZ;
-- 店舗カード型
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_seen_shop_url TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_seen_shop_name TEXT;
-- 連番URL探索の差分カーソル（last_valid_id / current_probe_id / last_checked_id は既存）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS next_start_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS invalid_ranges JSONB;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS retry_ids JSONB;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS fetch_failed_ids JSONB;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS parser_failed_ids JSONB;
-- 差分巡回の直近統計（UI表示用）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_new_count INTEGER;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_seen_skipped INTEGER;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_old_skipped INTEGER;

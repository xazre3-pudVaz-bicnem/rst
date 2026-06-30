-- 連番探索ソースの一意キー・地域ラベル（同一ドメイン地域別を別ソースに）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS normalized_url_template TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS region_label TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS prefecture TEXT;
-- 既存の連番ソースに normalized_url_template / source_key を埋める（base_urlは変更しない）
UPDATE source_sites
SET normalized_url_template = regexp_replace(regexp_replace(url_template, '\{ID\}', '', 'g'), '/+$', ''),
    source_key = regexp_replace(regexp_replace(url_template, '\{ID\}', '', 'g'), '/+$', '') || '|' || COALESCE(parser_type, 'generic_detail_page')
WHERE source_type = 'sequential_id_probe' AND url_template IS NOT NULL AND (normalized_url_template IS NULL OR normalized_url_template = '');

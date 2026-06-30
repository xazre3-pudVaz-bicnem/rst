-- JSレンダリング対応: rendering_mode（static/auto/browser・既定auto）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS rendering_mode TEXT DEFAULT 'auto';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS needs_improvement BOOLEAN DEFAULT false;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS improvement_hint TEXT;
-- HORBYを /horby（新規加盟店舗）に統一。旧 h-word.com の検索結果URLは無効化（重複回避）
UPDATE source_sites SET base_url='https://u-word.com/horby', list_url='https://u-word.com/horby', parser_type='horby_new_salon', source_type='marketplace_listing', rendering_mode='browser', category_label='新規加盟店舗', reliability_score=70, is_active=true, review_flag=false, disabled_reason=NULL, name='HORBY 新規加盟店舗', updated_at=now()
WHERE name ILIKE '%HORBY%' AND base_url ILIKE '%h-word.com%';
UPDATE source_sites SET is_active=false, disabled_by='admin', disabled_reason='HORBYは /horby（u-word.com）に統合', updated_at=now()
WHERE base_url ILIKE '%h-word.com%' AND base_url NOT ILIKE '%u-word.com%' AND name NOT ILIKE '%新規加盟店舗%';

-- 連番URL探索ソースの無効理由・要確認フラグ（自動無効化はせず要確認に留める）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS disabled_by TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_error_type TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_error_message TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS review_flag BOOLEAN DEFAULT false;
-- 勝手に無効化されていた連番ソースを有効に戻す（管理者が明示的に無効化していないもの）
UPDATE source_sites SET is_active = true, review_flag = false, disabled_reason = NULL, disabled_at = NULL, disabled_by = NULL, updated_at = now()
WHERE source_type = 'sequential_id_probe' AND is_active = false AND (disabled_by IS NULL OR disabled_by <> 'admin');

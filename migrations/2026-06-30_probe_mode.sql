-- 連番探索: モード（安全確認/先行）＋同一ID再確認制御
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_mode TEXT DEFAULT 'safe';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS same_id_retry_limit INTEGER DEFAULT 3;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS invalid_retry_interval_hours INTEGER DEFAULT 24;

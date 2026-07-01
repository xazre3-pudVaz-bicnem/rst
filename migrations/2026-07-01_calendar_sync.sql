-- 訪問予定→Googleカレンダー反映（TimeRexが連携カレンダーを見て空き枠を埋める）
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_synced_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_sync_error TEXT;

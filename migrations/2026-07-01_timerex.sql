-- TimeRex連携: アポ代行会社に「こちらの空き日程」を共有するためのURL管理（複数URL対応）
CREATE TABLE IF NOT EXISTS timerex_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  name TEXT NOT NULL,                        -- 表示名（例: 織田 訪問可能日程）
  timerex_schedule_url TEXT,                 -- TimeRex 日程調整URL
  memo TEXT,                                 -- 補足メモ
  is_enabled BOOLEAN NOT NULL DEFAULT false, -- 有効/無効（URL登録後にON）
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_by UUID
);
CREATE INDEX IF NOT EXISTS idx_timerex_enabled ON timerex_settings(is_enabled, sort_order);
ALTER TABLE timerex_settings ENABLE ROW LEVEL SECURITY;
-- 既存方針に合わせ authenticated 全許可（登録/編集/削除の管理者制限はアプリ側で担保）
DO $$ BEGIN
  CREATE POLICY rst_authenticated_all ON timerex_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

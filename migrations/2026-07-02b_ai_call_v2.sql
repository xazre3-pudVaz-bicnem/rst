-- ============================================================
-- AIテレアポ v2: 次回架電予定日＋一覧表示用の温度感/次回アクションを cases に持たせる（denormalize）。
-- 既存機能は変更しない（列追加のみ・冪等）。
-- ============================================================
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_ai_call_at TIMESTAMPTZ;        -- 次回架電予定日（不在/担当者不在/再架電で設定）
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ai_call_temperature TEXT;           -- 最新架電の温度感（高/中/低）
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ai_call_next_action TEXT;           -- 最新架電の次回アクション
CREATE INDEX IF NOT EXISTS idx_cases_next_ai_call ON cases(next_ai_call_at) WHERE next_ai_call_at IS NOT NULL;

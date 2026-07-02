-- ============================================================
-- リアルタイム音声AI会話（Twilio Media Streams × OpenAI Realtime）用の列追加。
-- 既存の固定音声(fixed)フローは不変。列追加のみ・冪等。
-- ============================================================
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS call_mode TEXT DEFAULT 'fixed';   -- fixed / realtime
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS ai_contact_name TEXT;             -- AIが会話で取得した相手氏名
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS appo_at TIMESTAMPTZ;              -- AIが取得したアポ日時
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS calendar_result TEXT;             -- Googleカレンダー登録結果

-- ============================================================
-- 音声AI 第一段階: 通話録音・文字起こし・AI要約/温度感/推奨ステータスを ai_call_jobs に保持。
-- 列追加のみ（既存機能・データは不変・冪等）。
-- ============================================================
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS recording_url TEXT;              -- Twilio録音URL
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS recording_sid TEXT;              -- Twilio Recording SID
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS recording_duration_sec INTEGER; -- 録音秒数
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS recording_error TEXT;            -- 録音失敗理由
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS recommended_status TEXT;         -- AI推奨ステータス（興味あり等）
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS ai_reaction TEXT;                -- 相手の反応
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS ai_needs_recall BOOLEAN;         -- 再架電が必要か
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS ai_should_ng BOOLEAN;            -- NGにすべきか
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS ai_applied BOOLEAN DEFAULT false;-- AI判定を案件へ反映済みか
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS processing_status TEXT;          -- 未処理/処理中/完了/失敗/未設定
ALTER TABLE ai_call_jobs ADD COLUMN IF NOT EXISTS processing_error TEXT;           -- 文字起こし/要約の失敗理由

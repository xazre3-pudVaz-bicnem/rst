-- ============================================================
-- 自動ダイヤラーの待機をブラウザ通話（ヘッドセット）に対応する。
--   rep_mode='browser' … パソコンのブラウザがカンファレンスに入る（通話料が携帯の約1/25）
--   rep_mode='phone'   … 従来どおり担当者のケータイを呼ぶ
-- ブラウザ待機では電話番号を使わないため rep_phone は任意にする。
-- 冪等: IF NOT EXISTS / DROP NOT NULL は何度流しても同じ。
-- ============================================================
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS rep_mode TEXT NOT NULL DEFAULT 'phone';
ALTER TABLE dialer_sessions ALTER COLUMN rep_phone DROP NOT NULL;

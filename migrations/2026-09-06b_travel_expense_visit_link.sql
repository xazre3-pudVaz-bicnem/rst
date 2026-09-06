-- ============================================================
-- 交通費を「訪問結果の登録」に紐付ける。
--   入力導線を 訪問予定 → 訪問結果を登録 に一本化したため、どの訪問で発生した交通費かを
--   visit_report_id で持つ。訪問結果を編集したときに同じ行を更新／削除できるようにする。
-- 冪等: IF NOT EXISTS。
-- ============================================================
ALTER TABLE travel_expenses ADD COLUMN IF NOT EXISTS visit_report_id UUID;  -- 紐付く訪問結果
ALTER TABLE travel_expenses ADD COLUMN IF NOT EXISTS appointment_id UUID;   -- 紐付く訪問予定（あれば）
CREATE INDEX IF NOT EXISTS idx_travel_exp_visit ON travel_expenses(visit_report_id);

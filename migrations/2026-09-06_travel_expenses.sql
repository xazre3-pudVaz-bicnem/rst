-- ============================================================
-- 案件ごとの交通費申請。
--   営業担当が案件（訪問先）単位で申請し、管理者は労務管理で担当者ごとに集計して精算する。
--   案件が削除されても経費記録は会計上残す必要があるため、案件名・担当者名は非正規化して保持する
--   （FKにしない＝既存テーブルの方針と同じ）。
-- 冪等: IF NOT EXISTS。
-- ============================================================
CREATE TABLE IF NOT EXISTS travel_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID,                                  -- 案件（任意。案件に紐づかない移動も登録できる）
  case_name TEXT,                                -- 表示用（申請時点の案件名）
  employee_id UUID,                              -- 従業員（労務側の集計キー）
  employee_name TEXT,                            -- 表示用（申請時点の氏名）
  user_id UUID,                                  -- 申請者のログインユーザー（自分の申請だけ見せる判定に使う）
  expense_date DATE NOT NULL,                    -- 発生日（集計の対象月はこの日付）
  transport_type TEXT,                           -- 電車/バス/タクシー/自家用車/高速道路/駐車場/その他
  departure TEXT,                                -- 出発地
  destination TEXT,                              -- 到着地
  round_trip BOOLEAN DEFAULT false,              -- 往復（金額は往復込みの実費を入れる）
  amount NUMERIC NOT NULL DEFAULT 0,             -- 金額（円）
  purpose TEXT,                                  -- 訪問目的
  memo TEXT,
  status TEXT DEFAULT '申請中',                   -- 申請中/承認済み/却下/精算済み
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_by_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_travel_exp_employee ON travel_expenses(employee_id);
CREATE INDEX IF NOT EXISTS idx_travel_exp_case ON travel_expenses(case_id);
CREATE INDEX IF NOT EXISTS idx_travel_exp_date ON travel_expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_travel_exp_status ON travel_expenses(status);

DROP TRIGGER IF EXISTS trg_travel_expenses_touch ON travel_expenses;
CREATE TRIGGER trg_travel_expenses_touch BEFORE UPDATE ON travel_expenses
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- RLS: 他の労務テーブルと同じ方針（認証済みは全操作可・画面側ロールで表示範囲を制御）
ALTER TABLE travel_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON travel_expenses;
CREATE POLICY rst_all_authenticated ON travel_expenses FOR ALL TO authenticated USING (true) WITH CHECK (true);

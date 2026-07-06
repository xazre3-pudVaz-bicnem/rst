-- ============================================================
-- RST CRM: 労務管理（勤怠・従業員・休暇・申請承認・シフト・給与連携・
--          労務書類・アラート・設定・監査ログ）土台テーブル一式。
-- 冪等・再実行安全。npm run db:apply -- migrations/2026-07-06_labor.sql で適用。
-- 既存の営業系テーブル（cases 等）には一切変更を加えません。
-- ============================================================

-- 共通: updated_at 自動更新トリガ関数（無ければ作成）
CREATE OR REPLACE FUNCTION rst_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. 従業員マスタ
-- ============================================================
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,                              -- auth.users / profiles との紐付け（任意）
  employee_code TEXT,
  name TEXT NOT NULL,
  name_kana TEXT,
  email TEXT,
  phone TEXT,
  employment_type TEXT DEFAULT '正社員',      -- 正社員/契約社員/アルバイト/パート/業務委託/役員
  department TEXT,
  position TEXT,
  role TEXT DEFAULT '従業員',                 -- 労務ロール（管理者/労務管理者/マネージャー/従業員/社労士/閲覧専用）
  hire_date DATE,
  resignation_date DATE,
  status TEXT DEFAULT '在籍中',               -- 在籍中/休職中/退職済み
  work_style TEXT DEFAULT '固定勤務',         -- 固定勤務/シフト制/フレックス/時短勤務/在宅勤務/直行直帰あり
  base_salary NUMERIC,
  hourly_wage NUMERIC,
  fixed_overtime_hours NUMERIC,
  fixed_overtime_pay NUMERIC,
  standard_work_start TEXT DEFAULT '09:00',
  standard_work_end TEXT DEFAULT '18:00',
  standard_break_minutes INTEGER DEFAULT 60,
  weekly_work_days INTEGER DEFAULT 5,
  closing_day INTEGER DEFAULT 31,            -- 締め日（末日=31 で表現）
  payment_day INTEGER DEFAULT 25,
  trial_period_end_date DATE,
  contract_start_date DATE,
  contract_end_date DATE,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  bank_name TEXT,
  branch_name TEXT,
  account_type TEXT,
  account_number TEXT,
  account_holder TEXT,
  social_insurance_status TEXT,
  employment_insurance_status TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_employees_user_id ON employees(user_id);
DROP TRIGGER IF EXISTS trg_employees_touch ON employees;
CREATE TRIGGER trg_employees_touch BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 2. 勤怠打刻
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  clock_in_at TIMESTAMPTZ,
  clock_out_at TIMESTAMPTZ,
  break_start_at TIMESTAMPTZ,
  break_end_at TIMESTAMPTZ,
  total_break_minutes INTEGER DEFAULT 0,
  work_minutes INTEGER DEFAULT 0,
  overtime_minutes INTEGER DEFAULT 0,
  late_night_minutes INTEGER DEFAULT 0,
  holiday_work_minutes INTEGER DEFAULT 0,
  status TEXT DEFAULT '未出勤',              -- 未出勤/出勤中/休憩中/退勤済/欠勤/休暇 等
  work_location_type TEXT DEFAULT 'office', -- office/remote/direct（直行直帰）
  clock_in_method TEXT,                      -- web/mobile/proxy(代理)/manual(修正)
  clock_out_method TEXT,
  clock_in_ip TEXT,
  clock_out_ip TEXT,
  clock_in_lat NUMERIC,
  clock_in_lng NUMERIC,
  clock_out_lat NUMERIC,
  clock_out_lng NUMERIC,
  is_late BOOLEAN DEFAULT false,
  is_early_leave BOOLEAN DEFAULT false,
  note TEXT,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_emp ON attendance_records(employee_id);
DROP TRIGGER IF EXISTS trg_attendance_touch ON attendance_records;
CREATE TRIGGER trg_attendance_touch BEFORE UPDATE ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 3. 勤怠集計（日次・月次）
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_daily_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  scheduled_minutes INTEGER DEFAULT 0,
  actual_work_minutes INTEGER DEFAULT 0,
  break_minutes INTEGER DEFAULT 0,
  overtime_minutes INTEGER DEFAULT 0,
  late_night_minutes INTEGER DEFAULT 0,
  holiday_work_minutes INTEGER DEFAULT 0,
  legal_holiday_work_minutes INTEGER DEFAULT 0,
  is_late BOOLEAN DEFAULT false,
  is_early_leave BOOLEAN DEFAULT false,
  is_absent BOOLEAN DEFAULT false,
  is_paid_leave BOOLEAN DEFAULT false,
  is_half_leave BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_att_daily_emp ON attendance_daily_summaries(employee_id);

CREATE TABLE IF NOT EXISTS attendance_monthly_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  target_month TEXT NOT NULL,                -- 'YYYY-MM'
  scheduled_minutes INTEGER DEFAULT 0,
  actual_work_minutes INTEGER DEFAULT 0,
  overtime_minutes INTEGER DEFAULT 0,
  late_night_minutes INTEGER DEFAULT 0,
  holiday_work_minutes INTEGER DEFAULT 0,
  legal_holiday_work_minutes INTEGER DEFAULT 0,
  late_count INTEGER DEFAULT 0,
  early_leave_count INTEGER DEFAULT 0,
  absent_days NUMERIC DEFAULT 0,
  paid_leave_days NUMERIC DEFAULT 0,
  is_closed BOOLEAN DEFAULT false,           -- 締め済みか
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, target_month)
);
CREATE INDEX IF NOT EXISTS idx_att_monthly_emp ON attendance_monthly_summaries(employee_id);
DROP TRIGGER IF EXISTS trg_att_monthly_touch ON attendance_monthly_summaries;
CREATE TRIGGER trg_att_monthly_touch BEFORE UPDATE ON attendance_monthly_summaries
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 4. シフト管理
-- ============================================================
CREATE TABLE IF NOT EXISTS work_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  shift_date DATE NOT NULL,
  planned_start_at TIMESTAMPTZ,
  planned_end_at TIMESTAMPTZ,
  planned_break_minutes INTEGER DEFAULT 60,
  shift_type TEXT DEFAULT '通常',           -- 通常/早番/遅番/夜勤/休み/希望
  status TEXT DEFAULT '確定',               -- 希望/申請中/確定/変更申請中
  note TEXT,
  created_by UUID,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, shift_date)
);
CREATE INDEX IF NOT EXISTS idx_shift_date ON work_shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_shift_emp ON work_shifts(employee_id);
DROP TRIGGER IF EXISTS trg_shift_touch ON work_shifts;
CREATE TRIGGER trg_shift_touch BEFORE UPDATE ON work_shifts
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 5. 有給・休暇管理
-- ============================================================
CREATE TABLE IF NOT EXISTS leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  paid_leave_granted_days NUMERIC DEFAULT 0,
  paid_leave_used_days NUMERIC DEFAULT 0,
  paid_leave_remaining_days NUMERIC DEFAULT 0,
  paid_leave_expire_date DATE,
  required_5days_used NUMERIC DEFAULT 0,     -- 年5日取得義務の消化日数
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, fiscal_year)
);
CREATE INDEX IF NOT EXISTS idx_leave_bal_emp ON leave_balances(employee_id);
DROP TRIGGER IF EXISTS trg_leave_bal_touch ON leave_balances;
CREATE TRIGGER trg_leave_bal_touch BEFORE UPDATE ON leave_balances
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

CREATE TABLE IF NOT EXISTS leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  leave_type TEXT DEFAULT '有給',           -- 有給/半休/時間休/欠勤/慶弔休暇/産休/育休/介護休暇/特別休暇
  start_date DATE,
  end_date DATE,
  days NUMERIC DEFAULT 0,
  hours NUMERIC DEFAULT 0,
  reason TEXT,
  status TEXT DEFAULT 'pending',            -- pending/approved/rejected/canceled
  requested_at TIMESTAMPTZ DEFAULT now(),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leave_req_emp ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_req_status ON leave_requests(status);
DROP TRIGGER IF EXISTS trg_leave_req_touch ON leave_requests;
CREATE TRIGGER trg_leave_req_touch BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 6. 申請承認ワークフロー
-- ============================================================
CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL,               -- 打刻修正/有給申請/残業申請/休日出勤申請/シフト変更/遅刻申請/早退申請/欠勤申請/交通費申請/経費申請/住所変更/銀行口座変更
  target_table TEXT,
  target_id UUID,
  title TEXT,
  reason TEXT,
  before_data JSONB,
  after_data JSONB,
  status TEXT DEFAULT 'pending',            -- pending/approved/rejected/canceled
  requested_at TIMESTAMPTZ DEFAULT now(),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_by UUID,
  rejected_at TIMESTAMPTZ,
  rejected_reason TEXT,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_emp ON approval_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_approval_type ON approval_requests(request_type);
DROP TRIGGER IF EXISTS trg_approval_touch ON approval_requests;
CREATE TRIGGER trg_approval_touch BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 7. 労務アラート
-- ============================================================
CREATE TABLE IF NOT EXISTS labor_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,                 -- 打刻漏れ/残業超過/週労働超過/休憩不足/連勤/深夜多/休日多/残業申請なし/勤怠未締め/退勤打刻忘れ/有給5日未取得/有給失効/契約更新/試用期間終了/労務書類未提出 等
  severity TEXT DEFAULT 'warning',          -- info/warning/critical
  title TEXT,
  message TEXT,
  target_date DATE,
  target_month TEXT,                         -- 'YYYY-MM'
  status TEXT DEFAULT 'open',               -- open/resolved/ignored
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_status ON labor_alerts(status);
CREATE INDEX IF NOT EXISTS idx_alert_emp ON labor_alerts(employee_id);
CREATE INDEX IF NOT EXISTS idx_alert_severity ON labor_alerts(severity);

-- ============================================================
-- 8. 労務書類管理
-- ============================================================
CREATE TABLE IF NOT EXISTS labor_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,              -- 雇用契約書/労働条件通知書/誓約書/秘密保持契約書/就業規則同意書/入社書類/退職書類/給与辞令/契約更新書類/身元保証書
  title TEXT,
  file_url TEXT,
  status TEXT DEFAULT '未提出',             -- 未提出/提出済み/確認済み/期限切れ/差戻し
  signed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  uploaded_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_emp ON labor_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_doc_status ON labor_documents(status);
DROP TRIGGER IF EXISTS trg_doc_touch ON labor_documents;
CREATE TRIGGER trg_doc_touch BEFORE UPDATE ON labor_documents
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 9. 労務設定（会社全体で1行運用を想定・複数可）
-- ============================================================
CREATE TABLE IF NOT EXISTS labor_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT DEFAULT '自社',
  standard_work_start TEXT DEFAULT '09:00',
  standard_work_end TEXT DEFAULT '18:00',
  standard_break_minutes INTEGER DEFAULT 60,
  scheduled_daily_minutes INTEGER DEFAULT 480,   -- 所定労働時間（分）
  holiday_weekdays JSONB DEFAULT '[0,6]'::jsonb, -- 0=日,6=土
  closing_day INTEGER DEFAULT 31,
  payment_day INTEGER DEFAULT 25,
  overtime_alert_monthly_hours INTEGER DEFAULT 45,
  overtime_alert_weekly_hours INTEGER DEFAULT 15,
  paid_leave_grant_rule TEXT DEFAULT '入社6ヶ月後10日',
  require_approval_attendance_edit BOOLEAN DEFAULT true,
  require_approval_leave BOOLEAN DEFAULT true,
  gps_clock_enabled BOOLEAN DEFAULT false,
  ip_restriction_enabled BOOLEAN DEFAULT false,
  csv_format TEXT DEFAULT 'generic',             -- generic/freee/moneyforward/yayoi
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_labor_settings_touch ON labor_settings;
CREATE TRIGGER trg_labor_settings_touch BEFORE UPDATE ON labor_settings
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 10. 労務監査ログ
-- ============================================================
CREATE TABLE IF NOT EXISTS labor_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor_name TEXT,
  employee_id UUID,
  action TEXT NOT NULL,                      -- 打刻/打刻修正/代理打刻/勤怠承認/休暇申請/休暇承認/従業員情報変更/給与情報変更/労務書類変更/CSV出力/権限変更 等
  target_table TEXT,
  target_id UUID,
  before_data JSONB,
  after_data JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_labor_audit_created ON labor_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labor_audit_emp ON labor_audit_logs(employee_id);

-- ============================================================
-- RLS: 開発用（認証済みユーザーは全操作可）。既存方針に合わせる。
-- 画面側ロールで表示範囲を制御する。将来 RLS を厳格化する場合はここを差し替え。
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employees','attendance_records','attendance_daily_summaries',
    'attendance_monthly_summaries','work_shifts','leave_balances',
    'leave_requests','approval_requests','labor_alerts','labor_documents',
    'labor_settings','labor_audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS rst_all_authenticated ON %I;', t);
    EXECUTE format(
      'CREATE POLICY rst_all_authenticated ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true);', t);
  END LOOP;
END $$;

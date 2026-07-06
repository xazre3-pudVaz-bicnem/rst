-- ============================================================
-- RST CRM 労務管理 拡張: 給与計算本体・年末調整・社会保険手続き・
--   マイナンバー管理・電子申請・社労士連携。
-- 冪等・再実行安全。npm run db:apply -- migrations/2026-07-06b_labor_advanced.sql
-- 前提: 2026-07-06_labor.sql（employees 等）適用済み。rst_touch_updated_at() を再利用。
-- ============================================================

CREATE OR REPLACE FUNCTION rst_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. 給与計算バッチ（月次の実行単位）
-- ============================================================
CREATE TABLE IF NOT EXISTS payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_month TEXT NOT NULL,                 -- 'YYYY-MM'
  title TEXT,
  status TEXT DEFAULT '下書き',               -- 下書き/計算済/確定/締め
  run_by UUID,
  run_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (target_month)
);
DROP TRIGGER IF EXISTS trg_payroll_runs_touch ON payroll_runs;
CREATE TRIGGER trg_payroll_runs_touch BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 2. 給与明細（従業員別・月別）
-- ============================================================
CREATE TABLE IF NOT EXISTS payslips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id UUID REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  target_month TEXT NOT NULL,
  -- 勤怠
  work_days NUMERIC DEFAULT 0,
  work_minutes INTEGER DEFAULT 0,
  overtime_minutes INTEGER DEFAULT 0,
  late_night_minutes INTEGER DEFAULT 0,
  holiday_work_minutes INTEGER DEFAULT 0,
  paid_leave_days NUMERIC DEFAULT 0,
  absent_days NUMERIC DEFAULT 0,
  -- 支給
  base_salary NUMERIC DEFAULT 0,
  overtime_pay NUMERIC DEFAULT 0,
  late_night_pay NUMERIC DEFAULT 0,
  holiday_pay NUMERIC DEFAULT 0,
  fixed_overtime_pay NUMERIC DEFAULT 0,
  commute_allowance NUMERIC DEFAULT 0,
  position_allowance NUMERIC DEFAULT 0,
  other_allowance NUMERIC DEFAULT 0,
  gross_pay NUMERIC DEFAULT 0,                 -- 総支給
  -- 控除
  health_insurance NUMERIC DEFAULT 0,          -- 健康保険
  long_term_care_insurance NUMERIC DEFAULT 0,  -- 介護保険(40歳以上)
  pension_insurance NUMERIC DEFAULT 0,         -- 厚生年金
  employment_insurance NUMERIC DEFAULT 0,      -- 雇用保険
  income_tax NUMERIC DEFAULT 0,                -- 所得税(源泉)
  resident_tax NUMERIC DEFAULT 0,              -- 住民税
  other_deduction NUMERIC DEFAULT 0,
  total_deduction NUMERIC DEFAULT 0,           -- 控除合計
  net_pay NUMERIC DEFAULT 0,                   -- 差引支給額
  status TEXT DEFAULT '未確定',                -- 未確定/確定
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, target_month)
);
CREATE INDEX IF NOT EXISTS idx_payslips_run ON payslips(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslips_emp ON payslips(employee_id);
CREATE INDEX IF NOT EXISTS idx_payslips_month ON payslips(target_month);
DROP TRIGGER IF EXISTS trg_payslips_touch ON payslips;
CREATE TRIGGER trg_payslips_touch BEFORE UPDATE ON payslips
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 3. 年末調整
-- ============================================================
CREATE TABLE IF NOT EXISTS year_end_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  total_income NUMERIC DEFAULT 0,               -- 給与総額
  total_withholding NUMERIC DEFAULT 0,          -- 源泉徴収税額(年間)
  social_insurance_deduction NUMERIC DEFAULT 0, -- 社会保険料控除
  life_insurance_deduction NUMERIC DEFAULT 0,   -- 生命保険料控除
  earthquake_insurance_deduction NUMERIC DEFAULT 0, -- 地震保険料控除
  spouse_deduction NUMERIC DEFAULT 0,           -- 配偶者(特別)控除
  dependent_deduction NUMERIC DEFAULT 0,        -- 扶養控除
  basic_deduction NUMERIC DEFAULT 480000,       -- 基礎控除
  housing_loan_deduction NUMERIC DEFAULT 0,     -- 住宅ローン控除
  taxable_income NUMERIC DEFAULT 0,             -- 課税所得
  calculated_tax NUMERIC DEFAULT 0,             -- 年調年税額
  settlement_amount NUMERIC DEFAULT 0,          -- 過不足額(+還付/-徴収)
  status TEXT DEFAULT '未着手',                 -- 未着手/書類回収中/計算済/完了
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, fiscal_year)
);
CREATE INDEX IF NOT EXISTS idx_yea_emp ON year_end_adjustments(employee_id);
DROP TRIGGER IF EXISTS trg_yea_touch ON year_end_adjustments;
CREATE TRIGGER trg_yea_touch BEFORE UPDATE ON year_end_adjustments
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 4. 社会保険手続き
-- ============================================================
CREATE TABLE IF NOT EXISTS social_insurance_procedures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  procedure_type TEXT NOT NULL,   -- 資格取得届/資格喪失届/算定基礎届/月額変更届/賞与支払届/被扶養者異動届/産前産後・育休関連
  status TEXT DEFAULT '未着手',   -- 未着手/準備中/提出済/受理/差戻し
  insurer TEXT,                    -- 協会けんぽ/健保組合/年金機構/ハローワーク
  target_date DATE,
  submitted_at TIMESTAMPTZ,
  reference_number TEXT,
  standard_monthly_wage NUMERIC,   -- 標準報酬月額(算定/月変で使用)
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sip_emp ON social_insurance_procedures(employee_id);
CREATE INDEX IF NOT EXISTS idx_sip_status ON social_insurance_procedures(status);
DROP TRIGGER IF EXISTS trg_sip_touch ON social_insurance_procedures;
CREATE TRIGGER trg_sip_touch BEFORE UPDATE ON social_insurance_procedures
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 5. マイナンバー管理（機密。番号本体は平文保存しない方針。
--    ここでは収集状況・マスク値・利用目的・保管情報のみ管理する）
-- ============================================================
CREATE TABLE IF NOT EXISTS my_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  holder_type TEXT DEFAULT '本人',       -- 本人/扶養家族
  holder_name TEXT,
  masked_number TEXT,                     -- 例: '****-****-1234'（下4桁のみ）
  collection_status TEXT DEFAULT '未収集', -- 未収集/収集済/確認済/廃棄済
  purpose TEXT,                           -- 利用目的（源泉徴収/社会保険 等）
  stored_location TEXT,                   -- 保管場所（金庫/暗号化ストレージ 等）
  collected_at DATE,
  disposed_at DATE,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mynum_emp ON my_numbers(employee_id);
DROP TRIGGER IF EXISTS trg_mynum_touch ON my_numbers;
CREATE TRIGGER trg_mynum_touch BEFORE UPDATE ON my_numbers
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 6. 電子申請（e-Gov / ハローワーク / 年金事務所）
-- ============================================================
CREATE TABLE IF NOT EXISTS e_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  application_type TEXT NOT NULL, -- 雇用保険資格取得/雇用保険資格喪失/離職票/健康保険資格取得/健康保険資格喪失/36協定届/算定基礎届 等
  status TEXT DEFAULT '下書き',   -- 下書き/申請準備/送信済/到達/審査中/完了/エラー
  submission_target TEXT,          -- e-Gov/ハローワーク/年金事務所/労働基準監督署
  reference_number TEXT,           -- 到達番号
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eapp_status ON e_applications(status);
CREATE INDEX IF NOT EXISTS idx_eapp_emp ON e_applications(employee_id);
DROP TRIGGER IF EXISTS trg_eapp_touch ON e_applications;
CREATE TRIGGER trg_eapp_touch BEFORE UPDATE ON e_applications
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- 7. 社労士連携（データ共有・相談・タスク依頼）
-- ============================================================
CREATE TABLE IF NOT EXISTS sharoshi_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  share_type TEXT DEFAULT '相談',  -- 勤怠データ/給与データ/入退社/社会保険/相談/その他
  status TEXT DEFAULT '依頼中',    -- 依頼中/対応中/完了/保留
  target_month TEXT,               -- 'YYYY-MM'
  assigned_to TEXT,                -- 社労士名/事務所名
  message TEXT,                    -- 依頼内容
  response TEXT,                   -- 社労士からの回答
  shared_by UUID,
  responded_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sharoshi_status ON sharoshi_shares(status);
DROP TRIGGER IF EXISTS trg_sharoshi_touch ON sharoshi_shares;
CREATE TRIGGER trg_sharoshi_touch BEFORE UPDATE ON sharoshi_shares
  FOR EACH ROW EXECUTE FUNCTION rst_touch_updated_at();

-- ============================================================
-- RLS: 開発用（認証済みユーザーは全操作可）。画面側ロールで表示範囲制御。
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payroll_runs','payslips','year_end_adjustments','social_insurance_procedures',
    'my_numbers','e_applications','sharoshi_shares'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS rst_all_authenticated ON %I;', t);
    EXECUTE format(
      'CREATE POLICY rst_all_authenticated ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true);', t);
  END LOOP;
END $$;

-- ============================================================
-- 月次KPI目標（コール/アポ/行動(訪問)/契約）。全体＝sales_rep=''、営業マン毎＝氏名。
-- 月ごと×担当ごとに1行。1日目標・ペース必要数は月間目標から画面側で算出する。
-- ============================================================
CREATE TABLE IF NOT EXISTS kpi_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month TEXT NOT NULL,                       -- 'YYYY-MM'
  sales_rep TEXT NOT NULL DEFAULT '',        -- '' = 全体、氏名 = 営業マン毎
  call_target INTEGER NOT NULL DEFAULT 0,    -- コール（架電）
  appo_target INTEGER NOT NULL DEFAULT 0,    -- アポ
  action_target INTEGER NOT NULL DEFAULT 0,  -- 行動（訪問実施）
  contract_target INTEGER NOT NULL DEFAULT 0,-- 契約（成約）
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (month, sales_rep)
);

ALTER TABLE kpi_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON kpi_targets;
CREATE POLICY rst_all_authenticated ON kpi_targets FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_kpi_targets_month ON kpi_targets(month);

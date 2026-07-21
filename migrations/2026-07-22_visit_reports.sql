-- ============================================================
-- 訪問結果（成約/失注）＋成約時の契約詳細（HP/保守管理/SEO/MEO・契約日・最低契約期間・支払方法）
-- ============================================================
CREATE TABLE IF NOT EXISTS visit_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID REFERENCES cases(id) ON DELETE CASCADE,
  case_name TEXT,
  appointment_id UUID,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result TEXT NOT NULL,               -- '成約' | '失注'
  lost_reason TEXT,                   -- 失注時: 金額ネック/期間ネック/本人検討/第三者相談/第三者NG/不在
  memo TEXT,
  -- 成約時の契約詳細（各サービスは契約したもののみ金額を入れる。null=未契約）
  contract_date DATE,
  min_contract_months INTEGER,        -- 最低契約期間（月）
  payment_method TEXT,                -- 一括/月額/分割 等
  hp_price INTEGER,                   -- HP制作
  maintenance_price INTEGER,          -- 保守管理（月額）
  seo_price INTEGER,                  -- SEO（月額）
  meo_price INTEGER,                  -- MEO（月額）
  total_price INTEGER,                -- 合計（初期＋月額合算の目安・表示用）
  created_by_id UUID,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE visit_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON visit_reports;
CREATE POLICY rst_all_authenticated ON visit_reports FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_visit_reports_case ON visit_reports(case_id);
CREATE INDEX IF NOT EXISTS idx_visit_reports_result ON visit_reports(result);
CREATE INDEX IF NOT EXISTS idx_visit_reports_visited ON visit_reports(visited_at DESC);

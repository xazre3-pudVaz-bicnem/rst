-- ============================================================
-- 成約案件の歩合計算。
--   売上の20%を歩合原資とし、リスト担当10% / アポ担当40% / 営業担当50% で分配する。
--   初期費用は契約月に1回、月額費用は契約が続く限り毎月の入金ごとに歩合が発生する。
--   HP制作の分割払いは、分割の各回（入金月）ごとに歩合が発生する。
--
--   list_rep / appo_rep : リスト担当・アポ担当（営業担当は既存の sales_rep）
--   commission_unpaid   : 未払い（入金待ち）。立っている間は unpaid_since 以降の月の歩合を計上しない
--   unpaid_since        : 未払いの開始月（月初日）。過去に支払済みの月の歩合を遡って消さないため月単位で持つ
--   contract_end_month  : 解約月（月初日）。この月までを計上し、翌月以降の月額歩合を止める
-- 冪等: IF NOT EXISTS。
-- ============================================================
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS list_rep TEXT;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS appo_rep TEXT;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS commission_unpaid BOOLEAN DEFAULT false;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS unpaid_since DATE;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS contract_end_month DATE;

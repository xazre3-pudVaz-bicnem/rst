-- ============================================================
-- HP制作の分割払いを「途中で支払方法が変わる契約」に対応させる。
--   カード会社の分割上限（24回など）の都合で、
--   「1〜24回目はクレジットカード／25回目以降は口座振替」という契約が増えたため、
--   どの回まで何で払うのかを訪問結果（成約内容）に残せるようにする。
--
--   hp_first_method       : 1回目から切替までの支払方法（例: クレジットカード）
--   hp_first_installments : その方法で払う回数（例: 24 → 1〜24回目）
--   hp_later_method       : 残りの回の支払方法（例: 口座振替 → 25回目〜最終回）
--   ※ 金額・回数の総額は既存の hp_price / hp_installments のまま。
--     歩合は「分割の各回＝入金月ごと」に計上しており、支払方法が変わっても金額は変わらない。
-- 冪等: IF NOT EXISTS。
-- ============================================================
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS hp_first_method TEXT;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS hp_first_installments INT;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS hp_later_method TEXT;

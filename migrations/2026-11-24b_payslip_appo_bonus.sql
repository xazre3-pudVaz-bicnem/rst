-- ============================================================
-- 給与明細に「アポ歩合」を追加。
--   アルバイトは 時給 ＋ アポ1件あたりの歩合 で支給する。
--   その他手当に混ぜると内訳が分からなくなるため、独立した項目として持つ。
--   employees.appo_bonus_yen（1件あたり）× その月に取ったアポ件数 で算出する。
-- 冪等: IF NOT EXISTS。
-- ============================================================
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS appo_bonus INT NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS appo_count INT NOT NULL DEFAULT 0;

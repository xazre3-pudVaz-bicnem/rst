-- ============================================================
-- 労務管理: 自動退勤とアルバイト対応。
--   auto_clock_out_time     … この時刻になったら、退勤打刻のない人を自動で退勤にする（既定18:30）
--   auto_clock_out_enabled  … 自動退勤のON/OFF
--   employees.appo_bonus_yen … アポ1件あたりの歩合（アルバイト用。例: 100円）
--   labor_settings は1行も無いと時刻を読めないため、既定値の行を入れておく。
-- 冪等: IF NOT EXISTS / 既に行があれば入れない。
-- ============================================================
ALTER TABLE labor_settings ADD COLUMN IF NOT EXISTS auto_clock_out_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE labor_settings ADD COLUMN IF NOT EXISTS auto_clock_out_time TEXT NOT NULL DEFAULT '18:30';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS appo_bonus_yen INT;

INSERT INTO labor_settings (company_name)
SELECT '株式会社サイプレス' WHERE NOT EXISTS (SELECT 1 FROM labor_settings);

-- ============================================================
-- アポ（訪問予定）を案件なしでも登録可能にする。
-- 「社内MTG」「内見同行」など案件に紐づかない予定を共有できるようにするため、
-- case_id / case_name の NOT NULL 制約を外す。FK は NULL を許容するので参照整合は維持。
-- 冪等: DROP NOT NULL は既に外れていても成功する。
-- ============================================================
ALTER TABLE appointments ALTER COLUMN case_id DROP NOT NULL;
ALTER TABLE appointments ALTER COLUMN case_name DROP NOT NULL;

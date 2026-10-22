-- ============================================================
-- ステータス「アポ獲得」を「アポ」に統一する。
--   画面の選択肢（STATUSES）は元々「アポ」だけだったが、
--   コール登録でアポ日時を入れたときだけ「アポ獲得」を書き込んでいたため、
--   2つの名前が混在していた（案件215件・コール履歴240件）。
-- 冪等: 何度流しても同じ（既に「アポ」なら対象0件）。
-- ============================================================
UPDATE cases         SET status      = 'アポ' WHERE status      = 'アポ獲得';
UPDATE call_logs     SET next_status = 'アポ' WHERE next_status = 'アポ獲得';
UPDATE call_logs     SET prev_status = 'アポ' WHERE prev_status = 'アポ獲得';
UPDATE call_sessions SET status      = 'アポ' WHERE status      = 'アポ獲得';
UPDATE templates     SET status      = 'アポ' WHERE status      = 'アポ獲得';
UPDATE templates     SET title       = 'アポ' WHERE title       = 'アポ獲得';

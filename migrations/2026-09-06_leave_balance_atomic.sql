-- ============================================================
-- 有給残高の増減をアトミックにするRPC。
--   これまで承認処理は画面側のスナップショットから絶対値を書き戻していた（read-modify-write）。
--   別々の申請を2人の管理者が同時承認すると、後勝ちで片方の引当が消え残日数が過大になる。
--   DB側で `used = used + delta` の相対更新にして、同時承認でも取りこぼさないようにする。
--   ※不足承知の承認（前借り）を許す運用のため、残日数が負になること自体は禁止しない。
-- 冪等: CREATE OR REPLACE。
-- ============================================================
CREATE OR REPLACE FUNCTION rst_apply_leave_balance_delta(
  p_id UUID,
  p_used_delta NUMERIC,
  p_remaining_delta NUMERIC,
  p_required5_delta NUMERIC
) RETURNS leave_balances
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE r leave_balances;
BEGIN
  UPDATE leave_balances
     SET paid_leave_used_days      = COALESCE(paid_leave_used_days, 0)      + COALESCE(p_used_delta, 0),
         paid_leave_remaining_days = COALESCE(paid_leave_remaining_days, 0) + COALESCE(p_remaining_delta, 0),
         required_5days_used       = COALESCE(required_5days_used, 0)       + COALESCE(p_required5_delta, 0),
         updated_at                = now()
   WHERE id = p_id
   RETURNING * INTO r;
  IF NOT FOUND THEN
    RAISE EXCEPTION '有給付与レコードが見つかりません: %', p_id;
  END IF;
  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION rst_apply_leave_balance_delta(UUID, NUMERIC, NUMERIC, NUMERIC) TO authenticated;

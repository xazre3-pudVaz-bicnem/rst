-- ============================================================
-- パワーダイヤラー（AIは繋がるまで・話すのは人）
--   先に担当者のケータイを呼んでカンファレンスに待機させ、その裏でリストへ自動発信する。
--   相手が「人」として出た瞬間だけカンファレンスへ合流させ、担当者が話す。
--   留守番電話・不在・話中は自動で次へ進み、記録する内容を pending_outcomes に積む
--   （案件への記録＝コール履歴の作成は、既存ロジックを持つ画面側が拾って書く）。
--
--   queue           : 発信対象の案件ID配列（画面で絞り込んだ順）
--   cursor          : queue の次に発信する位置
--   status          : 待機中 / 接続中 / 通話待機 / 発信中 / 通話中 / 結果待ち / 停止
--   amd_mode        : sync=留守電判定の確定後に繋ぐ（誤接続なし・2〜4秒の無音）
--                     async=即つないで後から判定（無音なし・留守電に一瞬繋がる）/ off=判定なし
--   pending_outcomes: 画面がコール履歴に書き込むべき自動結果の待ち行列
-- 冪等: IF NOT EXISTS。
-- ============================================================
CREATE TABLE IF NOT EXISTS dialer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  rep_name TEXT,
  rep_phone TEXT NOT NULL,
  conference_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待機中',
  amd_mode TEXT NOT NULL DEFAULT 'sync',
  test_mode BOOLEAN NOT NULL DEFAULT true,
  test_number TEXT,
  auto_next BOOLEAN NOT NULL DEFAULT true,
  queue JSONB NOT NULL DEFAULT '[]'::jsonb,
  cursor INT NOT NULL DEFAULT 0,
  rep_call_sid TEXT,
  current_case_id UUID,
  current_case_name TEXT,
  current_phone TEXT,
  current_call_sid TEXT,
  current_started_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  pending_outcomes JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_note TEXT,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dialer_sessions_user ON dialer_sessions (user_id, created_date DESC);
CREATE INDEX IF NOT EXISTS idx_dialer_sessions_rep_sid ON dialer_sessions (rep_call_sid);
CREATE INDEX IF NOT EXISTS idx_dialer_sessions_cur_sid ON dialer_sessions (current_call_sid);

ALTER TABLE dialer_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY dialer_sessions_all ON dialer_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

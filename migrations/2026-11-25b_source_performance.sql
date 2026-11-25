-- ============================================================
-- 取得元ごとの実績（架電→アポ率）と、そこから決まる案件の優先度
--   案件一覧のドットの色（赤=高 / 黄=中 / グレー=低）を「実際にアポが取れているか」で決めるための集計表。
--   例: じゃらん観光/体験 9.5% → 高、食べログ 1.8% → 中、台東区保健所 0% → 低
-- 冪等・再実行安全。
-- ============================================================

CREATE TABLE IF NOT EXISTS source_performance (
  src_key    TEXT PRIMARY KEY,           -- 取得元キー（URLはホスト名、それ以外はラベルそのまま）
  label      TEXT,                       -- 表示用
  cases      INTEGER NOT NULL DEFAULT 0, -- 案件数
  calls      INTEGER NOT NULL DEFAULT 0, -- 架電した案件数
  appos      INTEGER NOT NULL DEFAULT 0, -- アポになった案件数
  rate       NUMERIC NOT NULL DEFAULT 0, -- アポ率(%)
  priority   TEXT NOT NULL DEFAULT '中', -- この取得元の案件に付ける優先度
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_performance_rate ON source_performance(rate DESC);

ALTER TABLE source_performance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS source_performance_select ON source_performance;
CREATE POLICY source_performance_select ON source_performance FOR SELECT TO authenticated USING (true);

-- ============================================================
-- チェーンブランドの学習テーブル（自社データ由来）
--   「<ブランド> <地名>店」形の店名からブランドを抽出し、同ブランドが3市区町村以上に
--   出現していればチェーンとみなす。手書きの大手チェーン一覧（chainFilter.ts）で拾えない
--   地域チェーン・新興チェーン（資さんうどん/買取大吉/おそうじ本舗 等）を投入ゲートで弾くために使う。
-- 冪等・再実行安全。
-- ============================================================

CREATE TABLE IF NOT EXISTS chain_brands (
  brand_key    TEXT PRIMARY KEY,          -- 比較キー（全角→半角・記号/空白除去・小文字）
  brand        TEXT NOT NULL,             -- 表示用のブランド名
  city_count   INTEGER NOT NULL DEFAULT 0,-- 同ブランドの支店が確認できた市区町村数
  example_name TEXT,                      -- 根拠になった店名の例
  source       TEXT NOT NULL DEFAULT 'learned', -- learned=自動学習 / manual=手動追加
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chain_brands_city_count ON chain_brands(city_count DESC);

ALTER TABLE chain_brands ENABLE ROW LEVEL SECURITY;

-- 読み取りは認証ユーザー、書き込みはサービスロール（巡回cron）のみ
DROP POLICY IF EXISTS chain_brands_select ON chain_brands;
CREATE POLICY chain_brands_select ON chain_brands FOR SELECT TO authenticated USING (true);

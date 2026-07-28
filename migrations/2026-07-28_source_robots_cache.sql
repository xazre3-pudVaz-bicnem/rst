-- robots.txt再取得の削減用キャッシュ。サイト毎に毎回 robots.txt を取得(最大6秒)しており、
-- これが巡回スループットの主要ボトルネックだった（1サイト14秒→開店記事280サイトが1〜2日遅れ）。
-- robotsは滅多に変わらないので、判定結果を保存して一定期間(既定7日)再取得しない。
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS robots_allowed BOOLEAN;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS robots_checked_at TIMESTAMPTZ;

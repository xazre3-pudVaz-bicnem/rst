-- 複数の新規根拠（シグナル）を1候補に紐づける
CREATE TABLE IF NOT EXISTS lead_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_candidate_id UUID,
  signal_type TEXT,
  signal_source TEXT,
  signal_url TEXT,
  signal_date DATE,
  signal_text TEXT,
  confidence NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_signals_candidate ON lead_signals(lead_candidate_id);
CREATE INDEX IF NOT EXISTS idx_lead_signals_type ON lead_signals(signal_type);
ALTER TABLE lead_signals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY rst_ls_sel ON lead_signals FOR SELECT TO authenticated USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AI営業優先度・サブスコア・Web弱点・架電前メモ
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS sales_priority_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS sales_priority_grade TEXT;        -- S/A/B/C
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS newness_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS contactability_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS business_fit_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS website_weakness_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS budget_likelihood_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS chain_exclusion_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS duplicate_risk_score INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS signal_count INTEGER DEFAULT 0;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS website_status TEXT;              -- none/instagram_only/builder/own_domain...
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS website_type TEXT;                -- wix/jimdo/peraichi/studio/ameba_ownd/linktree/google_sites...
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS seo_weakness_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS hp_sales_angle TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS call_memo TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS call_memo_generated_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS discovery_source_type TEXT;       -- 取得元 source_type
CREATE INDEX IF NOT EXISTS idx_lead_candidates_sales_priority ON lead_candidates(sales_priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_lead_candidates_discovery_source ON lead_candidates(discovery_source_type);

-- SERP/差分巡回の既読URLストア（source_articlesと別に汎用化）
CREATE TABLE IF NOT EXISTS discovery_seen_urls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT,
  url_hash TEXT,
  url TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_seen_uniq ON discovery_seen_urls(source_type, url_hash);

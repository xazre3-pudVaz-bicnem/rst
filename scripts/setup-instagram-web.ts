/* ============================================================
 * Instagram Web検索 のDBセットアップ（Claude Code / CLIで完結）
 *   npm run setup:instagram-web
 *
 * 冪等・再実行安全。Supabase SQL Editorを触らずに必要カラム/テーブル/設定を用意。
 *   - lead_candidates に Instagram Web検索 由来カラムを追加
 *   - ig_web_query_log（クエリ実行履歴）を作成
 *   - app_config に instagram_web_auto を追加（初期HOT自動投入OFF）
 * DDLには SUPABASE_DB_URL（Postgres直結）を使用。無ければ確認のみ＆案内。
 * DDLはコード固定。任意SQLは生成・実行しない。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || ''

function projectRef(url: string): string { try { return new URL(url).host.split('.')[0] } catch { return '不明' } }

const DDL = `
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_query TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_title TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_snippet TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS anthropic_judgement JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS newness_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_prefecture TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_city TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS recommended_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS rule_filter_result TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS skipped_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS api_run_id UUID;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_sources JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_phone TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_prefecture TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_city TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ig_enrich_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL UNIQUE,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  runs INTEGER NOT NULL DEFAULT 0,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ig_enrich_log_last ON ig_enrich_log(last_run_at);
ALTER TABLE ig_enrich_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON ig_enrich_log;
CREATE POLICY rst_all_authenticated ON ig_enrich_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_shop_name TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_area TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_industry TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_phone TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_newness_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS match_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_run_id UUID;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS lead_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS lead_temperature TEXT NOT NULL DEFAULT 'HOLD';
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS is_new_instagram BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_to_cases BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_lead_candidates_source ON lead_candidates(source);

CREATE TABLE IF NOT EXISTS ig_web_query_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL UNIQUE,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  runs INTEGER NOT NULL DEFAULT 0,
  results INTEGER NOT NULL DEFAULT 0,
  hot_count INTEGER NOT NULL DEFAULT 0,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ig_web_query_log_last ON ig_web_query_log(last_run_at);
ALTER TABLE ig_web_query_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON ig_web_query_log;
CREATE POLICY rst_all_authenticated ON ig_web_query_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb, updated_date TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON app_config;
CREATE POLICY rst_all_authenticated ON app_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
INSERT INTO app_config (key, value) VALUES
  ('instagram_web_auto', '{"iwEnabled": true, "iwAutoImport": false, "iwRequirePhone": false, "iwPlacesRequired": false, "iwAnthropic": true, "iwMaxQueriesPerDay": 80, "iwPerQuery": 10, "iwMaxRunsPerDay": 4, "iwPerRun": 20, "iwAnthropicDailyCap": 100, "iwEnrichEnabled": true, "iwEnrichMaxQueries": 3, "iwEnrichPerQuery": 5, "iwEnrichDailyCap": 100}'::jsonb)
ON CONFLICT (key) DO NOTHING;
`

async function main() {
  console.log('=== RST Instagram Web検索 セットアップ ===')
  if (!SUPABASE_URL || !SERVICE_ROLE) { console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（.env）'); process.exit(1) }
  console.log('• 接続先 projectRef:', projectRef(SUPABASE_URL))
  console.log('• DDLモード:', DB_URL ? 'Postgres直結(SUPABASE_DB_URL)' : 'service role確認のみ')

  if (DB_URL) {
    const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      console.log('• 必要カラム/テーブル/設定を適用中（冪等）...')
      await client.query(DDL)
      const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='lead_candidates' AND column_name = ANY($1)`,
        [['source', 'search_query', 'search_snippet', 'line_url', 'reservation_url', 'official_url', 'anthropic_judgement', 'newness_type']])
      const cfg = await client.query(`SELECT 1 FROM app_config WHERE key='instagram_web_auto'`)
      console.log('  ✓ lead_candidates カラム確認:', cols.rows.map((r: any) => r.column_name).join(', '))
      console.log('  ✓ app_config[instagram_web_auto]:', cfg.rowCount ? 'あり' : 'なし')
      console.log('  ✓ ig_web_query_log: 作成済み')
      console.log('\n✅ セットアップ完了')
    } finally { await client.end() }
  } else {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
    const probe = await admin.from('ig_web_query_log').select('query', { count: 'exact', head: true })
    if (probe.error) {
      console.error('✗ ig_web_query_log を確認できません:', probe.error.message)
      console.error('  → DDL自動適用には .env に SUPABASE_DB_URL（Supabase > Project Settings > Database > Connection string [URI]）を設定して再実行してください。')
      process.exit(1)
    }
    // app_config 既定を保険でupsert（カラムが揃っている前提）
    await admin.from('app_config').upsert({ key: 'instagram_web_auto', value: { iwEnabled: true, iwAutoImport: false, iwRequirePhone: false, iwPlacesRequired: false, iwAnthropic: true, iwMaxQueriesPerDay: 80, iwPerQuery: 10, iwMaxRunsPerDay: 4, iwPerRun: 20, iwAnthropicDailyCap: 100, iwEnrichEnabled: true, iwEnrichMaxQueries: 3, iwEnrichPerQuery: 5, iwEnrichDailyCap: 100 }, updated_date: new Date().toISOString() }, { onConflict: 'key' }).then(() => {}, () => {})
    console.log('✅ 既存スキーマを確認（DDLが必要な場合は SUPABASE_DB_URL を設定して再実行）')
  }
  console.log('次: npm run build → npm run check:instagram-web-api → RST「Instagram Web検索」タブ')
}

main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

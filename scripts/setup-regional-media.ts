/* ============================================================
 * 地域メディア巡回のDBセットアップ（Claude Code / CLIで完結）
 *   npm run setup:regional-media
 *
 * 役割（冪等・何度実行しても安全）:
 *   - .env / 環境変数から接続情報を読む
 *   - source_sites / source_articles / auto_lead_runs / app_config の作成・不足カラム追加
 *   - lead_candidates に地域メディア由来カラムを追加
 *   - 初期ソース(seedSources)を base_url で upsert（重複はUPDATE）
 *   - 結果をコンソール表示
 *
 * DDL(列追加)には Postgres 直結が必要なので SUPABASE_DB_URL を使う。
 *   無い場合は service role(PostgREST) で seed のみ実行し、必要DDLを案内する。
 * 安全: DDL/UPSERTはこのファイルに固定。任意SQLは生成・実行しない。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'
import { INITIAL_SOURCES, normalizeUrl } from '../src/lib/regionalAdmin.js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || ''

function projectRef(url: string): string {
  try { return new URL(url).host.split('.')[0] } catch { return '不明' }
}

// コードに固定した冪等DDL（地域メディアに必要な範囲）
const DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS source_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'category_page',
  prefecture TEXT, area TEXT, category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  crawl_interval_days INTEGER NOT NULL DEFAULT 1,
  last_crawled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS list_url TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS media_family TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS category_label TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS reliability_score INTEGER NOT NULL DEFAULT 50;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS crawl_interval_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_crawl_result TEXT;
UPDATE source_sites SET list_url = base_url WHERE list_url IS NULL OR list_url = '';
ALTER TABLE source_sites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON source_sites;
CREATE POLICY rst_all_authenticated ON source_sites FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS source_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site_id UUID REFERENCES source_sites(id) ON DELETE SET NULL,
  article_url TEXT NOT NULL,
  article_url_hash TEXT NOT NULL UNIQUE,
  title TEXT, published_at TIMESTAMPTZ, detected_type TEXT, raw_excerpt TEXT,
  processed_status TEXT NOT NULL DEFAULT 'pending',
  extracted_shop_name TEXT, extracted_area TEXT, extracted_address TEXT,
  extracted_open_date TEXT, extracted_industry TEXT, exclusion_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE source_articles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON source_articles;
CREATE POLICY rst_all_authenticated ON source_articles FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS auto_lead_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'google_places',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  search_queries_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  hot_count INTEGER NOT NULL DEFAULT 0,
  hold_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by_id UUID,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE auto_lead_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON auto_lead_runs;
CREATE POLICY rst_all_authenticated ON auto_lead_runs FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON app_config;
CREATE POLICY rst_all_authenticated ON app_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
INSERT INTO app_config (key, value) VALUES ('regional_auto', '{"regionalEnabled": true}'::jsonb) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS lead_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS phone_normalized TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS lead_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS lead_temperature TEXT NOT NULL DEFAULT 'HOLD';
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS owner_reachability_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS should_exclude_from_call_list BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_import_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS ai_comment TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS is_new_gbp BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS is_new_instagram BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_to_cases BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS detected_signals TEXT[];
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS matched_google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS match_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_shop_name TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_area TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_industry TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_article_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_article_title TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_site_name TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS regional_media_detected_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS regional_media_newness_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_run_id UUID;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS created_by_id UUID;
-- 外部情報補完（IWと共通）＋記事由来カラム
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_sources JSONB;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_phone TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_address TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_prefecture TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_city TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_instagram_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enriched_google_place_id TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS enrichment_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS line_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS reservation_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_prefecture TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_city TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_phone TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_article_excerpt TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_media_family TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_shop_name_from_article TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_area_from_article TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date_from_article TEXT;
-- 店舗ディレクトリ型（彩北なび等）
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_site_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_listing_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_detail_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_title TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS search_snippet TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS newness_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date_text TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_month INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_day INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_open_date_confidence TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS map_url TEXT;
-- マーケットプレイス/汎用カード型パーサー
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS parser_used TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS source_list_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS candidate_block_text_short TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS detail_fetch_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS matched_keywords TEXT[];
-- 自動投入の試行ログ
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_attempted BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_success BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_skipped_reason TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS auto_insert_error TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_case_id UUID;
-- 連番URL探索（sequential_id_probe）
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS url_template TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS id_padding INTEGER;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS current_probe_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_checked_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_found_id BIGINT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS scan_direction TEXT DEFAULT 'forward';
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_batch_size INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS max_probe_per_run INTEGER DEFAULT 20;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS valid_page_pattern TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS invalid_page_pattern TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS parser_type TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_enabled BOOLEAN DEFAULT true;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS probe_result_summary TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS consecutive_not_found_count INTEGER DEFAULT 0;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS max_consecutive_not_found INTEGER DEFAULT 10;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probed_id BIGINT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probed_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probe_valid BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS probe_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS extracted_official_url TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS first_discovered_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS sequential_probe_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_site_id UUID, probed_url TEXT NOT NULL UNIQUE, probed_id BIGINT,
  valid BOOLEAN, status TEXT, last_probed_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sequential_probe_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON sequential_probe_log;
CREATE POLICY rst_all_authenticated ON sequential_probe_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- じゃらん観光スポット（連番探索）の初期登録（既定OFF・UIで有効化）
INSERT INTO source_sites (name, base_url, list_url, media_family, source_type, parser_type, category_label, is_active, reliability_score, crawl_interval_hours, url_template, id_padding, current_probe_id, scan_direction, probe_batch_size, max_probe_per_run, max_consecutive_not_found, probe_enabled, updated_at)
VALUES ('じゃらん観光スポット', 'https://www.jalan.net/kankou/', 'https://www.jalan.net/kankou/', 'jalan', 'sequential_id_probe', 'jalan_spot_detail', '店舗新着', false, 60, 24, 'https://www.jalan.net/kankou/spt_guide{ID}/', 12, 231369, 'forward', 20, 20, 10, true, now())
ON CONFLICT (base_url) DO UPDATE SET source_type='sequential_id_probe', parser_type='jalan_spot_detail', url_template=EXCLUDED.url_template, id_padding=12, scan_direction='forward', probe_batch_size=20, max_probe_per_run=20, max_consecutive_not_found=10, updated_at=now();
CREATE INDEX IF NOT EXISTS idx_lead_candidates_detail_url ON lead_candidates(source_detail_url);
-- 旧・誤URLの彩北なび(saihokunavi.net)は無効化（正: www.saikohkunavi.net）
UPDATE source_sites SET is_active = false, last_crawl_result = '旧URL（無効化）' WHERE base_url ILIKE '%saihokunavi.net%';
CREATE TABLE IF NOT EXISTS ig_enrich_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), query TEXT NOT NULL UNIQUE,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(), runs INTEGER NOT NULL DEFAULT 0, created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ig_enrich_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON ig_enrich_log;
CREATE POLICY rst_all_authenticated ON ig_enrich_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE lead_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON lead_candidates;
CREATE POLICY rst_all_authenticated ON lead_candidates FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_lead_candidates_article_url ON lead_candidates(source_article_url);
CREATE INDEX IF NOT EXISTS idx_lead_candidates_lead_source ON lead_candidates(lead_source);
`

const SITE_COLS = ['name', 'base_url', 'list_url', 'media_family', 'source_type', 'category_label', 'is_active', 'reliability_score', 'crawl_interval_hours']

async function viaPg() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    console.log('• DDL を適用中（冪等）...')
    await client.query(DDL)
    console.log('  ✓ テーブル/カラム/ポリシーを確認・作成しました')

    console.log('• 初期ソースを upsert 中...')
    for (const s of INITIAL_SOURCES) {
      await client.query(
        `INSERT INTO source_sites (name, base_url, list_url, media_family, source_type, category_label, is_active, reliability_score, crawl_interval_hours, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (base_url) DO UPDATE SET
           name=EXCLUDED.name, list_url=EXCLUDED.list_url, media_family=EXCLUDED.media_family,
           source_type=EXCLUDED.source_type, category_label=EXCLUDED.category_label,
           reliability_score=EXCLUDED.reliability_score, crawl_interval_hours=EXCLUDED.crawl_interval_hours,
           updated_at=now()`,
        [s.name, normalizeUrl(s.base_url), normalizeUrl(s.list_url), s.media_family, s.source_type, s.category_label, s.is_active, s.reliability_score, s.crawl_interval_hours],
      )
    }
    const total = await client.query('SELECT count(*)::int AS c FROM source_sites')
    const active = await client.query('SELECT count(*)::int AS c FROM source_sites WHERE is_active = true')
    return { total: total.rows[0].c, active: active.rows[0].c, seeded: INITIAL_SOURCES.length }
  } finally { await client.end() }
}

async function viaServiceRole() {
  console.log('• SUPABASE_DB_URL が無いため service role(PostgREST) で seed のみ実行します')
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
  const rows = INITIAL_SOURCES.map((s) => ({ ...s, base_url: normalizeUrl(s.base_url), list_url: normalizeUrl(s.list_url), updated_at: new Date().toISOString() }))
  const { error } = await admin.from('source_sites').upsert(rows, { onConflict: 'base_url' })
  if (error) {
    throw new Error(
      `seed に失敗しました: ${error.message}\n` +
      `→ カラム不足の可能性があります。DDLを自動適用するには .env に SUPABASE_DB_URL（Supabase > Project Settings > Database > Connection string [URI]）を設定して再実行してください。`,
    )
  }
  const total = await admin.from('source_sites').select('id', { count: 'exact', head: true })
  const active = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true)
  return { total: total.count || 0, active: active.count || 0, seeded: rows.length }
}

async function main() {
  console.log('=== RST 地域メディア セットアップ ===')
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。')
    console.error('  .env に設定してください（.env.example 参照）。')
    process.exit(1)
  }
  console.log('• 接続先 projectRef:', projectRef(SUPABASE_URL))
  console.log('• DDL適用モード:', DB_URL ? 'Postgres直結(SUPABASE_DB_URL)' : 'service roleフォールバック(seedのみ)')

  try {
    const r = DB_URL ? await viaPg() : await viaServiceRole()
    console.log('')
    console.log('✅ セットアップ完了')
    console.log('   source_sites 総数 :', r.total)
    console.log('   有効サイト数      :', r.active)
    console.log('   seed登録件数      :', r.seeded)
    console.log('')
    console.log('次の手順: npm run build → npm run check:regional-media-api → RST「地域メディア」タブで確認')
  } catch (e: any) {
    console.error('✗ セットアップ失敗:', e?.message || e)
    process.exit(1)
  }
}

main()

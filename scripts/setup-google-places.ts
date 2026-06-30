/* ============================================================
 * Google Places openingDate/businessStatus 用のDBセットアップ（CLIで完結）
 *   npm run setup:google-places
 * 冪等。SUPABASE_DB_URL で Postgres 直結（無ければ案内）。任意SQLは生成しない。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'

const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || ''

const DDL = `
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_year INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_month INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_day INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_opening_date_raw TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_business_status TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS has_google_opening_date BOOLEAN;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_source TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_confidence INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS days_until_opening INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS days_since_opening INTEGER;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_places_checked_at TIMESTAMPTZ;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS opening_date_checked_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS google_business_status TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS google_opening_date_raw TEXT;
-- 全国・新店系ワード検索（エリア/業種で絞らない）の保存列
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS places_search_query TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS places_search_mode TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_primary_type TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_types TEXT[];
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_website_uri TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_rating NUMERIC;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS google_user_rating_count INTEGER;
`

// 既存の海外候補を EXCLUDED に更新（日本国外は対象外）
const FOREIGN_CLEANUP = `
UPDATE lead_candidates SET
  lead_temperature = 'EXCLUDED',
  should_exclude_from_call_list = TRUE,
  exclusion_reason = COALESCE(NULLIF(exclusion_reason, ''), '日本国外の候補のため除外')
WHERE lead_temperature <> 'EXCLUDED' AND (
     address ILIKE '%アメリカ合衆国%' OR address ILIKE '%United States%' OR address ILIKE '%USA%'
  OR address ILIKE '%Canada%' OR address ILIKE '%カナダ%' OR address ILIKE '%Australia%' OR address ILIKE '%オーストラリア%'
  OR address ILIKE '%Korea%' OR address ILIKE '%韓国%' OR address ILIKE '%Taiwan%' OR address ILIKE '%台湾%'
  OR address ILIKE '%Singapore%' OR address ILIKE '%シンガポール%' OR address ILIKE '%Oregon%' OR address ILIKE '%California%'
  OR phone_number LIKE '+1%' OR phone_number LIKE '+44%' OR phone_number LIKE '+61%' OR phone_number LIKE '+82%' OR phone_number LIKE '+886%' OR phone_number LIKE '+65%'
);
`

// 法人/団体/研究会系（新店営業対象でない可能性が高い）を EXCLUDED に更新。
// ただし 電話＋openingDate が揃う真の新規開業は残す（HOLD扱いのまま）。
const ORG_CLEANUP = `
UPDATE lead_candidates SET
  lead_temperature = 'EXCLUDED',
  should_exclude_from_call_list = TRUE,
  exclusion_reason = COALESCE(NULLIF(exclusion_reason, ''), '法人/団体/研究会系のため除外（新店営業対象ではない可能性が高い）')
WHERE lead_temperature <> 'EXCLUDED'
  AND name ~ '(機構|協会|商工会|振興会|振興公社|公社|事業団|協同組合|連合会|連盟|学会|研究会|財団|社団|一般社団法人|一般財団法人|公益社団法人|公益財団法人|NPO|特定非営利活動法人|独立行政法人|委員会|評議会|総本部|協議会)'
  AND NOT (COALESCE(phone_number, '') <> '' AND has_google_opening_date IS TRUE);
`

async function main() {
  console.log('=== RST Google Places（全国・新店系／日本限定）セットアップ ===')
  if (!DB_URL) { console.error('✗ SUPABASE_DB_URL が未設定です（.env）。Connection string[URI] を設定して再実行してください。'); process.exit(1) }
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    console.log('• openingDate/businessStatus・全国検索カラムを適用中（冪等）...')
    await client.query(DDL)
    const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='lead_candidates' AND column_name LIKE 'google_opening%' OR column_name IN ('google_business_status','has_google_opening_date','days_until_opening','days_since_opening','places_search_mode')`)
    console.log('  ✓ lead_candidates:', cols.rows.map((r: any) => r.column_name).join(', '))
    console.log('• 既存の海外候補を EXCLUDED に更新中...')
    const upd = await client.query(FOREIGN_CLEANUP)
    console.log(`  ✓ 日本国外候補を除外: ${upd.rowCount}件`)
    console.log('• 既存の法人/団体/研究会系候補を EXCLUDED に更新中...')
    const updOrg = await client.query(ORG_CLEANUP)
    console.log(`  ✓ 法人/団体/研究会系を除外: ${updOrg.rowCount}件`)
    console.log('\n✅ セットアップ完了 — npm run build → RST「AI投入」Google Places タブで確認')
  } finally { await client.end() }
}
main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

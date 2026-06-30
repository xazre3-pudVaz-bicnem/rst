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
`

async function main() {
  console.log('=== RST Google Places openingDate セットアップ ===')
  if (!DB_URL) { console.error('✗ SUPABASE_DB_URL が未設定です（.env）。Connection string[URI] を設定して再実行してください。'); process.exit(1) }
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    console.log('• openingDate/businessStatus カラムを適用中（冪等）...')
    await client.query(DDL)
    const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='lead_candidates' AND column_name LIKE 'google_opening%' OR column_name IN ('google_business_status','has_google_opening_date','days_until_opening','days_since_opening')`)
    console.log('  ✓ lead_candidates:', cols.rows.map((r: any) => r.column_name).join(', '))
    console.log('\n✅ セットアップ完了 — npm run build → RST「AI投入」Google Places タブで確認')
  } finally { await client.end() }
}
main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

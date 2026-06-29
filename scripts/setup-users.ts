/* ============================================================
 * ユーザー管理/申請のDBセットアップ（Claude Code / CLIで完結）
 *   npm run setup:users
 *
 * 冪等・再実行安全。Supabase SQL Editor不要（SUPABASE_DB_URLでPostgres直結）。
 *   - signup_requests テーブル作成（anon申請可）
 *   - profiles に username/email/is_active/is_sales_assignee/last_login/created_by 追加
 *   - cases / lead_candidates / call_logs に user_id系カラム追加（将来の紐付け用）
 *   - app_config に fixed_admin_email を保存
 *   - profiles に固定adminメールの行があれば role=admin に更新
 * DDLはコード固定。任意SQLは生成しない。
 * ============================================================ */
import 'dotenv/config'
import { Client } from 'pg'

const FIXED_ADMIN_EMAIL = 'odaharuki129@gmail.com'
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || ''

const DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 新規登録申請
CREATE TABLE IF NOT EXISTS signup_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  display_name TEXT,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON signup_requests(status);
ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sr_insert ON signup_requests;
CREATE POLICY sr_insert ON signup_requests FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS sr_admin ON signup_requests;
CREATE POLICY sr_admin ON signup_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- profiles 拡張（テーブルが無い場合も最低限作成）
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'sales',
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_sales_assignee BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profiles_all ON profiles;
CREATE POLICY profiles_all ON profiles FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 案件/候補/履歴に user_id系カラム（将来の紐付け用・既存挿入は非送信なので安全）
ALTER TABLE cases ADD COLUMN IF NOT EXISTS assigned_user_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS assigned_user_name TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS created_by_user_name TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS imported_by_user_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS imported_by_user_name TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS updated_by_user_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS updated_by_user_name TEXT;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_by_user_id UUID;
ALTER TABLE lead_candidates ADD COLUMN IF NOT EXISTS imported_by_user_name TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recorded_by_user_id UUID;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recorded_by_user_name TEXT;

-- app_config
CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb, updated_date TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rst_all_authenticated ON app_config;
CREATE POLICY rst_all_authenticated ON app_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
INSERT INTO app_config (key, value) VALUES ('fixed_admin_email', '"${FIXED_ADMIN_EMAIL}"'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_date = now();

-- 固定adminメールの profiles 行があれば admin に固定
UPDATE profiles SET role = 'admin', is_active = true WHERE lower(email) = lower('${FIXED_ADMIN_EMAIL}');

-- 既存案件の担当者名を assigned_user_name に補完（user_idは紐付けできる範囲のみ・空なら据え置き）
UPDATE cases SET assigned_user_name = sales_rep
  WHERE (assigned_user_name IS NULL OR assigned_user_name = '') AND sales_rep IS NOT NULL AND sales_rep <> '';
UPDATE cases SET created_by_user_name = created_by_name
  WHERE (created_by_user_name IS NULL OR created_by_user_name = '') AND created_by_name IS NOT NULL AND created_by_name <> '';
`

async function main() {
  console.log('=== RST ユーザー管理 セットアップ ===')
  if (!DB_URL) {
    console.error('✗ SUPABASE_DB_URL が未設定です（.env）。Supabase > Project Settings > Database > Connection string [URI] を設定してください。')
    process.exit(1)
  }
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    console.log('• テーブル/カラム/ポリシーを適用中（冪等）...')
    await client.query(DDL)
    const sr = await client.query('SELECT count(*)::int AS c FROM signup_requests')
    const pr = await client.query('SELECT count(*)::int AS c FROM profiles')
    const admins = await client.query(`SELECT count(*)::int AS c FROM profiles WHERE role='admin'`)
    const sales = await client.query(`SELECT count(*)::int AS c FROM profiles WHERE is_active = true AND is_sales_assignee = true`)
    const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='cases' AND column_name = ANY($1)`,
      [['assigned_user_id', 'assigned_user_name', 'created_by_user_id', 'created_by_user_name', 'imported_by_user_id', 'imported_by_user_name']])
    console.log('  ✓ app_users(profiles)総数:', pr.rows[0].c, '件')
    console.log('  ✓ 営業担当候補(is_active&is_sales_assignee):', sales.rows[0].c, '件')
    console.log('  ✓ admin:', admins.rows[0].c, '件 / 固定admin:', FIXED_ADMIN_EMAIL)
    console.log('  ✓ signup_requests:', sr.rows[0].c, '件')
    console.log('  ✓ cases 追加/確認カラム:', cols.rows.map((r: any) => r.column_name).join(', '))
    console.log('\n✅ セットアップ完了')
    console.log('次: npm run build → ログイン画面の「新規登録申請」/ ユーザー管理画面 を確認')
  } finally {
    await client.end()
  }
}

main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

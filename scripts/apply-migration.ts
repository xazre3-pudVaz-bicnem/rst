/* ============================================================
 * 任意のマイグレーションSQLファイルをDBへ適用（Supabase SQL Editor不要）
 *   npm run db:apply -- migrations/2026-06-29_case_creator.sql
 *
 * SUPABASE_DB_URL（Postgres直結）が必要。冪等なSQLを前提。
 * 安全: ファイル内容のみ実行。任意SQLの自動生成はしない。
 * ============================================================ */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const file = process.argv[2]
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || ''

async function main() {
  if (!file) { console.error('✗ 適用するSQLファイルを指定してください。例: npm run db:apply -- migrations/xxx.sql'); process.exit(1) }
  if (!DB_URL) { console.error('✗ SUPABASE_DB_URL が未設定です（.env）。'); process.exit(1) }
  const sql = readFileSync(file, 'utf8')
  console.log(`=== マイグレーション適用: ${file} ===`)
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    await client.query(sql)
    console.log('✅ 適用完了（冪等）')
  } finally {
    await client.end()
  }
}

main().catch((e) => { console.error('✗ 失敗:', e?.message || e); process.exit(1) })

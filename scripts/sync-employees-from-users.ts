/**
 * ユーザー(profiles) → 従業員(employees) の同期を手動実行（冪等）。
 * 画面側は従業員マスタを開いたときに自動同期するが、初回投入や確認用にCLIからも実行できる。
 *   npx tsx scripts/sync-employees-from-users.ts            … 有効ユーザーのみ
 *   npx tsx scripts/sync-employees-from-users.ts --all      … 無効ユーザーも含める
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { syncEmployeesFromProfiles } from '../src/lib/employeeSync.js'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const includeInactive = process.argv.includes('--all')
  const r = await syncEmployeesFromProfiles(admin, { includeInactive })
  console.log(`新規作成 ${r.created.length}件${r.created.length ? `: ${r.created.join('・')}` : ''}`)
  console.log(`既存へ紐付け ${r.linked.length}件${r.linked.length ? `: ${r.linked.join('・')}` : ''}`)
  console.log(`既に同期済み ${r.skipped}件`)
  const { count } = await admin.from('employees').select('id', { count: 'exact', head: true })
  console.log(`従業員マスタ合計: ${count}人`)
}
main().catch((e) => { console.error(e); process.exit(1) })

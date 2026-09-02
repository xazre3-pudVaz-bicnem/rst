/**
 * 恒久除外ドメイン（ホットペッパー / 開店閉店.com）の巡回サイトをDBから無効化（冪等）。
 * コード側は src/lib/sourceBlocklist.ts で流入を止めているが、既に登録済みの source_sites 行は
 * DBに残るためこのスクリプトで is_active=false にする。
 * 実行: npx tsx scripts/disable-excluded-sources.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { EXCLUDED_SOURCE_DOMAINS, isExcludedSourceUrl } from '../src/lib/sourceBlocklist.js'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: sites, error } = await admin.from('source_sites').select('id,name,base_url,list_url,is_active').limit(5000)
  if (error) throw new Error(error.message)

  const targets = (sites || []).filter((s: any) => isExcludedSourceUrl(s.list_url || '') || isExcludedSourceUrl(s.base_url || ''))
  console.log(`除外ドメイン: ${EXCLUDED_SOURCE_DOMAINS.join(', ')}`)
  console.log(`該当サイト: ${targets.length}件（うち有効 ${targets.filter((s: any) => s.is_active).length}件）`)

  for (const s of targets) {
    if (!s.is_active) { console.log(`既に無効: ${s.name}`); continue }
    const { error: e } = await admin.from('source_sites')
      .update({ is_active: false, disabled_reason: '除外ドメイン（対象外メディア）', updated_at: new Date().toISOString() })
      .eq('id', s.id)
    console.log(e ? `失敗: ${s.name}: ${e.message}` : `無効化: ${s.name}（${s.list_url || s.base_url}）`)
  }

  const { count } = await admin.from('source_sites').select('id', { count: 'exact', head: true }).eq('is_active', true).neq('source_type', 'sequential_id_probe')
  console.log(`地域メディア有効サイト合計: ${count}`)
}
main().catch((e) => { console.error(e); process.exit(1) })

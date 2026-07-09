/**
 * 食べログ系の連番URL探索ソースを一括OFF（is_active=false）にする一回用スクリプト。
 * UIの「一括無効化(tabelog)」と同一条件（parser_type=tabelog_detail / 名前に食べログ / URLにtabelog.com）。
 * 実行: npx tsx scripts/disable-tabelog-probes.ts
 * 再有効化はUI（連番URL探索タブの一括有効化）から可能。
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（.env）'); process.exit(1) }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: targets, error: selErr } = await admin.from('source_sites')
    .select('id,name,is_active,parser_type,url_template')
    .eq('source_type', 'sequential_id_probe')
    .or('parser_type.eq.tabelog_detail,name.ilike.%食べログ%,url_template.ilike.%tabelog.com%')
  if (selErr) { console.error('取得失敗:', selErr.message); process.exit(1) }
  const list = targets || []
  const active = list.filter((s: any) => s.is_active)
  console.log(`食べログ系 連番ソース: 全${list.length}件（うち有効 ${active.length}件）`)

  const { error } = await admin.from('source_sites').update({
    is_active: false,
    disabled_reason: 'ユーザー指示で食べログ連番を一括OFF（2026-07-09）',
    disabled_at: new Date().toISOString(),
    disabled_by: 'admin',
    updated_at: new Date().toISOString(),
  }).eq('source_type', 'sequential_id_probe')
    .or('parser_type.eq.tabelog_detail,name.ilike.%食べログ%,url_template.ilike.%tabelog.com%')
  if (error) { console.error('更新失敗:', error.message); process.exit(1) }

  const { count: stillActive } = await admin.from('source_sites').select('id', { count: 'exact', head: true })
    .eq('source_type', 'sequential_id_probe').eq('is_active', true)
    .or('parser_type.eq.tabelog_detail,name.ilike.%食べログ%,url_template.ilike.%tabelog.com%')
  const { count: totalActive } = await admin.from('source_sites').select('id', { count: 'exact', head: true })
    .eq('source_type', 'sequential_id_probe').eq('is_active', true)
  console.log(`OFF完了: 食べログ系の有効ソース残 ${stillActive ?? '?'} 件（0であること）`)
  console.log(`連番探索の有効ソース合計（食べログ以外）: ${totalActive ?? '?'} 件`)
  for (const s of active.slice(0, 15)) console.log(`  OFF: ${s.name}`)
  if (active.length > 15) console.log(`  ...他${active.length - 15}件`)
}

main().catch((e) => { console.error(e); process.exit(1) })

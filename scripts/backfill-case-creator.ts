/**
 * cases のリスト投入者名（created_by_name / created_by_user_name）を created_by_id から補完（冪等）。
 * CSV取込・URL取込・AI候補の手動投入は created_by_id しか入れていなかった時期があり、
 * 詳細検索の「リスト投入者」で人が拾えないため、profiles の氏名で埋め戻す。
 * created_by_id が無い行（cronのAI自動投入）は人が介在しないので対象外。
 * 実行: npx tsx scripts/backfill-case-creator.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: profiles, error: pe } = await admin.from('profiles').select('id,full_name,username,email').limit(1000)
  if (pe) throw new Error(pe.message)
  const nameById = new Map<string, string>()
  for (const p of profiles || []) {
    const n = String((p as any).full_name || (p as any).username || (p as any).email || '').trim()
    if (n) nameById.set((p as any).id, n)
  }
  console.log(`profiles: ${nameById.size}人`)

  let from = 0, fixed = 0, noProfile = 0, scanned = 0
  for (;;) {
    const { data, error } = await admin.from('cases')
      .select('id,created_by_id,created_by_name,created_by_user_name')
      .not('created_by_id', 'is', null)
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = data || []
    if (!rows.length) break
    scanned += rows.length
    for (const r of rows as any[]) {
      if ((r.created_by_name || '').trim() && (r.created_by_user_name || '').trim()) continue
      const name = nameById.get(r.created_by_id)
      if (!name) { noProfile++; continue }
      const patch: any = { updated_date: new Date().toISOString() }
      if (!(r.created_by_name || '').trim()) patch.created_by_name = name
      if (!(r.created_by_user_name || '').trim()) { patch.created_by_user_name = name; patch.created_by_user_id = r.created_by_id }
      const { error: ue } = await admin.from('cases').update(patch).eq('id', r.id)
      if (ue) console.log(`失敗 ${r.id}: ${ue.message}`)
      else fixed++
    }
    if (rows.length < 1000) break
    from += 1000
  }
  console.log(`走査 ${scanned}件 / 補完 ${fixed}件 / profilesに該当なし ${noProfile}件`)
}
main().catch((e) => { console.error(e); process.exit(1) })

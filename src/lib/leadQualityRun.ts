// ============================================================
// リード品質の一括再計算＋クロスソース重複グルーピング。サーバー専用。
// 既存・新規すべての lead_candidates に quality_score/grade/category/dedup_key/flags/phone_pref_match を付与し、
// 同一店舗（電話 or 店名＋県）が複数ソースに跨る場合の重複グループサイズを記録する。
// ============================================================
import { computeQuality } from './leadQuality.js'

const QUALITY_FIELDS = 'id,name,address,industry,phone_number,phone_normalized,extracted_phone,enriched_phone,extracted_shop_name,extracted_address,extracted_industry,primary_type,google_primary_type,lead_temperature,hot_tier,name_unconfirmed_hot,first_seen_at,regional_media_detected_at,first_discovered_at,source_published_date,last_seen_at,opening_date_band,is_new_gbp_priority,user_rating_count,google_user_rating_count,is_chain_store,is_large_franchise,is_large_company_branch,search_title,search_snippet,ai_comment'

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]) }
  })
  await Promise.all(workers)
}

/** 1バッチ分の品質を再計算。mode='missing' は未計算のみ、'all' は全件。返り値の remaining>0 なら継続呼び出し。 */
export async function recomputeQualityBatch(admin: any, opts: { limit?: number; mode?: 'missing' | 'all' } = {}): Promise<any> {
  const limit = Math.max(1, Math.min(2000, opts.limit || 800))
  const mode = opts.mode || 'all'
  let q = admin.from('lead_candidates').select(QUALITY_FIELDS).order('quality_computed_at', { ascending: true, nullsFirst: true }).limit(limit)
  if (mode === 'missing') q = admin.from('lead_candidates').select(QUALITY_FIELDS).is('quality_computed_at', null).limit(limit)
  const { data: rows, error } = await q
  if (error) return { ok: false, error: error.message }
  const list: any[] = rows || []
  const nowIso = new Date().toISOString()
  const gradeDist: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 }
  let updated = 0
  await mapLimit(list, 20, async (c) => {
    const qr = computeQuality(c)
    gradeDist[qr.grade] = (gradeDist[qr.grade] || 0) + 1
    const { error: ue } = await admin.from('lead_candidates').update({
      quality_score: qr.score, quality_grade: qr.grade, industry_category: qr.category,
      dedup_key: qr.dedupKey, quality_flags: qr.flags, phone_pref_match: qr.phoneMatch, quality_computed_at: nowIso,
    }).eq('id', c.id)
    if (!ue) updated++
  })
  // 残件数（missingモードのみ意味がある）
  let remaining = 0
  if (mode === 'missing') { const { count } = await admin.from('lead_candidates').select('id', { count: 'exact', head: true }).is('quality_computed_at', null); remaining = count || 0 }
  return { ok: true, scanned: list.length, updated, gradeDist, remaining, mode }
}

/** dedup_key ごとの重複グループサイズを全件に記録（クロスソース重複の可視化用）。 */
export async function recomputeDupGroups(admin: any): Promise<any> {
  // 軽量に id+dedup_key だけ全件取得（ページング）
  const counts = new Map<string, number>()
  const all: { id: string; dedup_key: string | null }[] = []
  let from = 0
  const page = 1000
  for (;;) {
    const { data, error } = await admin.from('lead_candidates').select('id,dedup_key').range(from, from + page - 1)
    if (error) return { ok: false, error: error.message }
    const batch = data || []
    for (const r of batch) { if (r.dedup_key) counts.set(r.dedup_key, (counts.get(r.dedup_key) || 0) + 1) }
    all.push(...batch)
    if (batch.length < page) break
    from += page
  }
  let dupRows = 0, groups = 0
  for (const [, n] of counts) if (n > 1) groups++
  // group>1 のものだけ dup_group_size を更新
  const targets = all.filter((r) => r.dedup_key && (counts.get(r.dedup_key) || 0) > 1)
  await mapLimit(targets, 20, async (r) => {
    await admin.from('lead_candidates').update({ dup_group_size: counts.get(r.dedup_key!) }).eq('id', r.id)
    dupRows++
  })
  // 重複でないものは1にリセット（前回の残骸対策）
  const singles = all.filter((r) => !r.dedup_key || (counts.get(r.dedup_key) || 0) <= 1)
  await mapLimit(singles, 20, async (r) => { await admin.from('lead_candidates').update({ dup_group_size: 1 }).eq('id', r.id) })
  return { ok: true, totalKeys: counts.size, dupGroups: groups, dupRows }
}

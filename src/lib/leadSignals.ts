// ============================================================
// lead_signals 操作＋営業優先度/Web弱点/架電前メモの一括再計算。サーバー専用。
// ============================================================
import { computeSalesPriority, generateCallMemo } from './salesScore.js'
import { classifyWebsite, type WebsiteClass } from './websiteClassify.js'

export interface SignalInput { type: string; source?: string; url?: string; date?: string | null; text?: string; confidence?: number }

/** 1候補にシグナルを追加（重複は signal_type+url で抑止）。signal_count も更新。 */
export async function addSignals(admin: any, candidateId: string, signals: SignalInput[]): Promise<number> {
  if (!candidateId || !signals?.length) return 0
  let added = 0
  for (const s of signals) {
    const { data: ex } = await admin.from('lead_signals').select('id').eq('lead_candidate_id', candidateId).eq('signal_type', s.type).eq('signal_url', s.url || '').limit(1)
    if (ex?.[0]) continue
    const { error } = await admin.from('lead_signals').insert({ lead_candidate_id: candidateId, signal_type: s.type, signal_source: s.source || null, signal_url: s.url || null, signal_date: s.date || null, signal_text: (s.text || '').slice(0, 500), confidence: s.confidence ?? 0.6 })
    if (!error) added++
  }
  const { count } = await admin.from('lead_signals').select('id', { count: 'exact', head: true }).eq('lead_candidate_id', candidateId)
  await admin.from('lead_candidates').update({ signal_count: count || 0 }).eq('id', candidateId).then(() => {}, () => {})
  return added
}

export async function getSignalTypes(admin: any, candidateId: string): Promise<string[]> {
  const { data } = await admin.from('lead_signals').select('signal_type').eq('lead_candidate_id', candidateId)
  return Array.from(new Set((data || []).map((r: any) => r.signal_type).filter(Boolean)))
}

const FIELDS = 'id,name,phone_number,extracted_phone,address,extracted_address,website_url,official_url,instagram_url,industry,extracted_industry,primary_type,google_primary_type,lead_temperature,hot_tier,user_rating_count,google_user_rating_count,is_chain_store,is_large_franchise,dup_group_size,source_published_date,source_date_type,newness_type,regional_media_newness_reason,newness_reason,search_title,opening_date_band,quality_grade'

/** 営業優先度・Web弱点・架電前メモ(HOT-B以上)を1候補に付与。 */
export async function applySalesScore(admin: any, c: any, signalTypes: string[]): Promise<void> {
  const web: WebsiteClass = classifyWebsite(c.website_url || c.official_url, { instagramUrl: c.instagram_url, title: c.search_title, shopName: c.name })
  const ss = computeSalesPriority(c, signalTypes, web)
  const isHotB = c.lead_temperature === 'HOT'
  const upd: any = {
    sales_priority_score: ss.sales_priority_score, sales_priority_grade: ss.sales_priority_grade,
    newness_score: ss.newness_score, contactability_score: ss.contactability_score, business_fit_score: ss.business_fit_score,
    website_weakness_score: ss.website_weakness_score, budget_likelihood_score: ss.budget_likelihood_score,
    chain_exclusion_score: ss.chain_exclusion_score, duplicate_risk_score: ss.duplicate_risk_score,
    website_status: web.status, website_type: web.type, seo_weakness_reason: web.weaknessReasons.join(' / ') || null, hp_sales_angle: web.salesAngles.join(' / ') || null,
  }
  // 架電前メモはHOT-B以上だけ生成（コスト/ノイズ抑制）
  if (isHotB) { upd.call_memo = generateCallMemo(c, signalTypes, web); upd.call_memo_generated_at = new Date().toISOString() }
  await admin.from('lead_candidates').update(upd).eq('id', c.id)
}

/** 一括再計算（既存候補に営業優先度/Web弱点/メモを付与）。signal_typesはlead_signals＋自身の根拠から。 */
export async function recomputeSalesBatch(admin: any, opts: { limit?: number; onlyHot?: boolean } = {}): Promise<any> {
  const limit = Math.max(1, Math.min(2000, opts.limit || 800))
  let q = admin.from('lead_candidates').select(FIELDS).order('sales_priority_score', { ascending: true, nullsFirst: true }).limit(limit)
  if (opts.onlyHot) q = admin.from('lead_candidates').select(FIELDS).eq('lead_temperature', 'HOT').limit(limit)
  const { data: rows, error } = await q
  if (error) return { ok: false, error: error.message }
  const list: any[] = rows || []
  // signal_types をまとめて取得
  const ids = list.map((r) => r.id)
  const sigMap = new Map<string, string[]>()
  if (ids.length) {
    const { data: sigs } = await admin.from('lead_signals').select('lead_candidate_id,signal_type').in('lead_candidate_id', ids)
    for (const s of (sigs || []) as any[]) { const arr = sigMap.get(s.lead_candidate_id) || []; if (!arr.includes(s.signal_type)) arr.push(s.signal_type); sigMap.set(s.lead_candidate_id, arr) }
  }
  const dist: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 }
  let updated = 0, memos = 0
  for (const c of list) {
    const types = sigMap.get(c.id) || []
    try {
      await applySalesScore(admin, c, types)
      const g = computeSalesPriority(c, types).sales_priority_grade
      dist[g] = (dist[g] || 0) + 1
      if (c.lead_temperature === 'HOT') memos++
      updated++
    } catch { /* noop */ }
  }
  return { ok: true, scanned: list.length, updated, memos, gradeDist: dist }
}

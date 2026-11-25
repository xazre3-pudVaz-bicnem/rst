// ============================================================
// 取得元の実績（架電→アポ率）で案件の優先度（一覧のドットの色）を決める。サーバー専用。
//
// なぜ: 従来の優先度は投入経路で固定（連番探索=高 / その他エンジン=中）だったため、色と成果が
//   対応していなかった。実測すると 赤(高)2.2% / 黄(中)1.3% で色の差より取得元の差のほうが大きく、
//   じゃらん観光・体験 9.5% ＞ 食べログ 1.8% ＞ HOLD再補完 1.5% ＞ 台東区保健所 0% だった。
//   「赤から順にかければ成果が出る」並びにするため、実績で色を付け直す。
//
// 付け直しは投入時ではなく定期実行でまとめて行う（投入箇所が14か所に散っており、
// しかも実績は日々変わるので、1か所で全件を再計算するほうが確実）。
// ============================================================

/** この件数以上の架電実績があれば実績で判定する。未満は「中」（未知） */
export const MIN_CALLS_TO_JUDGE = 30
/** アポ率（%）のしきい値 */
export const HIGH_RATE = 3.0
export const LOW_RATE = 1.5

/** 取得元キー: URLはホスト名、それ以外（「HOLD再補完」等のラベル）はそのまま */
export function sourceKeyOf(sourceUrls?: string | null): string {
  const s = String(sourceUrls || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) {
    const host = s.split('//')[1]?.split('/')[0] || ''
    return host.replace(/^(www|s|m|sp)\./i, '').toLowerCase()
  }
  return s.slice(0, 80)
}

/** 実績から優先度を決める */
export function priorityFromRate(calls: number, appos: number): '高' | '中' | '低' {
  if (calls < MIN_CALLS_TO_JUDGE) return '中'          // 判断できる実績がない
  if (appos === 0 && calls >= 100) return '低'          // 100件かけて1件も取れていない＝明確に悪い
  const rate = (appos / calls) * 100
  if (rate >= HIGH_RATE) return '高'
  if (rate < LOW_RATE) return '低'
  return '中'
}

async function fetchAll(admin: any, table: string, cols: string): Promise<any[]> {
  const out: any[] = []
  const page = 1000
  for (let from = 0; from < 300000; from += page) {
    // order 指定なしの range はページがずれて取り逃すので id 昇順を明示
    const { data, error } = await admin.from(table).select(cols).order('id', { ascending: true }).range(from, from + page - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = data || []
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}

/**
 * 取得元ごとの実績を集計して source_performance を更新し、
 * その結果で既存案件の priority（一覧のドットの色）を付け直す。
 * 手動登録（source_urls なし）の案件は営業の判断なので触らない。
 */
export async function refreshSourcePerformance(admin: any): Promise<any> {
  const cases = await fetchAll(admin, 'cases', 'id,source_urls,priority,status')
  const calls = await fetchAll(admin, 'call_logs', 'id,case_id')
  const appos = await fetchAll(admin, 'appointments', 'id,case_id')
  const calledSet = new Set(calls.map((r: any) => r.case_id).filter(Boolean))
  const appoSet = new Set(appos.map((r: any) => r.case_id).filter(Boolean))

  const agg = new Map<string, { label: string; cases: number; calls: number; appos: number }>()
  for (const c of cases) {
    const key = sourceKeyOf(c.source_urls)
    if (!key) continue                                   // 手動登録は対象外
    const e = agg.get(key) ?? { label: key, cases: 0, calls: 0, appos: 0 }
    e.cases++
    if (calledSet.has(c.id)) e.calls++
    if (appoSet.has(c.id)) e.appos++
    agg.set(key, e)
  }

  const nowIso = new Date().toISOString()
  const rows = [...agg.entries()].map(([key, e]) => ({
    src_key: key, label: e.label, cases: e.cases, calls: e.calls, appos: e.appos,
    rate: e.calls ? Math.round((e.appos / e.calls) * 1000) / 10 : 0,
    priority: priorityFromRate(e.calls, e.appos), updated_at: nowIso,
  }))
  for (let i = 0; i < rows.length; i += 200) {
    await admin.from('source_performance').upsert(rows.slice(i, i + 200), { onConflict: 'src_key' }).then(() => {}, () => {})
  }

  // 案件の優先度を付け直す（対象外案件は見ないので触らない）
  const want = new Map(rows.map((r) => [r.src_key, r.priority]))
  const byTarget = new Map<string, string[]>()
  for (const c of cases) {
    if (c.status === '対象外案件') continue
    const key = sourceKeyOf(c.source_urls)
    if (!key) continue
    const target = want.get(key)
    if (!target || c.priority === target) continue
    const list = byTarget.get(target) ?? []
    list.push(c.id)
    byTarget.set(target, list)
  }
  let updated = 0
  for (const [target, ids] of byTarget.entries()) {
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300)
      const { error } = await admin.from('cases').update({ priority: target }).in('id', chunk)
      if (!error) updated += chunk.length
    }
  }
  return {
    ok: true, sources: rows.length, updated,
    high: rows.filter((r) => r.priority === '高').length,
    mid: rows.filter((r) => r.priority === '中').length,
    low: rows.filter((r) => r.priority === '低').length,
    top: rows.filter((r) => r.calls >= MIN_CALLS_TO_JUDGE).sort((a, b) => b.rate - a.rate).slice(0, 8)
      .map((r) => `${r.label} ${r.rate}%(${r.appos}/${r.calls}) ${r.priority}`),
  }
}

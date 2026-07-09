// ============================================================
// ホットスポット（勝ちエリア）抽出。サーバー専用・依存なし（どこからでも安全にimport可）。
// 直近N日でHOT投入が出た市区を集計し、Places/Instagram/ニュース検索の「倍賭け先」を返す。
// 成果が出たエリアには新店が連鎖的に生まれやすい（再開発/商圏の熱）ため、探索を自動で寄せる。
// ============================================================

const CITY_RE = /(?:北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)?([一-龥ぁ-んァ-ヶ]{1,8}?[市区])/

/** 勝ちエリア抽出: 直近days日のHOT投入（重み1）＋アポ/成約になった案件（重み3）で市区を採点し、上位max件を返す。
 *  「投入できた場所」より「売れた場所」を優先して探索を寄せる（アポ実績は最強の地域シグナル）。 */
export async function getHotCities(admin: any, opts: { days?: number; max?: number } = {}): Promise<string[]> {
  const days = Math.max(3, Math.min(60, opts.days ?? 14))
  const max = Math.max(1, Math.min(12, opts.max ?? 8))
  const tally = new Map<string, number>()
  const add = (address: string, w: number) => {
    const m = String(address || '').match(CITY_RE)
    const city = m?.[1] || ''
    if (city && city.length >= 2) tally.set(city, (tally.get(city) || 0) + w)
  }
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const { data } = await admin.from('lead_candidates')
      .select('address')
      .eq('imported_to_cases', true).gte('imported_at', since)
      .not('address', 'is', null).limit(500)
    for (const r of (data || []) as any[]) add(r.address, 1)
  } catch { /* noop */ }
  try {
    // アポ/成約エリアは3倍重み（直近45日に作成された案件のうち成果ステータスのもの）
    const since45 = new Date(Date.now() - 45 * 86400000).toISOString()
    const { data: appo } = await admin.from('cases')
      .select('address')
      .in('status', ['アポ獲得', 'アポ', '仮アポ', '成約', '契約', '契約済み'])
      .gte('created_date', since45).not('address', 'is', null).limit(300)
    for (const r of (appo || []) as any[]) add(r.address, 3)
  } catch { /* noop */ }
  return [...tally.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([c]) => c)
}

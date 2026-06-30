// ============================================================
// 新店探索クエリ生成。HOT条件は緩めず「探し方」を強化するためのもの。
// 新規オープン系クエリを優先し、通常「地域 業種」は低優先で末尾に置く。
// ============================================================

/** 新規オープン系クエリのパターン（優先順。開業予定系＝Google openingDate/FUTURE_OPENINGが出やすい） */
export const NEW_OPEN_PATTERNS = [
  '新規オープン', 'ニューオープン', 'オープン', '新規開業', 'グランドオープン',
  'プレオープン', '開店', '新店舗', '新規開店', '近日オープン',
  'オープン予定', '開業予定', '開店予定', '開院予定',
  '移転オープン', 'リニューアルオープン',
]

/** 業種別の開業表現（整体は「開院」など） */
export function industryOpenWords(industry: string): string[] {
  const i = industry
  if (/整体|整骨院|接骨院|鍼灸|カイロ/.test(i)) return ['新規開院', '開院']
  if (/美容室|理容室|ネイル|まつ毛|まつげ|エステ|サロン/.test(i)) return ['独立開業']
  if (/行政書士|税理士|社労士|司法書士|弁護士|会計/.test(i)) return ['新規開業', '独立開業']
  if (/リフォーム|ハウスクリーニング|不用品|外壁塗装|水道|電気工事|解体/.test(i)) return ['新規開業']
  return []
}

export interface GenQuery {
  query: string
  isNewOpen: boolean
  area: string
  industry: string
}

/**
 * 検索クエリを生成。新規オープン系を全エリア×全業種で先に、通常クエリは末尾。
 * areas は呼び出し側で「駅名→市区町村」の順に並べておくこと（新店が出やすい順）。
 */
export function buildLeadQueries(areas: string[], industries: string[]): GenQuery[] {
  const newOpen: GenQuery[] = []
  const normal: GenQuery[] = []
  for (const area of areas) {
    for (const industry of industries) {
      const patterns = [...NEW_OPEN_PATTERNS, ...industryOpenWords(industry)]
      for (const p of patterns) {
        newOpen.push({ query: `${area} ${p} ${industry}`, isNewOpen: true, area, industry })
      }
      normal.push({ query: `${area} ${industry}`, isNewOpen: false, area, industry })
    }
  }
  return [...newOpen, ...normal]
}

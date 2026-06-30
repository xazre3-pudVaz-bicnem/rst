// ============================================================
// 公式サイトのWeb弱者判定（HP制作・SEO・MEO・AIO提案の角度づけ）。純関数。
// ============================================================
export type WebsiteStatus = 'none' | 'instagram_only' | 'linktree' | 'builder' | 'sns_only' | 'own_domain' | 'unknown'
export interface WebsiteClass {
  status: WebsiteStatus
  type: string                 // wix/jimdo/peraichi/studio/ameba_ownd/google_sites/base/instagram/linktree/own_domain...
  weaknessReasons: string[]
  salesAngles: string[]        // MEO/HP/SEO/AIO 提案角度
}

const BUILDER_PATTERNS: { type: string; re: RegExp; label: string }[] = [
  { type: 'wix', re: /wixsite\.com|\.wix\.com|wix\.com/i, label: 'Wix' },
  { type: 'jimdo', re: /jimdofree\.com|jimdo\.com|\.jimdosite\.com/i, label: 'Jimdo' },
  { type: 'peraichi', re: /peraichi\.com/i, label: 'ペライチ' },
  { type: 'studio', re: /studio\.site|\.studio\.design/i, label: 'STUDIO' },
  { type: 'ameba_ownd', re: /amebaownd\.com|\.amebaownd\.com/i, label: 'Ameba Ownd' },
  { type: 'google_sites', re: /sites\.google\.com/i, label: 'Google Sites' },
  { type: 'base', re: /\.base\.shop|\.thebase\.in|base\.ec/i, label: 'BASE' },
]
const LINKTREE_RE = /lit\.link|linktr\.ee|instabio|profu\.link|lnk\.bio/i
const INSTAGRAM_RE = /instagram\.com/i
const SNS_RE = /facebook\.com|twitter\.com|x\.com|tiktok\.com|threads\.net|line\.me/i

/** website_url（＋Instagram有無・title等）からWeb弱点を判定。HP/MEO/SEO/AIO提案の角度を返す。 */
export function classifyWebsite(websiteUrl?: string | null, opts: { instagramUrl?: string | null; title?: string | null; shopName?: string | null; hasOwnDomainSite?: boolean } = {}): WebsiteClass {
  const url = String(websiteUrl || '').trim()
  const reasons: string[] = []
  const angles: string[] = []
  let status: WebsiteStatus = 'unknown'
  let type = ''

  if (!url) {
    if (opts.instagramUrl) { status = 'instagram_only'; type = 'instagram'; reasons.push('公式サイトなし・Instagramのみ') }
    else { status = 'none'; type = 'none'; reasons.push('公式サイト・SNSが見つからない') }
  } else if (INSTAGRAM_RE.test(url)) { status = 'instagram_only'; type = 'instagram'; reasons.push('公式サイト欄がInstagram') }
  else if (LINKTREE_RE.test(url)) { status = 'linktree'; type = 'linktree'; reasons.push('リンクまとめサービスのみ（lit.link/Linktree等）') }
  else {
    const b = BUILDER_PATTERNS.find((p) => p.re.test(url))
    if (b) { status = 'builder'; type = b.type; reasons.push(`無料/簡易HP作成サービス（${b.label}）`) }
    else if (SNS_RE.test(url)) { status = 'sns_only'; type = 'sns'; reasons.push('SNSページのみ') }
    else { status = 'own_domain'; type = 'own_domain' }
  }

  // titleの弱点（店名だけ・地域/業種なし）
  const title = String(opts.title || '')
  if (status === 'own_domain' && title) {
    if (opts.shopName && title.replace(/\s/g, '') === String(opts.shopName).replace(/\s/g, '')) reasons.push('titleが店名だけ（地域・業種キーワードなし）')
    if (!/[都道府県市区町村]/.test(title)) reasons.push('titleに地域キーワードなし')
  }
  if (status === 'own_domain' && url && !/^https:/i.test(url) && /^http:/i.test(url)) reasons.push('SSL未対応（http）')

  // 提案角度
  if (status === 'none') { angles.push('MEO（Googleマップ）整備', '公式HP新規制作', 'GBP連動') }
  else if (status === 'instagram_only') { angles.push('公式HP新規制作（InstagramはGoogle/AI検索に弱い）', 'MEO連動', 'Instagram×GBP連動') }
  else if (status === 'linktree' || status === 'sns_only') { angles.push('独自ドメイン公式HP制作', 'SEO/MEO整備', 'AI検索対応') }
  else if (status === 'builder') { angles.push('独自ドメインへのHPリニューアル', 'SEO対応', 'MEO連動', 'AI検索（AIO）対応', '予約導線改善') }
  else if (status === 'own_domain') { angles.push('SEO強化', 'MEO強化', 'AIO対応', 'ブログ/構造化データ追加') }

  return { status, type, weaknessReasons: reasons, salesAngles: angles }
}

/** Web弱点スコア（0-100。弱いほど高い＝提案余地が大きい）。 */
export function websiteWeaknessScore(c: WebsiteClass): number {
  switch (c.status) {
    case 'none': return 90
    case 'instagram_only': return 85
    case 'linktree': return 80
    case 'sns_only': return 78
    case 'builder': return 70
    case 'own_domain': return Math.min(55, 25 + c.weaknessReasons.length * 12)
    default: return 40
  }
}

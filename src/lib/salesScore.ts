// ============================================================
// AI営業優先度スコア＋架電前メモ生成。純関数（コスト0・LLM不要の決定的生成）。
// 複数シグナル合算で優先度を上げる。電話なし/住所なしはHOT/上位にしない。
// ============================================================
import { computeQuality } from './leadQuality.js'
import { classifyWebsite, websiteWeaknessScore, type WebsiteClass } from './websiteClassify.js'

export interface SalesScore {
  newness_score: number
  contactability_score: number
  business_fit_score: number
  website_weakness_score: number
  budget_likelihood_score: number
  chain_exclusion_score: number
  duplicate_risk_score: number
  sales_priority_score: number
  sales_priority_grade: 'S' | 'A' | 'B' | 'C'
}

// signal_type ごとの新規性/投資意欲の重み
const NEWNESS_W: Record<string, number> = {
  future_opening: 30, opening_date: 28, new_gbp: 22, portal_published_date: 24, press_release: 22, official_news: 18,
  new_article: 16, job_opening: 20, construction_signal: 24, construction_case: 20, corporation_new: 18, public_permit: 18,
  sns_opening: 16, chamber_new_member: 14, new_review_delta: 18, tenant_property: 22, local_event_vendor: 12, low_review_count: 10,
}
const BUDGET_W: Record<string, number> = { subsidy_awardee: 35, crowdfunding: 30, paid_ads_weak_site: 28, press_release: 12, business_transfer: 14 }

/** 複数シグナル＋品質＋Web弱点から営業優先度を算出。signalTypes は lead_signals.signal_type の配列。 */
export function computeSalesPriority(c: any, signalTypes: string[] = [], web?: WebsiteClass): SalesScore {
  const q = computeQuality(c)
  const phone = c?.phone_number || c?.extracted_phone || ''
  const address = c?.address || c?.extracted_address || ''
  const hasPhone = !!phone, hasAddr = !!address
  const types = Array.from(new Set([...(signalTypes || []), c?.newness_type, c?.source_date_type ? 'portal_published_date' : null].filter(Boolean) as string[]))

  // 新規性: シグナル重みの最大＋本数ボーナス
  let newness = types.reduce((mx, t) => Math.max(mx, NEWNESS_W[t] || 0), 0)
  newness += Math.min(20, Math.max(0, types.length - 1) * 8) // 複数シグナル合算
  if (c?.source_published_date) { const d = (Date.now() - Date.parse(String(c.source_published_date).replace(/\//g, '-'))) / 86400000; if (d <= 7) newness += 16; else if (d <= 30) newness += 8 }
  newness = Math.min(100, newness)

  const contactability = hasPhone ? (q.phoneMatch === 'match' ? 90 : q.phoneMatch === 'mismatch' ? 55 : 78) + (hasAddr ? 8 : 0) : 8
  const businessFit = q.category === 'その他' ? 50 : 72
  const webClass = web || classifyWebsite(c?.website_url || c?.official_url, { instagramUrl: c?.instagram_url, title: c?.search_title, shopName: c?.name })
  const websiteWeak = websiteWeaknessScore(webClass)
  const budget = types.reduce((mx, t) => Math.max(mx, BUDGET_W[t] || 0), 0) + (websiteWeak >= 80 ? 10 : 0)
  const chainExcl = (c?.is_chain_store || c?.is_large_franchise) ? 5 : (Number(c?.user_rating_count || c?.google_user_rating_count || 0) >= 30 ? 25 : 90) // 高いほどチェーンでない
  const dupRisk = Number(c?.dup_group_size || 1) > 1 ? 40 : 90 // 高いほど重複リスク低い

  // 総合: 連絡可能性と新規性を主軸、Web弱点(提案余地)とチェーン除外/重複を加味
  let score = Math.round(contactability * 0.34 + newness * 0.28 + websiteWeak * 0.14 + businessFit * 0.08 + Math.min(budget, 100) * 0.06 + chainExcl * 0.05 + dupRisk * 0.05)
  if (!hasPhone || !hasAddr) score = Math.min(score, 34)            // 電話/住所なしは上位にしない（HOT禁止に整合）
  if (c?.lead_temperature === 'EXCLUDED') score = Math.min(score, 15)
  score = Math.max(0, Math.min(100, score))
  const grade: SalesScore['sales_priority_grade'] = (!hasPhone || !hasAddr) ? 'C' : score >= 78 ? 'S' : score >= 62 ? 'A' : score >= 45 ? 'B' : 'C'

  return {
    newness_score: newness, contactability_score: Math.min(100, contactability), business_fit_score: businessFit,
    website_weakness_score: websiteWeak, budget_likelihood_score: Math.min(100, budget), chain_exclusion_score: chainExcl,
    duplicate_risk_score: dupRisk, sales_priority_score: score, sales_priority_grade: grade,
  }
}

/** 開業への近接度（小さいほど開業に近い）。sweep投入順・開業予定キューの処理順で共用する共通コンパレータ。
 *  なぜ専用関数か: DBのorderだけでは「duo負値がascで先頭に来る」「gradeは辞書順でSが末尾」等の並び崩れが
 *  避けられないため、JS側で開業タイミングへの距離を単一の数直線に射影する。
 *  duo>=0（開業前）はそのまま残日数、開業直後(dso 0〜30)は開業予定45日先の直後に並ぶよう46+dso、
 *  FUTURE_OPENINGで日付不明は「予定30日先」相当とみなし30、開業根拠なしは999。 */
export function openProx(c: { days_until_opening?: number | null; days_since_opening?: number | null; google_business_status?: string | null }): number {
  const duo = c?.days_until_opening == null ? NaN : Number(c.days_until_opening)
  const dso = c?.days_since_opening == null ? NaN : Number(c.days_since_opening)
  if (Number.isFinite(duo) && duo >= 0) return duo
  if (Number.isFinite(dso) && dso >= 0 && dso <= 30) return 46 + dso
  if (c?.google_business_status === 'FUTURE_OPENING') return 30
  return 999
}

const SIGNAL_LABEL: Record<string, string> = {
  future_opening: '開業予定', opening_date: '開業直後', new_gbp: '新規GBP', portal_published_date: 'ポータル公開日が直近', press_release: 'プレスリリース',
  official_news: '公式サイトのオープン告知', new_article: '新店記事', job_opening: 'オープニング求人', construction_signal: '開業準備ワード', construction_case: '内装/看板の施工事例',
  corporation_new: '新設/移転法人', public_permit: '営業許可', sns_opening: 'SNSの新規オープン投稿', chamber_new_member: '商工会新入会員', new_review_delta: '口コミ急増',
  tenant_property: '居抜き/跡地', local_event_vendor: 'イベント出店者', low_review_count: '口コミ少（MEO弱）', subsidy_awardee: '補助金採択', crowdfunding: 'クラウドファンディング',
  business_transfer: '事業承継/リニューアル', instagram_only: 'Instagramのみ', weak_builder_site: '簡易HP利用', website_missing: 'HP未整備', paid_ads_weak_site: '広告出稿中だがHP弱い',
}

/** 架電前メモ生成（HOT-B以上向け・決定的）。なぜ今/根拠/Web弱点/提案/トーク/断り文句/切り返し/追客。 */
export function generateCallMemo(c: any, signalTypes: string[] = [], web?: WebsiteClass): string {
  const name = c?.name && c.name !== '店名未確定' ? c.name : '（店名未確定）'
  const webClass = web || classifyWebsite(c?.website_url || c?.official_url, { instagramUrl: c?.instagram_url, title: c?.search_title, shopName: c?.name })
  const reviews = Number(c?.user_rating_count || c?.google_user_rating_count || 0)
  const sigs = Array.from(new Set(signalTypes)).map((t) => SIGNAL_LABEL[t] || t)
  const pub = c?.source_published_date ? `${c.source_published_date}（ポータル公開日）` : ''
  const angles = webClass.salesAngles.slice(0, 3).join('・')

  const whyNow: string[] = []
  if (pub) whyNow.push(`${pub}で掲載直後の可能性`)
  if (sigs.length) whyNow.push(`新規根拠: ${sigs.slice(0, 4).join('、')}`)
  if (reviews > 0 && reviews <= 5) whyNow.push(`Google口コミ${reviews}件と少なくMEO整備の初動が効きやすい`)
  if (webClass.status !== 'own_domain') whyNow.push(`Webが弱い（${webClass.weaknessReasons[0] || webClass.type}）`)

  const lines = [
    `■ なぜ今架電すべきか`,
    `  ${whyNow.length ? whyNow.join('。') : '新規/新着の候補。電話・住所が取れており接触可能。'}。`,
    `■ 新規性の根拠`,
    `  ${sigs.length ? sigs.join(' / ') : c?.regional_media_newness_reason || c?.newness_reason || '新規掲載候補'}`,
    `■ Web/MEOの弱点`,
    `  状態: ${webClass.status} / 種別: ${webClass.type}${webClass.weaknessReasons.length ? ' / ' + webClass.weaknessReasons.join('、') : ''}${reviews ? ` / 口コミ${reviews}件` : ''}`,
    `■ 提案できるサービス`,
    `  ${angles || 'MEO・HP制作・SEO・AIO'}`,
    `■ 初回架電トーク`,
    `  「${name}様、${pub ? '最近掲載/開業されたとお見受けし' : 'この地域で新しくされていると拝見し'}ご連絡しました。Googleマップや検索で見つけてもらいやすくする${webClass.status === 'instagram_only' ? '公式ホームページとMEOの' : 'MEO/SEOの'}ご提案で、開業初期の集客を後押しできます。」`,
    `■ 想定される断り文句 → 切り返し`,
    `  「今は忙しい」→「3分だけ。今のうちにGoogleの情報を整えると後が楽です」`,
    `  「Instagramで足りている」→「Instagramは検索・AI検索に出にくく、HP+Googleマップで取りこぼしを防げます」`,
    `  「ホームページは持っている」→「${webClass.status === 'builder' ? '簡易作成サービスは検索に弱いので独自ドメイン化を' : '検索/AIに出る形への最適化を'}ご提案できます」`,
    `■ 次回追客タイミング`,
    `  ${pub || c?.opening_date_band === 'future' ? '開業/掲載直後の今が最優先。不在なら3〜5日後に再架電' : '1〜2週間後に再架電。口コミ増加を再確認'}`,
  ]
  return lines.join('\n')
}

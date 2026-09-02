// ============================================================
// 取得元ドメインの恒久除外リスト（サーバー/クライアント共用）
//  ここに入れたドメインは SERP検索・サイト自動発見・地域メディア巡回のすべてで対象外にする。
//  「巡回サイトから消す」だけでは検索クエリ経由で再流入するため、必ずURL単位のガードで止める。
// ============================================================

/** 除外ドメイン（サブドメイン含む。www. は除去して比較） */
export const EXCLUDED_SOURCE_DOMAINS = [
  // ホットペッパー（beauty./www./gourmet 等サブドメイン全部）: 大手ポータル掲載済み＝既に集客支援が入っており対象外
  'hotpepper.jp',
  // 開店閉店.com: 記事が転載中心で一次情報が薄く、抽出精度・鮮度が安定しないため対象外
  'kaiten-heiten.com',
  'kaiten-heiten-24.com',
]

/** URLのホスト名（www.除去・小文字） */
export function hostOfUrl(url: string): string {
  try { return new URL(String(url || '')).host.replace(/^www\./, '').toLowerCase() } catch { return '' }
}

/** 除外ドメイン（またはそのサブドメイン）のURLか */
export function isExcludedSourceUrl(url: string): boolean {
  const h = hostOfUrl(url)
  if (!h) return false
  return EXCLUDED_SOURCE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))
}

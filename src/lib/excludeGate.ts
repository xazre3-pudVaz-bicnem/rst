// ============================================================
// 全AI検索エンジン共通の「営業対象外」ハード除外（同期・ネットワーク不要）。
// 各エンジンがHOT付与前／直接投入前に必ず通すことで、フリーダイヤル・○○店支店・
// 大手/量販/モール・2店舗以上/FC・記事/まとめページ を全ソースで一貫して弾く。
// （口コミ数≥30・最古クチコミ>30日・IGフォロワー≥1000 は要ネットワークのため別ゲート＝importHot/各エンジンで実施）
// ============================================================
import { isTollFreeJp } from './regionalParsers.js'
import { detectBigOrPublicStrong, detectMultiStore, looksLikeBranchStore } from './targetFilter.js'
import { detectChain } from './chainFilter.js'
import { looksLikeArticle } from './leadQuality.js'

/** 営業対象外なら理由文字列、対象なら null。text には reason/snippet/本文など名前以外の根拠テキストを渡す。 */
export function hardExcludeReason(opts: { name?: string | null; phone?: string | null; text?: string | null }): string | null {
  const name = String(opts.name || '').trim()
  const extra = String(opts.text || '')
  const phone = String(opts.phone || '')
  if (phone && isTollFreeJp(phone)) return `フリーダイヤル(${phone})＝店舗直通でない`
  if (looksLikeBranchStore(name)) return '支店/チェーン店（○○店）'
  const strong = detectBigOrPublicStrong(name)
  if (strong.exclude) return `大手/量販/モール(${strong.hit})`
  const multi = detectMultiStore(`${name} ${extra}`.slice(0, 400))
  if (multi.exclude) return `2店舗以上/姉妹店/FC(${String(multi.hit).trim()})`
  if (detectChain(name, extra).definite) return '大手チェーン'
  if (looksLikeArticle(name, extra)) return '記事/まとめページ（実店舗でない）'
  return null
}

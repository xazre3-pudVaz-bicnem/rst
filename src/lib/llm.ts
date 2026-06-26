import { supabase } from './supabaseClient'
import type { ExtractedShop } from './types'

/**
 * Base44 の InvokeLLM(add_context_from_internet=true) の置換。
 * Supabase Edge Function `llm-search` を呼び出す。
 * Edge Function 側で Serper(Web検索) + Anthropic(Claude) を実行し、
 * json_schema に準拠した JSON を返す。
 */

export const SHOP_SCHEMA = {
  type: 'object',
  properties: {
    shops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          address: { type: 'string' },
          phone1: { type: 'string' },
          phone2: { type: 'string' },
          industry: { type: 'string' },
          representative: { type: 'string' },
          hp1: { type: 'string' },
          hp2: { type: 'string' },
          instagram: { type: 'string' },
          source_urls: { type: 'string' },
          memo: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  required: ['shops'],
} as const

export interface InvokeLLMArgs {
  prompt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json_schema?: Record<string, any>
  search_enabled?: boolean
}

export interface LLMShopResult {
  shops: ExtractedShop[]
}

/**
 * Edge Function を呼び出して JSON を取得する。
 * 未設定/失敗時は例外を投げる（呼び出し側でハンドリング）。
 */
export async function invokeLLM<T = unknown>(args: InvokeLLMArgs): Promise<T> {
  const { data, error } = await supabase.functions.invoke('llm-search', {
    body: {
      prompt: args.prompt,
      json_schema: args.json_schema ?? null,
      search_enabled: args.search_enabled ?? true,
    },
  })
  if (error) throw new Error(error.message)
  return data as T
}

/** 店舗抽出用ヘルパー（SHOP_SCHEMA 固定） */
export async function extractShops(prompt: string): Promise<ExtractedShop[]> {
  const result = await invokeLLM<LLMShopResult>({
    prompt,
    json_schema: SHOP_SCHEMA,
    search_enabled: true,
  })
  return result?.shops ?? []
}

// ============================================================
// 検索ソース定義（AutoSearchRunner / MAP / TTP で使用）
// ============================================================

export const KANTO = '東京・神奈川・埼玉・千葉・茨城・栃木・群馬'

const COMMON_RULES = `
【厳守ルール】
- 過去1ヶ月以内にオープン、または今後オープン予定の新規開業店舗のみ
- チェーン店・フランチャイズ・大型施設内テナントは厳格に除外
- 個人経営・独立系のみ対象
- 対象エリアは関東（${KANTO}）のみ
- 店名・住所・電話番号が確認できるもののみ
- 推測や捏造は禁止。確認できた情報のみ返す`

/** 自動検索: ポータルサイト（抜粋。必要に応じ追加可能） */
export const TARGET_SITES = [
  'tabelog.com',
  'hotpepper.jp',
  'beauty.hotpepper.jp',
  'r.gnavi.co.jp',
  'retty.me',
  'minimodel.jp',
  'eparkbeauty.com',
  'beauty.rakuten.co.jp',
  'epark.jp',
  'goo.ne.jp',
  'ekiten.jp',
  'localplace.jp',
  'koem.jp',
  'machikado-fc.com',
  'shinise.tv',
  'opentable.jp',
  'ozmall.co.jp',
  'biyo-times.jp',
  'salonboard.com',
  'reservia.jp',
  'tablecheck.com',
  'pathee.com',
  'navitime.co.jp',
  'mapion.co.jp',
  'its-mo.com',
  'townwork.net',
  'baitoru.com',
  'an-tta.jp',
  'indeed.com',
  'job-medley.com',
  'ida-fa.com',
  'rasik.style',
  'jmty.jp',
  'shopcounter.jp',
  'tenpo.biz',
  'inshokuten.com',
  'tenpos.com',
  'restaurant-tenpo.com',
  'akippa.com',
  'caedu.jp',
  'beautynavi.woman.excite.co.jp',
  'kireisearch.jp',
  'beauty-park.jp',
  'hairlog.jp',
  'minimo.jp',
  'nailbook.jp',
  'b-merit.jp',
  'requ.ameba.jp',
  'coubic.com',
  'storeinfo.jp',
  'open-info.jp',
  'newopen-navi.com',
]

/** 自動検索: Instagram ハッシュタグ（抜粋） */
export const INSTAGRAM_HASHTAGS = [
  '#新規オープン',
  '#新店舗',
  '#オープン準備中',
  '#プレオープン',
  '#グランドオープン',
  '#開業準備',
  '#独立開業',
  '#脱サラ開業',
  '#カフェ開業',
  '#飲食店開業',
  '#美容室開業',
  '#サロン開業',
  '#エステ開業',
  '#ネイルサロンオープン',
  '#まつげエクステサロン',
  '#新規オープン美容室',
  '#新規オープンカフェ',
  '#居酒屋オープン',
  '#ラーメン屋オープン',
  '#パン屋オープン',
  '#整体院開業',
  '#接骨院開業',
  '#トレーニングジムオープン',
  '#パーソナルジムオープン',
  '#焼肉店オープン',
  '#バーオープン',
  '#新規開店',
  '#開店準備',
  '#ニューオープン',
  '#東京新規オープン',
  '#関東新規オープン',
]

/** 自動検索 / Google検索クエリ */
export const GOOGLE_QUERIES = [
  '関東 新規オープン 個人店 飲食',
  '関東 新規オープン 美容室 個人',
  '関東 開業予定 エステサロン',
  '関東 新店舗 オープン予定 整体',
  '関東 独立開業 カフェ 新店',
  '関東 グランドオープン 個人経営',
  '関東 新規オープン ネイルサロン',
  '関東 開業 トレーニングジム 個人',
]

/** MAP検索（Googleマップ開業予定検索）クエリ */
export const MAP_QUERIES = [
  'Googleマップ 関東 開業予定 飲食店',
  'Googleマップ 関東 まもなくオープン 美容室',
  'Googleマップ 関東 オープン予定 エステ',
  'Googleマップ 関東 新規 整体院',
  'Googleマップ 関東 オープン予定 カフェ',
  'Googleマップ 関東 新店舗 居酒屋',
  'Googleマップ 関東 オープン予定 ネイル',
  'Googleマップ 関東 開業予定 パーソナルジム',
]

/** タウンページ（itp.ne.jp）新規掲載検索クエリ */
export const TOWNPAGE_QUERIES = [
  'itp.ne.jp 新規掲載 飲食店 関東',
  'itp.ne.jp 新規掲載 美容室 関東',
  'itp.ne.jp 新規掲載 エステ 関東',
  'itp.ne.jp 新規掲載 整体 関東',
  'itp.ne.jp 新規掲載 カフェ 関東',
  'itp.ne.jp 新規掲載 居酒屋 関東',
  'itp.ne.jp 新規掲載 ネイルサロン 関東',
  'itp.ne.jp 新規掲載 ジム 関東',
]

export function buildPortalPrompt(site: string): string {
  return `「${site}」を情報源として、関東の新規開業店舗を最大5件抽出してください。${COMMON_RULES}`
}

export function buildInstagramPrompt(hashtag: string): string {
  return `Instagramのハッシュタグ「${hashtag}」に関連する、関東の新規開業店舗を最大5件抽出してください。${COMMON_RULES}`
}

export function buildGooglePrompt(query: string): string {
  return `検索キーワード「${query}」で、関東の新規開業店舗を最大5件抽出してください。${COMMON_RULES}`
}

export function buildMapPrompt(query: string): string {
  return `「${query}」の検索結果から、関東の開業予定・新規オープン店舗を最大5件抽出してください。${COMMON_RULES}`
}

export function buildTownpagePrompt(query: string, cutoff: string): string {
  return `「${query}」の検索結果から、タウンページ(itp.ne.jp)に ${cutoff} 以降に新規掲載された店舗を最大5件抽出してください。${COMMON_RULES}
- ${cutoff} より前の掲載は除外`
}

export function buildImportPrompt(url: string): string {
  return `次のURLのWebページからRST CRMの案件情報を1件抽出してください: ${url}
店名(name)・住所(address)・電話番号(phone1, phone2)・業種(industry)・代表者名(representative)・HP(hp1)・メモ(memo)を可能な範囲で埋めてください。確認できない項目は空で構いません。`
}

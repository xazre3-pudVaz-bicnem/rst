// ============================================================
// チェーン店の自動学習（自社データ由来）。サーバー専用。
//
// なぜ必要か: chainFilter の LARGE_CHAIN は手書きの固有名リストなので、地域チェーン・新興チェーン
//   （資さんうどん / 買取大吉 / おそうじ本舗 / Seria 等）は載っていない。支店表記つき（「◯◯ △△店」）
//   なら looksLikeBranchStore が拾うが、支店表記のない本体名で入ってくると素通りする。
//   自社の lead_candidates には同ブランドの支店が大量に溜まっているので、それを根拠に学習する。
//
// 判定根拠: 「<ブランド> <地名>店」形の店名から ブランド部分を取り出し、
//   同じブランドが【3市区町村以上】に出現していればチェーンとみなす。
//   ターゲットは「個人事業主・1店舗の小規模店」なので、3市区町村展開は定義上対象外。
//
// 誤除外の防止（EXCLUDEDは実質復活不能なので誤検知の代償が大きい）:
//   - ブランドは3文字以上。2文字以下は一致範囲が広すぎるため学習しない
//   - 業種語・一般語（居酒屋/カフェ/ラーメン/美容室 等）はブランドとして採用しない
//   - 一致判定は【完全一致のみ】。前方一致にすると「まんぷく」で「まんぷく食堂」を殺すため
// ============================================================

export interface ChainBrand { brand: string; brand_key: string; city_count: number; example_name: string }

/** 比較キー: 全角英数→半角・空白/記号除去・小文字化 */
export function brandKey(s: string): string {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　・&＆'’"”`\-－ー~〜()（）【】\[\]|｜,，.。/／]/g, '')
    .toLowerCase()
}

// ブランドとして採用しない一般語・業種語（これをブランド扱いすると業種まるごと除外になる）
// ※比較は brandKey() を通して行う（長音符を落とすため、生文字列のままでは一致しない）
const GENERIC_BRAND_RAW = [
  '居酒屋', 'カフェ', 'cafe', 'ラーメン', '中華そば', 'そば', 'うどん', '寿司', 'すし', '鮨', '焼肉', '焼鳥', 'やきとり', '串カツ', 'ステーキ',
  '定食', '食堂', 'お食事処', '喫茶', '喫茶店', 'バー', 'bar', 'スナック', 'パブ', 'ダイニング', 'ビストロ', 'バル', '大衆酒場', '個室居酒屋',
  '美容室', '美容院', 'ヘアサロン', 'hair', 'サロン', 'salon', 'ネイル', 'nail', 'アイラッシュ', 'eyelash', 'まつげエクステ', 'エステ', 'エステサロン',
  '整体', '整体院', '整骨院', '接骨院', '鍼灸院', 'カイロプラクティック', 'リラクゼーション', 'リラクゼーションサロン', 'マッサージ',
  'クリニック', '歯科', '歯科医院', '医院', '薬局', '動物病院', 'ジム', 'gym', 'フィットネス', 'パーソナルジム', 'ピラティス', 'pilates', 'ヨガ', 'スタジオ', 'studio',
  'パン', 'ベーカリー', 'bakery', 'ケーキ', '洋菓子', '和菓子', '弁当', '惣菜', '総菜', '八百屋', '精肉店', '魚屋', '酒屋',
  '不動産', '工務店', 'リフォーム', 'クリーニング', '不用品回収', 'レンタルスペース', 'コインランドリー', '写真館', '教室', 'スクール', '塾',
  'ショップ', 'shop', 'store', 'ストア', '雑貨', '雑貨店', '商店', '本店', '支店', '新店舗', 'the', 'and', 'dog', 'pet',
  '株式会社', '有限会社', '合同会社', '一般社団法人', 'google', 'instagram', 'facebook',
]
const GENERIC_BRAND = new Set(GENERIC_BRAND_RAW.map((s) => brandKey(s)))

/**
 * 「<ブランド> <地名>店」形の店名から ブランド部分を取り出す。支店形でなければ ''。
 * 例: 「おそうじ本舗 大宮吉敷店」→「おそうじ本舗」 / 「ラーメン 魁力屋 イオンモール伊丹店」→「ラーメン 魁力屋」
 *
 * 【重要】ブランドと支店の間に空白があるものだけを学習する。
 *   空白なし（「セブンイレブン奈良大宮町1丁目店」）は切れ目が推測になり、
 *   「セブン」のような途中切れブランドを学習してしまう。実在する個人店「セブン」（スナック等18件）を
 *   チェーン扱いで永久除外する事故につながるため、空白区切りのみを根拠にする。
 *   空白なしの支店名は looksLikeBranchStore が別途弾くので取り逃さない。
 */
export function brandFromBranchName(name?: string | null): string {
  let s = String(name || '').trim()
  if (!s || s === '店名未確定') return ''
  s = s.replace(/[（(](?:仮称|仮|新店|NEW\s?OPEN|ニューオープン|オープン予定|近日開店)[)）]\s*$/i, '')
       .replace(/\s*(?:【[^】]*】|＜[^＞]*＞)\s*$/g, '').trim()
  if (!/店$/.test(s)) return ''
  const m = s.match(/^(.*?)[\s　]+[一-龥ぁ-んァ-ヶーｰ〜0-9０-９A-Za-z々ヶ・]{2,12}店$/)
  const brand = (m?.[1] || '').trim()
  if (brand.length < 3) return ''
  if (GENERIC_BRAND.has(brandKey(brand))) return ''
  return brand
}

/** 住所から市区町村を取り出す（都道府県を先に消費する） */
function cityOf(address?: string | null): string {
  const m = String(address || '').match(/(?:北海道|東京都|(?:京都|大阪)府|[一-龥]{2,3}県)?([一-龥ぁ-んァ-ヶ0-9０-９]{1,8}?[市区町村])/)
  return m ? m[1] : ''
}

/** チェーンとみなす最小の市区町村数（ターゲットは1店舗の個人店なので3以上は定義上対象外） */
export const CHAIN_MIN_CITIES = 3

let cache: { at: number; rows: ChainBrand[] } | null = null
const CACHE_MS = 10 * 60 * 1000

/** 学習済みチェーンブランドを読む（10分キャッシュ。テーブル未作成時は空配列） */
export async function loadChainBrands(admin: any): Promise<ChainBrand[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows
  const { data, error } = await admin.from('chain_brands').select('brand,brand_key,city_count,example_name').gte('city_count', CHAIN_MIN_CITIES).limit(5000)
  if (error) { cache = { at: Date.now(), rows: [] }; return [] }
  const rows: ChainBrand[] = (data || []).map((r: any) => ({ brand: r.brand, brand_key: r.brand_key, city_count: r.city_count, example_name: r.example_name || '' }))
  cache = { at: Date.now(), rows }
  return rows
}

/** 店名が学習済みチェーンブランドか（完全一致のみ。前方一致は誤除外が出るので使わない） */
export function matchChainBrand(name: string | null | undefined, brands: ChainBrand[]): ChainBrand | null {
  const k = brandKey(String(name || ''))
  if (k.length < 3) return null
  return brands.find((b) => b.brand_key === k) || null
}

/**
 * lead_candidates / cases の店名を走査して chain_brands を更新する。
 * 支店形の店名からブランドを学習し、3市区町村以上に出現するものをチェーンとして保存。
 */
export async function refreshChainBrands(admin: any): Promise<{ ok: boolean; scanned: number; brands: number; saved: number; error?: string }> {
  const acc = new Map<string, { brand: string; cities: Set<string>; example: string }>()
  const take = (name: string, address: string) => {
    const brand = brandFromBranchName(name)
    if (!brand) return
    const key = brandKey(brand)
    if (key.length < 3) return
    const e = acc.get(key) ?? { brand, cities: new Set<string>(), example: name }
    const ct = cityOf(address)
    if (ct) e.cities.add(ct)
    acc.set(key, e)
  }
  let scanned = 0
  try {
    for (const table of ['lead_candidates', 'cases'] as const) {
      const page = 1000
      for (let from = 0; from < 200000; from += page) {
        // order 指定なしの range はページがずれて取り逃すため id 昇順を明示する
        // （指定なしで走らせたら 580件学習できるはずのブランドが 353件しか拾えなかった）
        const { data, error } = await admin.from(table).select('name,address').order('id', { ascending: true }).range(from, from + page - 1)
        if (error) return { ok: false, scanned, brands: 0, saved: 0, error: error.message }
        const rows = data || []
        for (const r of rows) { take(String(r.name || ''), String(r.address || '')); scanned++ }
        if (rows.length < page) break
      }
    }
    const nowIso = new Date().toISOString()
    const payload = [...acc.entries()]
      .filter(([, e]) => e.cities.size >= CHAIN_MIN_CITIES)
      .map(([key, e]) => ({ brand_key: key, brand: e.brand, city_count: e.cities.size, example_name: e.example.slice(0, 80), source: 'learned', updated_at: nowIso }))
    let saved = 0
    for (let i = 0; i < payload.length; i += 200) {
      const chunk = payload.slice(i, i + 200)
      const { error } = await admin.from('chain_brands').upsert(chunk, { onConflict: 'brand_key' })
      if (!error) saved += chunk.length
    }
    cache = null
    return { ok: true, scanned, brands: acc.size, saved }
  } catch (e: any) {
    return { ok: false, scanned, brands: 0, saved: 0, error: String(e?.message || e) }
  }
}

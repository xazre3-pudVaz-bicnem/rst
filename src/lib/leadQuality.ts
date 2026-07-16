// ============================================================
// リード品質エンジン（全ソース共通）。サーバー/クライアント両用の純関数。
// 目的: 投入リストの「質」を1つのスコア/グレードに集約し、重複・電話/地域の不整合・業種・
//       ネガティブシグナル（閉店/移転/求人/ポータル）を機械的に検出して、架電に値する候補だけを上げる。
// ターゲットは「個人事業主・5人以下の小規模店」。電話で本人に届くことを最重要視する。
// ============================================================

// --- 市外局番 → 都道府県（主要のみ。境界をまたぐ番号があるため「ソフトな整合シグナル」として使う） ---
const AREA_CODE_PREF: Record<string, string> = {
  '011': '北海道', '0123': '北海道', '0134': '北海道', '0138': '北海道', '0143': '北海道', '0144': '北海道', '0155': '北海道', '0166': '北海道',
  '017': '青森県', '0172': '青森県', '0178': '青森県', '019': '岩手県', '0192': '岩手県', '0197': '岩手県',
  '022': '宮城県', '0220': '宮城県', '0223': '宮城県', '0229': '宮城県', '018': '秋田県', '0182': '秋田県', '0185': '秋田県',
  '023': '山形県', '0235': '山形県', '0238': '山形県', '024': '福島県', '0242': '福島県', '0246': '福島県',
  '029': '茨城県', '0280': '茨城県', '0285': '栃木県', '028': '栃木県', '027': '群馬県', '0276': '群馬県', '0277': '群馬県',
  '048': '埼玉県', '049': '埼玉県', '042': '東京都', '043': '千葉県', '047': '千葉県', '04': '千葉県', '0436': '千葉県', '0438': '千葉県',
  '03': '東京都', '045': '神奈川県', '044': '神奈川県', '046': '神奈川県', '0463': '神奈川県', '0465': '神奈川県', '0467': '神奈川県',
  '025': '新潟県', '0254': '新潟県', '0257': '新潟県', '076': '石川県', '0761': '石川県', '0767': '石川県', '0766': '富山県', '0763': '富山県',
  '0776': '福井県', '0770': '福井県', '055': '山梨県', '0551': '山梨県', '0553': '山梨県', '026': '長野県', '0263': '長野県', '0266': '長野県', '0267': '長野県',
  '058': '岐阜県', '0572': '岐阜県', '0584': '岐阜県', '054': '静岡県', '053': '静岡県', '0545': '静岡県', '0550': '静岡県',
  '052': '愛知県', '0561': '愛知県', '0564': '愛知県', '0566': '愛知県', '0568': '愛知県', '059': '三重県', '0594': '三重県', '0598': '三重県',
  '077': '滋賀県', '0748': '滋賀県', '075': '京都府', '0771': '京都府', '0773': '京都府', '06': '大阪府', '072': '大阪府', '0721': '大阪府', '0725': '大阪府',
  '078': '兵庫県', '079': '兵庫県', '0797': '兵庫県', '0798': '兵庫県', '0742': '奈良県', '0743': '奈良県', '0744': '奈良県', '073': '和歌山県', '0736': '和歌山県',
  '0857': '鳥取県', '0859': '鳥取県', '0852': '島根県', '0854': '島根県', '086': '岡山県', '0863': '岡山県', '0866': '岡山県',
  '082': '広島県', '084': '広島県', '0823': '広島県', '083': '山口県', '0827': '山口県', '0834': '山口県',
  '088': '徳島県', '0883': '徳島県', '087': '香川県', '0877': '香川県', '089': '愛媛県', '0897': '愛媛県', '0898': '愛媛県',
  '0888': '高知県', '0880': '高知県', '092': '福岡県', '093': '福岡県', '0940': '福岡県', '0942': '福岡県', '0944': '福岡県',
  '0952': '佐賀県', '0954': '佐賀県', '095': '長崎県', '0956': '長崎県', '0957': '長崎県', '096': '熊本県', '0964': '熊本県', '0968': '熊本県',
  '097': '大分県', '0972': '大分県', '0977': '大分県', '0985': '宮崎県', '0982': '宮崎県', '0986': '宮崎県',
  '099': '鹿児島県', '0993': '鹿児島県', '0995': '鹿児島県', '098': '沖縄県', '0980': '沖縄県',
}
const PREF_RE = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/

export function onlyDigits(s?: string | null): string { return String(s || '').replace(/[^\d]/g, '') }

/** 電話番号の市外局番から都道府県を推定（固定電話のみ）。携帯/IP/フリーダイヤルは null。 */
export function phonePrefecture(phone?: string | null): string | null {
  const d = onlyDigits(phone)
  if (!d || !d.startsWith('0')) return null
  if (/^0[789]0/.test(d) || /^050/.test(d) || /^(0120|0800|0570)/.test(d)) return null // 携帯/IP/フリーダイヤル
  for (let len = 4; len >= 2; len--) { const code = d.slice(0, len); if (AREA_CODE_PREF[code]) return AREA_CODE_PREF[code] }
  return null
}

/** 住所文字列から都道府県を抽出。 */
export function addressPrefecture(address?: string | null): string | null {
  const m = String(address || '').match(PREF_RE)
  return m ? m[1] : null
}

/** AREA_CODE_PREF で実際にヒットした局番を返す（県境MA判定に使う）。 */
function matchedAreaCode(phone?: string | null): string | null {
  const d = onlyDigits(phone)
  if (!d || !d.startsWith('0')) return null
  if (/^0[789]0/.test(d) || /^050/.test(d) || /^(0120|0800|0570)/.test(d)) return null
  for (let len = 4; len >= 2; len--) { const code = d.slice(0, len); if (AREA_CODE_PREF[code]) return code }
  return null
}

/**
 * 複数県にまたがる市外局番（MA）と、その候補県。
 * AREA_CODE_PREF は1局番=1県の決め打ちのため、県境MAでは電話も住所も正しい店が「不一致」と誤判定され
 * HOLDへ降格していた（降格すると hot_tier が消え、sweepはHOTしか拾わないので自動復帰もしない）。
 * 実害の確認例: 埼玉県所沢市 04-29xx → 表の'042'に先に当たり東京都判定 / 埼玉県飯能市 042-97x → 東京都 /
 *   富山市 076-441 → 石川県 / 宇治市 0774 → 滋賀県 / 沼津 055-951・熱海 0557 → 山梨県。
 * これらは候補県に含まれれば match、含まれなくても mismatch にはせず unknown（＝降格させない）。
 * 表が不完全な可能性がある領域で、正当な店を落とす方が損失が大きいため。
 */
const CROSS_PREF_AREA_CODES: Record<string, string[]> = {
  '04': ['千葉県', '埼玉県'],
  '042': ['東京都', '神奈川県', '埼玉県'],
  '055': ['山梨県', '静岡県'],
  '0557': ['静岡県'],
  '076': ['石川県', '富山県'],
  '077': ['滋賀県', '京都府'],
  '0774': ['京都府'],
}

export type PhoneMatch = 'match' | 'mismatch' | 'mobile' | 'unknown'
/** 電話の市外局番と住所の都道府県が一致するか（質の重要シグナル。不一致＝本社番号/誤データの疑い）。 */
export function phoneAddressMatch(phone?: string | null, address?: string | null): PhoneMatch {
  const d = onlyDigits(phone)
  if (d && (/^0[789]0/.test(d) || /^050/.test(d))) return 'mobile'
  const pp = phonePrefecture(phone), ap = addressPrefecture(address)
  if (!pp || !ap) return 'unknown'
  const code = matchedAreaCode(phone)
  const spans = code ? CROSS_PREF_AREA_CODES[code] : null
  if (spans) return spans.includes(ap) ? 'match' : 'unknown' // 県境MAは不一致と断定しない
  return pp === ap ? 'match' : 'mismatch'
}

// --- 業種オートタグ ---
export type IndustryCategory = '飲食' | '美容・サロン' | '医療・治療' | '小売・物販' | '暮らし・サービス' | '宿泊・観光' | 'その他'
const CAT_RE: { cat: IndustryCategory; re: RegExp }[] = [
  { cat: '飲食', re: /(飲食|レストラン|カフェ|喫茶|居酒屋|ダイニング|食堂|寿司|鮨|焼肉|焼鳥|ラーメン|そば|うどん|バル|ビストロ|料理|料亭|割烹|ステーキ|鉄板|お好み焼|たこ焼|パン|ベーカリー|スイーツ|ケーキ|パティスリー|バー|BAR|酒場|ホルモン|餃子|中華|韓国料理|イタリアン|フレンチ|定食|弁当|テイクアウト)/i },
  { cat: '美容・サロン', re: /(美容|ヘアサロン|美容室|理容|床屋|ネイル|まつげ|まつエク|アイラッシュ|エステ|脱毛|リラク|マッサージ|整体|もみほぐし|サロン|スパ|ブライダル|メイク|ヘアメイク|バーバー|barber|hair|nail|salon)/i },
  { cat: '医療・治療', re: /(クリニック|医院|内科|外科|歯科|皮膚科|眼科|耳鼻|小児科|整形外科|形成外科|心療|精神科|産婦人科|泌尿器|病院|診療所|接骨|整骨|鍼灸|はり|きゅう|カイロ|動物病院|獣医|薬局|調剤)/i },
  { cat: '小売・物販', re: /(店|ショップ|shop|store|物販|販売|雑貨|アパレル|洋服|古着|セレクト|花屋|生花|フラワー|書店|本屋|酒店|米店|精肉|鮮魚|青果|八百屋|時計|宝石|メガネ|眼鏡|家具|インテリア)/i },
  { cat: '宿泊・観光', re: /(ホテル|旅館|民宿|ペンション|ゲストハウス|温泉|観光|スポット|公園|美術館|博物館|キャンプ|グランピング)/i },
  { cat: '暮らし・サービス', re: /(整備|修理|クリーニング|不動産|工務店|リフォーム|塗装|電気|設備|清掃|塾|教室|スクール|ジム|フィットネス|ヨガ|ピラティス|写真|スタジオ|印刷|士業|行政書士|税理士|社労士|司法書士|弁護士|デザイン|車|自動車|ペット|トリミング)/i },
]
export function categorizeIndustry(...texts: (string | null | undefined)[]): IndustryCategory {
  const t = texts.filter(Boolean).join(' ')
  for (const { cat, re } of CAT_RE) if (re.test(t)) return cat
  return 'その他'
}

// --- ネガティブシグナル（投入すべきでない／要注意） ---
const NEGATIVE_RE = /(閉店|閉院|廃業|移転(しました|済|オープン)?|閉鎖|営業終了|テナント募集|物件募集|跡地|跡)/
const PORTAL_RE = /(求人|採用|アルバイト募集|スタッフ募集|ポータル|まとめ|ランキング|比較サイト|一覧|検索結果|食べログ|ホットペッパー|エキテン|ぐるなび|Retty|ヒトサラ)/
// 実店舗ではなく記事/ニュース/まとめ/イベント告知（映画・ドラマ・特集・ランキング等）
// ※「話題」「公開」「プレゼント」は正当な開店記事に頻出するため入れない
//   （「話題の新店◯◯がオープン」「オープン記念プレゼント」「メニュー公開」等で実店舗候補が落ちていた）。
const ARTICLE_LIKE_RE = /(映画|ドラマ|アニメ|ニュース|特集|まとめ|ランキング|一覧|上映|イベント情報|コラム|レビュー|について考え|とは\?|選び方|おすすめ\d|人気\d+選|注目スポット|観光情報|キャンペーン情報|号外|速報)/
/** タイトル/店名が「実店舗ではなく記事・ニュース・まとめ」に見えるか。 */
export function looksLikeArticle(...texts: (string | null | undefined)[]): boolean {
  const t = texts.filter(Boolean).join(' ')
  return ARTICLE_LIKE_RE.test(t)
}
// 「地域情報ブログ」等はサイトのタグライン（例: つうしん系の<title>末尾「千葉県松戸市の地域情報ブログ」）で、
// 住所の形をしているが実店舗の所在地ではない。素通りすると偽住所が案件に投入される。
const ADDR_JUNK_RE = /(まとめ|一覧|特集|最新|ランキング|エリア別|カテゴリ|の記事|レポート|ニュース|話題|イベント|地域情報|情報ブログ|ブログ|情報サイト|ポータル|タウン情報)/
const PREF_G = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/g
/** 住所が実在店舗のものか（都道府県＋具体地点。カテゴリ/ナビ文言・複数都道府県連結はNG＝記事のパンくず等）。 */
export function isRealStoreAddress(addr?: string | null): boolean {
  const s = String(addr || '').trim()
  if (!s) return false
  if (ADDR_JUNK_RE.test(s)) return false                       // 「最新まとめ」等のカテゴリ文言を含む
  const prefs = s.match(PREF_G) || []
  if (prefs.length >= 2) return false                          // 都道府県が2つ以上＝カテゴリナビ/パンくず
  if (!prefs.length) return false                             // 都道府県が無い
  // 「・」等で複数エリアが並ぶ（見沼区・岩槻区・浦和区・緑区 のようなカテゴリ列挙）はNG。
  // ※以前は [区市町村] の総数>=3 で弾いていたが、政令市の正規住所は「市＋区＋◯◯町」で必ず3つに達するため
  //   さいたま市大宮区桜木町… 等の実住所を巻き込み、主要商圏の個人店が恒久的に投入されなかった。
  //   列挙の本質は「区切り文字で並ぶこと」なので、区切りを伴う出現のみを数える。
  if ((s.match(/[区市町村][・、／/]/g) || []).length >= 2) return false
  return true
}

// ============================================================
// バーチャルオフィス/レンタルオフィス住所の検出。
// 開業届・登記だけの「実店舗なし開業」はMEO/HP営業の対象外（来店ビジネスでない）。
// definite: ブランド名/確定語（そこに実店舗が存在しないことがほぼ確実）→ exclude 相当。
// suspect(hit&&!definite): 汎用語（実店舗を構えるコワーキング併設等の例外があり得る）→ hold 相当。
// ※「レンタルサロン」は絶対に入れないこと: 間借りで開業する個人サロンは主要ターゲットそのもの。
// ============================================================
// definiteは「その語が住所に出たら登記用でほぼ確実」な語のみ（EXCLUDEDは復活しないため誤爆コストが高い）。
// レゾナンス/Karigo等の一般語と衝突しうるブランド名はsuspect（HOLD=手動確認可能）に留める
const VIRTUAL_OFFICE_DEFINITE_RE = /(バーチャルオフィス|ヴァーチャルオフィス|私書箱|リージャス|Regus|WeWork|ウィーワーク|DMMバーチャルオフィス|GMOオフィスサポート|ワンストップビジネスセンター|ナレッジソサエティ|METSオフィス|ユナイテッドオフィス)/i
const VIRTUAL_OFFICE_SUSPECT_RE = /(レンタルオフィス|シェアオフィス|コワーキングスペース|コワーキング|サービスオフィス|Karigo|カリゴ|(?:^|[\s　])気付|c\/o\s)/i
/** 住所がバーチャルオフィス/登記用オフィスの可能性。definite=確定語 / hit&&!definite=疑い（要確認）。 */
export function isVirtualOfficeAddress(addr?: string | null): { hit: boolean; definite: boolean; word: string } {
  const s = String(addr || '')
  if (!s) return { hit: false, definite: false, word: '' }
  const d = s.match(VIRTUAL_OFFICE_DEFINITE_RE)
  if (d) return { hit: true, definite: true, word: d[0] }
  const su = s.match(VIRTUAL_OFFICE_SUSPECT_RE)
  if (su) return { hit: true, definite: false, word: su[0].trim() }
  return { hit: false, definite: false, word: '' }
}

/** ネガティブ/ポータル系シグナルを検出（閉店・移転・求人・ポータルそのもの）。店名・住所・短いスニペットに対して使う。 */
export function detectNegative(text?: string | null): { hit: boolean; closed: boolean; portal: boolean; reason: string } {
  const t = String(text || '')
  const closed = NEGATIVE_RE.test(t)
  const portal = PORTAL_RE.test(t)
  if (closed) return { hit: true, closed, portal, reason: `閉店/移転/募集の疑い（${t.match(NEGATIVE_RE)?.[0]}）` }
  if (portal) return { hit: true, closed, portal, reason: `求人/ポータル系の疑い（${t.match(PORTAL_RE)?.[0]}）` }
  return { hit: false, closed: false, portal: false, reason: '' }
}

// --- 重複キー（クロスソース統合） ---
export function normalizeName(name?: string | null): string {
  return String(name || '').replace(/[\s　]/g, '').replace(/[（(].*?[)）]/g, '').replace(/(店|本店|支店|営業所|株式会社|有限会社|合同会社)$/g, '').toLowerCase()
}
/** 店名がプレースホルダ/地名だけ等で、重複統合に使えないか（誤統合防止）。 */
export function isPlaceholderName(raw?: string | null): boolean {
  const s = String(raw || '')
  if (!s.trim()) return true
  if (/店名未確定|新店候補|未確定|候補$/.test(s)) return true
  // 都道府県を除いた残りが「地名（○○市/区/町/村/郡）」だけ → 実質は住所であって店名ではない
  const noPref = s.replace(PREF_RE, '').trim()
  if (/^[一-龥ぁ-んァ-ヶヶ]{1,6}(都|道|府|県|市|区|町|村|郡)$/.test(noPref)) return true
  // 都道府県・市区町村・数字・記号を除いて2文字未満なら「実質名前なし」。
  // ※以前は [市区町村丁目番地号通り駅前] と「1文字ずつの文字クラス」で除去していたため、
  //   「村上」→「上」/「前田」→「田」/「駅前食堂」→「食堂」のように実店名が削られて
  //   プレースホルダ扱いになり、dedupKey が id: に落ちて重複投入を防げなくなっていた。
  //   住所要素は「語」として除く。
  const stripped = s
    .replace(PREF_RE, '')
    .replace(/[一-龥ぁ-んァ-ヶ]{1,6}[市区町村]/g, '')  // 「◯◯市」等の地名（単独の市/村は削らない）
    .replace(/[0-9０-９]+/g, '')
    .replace(/(丁目|番地|駅前|通り)/g, '')
    .replace(/[\s　\-－—]/g, '')
  return stripped.length < 2
}
/** クロスソース重複キー: 電話（固定/携帯の下10桁）優先、無ければ 正規化店名＋都道府県。
 *  プレースホルダ名（店名未確定/新店候補/地名のみ）はid別キーにして誤統合しない。 */
export function dedupKey(c: any): string {
  const phone = onlyDigits(c?.phone_number || c?.phone_normalized || c?.extracted_phone || c?.enriched_phone)
  if (phone.length >= 10) return `tel:${phone.slice(-10)}`
  if (phone.length === 9) return `tel:${phone}`
  const rawName = c?.name || c?.extracted_shop_name
  if (isPlaceholderName(rawName)) return `id:${c?.id || Math.random().toString(36).slice(2)}`
  const name = normalizeName(rawName)
  const pref = addressPrefecture(c?.address || c?.extracted_address) || ''
  return `nm:${name}|${pref}`
}

export interface QualityResult {
  score: number          // 0-100
  grade: 'S' | 'A' | 'B' | 'C' | 'D'
  category: IndustryCategory
  dedupKey: string
  phoneMatch: PhoneMatch
  flags: string[]        // 注意フラグ
  factors: string[]      // 加点/減点の内訳
}

/** リード品質を総合スコア化（架電に値するか）。電話で本人に届く・新しい・小規模・地域整合を高評価。 */
export function computeQuality(c: any): QualityResult {
  const name = c?.name || c?.extracted_shop_name || ''
  const address = c?.address || c?.extracted_address || ''
  const phone = c?.phone_number || c?.extracted_phone || c?.enriched_phone || ''
  const temp = c?.lead_temperature
  const flags: string[] = []
  const factors: string[] = []
  let s = 0
  const dPhone = onlyDigits(phone)
  const hasValidPhone = dPhone.length >= 9 && /^0/.test(dPhone)
  const isFixed = hasValidPhone && !/^0[789]0/.test(dPhone) && !/^050/.test(dPhone)
  if (hasValidPhone) { s += 26; factors.push('電話あり+26') } else { s -= 24; flags.push('電話なし（架電不可）'); factors.push('電話なし-24') }
  if (isFixed) { s += 6; factors.push('固定電話+6') }
  if (address) { s += 14; factors.push('住所あり+14') } else { s -= 8; flags.push('住所なし'); factors.push('住所なし-8') }
  const nameConfirmed = !!name && name !== '店名未確定' && !c?.name_unconfirmed_hot
  if (nameConfirmed) { s += 12; factors.push('店名確定+12') } else { flags.push('店名未確定'); factors.push('店名未確定±0') }
  // 電話×住所の地域整合
  const pm = phoneAddressMatch(phone, address)
  if (pm === 'match') { s += 10; factors.push('電話と住所の地域一致+10') }
  else if (pm === 'mismatch') { s -= 10; flags.push('電話の市外局番が住所と不一致（本社番号/誤データ疑い）'); factors.push('地域不一致-10') }
  // 温度
  if (temp === 'HOT') { s += 12; factors.push('HOT+12') } else if (temp === 'HOLD') { s += 3; factors.push('HOLD+3') } else if (temp === 'EXCLUDED') { s -= 20; factors.push('EXCLUDED-20') }
  if (c?.hot_tier === 'A') { s += 6; factors.push('HOT-A+6') }
  // 新しさ
  const seen = c?.first_seen_at || c?.regional_media_detected_at || c?.first_discovered_at || c?.source_published_date || c?.last_seen_at
  if (seen) { const days = (Date.now() - Date.parse(String(seen).replace(/\//g, '-'))) / 86400000; if (days <= 7) { s += 10; factors.push('直近7日以内+10') } else if (days <= 30) { s += 5; factors.push('30日以内+5') } else if (days > 365) { s -= 4; factors.push('1年超-4') } }
  // 開業/掲載の新しさ根拠
  if (c?.opening_date_band === 'future' || c?.opening_date_band === 'd0_90' || c?.is_new_gbp_priority) { s += 8; factors.push('新規開業/新着+8') }
  // 確立済み大型（口コミ多い）
  const reviews = Number(c?.user_rating_count || c?.google_user_rating_count || 0)
  if (reviews >= 30) { s -= 12; flags.push(`口コミ${reviews}件（確立済み大型の疑い）`); factors.push('口コミ多-12') } else if (reviews > 0 && reviews < 30) { s += 3; factors.push('口コミ少+3') }
  // チェーン/大手/公共
  if (c?.is_chain_store || c?.is_large_franchise || c?.is_large_company_branch) { s -= 16; flags.push('チェーン/大手/支店'); factors.push('チェーン-16') }
  // ネガティブ
  const neg = detectNegative(`${name} ${c?.search_title || ''} ${c?.search_snippet || ''} ${c?.ai_comment || ''}`)
  if (neg.closed) { s -= 30; flags.push(neg.reason); factors.push('閉店/移転-30') }
  else if (neg.portal) { s -= 10; flags.push(neg.reason); factors.push('ポータル系-10') }
  const score = Math.max(0, Math.min(100, Math.round(s)))
  const grade: QualityResult['grade'] = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : score >= 35 ? 'C' : 'D'
  return { score, grade, category: categorizeIndustry(name, c?.industry, c?.extracted_industry, c?.primary_type, c?.google_primary_type), dedupKey: dedupKey(c), phoneMatch: pm, flags, factors }
}

import { INDUSTRIES } from './constants'

type Industry = (typeof INDUSTRIES)[number]

/**
 * 業種の正規分類器。AI投入（店舗ディレクトリ / Google Places / LLM抽出）の
 * 業種を、フォームの選択肢（constants.INDUSTRIES）と一致する正規の値へ揃える。
 *
 * 重要:
 * - 出力は必ず INDUSTRIES のいずれか、または '' （不明）。
 * - 具体的な業種を上に並べる（find は先頭一致優先）。広すぎる語（飲食/小売）は末尾。
 * - 日本語・英語（Google Places の types/primaryType）双方のキーワードを含む。
 */
const CANON: { name: Industry; re: RegExp }[] = [
  // --- 医療・治療（具体 → 一般） ---
  { name: '歯科', re: /歯科|デンタル|矯正歯科|dental|dentist/i },
  { name: '整骨院・接骨院', re: /整骨院|接骨院/ },
  { name: '鍼灸院', re: /鍼灸|はり灸|はり・きゅう|acupuncture/i },
  { name: '整体', re: /整体|カイロ|chiropract|osteopath|physiotherap/i },
  { name: 'クリニック', re: /クリニック|医院|診療所|内科|外科|皮膚科|眼科|耳鼻|小児科|整形外科|心療内科|美容外科|美容皮膚科|clinic|hospital|\bdoctor\b/i },
  // --- 美容（まつ毛/ネイルを美容室より先に） ---
  { name: 'まつ毛サロン', re: /まつ毛|まつげ|マツエク|eyelash|アイラッシュ/i },
  { name: 'ネイル', re: /ネイル|nail/i },
  { name: 'エステ', re: /エステ|脱毛|フェイシャル|痩身/ },
  { name: 'リラクゼーション', re: /リラクゼーション|リラク|もみほぐし|リフレ|\bspa\b|wellness/i },
  { name: 'マッサージ', re: /マッサージ|指圧|massage/i },
  { name: '理容室', re: /理容|床屋|バーバー|barber/i },
  { name: '美容室', re: /美容室|ヘアサロン|美容院|hair\s?salon|hairdresser|beauty_salon|\bhair\b/i },
  // --- 運動 ---
  { name: 'ジム・フィットネス', re: /ジム|フィットネス|パーソナルトレ|ピラティス|ヨガ|加圧|\bgym\b|fitness|yoga|pilates/i },
  // --- ペット ---
  { name: 'ペット', re: /動物病院|獣医|ペットサロン|トリミング|ペットホテル|ペット|veterinary|\bpet\b/i },
  // --- 教育 ---
  { name: '学習塾', re: /学習塾|進学塾|個別指導|(?<![事美])塾/ },
  { name: 'スクール', re: /教室|スクール|習い事|レッスン|アカデミー|音楽教室|英会話|ダンススクール|\bschool\b|academy/i },
  // --- 士業・不動産・住まい ---
  { name: '士業', re: /行政書士|税理士|社会保険労務士|社労士|司法書士|弁護士|会計事務所|法律事務所|特許事務所|lawyer|accounting|legal|attorney/i },
  { name: '不動産', re: /不動産|賃貸仲介|real_estate/i },
  { name: '外壁塗装', re: /外壁塗装|塗装/ },
  { name: 'ハウスクリーニング', re: /ハウスクリーニング|エアコンクリーニング/ },
  { name: '不用品回収', re: /不用品回収|遺品整理|廃品回収/ },
  { name: 'リフォーム', re: /リフォーム|リノベーション|renovation/i },
  { name: '建設', re: /建設|工務店|建築|土木|解体工事|外構/ },
  // --- その他業種 ---
  { name: '自動車', re: /自動車|カー用品|車検|板金|中古車|カーディーラー|car_dealer|car_repair/i },
  { name: '介護・福祉', re: /介護|デイサービス|訪問看護|福祉|グループホーム|老人ホーム/ },
  { name: '宿泊', re: /ホテル|旅館|民宿|ゲストハウス|ペンション|グランピング|hotel|lodging/i },
  { name: 'レジャー', re: /遊園地|カラオケ|ボウリング|ネットカフェ|漫画喫茶|amusement|entertainment/i },
  // --- 飲食（広いので末尾側） ---
  {
    name: '飲食',
    re: /飲食|グルメ|カフェ|cafe|coffee|珈琲|喫茶|ラーメン|中華|餃子|居酒屋|酒場|バル|ダイニング|焼き?鳥|焼肉|ホルモン|パン屋|ベーカリー|bakery|ケーキ|パティスリー|スイーツ|洋菓子|和菓子|ジェラート|クレープ|レストラン|食堂|寿司|鮨|そば|うどん|定食|弁当|惣菜|カレー|ビストロ|イタリアン|フレンチ|韓国料理|タイ料理|ステーキ|restaurant|\bfood\b|dining|izakaya|\bpub\b|ramen|noodle|\bmeal\b|\bbar\b/i,
  },
  // --- 小売（最も一般的なので最後） ---
  { name: '小売', re: /雑貨|セレクトショップ|アパレル|古着|洋服|インテリアショップ|書店|本屋|花屋|フラワー|生花|フローリスト|ギャラリー|画廊|物販|\bstore\b|\bshop\b|retail/i },
]

const CANON_SET = new Set<string>(INDUSTRIES as readonly string[])

/**
 * テキスト（店名・記事タイトル・Google Places types など）から正規の業種を推定。
 * 該当なしは '' を返す（不明は空欄のままにし、誤分類しない方針）。
 */
export function classifyIndustry(text: string): Industry | '' {
  const s = String(text || '')
  if (!s) return ''
  return CANON.find((m) => m.re.test(s))?.name ?? ''
}

/**
 * 既存/外部（LLM抽出など）の業種ラベルを正規の値へ正規化。
 * すでに正規値ならそのまま、そうでなければキーワード分類にかける。マップ不能は ''。
 */
export function normalizeIndustry(raw?: string | null): Industry | '' {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (CANON_SET.has(s)) return s as Industry
  return classifyIndustry(s)
}

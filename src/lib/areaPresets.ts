// ============================================================
// エリアプリセット（一都三県を全市区町村に展開）
// 「探し方」改善用。HOT条件は別途 leadScoring 側で厳格に判定する。
// 必須=全市区町村。駅名は補助。毎日全部回さずローテーション巡回する。
// 各エリアは都県名を前置して曖昧さを排除（例: 東京都府中市 と 広島県府中市）。
// ============================================================

// ---- 東京都：23区＋多摩26市＋西多摩郡（島しょ部は除外） ----
const TOKYO_WARDS = ['千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区', '江東区', '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区', '杉並区', '豊島区', '北区', '荒川区', '板橋区', '練馬区', '足立区', '葛飾区', '江戸川区']
const TOKYO_CITIES = ['八王子市', '立川市', '武蔵野市', '三鷹市', '青梅市', '府中市', '昭島市', '調布市', '町田市', '小金井市', '小平市', '日野市', '東村山市', '国分寺市', '国立市', '福生市', '狛江市', '東大和市', '清瀬市', '東久留米市', '武蔵村山市', '多摩市', '稲城市', '羽村市', 'あきる野市', '西東京市', '瑞穂町', '日の出町', '檜原村', '奥多摩町']
const TOKYO_AREAS = [...TOKYO_WARDS, ...TOKYO_CITIES].map((a) => `東京都${a}`)
const TOKYO_STATIONS = ['新宿', '渋谷', '池袋', '東京', '品川', '上野', '北千住', '中野', '吉祥寺', '立川', '町田', '蒲田', '錦糸町', '亀有', '金町', '新小岩', '立石', '綾瀬']

// ---- 神奈川県：全市区町村（政令市は区単位） ----
const KANAGAWA_YOKOHAMA = ['鶴見区', '神奈川区', '西区', '中区', '南区', '保土ケ谷区', '磯子区', '金沢区', '港北区', '戸塚区', '港南区', '旭区', '緑区', '瀬谷区', '栄区', '泉区', '青葉区', '都筑区'].map((w) => `横浜市${w}`)
const KANAGAWA_KAWASAKI = ['川崎区', '幸区', '中原区', '高津区', '多摩区', '宮前区', '麻生区'].map((w) => `川崎市${w}`)
const KANAGAWA_SAGAMIHARA = ['緑区', '中央区', '南区'].map((w) => `相模原市${w}`)
const KANAGAWA_CITIES = ['横須賀市', '平塚市', '鎌倉市', '藤沢市', '小田原市', '茅ヶ崎市', '逗子市', '三浦市', '秦野市', '厚木市', '大和市', '伊勢原市', '海老名市', '座間市', '南足柄市', '綾瀬市', '葉山町', '寒川町', '大磯町', '二宮町', '中井町', '大井町', '松田町', '山北町', '開成町', '箱根町', '真鶴町', '湯河原町', '愛川町', '清川村']
const KANAGAWA_AREAS = [...KANAGAWA_YOKOHAMA, ...KANAGAWA_KAWASAKI, ...KANAGAWA_SAGAMIHARA, ...KANAGAWA_CITIES].map((a) => `神奈川県${a}`)
const KANAGAWA_STATIONS = ['横浜', '川崎', '武蔵小杉', '藤沢', '大和', '海老名', '本厚木', '横須賀中央', '小田原', '溝の口', '上大岡', '戸塚']

// ---- 埼玉県：全市区町村（さいたま市は区単位、主要町を含む） ----
const SAITAMA_CITY = ['西区', '北区', '大宮区', '見沼区', '中央区', '桜区', '浦和区', '南区', '緑区', '岩槻区'].map((w) => `さいたま市${w}`)
const SAITAMA_CITIES = ['川越市', '熊谷市', '川口市', '行田市', '秩父市', '所沢市', '飯能市', '加須市', '本庄市', '東松山市', '春日部市', '狭山市', '羽生市', '鴻巣市', '深谷市', '上尾市', '草加市', '越谷市', '蕨市', '戸田市', '入間市', '朝霞市', '志木市', '和光市', '新座市', '桶川市', '久喜市', '北本市', '八潮市', '富士見市', '三郷市', '蓮田市', '坂戸市', '幸手市', '鶴ヶ島市', '日高市', '吉川市', 'ふじみ野市', '白岡市', '伊奈町', '三芳町', '毛呂山町', '越生町', '滑川町', '嵐山町', '小川町', '川島町', '吉見町', '鳩山町', 'ときがわ町', '横瀬町', '皆野町', '長瀞町', '小鹿野町', '東秩父村', '美里町', '神川町', '上里町', '寄居町', '宮代町', '杉戸町', '松伏町']
const SAITAMA_AREAS = [...SAITAMA_CITY, ...SAITAMA_CITIES].map((a) => `埼玉県${a}`)
const SAITAMA_STATIONS = ['大宮', '浦和', '川口', '所沢', '川越', '越谷', '南越谷', '草加', '春日部', '熊谷', '和光市', '志木']

// ---- 千葉県：全市区町村（千葉市は区単位、主要町を含む） ----
const CHIBA_CITY = ['中央区', '花見川区', '稲毛区', '若葉区', '緑区', '美浜区'].map((w) => `千葉市${w}`)
const CHIBA_CITIES = ['銚子市', '市川市', '船橋市', '館山市', '木更津市', '松戸市', '野田市', '茂原市', '成田市', '佐倉市', '東金市', '旭市', '習志野市', '柏市', '勝浦市', '市原市', '流山市', '八千代市', '我孫子市', '鴨川市', '鎌ケ谷市', '君津市', '富津市', '浦安市', '四街道市', '袖ケ浦市', '八街市', '印西市', '白井市', '富里市', '南房総市', '匝瑳市', '香取市', '山武市', 'いすみ市', '大網白里市', '酒々井町', '栄町', '神崎町', '多古町', '東庄町', '九十九里町', '芝山町', '横芝光町', '一宮町', '睦沢町', '長生村', '白子町', '長柄町', '長南町', '大多喜町', '御宿町', '鋸南町']
const CHIBA_AREAS = [...CHIBA_CITY, ...CHIBA_CITIES].map((a) => `千葉県${a}`)
const CHIBA_STATIONS = ['千葉', '船橋', '西船橋', '柏', '松戸', '新浦安', '津田沼', '海浜幕張', '本八幡', '流山おおたかの森', '南柏']

export interface Prefecture {
  key: 'tokyo' | 'kanagawa' | 'saitama' | 'chiba'
  label: string
  areas: string[]
  stations: string[]
}

export const PREFECTURES: Prefecture[] = [
  { key: 'tokyo', label: '東京都', areas: TOKYO_AREAS, stations: TOKYO_STATIONS },
  { key: 'kanagawa', label: '神奈川県', areas: KANAGAWA_AREAS, stations: KANAGAWA_STATIONS },
  { key: 'saitama', label: '埼玉県', areas: SAITAMA_AREAS, stations: SAITAMA_STATIONS },
  { key: 'chiba', label: '千葉県', areas: CHIBA_AREAS, stations: CHIBA_STATIONS },
]

export type AreaPresetKey = 'ittokensanken' | 'tokyo' | 'kanagawa' | 'saitama' | 'chiba' | 'custom'

export interface AreaPreset {
  label: string
  description?: string
  areas: string[]
  stations: string[]
}

const byKey = (k: Prefecture['key']) => PREFECTURES.find((p) => p.key === k)!

export const AREA_PRESETS: Record<Exclude<AreaPresetKey, 'custom'>, AreaPreset> = {
  ittokensanken: {
    label: '一都三県',
    description: '東京都・神奈川県・埼玉県・千葉県の全市区町村',
    areas: PREFECTURES.flatMap((p) => p.areas),
    stations: PREFECTURES.flatMap((p) => p.stations),
  },
  tokyo: { label: '東京都のみ', areas: byKey('tokyo').areas, stations: byKey('tokyo').stations },
  kanagawa: { label: '神奈川県のみ', areas: byKey('kanagawa').areas, stations: byKey('kanagawa').stations },
  saitama: { label: '埼玉県のみ', areas: byKey('saitama').areas, stations: byKey('saitama').stations },
  chiba: { label: '千葉県のみ', areas: byKey('chiba').areas, stations: byKey('chiba').stations },
}

export const AREA_PRESET_OPTIONS: { value: AreaPresetKey; label: string }[] = [
  { value: 'ittokensanken', label: '一都三県（全市区町村）' },
  { value: 'tokyo', label: '東京都のみ' },
  { value: 'kanagawa', label: '神奈川県のみ' },
  { value: 'saitama', label: '埼玉県のみ' },
  { value: 'chiba', label: '千葉県のみ' },
  { value: 'custom', label: 'カスタム（手入力）' },
]

export function presetLabel(key: string): string {
  return AREA_PRESET_OPTIONS.find((o) => o.value === key)?.label || key
}

/**
 * プリセットから検索対象エリアを返す。市区町村（必須）を先に、駅名（補助）を後に。
 * custom のときは customAreas を使う。
 */
export function resolveAreas(key: AreaPresetKey, customAreas: string[]): string[] {
  if (key === 'custom') return customAreas
  const p = AREA_PRESETS[key]
  return [...p.areas, ...p.stations]
}

/** エリア文字列から都県ラベルを推定（巡回進捗の集計用） */
export function prefectureOfArea(area: string): string {
  for (const p of PREFECTURES) {
    if (area.startsWith(p.label)) return p.label
    if (p.stations.includes(area)) return p.label
  }
  return 'その他'
}

/** 一都三県の都県別の総エリア数（市区町村のみ。駅は補助なので含めない） */
export function prefectureAreaTotals(): { key: string; label: string; total: number }[] {
  return PREFECTURES.map((p) => ({ key: p.key, label: p.label, total: p.areas.length }))
}

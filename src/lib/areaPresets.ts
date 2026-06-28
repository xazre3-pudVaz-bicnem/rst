// ============================================================
// エリアプリセット（一都三県を主要市区町村＋主要駅に自動展開）
// 「探し方」改善用。HOT条件は別途 leadScoring 側で厳格に判定する。
// 駅名は新店が出やすいので areas より優先して回す。
// ============================================================

const TOKYO_WARDS = [
  '千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区', '江東区',
  '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区', '杉並区', '豊島区',
  '北区', '荒川区', '板橋区', '練馬区', '足立区', '葛飾区', '江戸川区',
]
const TOKYO_TAMA = ['八王子市', '立川市', '武蔵野市', '三鷹市', '府中市', '調布市', '町田市', '小金井市', '日野市', '西東京市']
const TOKYO_STATIONS = ['新宿', '渋谷', '池袋', '東京', '品川', '上野', '北千住', '中野', '吉祥寺', '立川', '町田', '蒲田', '錦糸町', '亀有', '金町', '新小岩', '青砥', '立石', '綾瀬', '北綾瀬', '堀切菖蒲園', 'お花茶屋', '柴又']

const KANAGAWA_CITIES = [
  '横浜市西区', '横浜市中区', '横浜市港北区', '横浜市鶴見区', '横浜市神奈川区', '横浜市戸塚区', '横浜市青葉区', '横浜市都筑区',
  '川崎市川崎区', '川崎市中原区', '川崎市高津区', '川崎市幸区', '川崎市宮前区',
  '相模原市中央区', '相模原市南区', '藤沢市', '鎌倉市', '茅ヶ崎市', '平塚市', '厚木市', '海老名市', '大和市', '横須賀市', '小田原市',
]
const KANAGAWA_STATIONS = ['横浜', '川崎', '武蔵小杉', '藤沢', '大和', '海老名', '本厚木', '横須賀中央', '小田原', '溝の口', 'センター北', '上大岡', '戸塚']

const SAITAMA_CITIES = [
  'さいたま市大宮区', 'さいたま市浦和区', 'さいたま市中央区', 'さいたま市南区', 'さいたま市北区', 'さいたま市見沼区',
  '川口市', '草加市', '越谷市', '春日部市', '所沢市', '川越市', '戸田市', '蕨市', '新座市', '朝霞市', '和光市', '志木市', '上尾市', '熊谷市',
]
const SAITAMA_STATIONS = ['大宮', '浦和', '川口', '所沢', '川越', '越谷', '南越谷', '草加', '春日部', '熊谷', '和光市', '志木', '朝霞台']

const CHIBA_CITIES = [
  '千葉市中央区', '千葉市美浜区', '千葉市稲毛区', '千葉市花見川区', '千葉市若葉区',
  '船橋市', '市川市', '松戸市', '柏市', '浦安市', '習志野市', '八千代市', '流山市', '我孫子市', '成田市', '木更津市', '市原市',
]
const CHIBA_STATIONS = ['千葉', '船橋', '西船橋', '柏', '松戸', '新浦安', '津田沼', '海浜幕張', '本八幡', '流山おおたかの森', '南柏', '北習志野']

export type AreaPresetKey = 'ittokensanken' | 'tokyo' | 'kanagawa' | 'saitama' | 'chiba' | 'custom'

export interface AreaPreset {
  label: string
  /** 市区町村 */
  areas: string[]
  /** 主要駅（新店が出やすいので優先） */
  stations: string[]
}

const TOKYO: AreaPreset = { label: '東京都のみ', areas: [...TOKYO_WARDS, ...TOKYO_TAMA], stations: TOKYO_STATIONS }
const KANAGAWA: AreaPreset = { label: '神奈川県のみ', areas: KANAGAWA_CITIES, stations: KANAGAWA_STATIONS }
const SAITAMA: AreaPreset = { label: '埼玉県のみ', areas: SAITAMA_CITIES, stations: SAITAMA_STATIONS }
const CHIBA: AreaPreset = { label: '千葉県のみ', areas: CHIBA_CITIES, stations: CHIBA_STATIONS }

export const AREA_PRESETS: Record<Exclude<AreaPresetKey, 'custom'>, AreaPreset> = {
  ittokensanken: {
    label: '一都三県',
    areas: [...TOKYO.areas, ...KANAGAWA.areas, ...SAITAMA.areas, ...CHIBA.areas],
    stations: [...TOKYO.stations, ...KANAGAWA.stations, ...SAITAMA.stations, ...CHIBA.stations],
  },
  tokyo: TOKYO,
  kanagawa: KANAGAWA,
  saitama: SAITAMA,
  chiba: CHIBA,
}

export const AREA_PRESET_OPTIONS: { value: AreaPresetKey; label: string }[] = [
  { value: 'ittokensanken', label: '一都三県' },
  { value: 'tokyo', label: '東京都のみ' },
  { value: 'kanagawa', label: '神奈川県のみ' },
  { value: 'saitama', label: '埼玉県のみ' },
  { value: 'chiba', label: '千葉県のみ' },
  { value: 'custom', label: 'カスタム（手入力）' },
]

/**
 * プリセットから検索対象エリアを返す。駅を先頭（新店が出やすい）、次に市区町村。
 * custom のときは customAreas を使う。
 */
export function resolveAreas(key: AreaPresetKey, customAreas: string[]): string[] {
  if (key === 'custom') return customAreas
  const p = AREA_PRESETS[key]
  return [...p.stations, ...p.areas]
}

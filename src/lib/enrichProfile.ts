// ============================================================
// 住所/電話の補完強化（サーバー専用）:
//  - Instagramプロフィール本文/外部リンク取得
//  - Google Maps短縮URL展開（goo.gl/maps 等）
//  - 都道府県省略住所の抽出＋市区町村→都道府県の推定
// 外部fetchはタイムアウト付き。本文の大量保存はしない（抽出結果のみ）。
// ============================================================
import { isJapanPhone } from './japanFilter.js'

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export const PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']

// 市区町村 → 都道府県（都道府県省略住所の補完用。主要市＋例示の沖縄等）
export const CITY_PREF: Record<string, string> = {
  札幌市: '北海道', 函館市: '北海道', 旭川市: '北海道', 青森市: '青森県', 盛岡市: '岩手県', 仙台市: '宮城県', 秋田市: '秋田県', 山形市: '山形県', 福島市: '福島県', 郡山市: '福島県', いわき市: '福島県',
  水戸市: '茨城県', つくば市: '茨城県', 宇都宮市: '栃木県', 前橋市: '群馬県', 高崎市: '群馬県',
  さいたま市: '埼玉県', 川口市: '埼玉県', 川越市: '埼玉県', 所沢市: '埼玉県', 越谷市: '埼玉県', 熊谷市: '埼玉県', 深谷市: '埼玉県',
  千葉市: '千葉県', 船橋市: '千葉県', 松戸市: '千葉県', 市川市: '千葉県', 柏市: '千葉県',
  横浜市: '神奈川県', 川崎市: '神奈川県', 相模原市: '神奈川県', 藤沢市: '神奈川県', 横須賀市: '神奈川県',
  新潟市: '新潟県', 富山市: '富山県', 金沢市: '石川県', 福井市: '福井県', 甲府市: '山梨県', 長野市: '長野県', 松本市: '長野県', 岐阜市: '岐阜県',
  静岡市: '静岡県', 浜松市: '静岡県', 名古屋市: '愛知県', 豊田市: '愛知県', 岡崎市: '愛知県', 一宮市: '愛知県', 津市: '三重県', 四日市市: '三重県',
  大津市: '滋賀県', 京都市: '京都府', 大阪市: '大阪府', 堺市: '大阪府', 東大阪市: '大阪府', 高槻市: '大阪府', 吹田市: '大阪府',
  神戸市: '兵庫県', 姫路市: '兵庫県', 西宮市: '兵庫県', 尼崎市: '兵庫県', 奈良市: '奈良県', 和歌山市: '和歌山県',
  鳥取市: '鳥取県', 松江市: '島根県', 岡山市: '岡山県', 倉敷市: '岡山県', 広島市: '広島県', 福山市: '広島県', 山口市: '山口県', 下関市: '山口県',
  徳島市: '徳島県', 高松市: '香川県', 松山市: '愛媛県', 高知市: '高知県',
  福岡市: '福岡県', 北九州市: '福岡県', 久留米市: '福岡県', 佐賀市: '佐賀県', 長崎市: '長崎県', 佐世保市: '長崎県', 熊本市: '熊本県', 大分市: '大分県', 宮崎市: '宮崎県', 鹿児島市: '鹿児島県',
  // 沖縄（例示の石垣市を含む）
  那覇市: '沖縄県', 沖縄市: '沖縄県', うるま市: '沖縄県', 浦添市: '沖縄県', 宜野湾市: '沖縄県', 名護市: '沖縄県', 糸満市: '沖縄県', 豊見城市: '沖縄県', 石垣市: '沖縄県', 宮古島市: '沖縄県', 南城市: '沖縄県',
}

/** 市区町村名から都道府県を推定（CITY_PREF→区名一部のフォールバック） */
export function prefectureFromCity(text: string): { prefecture: string; city: string } {
  if (!text) return { prefecture: '', city: '' }
  // 既に都道府県を含む
  const pref0 = PREFECTURES.find((p) => text.includes(p))
  const cityM = text.match(/([一-龥ぁ-んァ-ヶ]{1,8}[市区町村])/)
  const city = cityM ? cityM[1] : ''
  if (pref0) return { prefecture: pref0, city }
  // CITY_PREF（市名）
  for (const [c, p] of Object.entries(CITY_PREF)) { if (text.includes(c)) return { prefecture: p, city: city || c } }
  // 東京23区
  if (/[一-龥ぁ-んァ-ヶ]{1,4}区/.test(text) && /(渋谷|新宿|港|中央|千代田|品川|目黒|世田谷|杉並|中野|豊島|文京|台東|墨田|江東|大田|練馬|板橋|北|荒川|足立|葛飾|江戸川)区/.test(text)) {
    return { prefecture: '東京都', city }
  }
  return { prefecture: '', city }
}

/** 都道府県省略にも対応した日本住所の抽出（市区町村起点・丁目/番地/ビル/階を含めて拾う） */
export function extractAddressLoose(text: string): { address: string; prefecture: string; city: string } {
  if (!text) return { address: '', prefecture: '', city: '' }
  const t = text.replace(/\s+/g, ' ')
  // 1) 都道府県から始まる住所
  const m1 = t.match(new RegExp(`(${PREFECTURES.join('|')})[^\\n、。｜|/]{2,50}?(?:[0-9０-９][-－0-9０-９丁目番地号]{0,12}|ビル|[BbＢ][0-9０-９][Ff]?|[0-9０-９][FfＦ])`))
  if (m1) { const r = prefectureFromCity(m1[0]); return { address: m1[0].trim().slice(0, 70), prefecture: m1[1], city: r.city } }
  // 2) 市区町村から始まる住所（都道府県省略・「石垣市石垣20...」等）。番地/丁目/ビル/階まで含める
  const m2 = t.match(/([一-龥ぁ-んァ-ヶ]{1,8}[市区町村])([一-龥ぁ-んァ-ヶ]{0,12})([0-9０-９][-－0-9０-９丁目番地号]{0,12})((?:[一-龥ぁ-んァ-ヶ0-9０-９]{0,10}(?:ビル|館|[BbＢ][0-9０-９]|[0-9０-９][FfＦ階]))?)/)
  if (m2) {
    const r = prefectureFromCity(m2[1])
    const body = m2[0].trim().slice(0, 70)
    return { address: (r.prefecture && !body.startsWith(r.prefecture) ? r.prefecture : '') + body, prefecture: r.prefecture, city: r.city || m2[1] }
  }
  // 3) 市区町村だけでも拾う（エリア確定用）
  const r3 = prefectureFromCity(t)
  if (r3.city) return { address: '', prefecture: r3.prefecture, city: r3.city }
  return { address: '', prefecture: '', city: '' }
}

export interface FetchPageResult { ok: boolean; status: number; finalUrl: string; html: string; timedOut: boolean; error: string | null }

/** タイムアウト付きGET（リダイレクト追従・最終URLを返す） */
export async function fetchPage(url: string, timeoutMs = 8000): Promise<FetchPageResult> {
  const ctrl = new AbortController()
  let timedOut = false
  const to = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.8' }, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(to)
    const finalUrl = (res as any).url || url
    const ct = res.headers.get('content-type') || ''
    if (!/text|html|json|xml/i.test(ct) && ct) return { ok: false, status: res.status, finalUrl, html: '', timedOut: false, error: `非HTML(${ct})` }
    const html = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, finalUrl, html, timedOut: false, error: res.ok ? null : `HTTP ${res.status}` }
  } catch (e: any) {
    clearTimeout(to)
    return { ok: false, status: 0, finalUrl: url, html: '', timedOut, error: timedOut ? 'timeout(8s)' : String(e?.message || e).slice(0, 120) }
  }
}

export const MAP_URL_RE = /(https?:\/\/(?:goo\.gl\/maps|maps\.app\.goo\.gl|g\.page|share\.google|maps\.google\.[^/\s"'<>]+|(?:www\.)?google\.[^/\s"'<>]+\/maps|business\.google\.com)\/[^\s"'<>）)]+)/i

export interface MapExpand { ok: boolean; finalUrl: string; name: string; lat: string; lng: string; placeId: string; address: string; timedOut: boolean; error: string | null }

/** Google Maps短縮URLを展開し、店名/緯度経度/place_id/住所の手がかりを取得 */
export async function expandMapUrl(url: string, timeoutMs = 8000): Promise<MapExpand> {
  const r = await fetchPage(url, timeoutMs)
  const fu = r.finalUrl || url
  const dec = (s: string) => { try { return decodeURIComponent(s).replace(/\+/g, ' ') } catch { return s.replace(/\+/g, ' ') } }
  const nameM = fu.match(/\/maps\/place\/([^/@]+)/i)
  const name = nameM ? dec(nameM[1]).replace(/\s{2,}/g, ' ').trim() : ''
  const ll = fu.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
  const pidM = fu.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || fu.match(/[?&](?:place_id|ftid|cid)=([^&]+)/i)
  // 本文側からも住所/place_idを拾う
  const addrM = (r.html || '').match(new RegExp(`(${PREFECTURES.join('|')})[^"'<>、。｜|]{4,50}`))
  return {
    ok: r.ok || !!name || !!ll, finalUrl: fu, name, lat: ll?.[1] || '', lng: ll?.[2] || '',
    placeId: pidM ? pidM[1] : '', address: addrM ? addrM[0] : '', timedOut: r.timedOut, error: r.error,
  }
}

export interface ProfileResult { ok: boolean; name: string; text: string; bio: string; phone: string; address: string; prefecture: string; city: string; externalUrl: string; mapUrl: string; links: string[]; followers: number; reason: string; timedOut: boolean }
// ユーザー名に含まれる地名（例: les_tendresse.utsunomiya → 宇都宮）を都道府県/市区町村へ
export function regionFromUsername(username: string): { prefecture: string; city: string } {
  const u = (username || '').toLowerCase().replace(/[._-]+/g, ' ')
  const ROMAJI: Record<string, string> = {
    utsunomiya: '宇都宮市', tokyo: '東京都', osaka: '大阪市', kyoto: '京都市', nagoya: '名古屋市', yokohama: '横浜市', kobe: '神戸市', sapporo: '札幌市', fukuoka: '福岡市', sendai: '仙台市', hiroshima: '広島市', niigata: '新潟市', kanazawa: '金沢市', okinawa: '沖縄県', naha: '那覇市', ishigaki: '石垣市', chiba: '千葉市', saitama: 'さいたま市', kawasaki: '川崎市', shibuya: '渋谷区', shinjuku: '新宿区', ginza: '中央区', ikebukuro: '豊島区', omiya: 'さいたま市', kumagaya: '熊谷市', takasaki: '高崎市', maebashi: '前橋市', mito: '水戸市', kofu: '甲府市', matsumoto: '松本市', hamamatsu: '浜松市', shizuoka: '静岡市', gifu: '岐阜市', tsu: '津市', otsu: '大津市', nara: '奈良市', wakayama: '和歌山市', okayama: '岡山市', kurashiki: '倉敷市', matsuyama: '松山市', kochi: '高知市', kagoshima: '鹿児島市', miyazaki: '宮崎市', oita: '大分市', kumamoto: '熊本市', nagasaki: '長崎市', saga: '佐賀市', kitakyushu: '北九州市', himeji: '姫路市', nishinomiya: '西宮市',
  }
  for (const [k, v] of Object.entries(ROMAJI)) { if (new RegExp(`(^| )${k}( |$)`).test(u) || u.includes(k)) { return { prefecture: prefectureFromCity(v).prefecture, city: v } } }
  return { prefecture: '', city: '' }
}

/** Instagramプロフィールページを取得し、本文/電話/住所/外部リンク/Maps URL を抽出 */
export async function fetchInstagramProfile(username: string, timeoutMs = 8000): Promise<ProfileResult> {
  const empty: ProfileResult = { ok: false, name: '', text: '', bio: '', phone: '', address: '', prefecture: '', city: '', externalUrl: '', mapUrl: '', links: [], followers: 0, reason: '', timedOut: false }
  if (!username) return { ...empty, reason: 'Instagramユーザー名が取得できず' }
  const r = await fetchPage(`https://www.instagram.com/${encodeURIComponent(username)}/`, timeoutMs)
  if (!r.ok || !r.html) return { ...empty, timedOut: r.timedOut, reason: r.timedOut ? 'Instagramプロフィール取得タイムアウト' : `Instagramプロフィール取得失敗(${r.error || r.status})` }
  const html = r.html
  const unesc = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, ' ').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\t/g, ' ')
  // og:description / meta description / title
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] || ''
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || ''
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  // JSON埋め込み（ビジネスアカウントは住所/電話を持つことがある）
  // 表示名（full_name）= 正式店名。og:title「店名 (@user)」/ <title>からも抽出
  let fullName = unesc(html.match(/"full_name":"((?:[^"\\]|\\.)*)"/)?.[1] || '')
  if (!fullName) {
    const ogt = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1] || ''
    const tt = title
    fullName = (ogt || tt).replace(/\s*[(（]@[^)）]*[)）].*/, '').replace(/\s*[•·|｜].*$/, '').replace(/\s*on Instagram.*$/i, '').replace(/Instagram.*$/i, '').trim()
  }
  fullName = fullName.slice(0, 60)
  const bio = unesc(html.match(/"biography":"((?:[^"\\]|\\.)*)"/)?.[1] || '')
  const bphone = (html.match(/"(?:business_phone_number|public_phone_number|contact_phone_number)":"([^"]*)"/)?.[1] || '').trim()
  const extUrl = unesc(html.match(/"external_url":"((?:[^"\\]|\\.)*)"/)?.[1] || '')
  let addrStreet = '', addrCity = '', addrZip = ''
  const addrJson = html.match(/"address_json":"((?:[^"\\]|\\.)*)"/)?.[1]
  if (addrJson) {
    try { const a = JSON.parse(unesc(addrJson)); addrStreet = a.street_address || ''; addrCity = a.city_name || ''; addrZip = a.zip_code || '' } catch { /* noop */ }
  }
  const text = [title, og, desc, bio].filter(Boolean).join(' \n ')
  // 住所: address_json優先 → bio本文から緩い抽出
  let address = '', prefecture = '', city = ''
  if (addrStreet || addrCity) {
    const merged = `${addrCity} ${addrStreet}`.trim()
    const r2 = extractAddressLoose(merged) // city_nameは「Ishigaki, Okinawa」等の英語の場合もある
    address = r2.address || merged
    prefecture = r2.prefecture; city = r2.city
  }
  if (!address) { const r2 = extractAddressLoose(text); address = r2.address; prefecture = r2.prefecture; city = r2.city }
  if (!prefecture) { const r3 = prefectureFromCity(text); prefecture = r3.prefecture; city = city || r3.city }
  // 電話: JSON優先 → 本文
  let phone = ''
  const cand = bphone || (text.match(/0\d{1,3}[-(\s]?\d{2,4}[-)\s]?\d{3,4}|0120[-\s]?\d{2,3}[-\s]?\d{2,3}|0\d{9,10}/)?.[0] || '')
  if (cand && isJapanPhone(cand)) phone = cand.trim()
  // リンク群（og/desc/bio/HTML中のhttp）。Mapsを最優先で拾う
  const links = Array.from(new Set([extUrl, ...Array.from((og + ' ' + desc + ' ' + bio + ' ' + html).matchAll(/https?:\/\/[^\s"'<>\\）)]+/g)).map((m) => m[0])].filter(Boolean)))
    .filter((u) => !/instagram\.com\/(?:static|rsrc|p\/|images)/i.test(u)).slice(0, 12)
  const mapUrl = links.find((u) => MAP_URL_RE.test(u)) || ''
  // フォロワー数（数万＝確立済み大型の判定に使う）。JSON or og:description「X Followers / Xフォロワー」
  let followers = 0
  const fJson = html.match(/"edge_followed_by":\{"count":(\d+)\}/)?.[1] || html.match(/"follower_count":(\d+)/)?.[1] || ''
  if (fJson) followers = Number(fJson) || 0
  if (!followers) {
    const fm = (og + ' ' + desc).match(/([\d,.]+)\s*(?:Followers|フォロワー|followers)/i)
    if (fm) { let v = fm[1].replace(/,/g, ''); if (/万/.test(og + desc)) v = String(Math.round(parseFloat(v) * 10000)); followers = Math.round(Number(v)) || 0 }
    const fmMan = (og + ' ' + desc).match(/([\d.]+)\s*万\s*(?:Followers|フォロワー)/i); if (fmMan) followers = Math.round(parseFloat(fmMan[1]) * 10000)
  }
  const ok = !!(bio || og || addrStreet || extUrl)
  const reason = ok ? '' : 'プロフィール本文に住所/電話/リンクなし'
  return { ok, name: fullName, text, bio: bio || og, phone, address, prefecture, city, externalUrl: extUrl, mapUrl, links, followers, reason, timedOut: false }
}

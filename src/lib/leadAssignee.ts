// ============================================================
// 指定メディア由来のAI自動投入を、決まった営業担当の「新規」案件として入れる（サーバー専用）。
//  ユーザー指示: スクリーンショットで名指しされた地域メディア（開店・閉店系）の投入分は 織田春樹 の担当にする。
//  ※過去案件は対象外（このモジュールは投入時にだけ効く）。じゃらん由来の固定担当は sequentialProbe.ts 側に既存。
// ============================================================

/** 対象メディア由来の投入先担当（profilesの氏名で解決。見つからなければ名前だけ入れる） */
export const MEDIA_ASSIGNEE_NAME = '織田春樹'

/**
 * 担当固定の対象メディア。
 * 判定は「取得元サイト名 + list_url + base_url + 記事URL」に対して行う。
 * ドメインと媒体名の両方を入れてあるので、未登録のサイトが後から自動発見で登録されても取りこぼさない。
 */
export const ASSIGNED_MEDIA: { label: string; re: RegExp }[] = [
  { label: '号外NET', re: /goguynet\.jp|号外ＮＥＴ|号外NET/i },
  { label: '埼北つうしん（さいつう）', re: /sai2\.info|埼北つ[うー]しん|さいつう/i },
  { label: 'いばナビ', re: /ibanavi\.net|いばナビ/i },
  { label: '彩北なび', re: /saihokunavi\.net|saihoku-navi\.com|saikohkunavi\.net|彩北なび|埼北なび/i },
  { label: '松戸ロード', re: /wl29\.net|松戸ロード/i },
  { label: 'いいね！立川', re: /iine-?tachikawa|いいね[！!]?\s?立川/i },
  { label: 'ACT LOCALLY', re: /act-?locally/i },
  { label: '大和とぴっく（やまとぴ）', re: /yamatopi\.jp|やまとぴ|大和とぴっく/i },
  { label: '荒川102', re: /arakawa102\.com|荒川102/i },
  { label: '江東区の情報サイト', re: /minamisuna1\.com|江東区の情報サイト/i },
  { label: '赤羽マガジン', re: /akabane-shinbun\.com|赤羽マガジン/i },
  { label: '葛飾つうしん', re: /katsushika-tsushin\.com|葛飾つ[うー]しん/i },
  { label: 'リビングむさしのWeb', re: /living\.jp\/musashino|リビングむさしの|LIVINGむさしの/i },
  { label: 'いたばしTIMES', re: /itabashi-times\.com|いたばし\s?(TIMES|タイムズ)/i },
  { label: '船橋つうしん', re: /funabashi-tsushin\.com|船橋つ[うー]しん/i },
  { label: 'ぐんラボ！', re: /gunlabo\.net|ぐんラボ/i },
  { label: 'いいね！国立', re: /iine-kunitachi\.net|いいね[！!]?\s?国立/i },
  { label: '川口マガジン', re: /kawaguchi-magazine\.com|川口マガジン/i },
  { label: '越谷雑談がやてく', re: /koshigaya\.gayatec\.jp|越谷(雑談)?がやて/i },
  { label: 'む〜なび', re: /む[〜～ー]なび|mu-?navi\./i },
  { label: '全国ローカルニュースサイト名鑑', re: /ローカルニュースサイト名鑑/i },
  { label: '変わりゆく町田の街並み', re: /kawariyuku-machida\.com|変わりゆく町田/i },
  { label: 'ちょうふ通信', re: /chofucity\.com|ちょうふ通信/i },
  { label: 'Urawacity.net（浦和シティネット）', re: /urawacity\.net|浦和シティネット/i },
  { label: 'さいほくらし', re: /saikura\.info|さいほくらし/i },
  { label: 'さいたまっぷる', re: /jutaro123\.com|さいたまっぷる/i },
  { label: '所沢なび', re: /tokorozawa-?navi|所沢なび/i },
  { label: '戸田公園ガイド', re: /toda-?ko(u)?en|戸田公園ガイド/i },
  { label: '三郷ぐらし', re: /misato-gurashi\.com|三郷ぐらし/i },
  { label: '浦安に住みたい！web', re: /urayasu[-.a-z0-9]*sumitai|浦安に住みたい/i },
  { label: '清瀬タイムズ', re: /kiyose[-.a-z0-9]*times|清瀬タイムズ/i },
]

/** 担当固定の対象メディアなら媒体名を返す（該当なしは null） */
export function matchAssignedMedia(...texts: (string | null | undefined)[]): string | null {
  const hay = texts.filter(Boolean).join(' ')
  if (!hay) return null
  for (const m of ASSIGNED_MEDIA) if (m.re.test(hay)) return m.label
  return null
}

// profiles照会は1プロセス1回で足りるためキャッシュ
let _assignee: { id: string | null; name: string } | undefined
async function resolveAssignee(admin: any): Promise<{ id: string | null; name: string }> {
  if (_assignee !== undefined) return _assignee
  try {
    const { data } = await admin.from('profiles').select('id,full_name').ilike('full_name', `%${MEDIA_ASSIGNEE_NAME}%`).limit(1)
    _assignee = data?.[0] ? { id: data[0].id, name: data[0].full_name || MEDIA_ASSIGNEE_NAME } : { id: null, name: MEDIA_ASSIGNEE_NAME }
  } catch { _assignee = { id: null, name: MEDIA_ASSIGNEE_NAME } }
  return _assignee
}

/**
 * cases.insert に混ぜる担当パッチ。対象メディア由来でなければ空オブジェクト（＝従来どおり担当なし）。
 * ステータスは呼び出し側の DEFAULT_STATUS（＝新規）のまま。
 */
export async function mediaAssigneePatch(admin: any, ...texts: (string | null | undefined)[]): Promise<Record<string, unknown>> {
  if (!matchAssignedMedia(...texts)) return {}
  const a = await resolveAssignee(admin)
  return { sales_rep: a.name, assigned_user_id: a.id, assigned_user_name: a.name }
}

/* ============================================================
 * Instagram Web検索API 疎通確認
 *   npm run check:instagram-web-api
 *   npm run check:instagram-web-api -- https://your-app.vercel.app
 *
 * - GET /api/cron/instagram-web-leads がHTMLなら失敗、JSONなら成功
 * - 検索/Anthropic/Supabase の設定状況を「キー本体なし」で診断（hasKey/keyLength/prefix）
 * ============================================================ */
import 'dotenv/config'

const base = (process.argv[2] || process.env.RST_BASE_URL || '').replace(/\/+$/, '')

async function main() {
  console.log('=== Instagram Web検索API 疎通確認 ===')
  if (!base) {
    console.error('✗ 確認先URL未指定。例: npm run check:instagram-web-api -- https://<your-app>.vercel.app')
    process.exit(1)
  }
  const url = `${base}/api/cron/instagram-web-leads`
  console.log('• GET', url)
  try {
    const res = await fetch(url)
    const ct = res.headers.get('content-type') || ''
    const text = await res.text()
    if (/^\s*<(!doctype|html)/i.test(text) || ct.includes('text/html')) {
      console.error(`✗ 失敗: HTMLが返りました（${ct}）→ Functionが認識されていません。mainへpushして再デプロイ。`)
      process.exit(2)
    }
    let j: any = {}
    try { j = JSON.parse(text) } catch { console.error('✗ JSON解釈不可:', text.slice(0, 200)); process.exit(2) }
    console.log('✅ 成功: JSONが返りました')
    console.log('   検索プロバイダ   :', j.provider || '(なし)')
    console.log('   Serper           :', diag(j.serper))
    console.log('   Bing             :', diag(j.bing))
    console.log('   Anthropic        :', diag(j.anthropic))
    console.log('   GoogleMaps       :', diag(j.googleMaps))
    console.log('   Supabase URL     :', j.hasSupabaseUrl ? 'OK' : '未設定')
    console.log('   ServiceRole      :', j.hasServiceRole ? 'OK' : '未設定')
    console.log('   configured       :', j.configured ? 'OK（実行可能）' : 'NG（検索キー/Supabaseを確認）')
    console.log('\n※ 実行(POST)はCronまたはRST画面の「Instagram Web検索・実行」から。クエリ数/HOT/HOLD/EXCLUDEDは実行結果に表示されます。')
  } catch (e: any) { console.error('✗ 接続失敗:', e?.message || e); process.exit(2) }
}

function diag(d: any): string {
  if (!d) return '不明'
  return d.hasKey ? `設定あり(len=${d.keyLength}, prefix=${d.prefix})` : '未設定'
}

main()

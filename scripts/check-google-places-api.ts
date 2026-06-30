/* ============================================================
 * Google Places API 疎通確認
 *   npm run check:google-places-api
 *   npm run check:google-places-api -- https://your-app.vercel.app
 * GET /api/leads/google-places/run がHTMLなら失敗、JSONなら成功。キー状態を診断。
 * ============================================================ */
import 'dotenv/config'

const base = (process.argv[2] || process.env.RST_BASE_URL || '').replace(/\/+$/, '')

async function main() {
  console.log('=== Google Places API 疎通確認 ===')
  if (!base) { console.error('✗ 確認先URL未指定。例: npm run check:google-places-api -- https://<your-app>.vercel.app'); process.exit(1) }
  const url = `${base}/api/leads/google-places/run`
  console.log('• GET', url)
  try {
    const res = await fetch(url)
    const ct = res.headers.get('content-type') || ''
    const text = await res.text()
    if (/^\s*<(!doctype|html)/i.test(text) || ct.includes('text/html')) {
      console.error(`✗ 失敗: HTMLが返りました（${ct}）→ Functionが認識されていません。mainへpushして再デプロイ。`); process.exit(2)
    }
    let j: any = {}
    try { j = JSON.parse(text) } catch { console.error('✗ JSON解釈不可:', text.slice(0, 200)); process.exit(2) }
    console.log('✅ 成功: JSONが返りました')
    console.log('   GOOGLE_MAPS_API_KEY :', j.configured ? `設定あり(len=${j.keyLength})` : '未設定')
    console.log('   SUPABASE_URL        :', j.hasSupabaseUrl ? 'OK' : '未設定')
    console.log('   ServiceRole         :', j.hasServiceRole ? 'OK' : '未設定')
    console.log('   node                :', j.node || '-')
    console.log('\n※ openingDate/businessStatus は Place Details(FieldMask) で取得。実行はAI投入「取得・投入」または毎朝Cron。')
  } catch (e: any) { console.error('✗ 接続失敗:', e?.message || e); process.exit(2) }
}
main()

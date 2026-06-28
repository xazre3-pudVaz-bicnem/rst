/* ============================================================
 * 管理APIの疎通確認（HTMLが返る＝未デプロイ/ルート誤りを検知）
 *   npm run check:regional-media-api
 *   npm run check:regional-media-api -- https://your-app.vercel.app
 *
 * 判定:
 *   - JSONで {ok:true} が返れば成功（total/active を表示）
 *   - HTML(React本体)が返れば失敗（/api/* がFunctionとして認識されていない）
 * 認可: ADMIN_SECRET / CRON_SECRET を X-Admin-Secret ヘッダで送る。
 * ============================================================ */
import 'dotenv/config'

const base = (process.argv[2] || process.env.RST_BASE_URL || process.env.CHECK_BASE_URL || '').replace(/\/+$/, '')
const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET || ''

async function main() {
  console.log('=== 地域メディア管理API 疎通確認 ===')
  if (!base) {
    console.error('✗ 確認先URLが未指定です。')
    console.error('  例: npm run check:regional-media-api -- https://<your-app>.vercel.app')
    console.error('  もしくは .env に RST_BASE_URL を設定してください。')
    process.exit(1)
  }
  const url = `${base}/api/admin/regional-media/sources`
  console.log('• GET', url)
  try {
    const res = await fetch(url, { headers: secret ? { 'X-Admin-Secret': secret } : {} })
    const ct = res.headers.get('content-type') || ''
    const text = await res.text()
    const looksHtml = /^\s*<(!doctype|html)/i.test(text) || ct.includes('text/html')

    if (looksHtml) {
      console.error(`✗ 失敗: HTML が返りました（content-type: ${ct}）`)
      console.error('  → /api/* がVercel Functionとして認識されていません。')
      console.error('    対処: main に push して再デプロイ / vercel.json の rewrite が /api/ を除外しているか確認。')
      process.exit(2)
    }
    let json: any = {}
    try { json = JSON.parse(text) } catch { console.error('✗ 失敗: JSONとして解釈できません:', text.slice(0, 200)); process.exit(2) }

    if (res.status === 401) {
      console.error('△ 認可エラー（401）。ADMIN_SECRET/CRON_SECRET を .env に設定するか、ログインJWTが必要です。')
      console.error('  ただしJSONは返っているので、API自体は正しく動作しています。')
      process.exit(0)
    }
    if (json.ok === false) { console.error('△ APIエラー:', json.error); process.exit(0) }

    console.log('✅ 成功: JSON が返りました')
    console.log('   source_sites 総数 :', json.total)
    console.log('   有効サイト数      :', json.active)
    console.log('   無効サイト数      :', json.inactive)
  } catch (e: any) {
    console.error('✗ 失敗: 接続できません:', e?.message || e)
    process.exit(2)
  }
}

main()

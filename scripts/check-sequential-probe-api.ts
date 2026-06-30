/* ============================================================
 * 連番URL探索 疎通確認
 *   npm run check:sequential-probe-api -- https://your-app.vercel.app
 *   （URL省略時は RST_BASE_URL）
 * GET /api/leads/regional-media/run がJSONなら成功。連番探索ソース数を表示。
 * ============================================================ */
import 'dotenv/config'

const base = (process.argv[2] || process.env.RST_BASE_URL || '').replace(/\/+$/, '')

async function main() {
  console.log('=== 連番URL探索 疎通確認 ===')
  if (!base) { console.error('✗ 確認先URL未指定。例: npm run check:sequential-probe-api -- https://<your-app>.vercel.app'); process.exit(1) }
  const url = `${base}/api/leads/regional-media/run`
  console.log('• GET', url)
  try {
    const res = await fetch(url)
    const text = await res.text()
    if (/^\s*<(!doctype|html)/i.test(text)) { console.error('✗ 失敗: HTMLが返りました（Function未認識）。mainへpushして再デプロイ。'); process.exit(2) }
    const j: any = JSON.parse(text)
    console.log('✅ 成功: JSONが返りました')
    console.log('   configured        :', j.configured)
    console.log('   source_sites 総数 :', j.totalSites)
    console.log('   有効サイト数      :', j.activeSites)
    console.log('   MAPSキー          :', j.hasMapsKey ? 'OK' : '未設定')
    console.log('\n※ 連番探索の実行は 連番URL探索タブの「全ソースを探索（前回の続きから）」/「次の20件」。')
    console.log('※ 連番探索は新規掲載候補を検出（新規オープン確定ではない）。')
  } catch (e: any) { console.error('✗ 接続失敗:', e?.message || e); process.exit(2) }
}
main()

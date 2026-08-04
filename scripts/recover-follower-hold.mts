/**
 * ②の既存バックログ救済（冪等・一回性）:
 * 「Instagramフォロワー数を確認できず」でHOLDになっている候補のうち、電話＋実店舗住所があり
 * 店名ベースのチェーン/支店/大手/多店舗フィルタを通るものをHOTへ戻す。
 * → 以降の importHot sweep が（新方針=フォロワー未確認でも投入・bio再チェック付き）で cases へ投入する。
 * 実行: npx tsx scripts/recover-follower-hold.mts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { looksLikeBranchStore, detectBigOrPublic, detectBigOrPublicStrong, detectMultiStore, detectSameIndustry } from '../src/lib/targetFilter.js'
import { detectChain } from '../src/lib/chainFilter.js'
import { isRealStoreAddress } from '../src/lib/leadQuality.js'
import { isValidJpPhone, isTollFreeJp } from '../src/lib/regionalParsers.js'
import { isJapanPhone } from '../src/lib/japanFilter.js'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const { data: rows } = await admin.from('lead_candidates')
    .select('id,name,phone_number,address,search_snippet,regional_media_newness_reason')
    .eq('lead_temperature', 'HOLD')
    .ilike('auto_insert_skipped_reason', '%フォロワー数を確認できず%')
    .limit(1000)
  console.log('対象(フォロワー未確認HOLD):', (rows || []).length, '件')

  let promoted = 0, skipped = 0
  for (const c of rows || []) {
    const name = String(c.name || '')
    const phone = String(c.phone_number || '')
    const address = String(c.address || '')
    const phoneOk = !!phone && isJapanPhone(phone) && isValidJpPhone(phone) && !isTollFreeJp(phone)
    // 電話＋実店舗住所は必須（住所任意化は分類器側。ここは確実な救済のため住所ありに限定）
    if (!phoneOk || !address || !isRealStoreAddress(address)) { skipped++; continue }
    // 店名ベースの除外（importHot line316 相当）
    const gtext = `${name} ${c.regional_media_newness_reason || ''} ${c.search_snippet || ''}`
    if (detectChain(name).definite || looksLikeBranchStore(name) || detectBigOrPublicStrong(name).exclude
      || detectBigOrPublic(`${name} ${address}`).exclude || detectMultiStore(gtext).exclude || detectSameIndustry(name).exclude) { skipped++; continue }
    await admin.from('lead_candidates').update({
      lead_temperature: 'HOT', hot_tier: 'B', recommended_status: 'HOT_B', auto_insert_skipped_reason: null,
      ai_comment: 'フォロワー未確認だが電話・実店舗住所・非チェーンのためHOT-Bへ復帰（投入時にbio再確認）',
    }).eq('id', c.id)
    promoted++
  }
  console.log(`HOTへ復帰: ${promoted}件 / 除外条件で見送り: ${skipped}件`)
  console.log('→ 以降の巡回(importHot sweep)で cases へ投入されます。')
}
main().catch((e) => { console.error(e); process.exit(1) })

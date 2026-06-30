/* ============================================================
 * 日本国内フィルタの簡易チェック（isJapanPlace）
 *   npm run check:japan-filter
 * 海外住所/電話は EXCLUDED(isJapan=false)、日本住所/電話は OK(isJapan=true) を確認。
 * ============================================================ */
import { isJapanPlace } from '../src/lib/googlePlacesRun.js'

const FOREIGN = [
  { formattedAddress: '15882 Foxville Deerfield Rd, Sabillasville, MD 21780, United States' },
  { formattedAddress: 'Cedar Loop, Boonsboro, MD 21713, United States' },
  { formattedAddress: 'York, PA, United States' },
  { internationalPhoneNumber: '+1 301 555 0123', formattedAddress: 'Grand View Golf Club' },
  { addressComponents: [{ types: ['country'], shortText: 'US', longText: 'United States' }], formattedAddress: 'Owens Creek Campground' },
]
const JAPAN = [
  { formattedAddress: '東京都渋谷区神南1-2-3' },
  { formattedAddress: '大阪府大阪市北区梅田1-1-1' },
  { internationalPhoneNumber: '+81 3-1234-5678', formattedAddress: '居酒屋 さくら' },
  { nationalPhoneNumber: '03-1234-5678', formattedAddress: 'カフェ' },
  { addressComponents: [{ types: ['country'], shortText: 'JP', longText: '日本' }], formattedAddress: '深谷市上柴町東5-1-23' },
]

let fail = 0
console.log('=== 日本国外（EXCLUDED 期待: isJapan=false）===')
for (const p of FOREIGN) {
  const r = isJapanPlace(p)
  const ok = r.isJapan === false
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} isJapan=${r.isJapan} country=${r.country || '-'} basis=${r.basis} :: ${p.formattedAddress || p.internationalPhoneNumber}`)
}
console.log('\n=== 日本国内（OK 期待: isJapan=true）===')
for (const p of JAPAN) {
  const r = isJapanPlace(p)
  const ok = r.isJapan === true
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} isJapan=${r.isJapan} country=${r.country || '-'} basis=${r.basis} :: ${p.formattedAddress || p.internationalPhoneNumber || p.nationalPhoneNumber}`)
}
console.log(fail === 0 ? '\n✅ 全テストPASS（海外=EXCLUDED / 国内=OK）' : `\n❌ ${fail}件 失敗`)
process.exit(fail === 0 ? 0 : 1)

// ============================================================
// Google Places (New) 実行ロジック（サーバー専用）
// Vercel Functions(api/*) から静的importして使う。
// ※ ブラウザからは参照されない（クライアントバンドルには含まれない）。
//    秘密情報はコードに持たず、すべて process.env から実行時取得する。
// ============================================================
import { createClient } from '@supabase/supabase-js'
import { classifyLead } from './leadScoring.js'
import { DEFAULT_STATUS } from './constants.js'

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.types',
  'places.primaryType',
  'places.googleMapsUri',
  'places.regularOpeningHours',
].join(',')

export function getAdminClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（Vercel環境変数）')
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export function getDefaultSettings() {
  return {
    autoImport: true,
    placesEnabled: true,
    fetchLimit: 60,
    dailyCap: 30,
    areas: ['東京都葛飾区', '東京都足立区', '東京都江戸川区', '千葉県市川市', '千葉県船橋市', '埼玉県草加市', '埼玉県越谷市'],
    industries: ['美容室', '整体', '整骨院', 'リラクゼーション', 'エステ', '飲食店', '居酒屋', 'パーソナルジム', '士業', 'リフォーム', 'ハウスクリーニング'],
  }
}

function asArray(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[\n、,・]+/).map((x) => x.trim()).filter(Boolean)
  return fallback
}

/** Places Text Search。例外を投げず {status, places, error} を返す（診断用） */
async function searchTextRaw(
  apiKey: string, query: string, maxResultCount: number,
): Promise<{ status: number; places: any[]; error: string | null }> {
  try {
    const res = await fetch(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'ja',
        regionCode: 'JP',
        maxResultCount: Math.max(1, Math.min(20, maxResultCount)),
      }),
    })
    const status = res.status
    const text = await res.text().catch(() => '')
    let json: any = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = {} }
    if (!res.ok) {
      const msg = json?.error?.message || text || `HTTP ${status}`
      return { status, places: [], error: String(msg).slice(0, 500) }
    }
    const places = Array.isArray(json.places) ? json.places : []
    return { status, places, error: null }
  } catch (e: any) {
    return { status: 0, places: [], error: String(e?.message || e) }
  }
}

async function fetchCases(admin: any): Promise<any[]> {
  const all: any[] = []
  for (let page = 0; page < 10; page++) {
    const from = page * 1000
    const { data, error } = await admin
      .from('cases')
      .select('id,name,address,phone1,phone2,phone3,hp1,hp2,instagram')
      .range(from, from + 999)
    if (error) break
    const rows = data || []
    all.push(...rows)
    if (rows.length < 1000) break
  }
  return all
}

function phoneOf(p: any): string {
  return p.nationalPhoneNumber || p.internationalPhoneNumber || ''
}

/** メイン実行 */
export async function runGooglePlaces(admin: any, apiKey: string, rawSettings: any, userId: string | null) {
  const def = getDefaultSettings()
  const settings = {
    autoImport: rawSettings?.autoImport ?? def.autoImport,
    fetchLimit: Number(rawSettings?.fetchLimit) > 0 ? Number(rawSettings.fetchLimit) : def.fetchLimit,
    dailyCap: Number(rawSettings?.dailyCap) > 0 ? Number(rawSettings.dailyCap) : def.dailyCap,
    areas: asArray(rawSettings?.areas, def.areas),
    industries: asArray(rawSettings?.industries, def.industries),
  }

  // 動作確認用の固定条件（葛飾区 × 整体 × 20件）
  if (rawSettings?.testFixed) {
    settings.areas = ['東京都葛飾区']
    settings.industries = ['整体']
    settings.fetchLimit = 20
  }

  // 判定の閾値（口コミ件数など）
  const opts = {
    hotMaxReviews: Number(rawSettings?.hotMaxReviews) > 0 ? Number(rawSettings.hotMaxReviews) : 5,
    warmMaxReviews: Number(rawSettings?.warmMaxReviews) > 0 ? Number(rawSettings.warmMaxReviews) : 15,
    exclude100: rawSettings?.exclude100 ?? true,
    unknownHold: rawSettings?.unknownHold ?? true,
  }

  const { data: runRow } = await admin
    .from('auto_lead_runs')
    .insert({ source: 'google_places', status: 'running', created_by_id: userId })
    .select('id')
    .single()
  const runId: string | null = runRow?.id ?? null

  // 検索クエリ：通常「地域 業種」＋新規店が出やすい語を追加
  const queries: string[] = []
  for (const a of settings.areas) for (const i of settings.industries) {
    queries.push(`${a} 新規オープン ${i}`)
    queries.push(`${a} オープン ${i}`)
    queries.push(`${a} ${i}`)
  }

  const counts = {
    fetched: 0, hot: 0, hold: 0, excluded: 0, imported: 0, duplicate: 0, error: 0,
    noPhone: 0, chainExcluded: 0, saved: 0, saveError: 0,
    review0_5: 0, review6_15: 0, review16_99: 0, review100: 0, reviewUnknown: 0,
  }
  const debug: any = { queries, queryResults: [] as any[], sample: null, settings: { ...settings }, saveErrors: [] as string[] }
  let errorMessage = ''
  const recordSaveError = (msg: string) => {
    counts.saveError++
    if (debug.saveErrors.length < 5) debug.saveErrors.push(String(msg).slice(0, 300))
  }

  try {
    const cases = await fetchCases(admin)

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { count: importedToday } = await admin
      .from('lead_candidates')
      .select('id', { count: 'exact', head: true })
      .gte('imported_at', startToday.toISOString())
    let importedCount: number = importedToday || 0

    const nowIso = new Date().toISOString()

    for (const query of queries) {
      if (counts.fetched >= settings.fetchLimit) break
      const remain = settings.fetchLimit - counts.fetched
      const r = await searchTextRaw(apiKey, query, remain)
      debug.queryResults.push({ query, status: r.status, placesLength: r.places.length, error: r.error })
      if (r.error) {
        counts.error++
        errorMessage = r.error
      }
      const places = r.places

      for (const p of places) {
        if (counts.fetched >= settings.fetchLimit) break
        counts.fetched++
        const placeId: string = p.id || ''
        const phone = phoneOf(p)

        let existing: any = null
        if (placeId) {
          const { data } = await admin.from('lead_candidates').select('*').eq('google_place_id', placeId).limit(1)
          existing = data && data[0] ? data[0] : null
        }
        const reviewCount: number | null = typeof p.userRatingCount === 'number' ? p.userRatingCount : null
        // 口コミ件数の内訳カウント
        if (reviewCount === null) counts.reviewUnknown++
        else if (reviewCount <= opts.hotMaxReviews) counts.review0_5++
        else if (reviewCount <= opts.warmMaxReviews) counts.review6_15++
        else if (reviewCount < 100) counts.review16_99++
        else counts.review100++

        const classified: any = classifyLead(
          {
            name: p.displayName?.text || '',
            address: p.formattedAddress || '',
            industry: query.split(' ').slice(-1)[0],
            phone_number: phone,
            website_url: p.websiteUri || '',
            place_id: placeId,
            // 「未登録のplace_id（first-seen）」を新規GBPの前提として渡す。
            // 口コミ5件以下・営業中・非チェーン等の最終判定は classifyLead 側で行う。
            is_new_gbp: !existing,
            review_count: reviewCount ?? undefined,
            business_status: p.businessStatus || undefined,
          },
          cases,
          opts,
        )

        const payload: any = {
          ...classified,
          source_type: 'AI自動投入',
          detected_signals: classified.is_new_gbp ? ['GBP'] : (classified.detected_signals || []),
          google_place_id: placeId || null,
          google_maps_uri: p.googleMapsUri || null,
          rating: typeof p.rating === 'number' ? p.rating : null,
          user_rating_count: reviewCount,
          business_status: p.businessStatus || null,
          place_types: Array.isArray(p.types) ? p.types : null,
          primary_type: p.primaryType || null,
          website_url: p.websiteUri || null,
          search_query: query,
          source_run_id: runId,
          raw_payload: p,
          last_seen_at: nowIso,
        }

        if (classified.lead_temperature === 'HOT') counts.hot++
        else if (classified.lead_temperature === 'EXCLUDED') counts.excluded++
        else counts.hold++
        if (classified.duplicate_of_case_id) counts.duplicate++
        if (!classified.phone_normalized) counts.noPhone++
        if (
          classified.should_exclude_from_call_list &&
          (classified.is_chain_store || classified.is_in_shopping_mall || classified.is_in_station_building || classified.is_large_company_branch)
        ) counts.chainExcluded++

        // 先頭1件のサンプル（なぜその判定になったか確認用）
        if (!debug.sample) {
          debug.sample = {
            place: {
              name: p.displayName?.text || '',
              address: p.formattedAddress || '',
              nationalPhoneNumber: p.nationalPhoneNumber || '',
              internationalPhoneNumber: p.internationalPhoneNumber || '',
              websiteUri: p.websiteUri || '',
              primaryType: p.primaryType || '',
              types: p.types || [],
              rating: p.rating ?? null,
              userRatingCount: p.userRatingCount ?? null,
              businessStatus: p.businessStatus || '',
            },
            classified: {
              lead_temperature: classified.lead_temperature,
              owner_reachability_score: classified.owner_reachability_score,
              is_new_gbp: classified.is_new_gbp,
              user_rating_count: reviewCount,
              phone_normalized: classified.phone_normalized || '',
              should_exclude_from_call_list: classified.should_exclude_from_call_list,
              exclusion_reason: classified.exclusion_reason || '',
              detected_signals: payload.detected_signals,
              duplicate_of_case_id: classified.duplicate_of_case_id || null,
            },
          }
        }

        let candidateId: string | null = existing?.id || null
        const alreadyImported = !!existing?.imported_to_cases
        if (existing) {
          const { error: upErr } = await admin.from('lead_candidates').update(payload).eq('id', existing.id)
          if (upErr) recordSaveError('lead update: ' + upErr.message)
          else counts.saved++
        } else {
          const { data: ins, error: insErr } = await admin
            .from('lead_candidates')
            .insert({ ...payload, first_seen_at: nowIso, imported_to_cases: false, created_by_id: userId })
            .select('id')
            .single()
          if (insErr) recordSaveError('lead insert: ' + insErr.message)
          else counts.saved++
          candidateId = ins?.id || null
        }

        const canImport =
          settings.autoImport &&
          classified.lead_temperature === 'HOT' &&
          !classified.duplicate_of_case_id &&
          !alreadyImported &&
          importedCount < settings.dailyCap

        if (canImport && candidateId) {
          const memo = [
            `【AI自動投入 / GBP】`,
            `投入理由: ${classified.auto_import_reason || ''}`,
            `AIコメント: ${classified.ai_comment || ''}`,
            `オーナー到達スコア: ${classified.owner_reachability_score}`,
            `レビュー数: ${reviewCount ?? '不明'} / 評価: ${payload.rating ?? '不明'}`,
          ].join('\n')
          const { data: created, error: caseErr } = await admin
            .from('cases')
            .insert({
              name: classified.name,
              address: classified.address || '',
              phone1: classified.phone_number || '',
              industry: classified.industry || null,
              status: DEFAULT_STATUS,
              hp1: payload.website_url,
              instagram: classified.instagram_url || null,
              source_urls: 'AI自動投入',
              memo,
              created_by_id: userId,
            })
            .select('id')
            .single()
          if (caseErr) recordSaveError('case insert: ' + caseErr.message)
          if (created?.id) {
            await admin.from('lead_candidates').update({ imported_to_cases: true, imported_at: nowIso }).eq('id', candidateId)
          }
          if (created?.id) {
            counts.imported++
            importedCount++
            await admin.from('audit_logs').insert({
              action: 'create', entity: 'case', entity_id: created.id, entity_name: classified.name,
              detail: 'AI自動投入（Google Places）', actor_id: userId,
            }).then(() => {}, () => {})
          }
        }
      }
    }

    await admin.from('auto_lead_runs').update({
      status: 'success',
      finished_at: new Date().toISOString(),
      search_queries_count: queries.length,
      fetched_count: counts.fetched,
      hot_count: counts.hot,
      hold_count: counts.hold,
      excluded_count: counts.excluded,
      imported_count: counts.imported,
      duplicate_count: counts.duplicate,
      error_count: counts.error,
      error_message: errorMessage || null,
    }).eq('id', runId)

    debug.errorMessage = errorMessage || null
    return { ok: true, runId, queries: queries.length, ...counts, debug }
  } catch (e: any) {
    const msg = String(e?.message || e)
    await admin.from('auto_lead_runs').update({
      status: 'error', finished_at: new Date().toISOString(), error_message: msg,
      search_queries_count: queries.length, fetched_count: counts.fetched,
      hot_count: counts.hot, hold_count: counts.hold, excluded_count: counts.excluded,
      imported_count: counts.imported, duplicate_count: counts.duplicate, error_count: counts.error + 1,
    }).eq('id', runId)
    throw new Error(msg)
  }
}

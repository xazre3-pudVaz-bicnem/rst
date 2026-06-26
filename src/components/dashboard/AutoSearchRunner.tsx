import { useEffect, useRef } from 'react'
import { CaseApi } from '@/lib/api'
import { DEFAULT_STATUS } from '@/lib/constants'
import {
  GOOGLE_QUERIES,
  INSTAGRAM_HASHTAGS,
  TARGET_SITES,
  buildGooglePrompt,
  buildInstagramPrompt,
  buildPortalPrompt,
  extractShops,
} from '@/lib/llm'
import type { AutoSearchSettings, Case, ExtractedShop } from '@/lib/types'

interface Props {
  settings: AutoSearchSettings
  existingCases: Case[]
  onAdded: (count: number) => void
}

/**
 * 非表示のバックグラウンドランナー。
 * アプリ表示中のみ setInterval で定期実行する（MIGRATION_GUIDE 1.11）。
 */
export default function AutoSearchRunner({ settings, existingCases, onAdded }: Props) {
  const portalIdx = useRef(0)
  const instaIdx = useRef(0)
  const googleIdx = useRef(0)
  const running = useRef(false)
  // 最新の existingCases を参照するための ref
  const casesRef = useRef(existingCases)
  casesRef.current = existingCases

  useEffect(() => {
    if (!settings.enabled) return

    async function runBatch() {
      if (running.current) return
      running.current = true
      try {
        const prompts: string[] = []
        // ポータルサイト3件
        for (let i = 0; i < 3; i++) {
          prompts.push(buildPortalPrompt(TARGET_SITES[portalIdx.current % TARGET_SITES.length]))
          portalIdx.current++
        }
        // Instagram 2件
        for (let i = 0; i < 2; i++) {
          prompts.push(
            buildInstagramPrompt(
              INSTAGRAM_HASHTAGS[instaIdx.current % INSTAGRAM_HASHTAGS.length],
            ),
          )
          instaIdx.current++
        }
        // Google 1件
        prompts.push(buildGooglePrompt(GOOGLE_QUERIES[googleIdx.current % GOOGLE_QUERIES.length]))
        googleIdx.current++

        const found: ExtractedShop[] = []
        for (const p of prompts) {
          try {
            const shops = await extractShops(p)
            found.push(...shops)
          } catch (e) {
            // Edge Function 未設定など。静かにスキップ
            console.warn('[AutoSearch] skip:', e)
          }
        }

        // 既存案件と名前重複チェック → 新規のみ追加
        const existingNames = new Set(
          casesRef.current.map((c) => c.name.trim()),
        )
        let added = 0
        for (const s of found) {
          const name = s.name?.trim()
          if (!name || existingNames.has(name)) continue
          try {
            await CaseApi.create({
              name,
              address: s.address || '',
              phone1: s.phone1 || '',
              phone2: s.phone2 || null,
              industry: s.industry || null,
              representative: s.representative || null,
              hp1: s.hp1 || null,
              instagram: s.instagram || null,
              source_urls: s.source_urls || null,
              memo: s.memo || null,
              status: DEFAULT_STATUS,
            })
            existingNames.add(name)
            added++
          } catch (e) {
            console.warn('[AutoSearch] create failed:', e)
          }
        }
        if (added > 0) onAdded(added)
      } finally {
        running.current = false
      }
    }

    const intervalMs = Math.max(1, settings.intervalMinutes) * 60 * 1000
    const timer = setInterval(runBatch, intervalMs)
    // 有効化直後にも1回実行
    runBatch()

    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.enabled, settings.intervalMinutes])

  return null
}

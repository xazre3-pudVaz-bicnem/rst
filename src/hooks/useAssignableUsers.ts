import { useCallback, useEffect, useState } from 'react'
import { ProfileApi } from '@/lib/api'
import { FIXED_ADMIN_EMAIL } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import type { Profile } from '@/lib/types'

export interface AssignableUser { id: string; name: string }

function nameOf(p: Profile): string {
  return (p.full_name || p.username || p.email || '名称未設定').trim()
}

/**
 * 営業担当の候補をユーザー管理(profiles)から取得する共通フック。
 * 取得元: is_active=true かつ is_sales_assignee=true（固定admin/adminは常に候補）。
 * 案件やコール履歴からは拾わない＝過去案件でも常に同じ候補が出る。
 */
let cache: AssignableUser[] | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()
export function invalidateAssignableUsers() {
  cache = null
  inflight = null
  listeners.forEach((fn) => fn())
}

export function useAssignableUsers(): { users: AssignableUser[]; names: string[]; reload: () => void } {
  const [users, setUsers] = useState<AssignableUser[]>(cache ?? [])

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) return
    // 同時マウント時の二重フェッチを抑止（共有 inflight）
    if (!inflight) {
      inflight = (async () => {
        try {
          const list = await ProfileApi.list()
          const filtered = list.filter((p) => {
            const active = p.is_active !== false
            const fixed = (p.email || '').toLowerCase() === FIXED_ADMIN_EMAIL
            const sales = p.is_sales_assignee !== false
            return active && (sales || fixed || p.role === 'admin')
          })
          const seen = new Set<string>()
          const result: AssignableUser[] = []
          for (const p of filtered) {
            const name = nameOf(p)
            if (!name || seen.has(name)) continue
            seen.add(name)
            result.push({ id: p.id, name })
          }
          cache = result
          listeners.forEach((fn) => fn())
        } catch { /* RLS/未適用環境は空のまま */ }
        finally { inflight = null }
      })()
    }
    await inflight
    setUsers(cache ?? [])
  }, [])

  useEffect(() => {
    if (cache) setUsers(cache)
    else load()
    const fn = () => setUsers(cache ?? [])
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [load])

  return { users, names: users.map((u) => u.name), reload: load }
}

/** 現在値を保ちつつ候補リストを返す（旧担当者名はリストに無くても先頭に補完） */
export function withCurrent(names: string[], current?: string | null): string[] {
  const c = (current || '').trim()
  if (c && !names.includes(c)) return [c, ...names]
  return names
}

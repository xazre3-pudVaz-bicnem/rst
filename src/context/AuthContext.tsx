import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient'
import { ProfileApi } from '@/lib/api'
import type { Profile } from '@/lib/types'

interface AuthContextValue {
  session: Session | null
  user: User | null
  loading: boolean
  /** 表示用ユーザー名（profile.full_name → user_metadata → email の順で解決） */
  displayName: string
  /** ログインユーザーのプロフィール（未取得/未作成時は null） */
  profile: Profile | null
  /** ロール: 'admin' | 'member' | 'viewer'（不明時は member 相当） */
  role: string
  /** 書き込み権限（viewer 以外は true。既存運用を壊さないため既定は許可） */
  canWrite: boolean
  /** 管理者か */
  isAdmin: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

/** 固定管理者メール（常に admin・降格/削除不可） */
export const FIXED_ADMIN_EMAIL = 'odaharuki129@gmail.com'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    // env 未設定なら認証初期化をスキップ（無限ローディング/クラッシュ防止）
    if (!isSupabaseConfigured) {
      setLoading(false)
      return
    }
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch((e) => console.warn('[Auth] getSession failed', e))
      .finally(() => setLoading(false))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const user = session?.user ?? null

  // プロフィール（ロール）取得
  useEffect(() => {
    if (!isSupabaseConfigured || !user) {
      setProfile(null)
      return
    }
    let cancelled = false
    ProfileApi.me(user.id)
      .then((p) => { if (!cancelled) setProfile(p) })
      .catch(() => { if (!cancelled) setProfile(null) })
    return () => { cancelled = true }
  }, [user])

  const displayName =
    profile?.full_name ||
    (user?.user_metadata?.full_name as string | undefined) ||
    user?.email ||
    'ゲスト'

  // 固定管理者は常に admin（誤降格を防止）
  const forcedAdmin = (user?.email || '').trim().toLowerCase() === FIXED_ADMIN_EMAIL
  // profiles 未適用環境でも書き込みできるよう、role 不明時は member 扱い
  const role = forcedAdmin ? 'admin' : (profile?.role || 'member')
  const canWrite = role !== 'viewer'
  const isAdmin = role === 'admin'

  const value: AuthContextValue = {
    session,
    user,
    loading,
    displayName,
    profile,
    role,
    canWrite,
    isAdmin,
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw new Error(error.message)
    },
    async signUp(email, password) {
      const { error } = await supabase.auth.signUp({ email, password })
      if (error) throw new Error(error.message)
    },
    async signOut() {
      await supabase.auth.signOut()
      window.location.href = '/'
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

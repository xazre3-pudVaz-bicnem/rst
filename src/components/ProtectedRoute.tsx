import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { APPO_AGENCY_PATHS } from '@/lib/constants'

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading, isActive, isAppoAgency, signOut } = useAuth()
  const location = useLocation()

  // Supabase 未設定時はログインを通過させ、画面側で警告表示
  if (!isSupabaseConfigured) return <>{children}</>

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-xs">
        読み込み中...
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // 無効化ユーザーは利用不可
  if (!isActive) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-base font-bold">このアカウントは現在利用できません</div>
        <div className="text-xs text-muted-foreground">管理者によって無効化されています。利用再開は管理者にお問い合わせください。</div>
        <button onClick={signOut} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">ログアウト</button>
      </div>
    )
  }

  // アポ代行会社（社外）は訪問予定だけ。URL直打ちで他のページに入らせない
  // （データ自体もRLSで止めているが、画面も見せない）
  if (isAppoAgency && !APPO_AGENCY_PATHS.some((p) => location.pathname === p)) {
    return <Navigate to="/appointments" replace />
  }

  return <>{children}</>
}

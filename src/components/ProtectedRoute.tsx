import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
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

  return <>{children}</>
}

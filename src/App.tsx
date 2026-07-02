import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '@/context/AuthContext'
import { ToastProvider } from '@/components/ui/toast'
import { ConfirmProvider } from '@/components/ui/confirm'
import ErrorBoundary from '@/components/ErrorBoundary'
import EnvWarning from '@/components/EnvWarning'
import ProtectedRoute from '@/components/ProtectedRoute'
import CommandPalette from '@/components/CommandPalette'
import Login from '@/pages/Login'

// ルート単位のコード分割（初期表示を軽量化）
const Home = lazy(() => import('@/pages/Home'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Appointments = lazy(() => import('@/pages/Appointments'))
const Analytics = lazy(() => import('@/pages/Analytics'))
const Users = lazy(() => import('@/pages/Users'))
const AuditLog = lazy(() => import('@/pages/AuditLog'))
const Leads = lazy(() => import('@/pages/Leads'))
const AiScripts = lazy(() => import('@/pages/AiScripts'))
const MobileCall = lazy(() => import('@/pages/MobileCall'))

function PageFallback() {
  return (
    <div className="flex h-screen items-center justify-center text-xs text-muted-foreground">
      読み込み中...
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
           <ConfirmProvider>
            <EnvWarning />
            <CommandPalette />
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                {/* スマホ連動はキーで入るため認証不要 */}
                <Route path="/mobile-call" element={<MobileCall />} />
                <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                <Route path="/home" element={<ProtectedRoute><Home /></ProtectedRoute>} />
                <Route path="/appointments" element={<ProtectedRoute><Appointments /></ProtectedRoute>} />
                <Route path="/analytics" element={<ProtectedRoute><Analytics /></ProtectedRoute>} />
                <Route path="/leads" element={<ProtectedRoute><Leads /></ProtectedRoute>} />
                <Route path="/ai-scripts" element={<ProtectedRoute><AiScripts /></ProtectedRoute>} />
                <Route path="/users" element={<ProtectedRoute><Users /></ProtectedRoute>} />
                <Route path="/audit" element={<ProtectedRoute><AuditLog /></ProtectedRoute>} />
              </Routes>
            </Suspense>
           </ConfirmProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

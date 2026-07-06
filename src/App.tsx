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
const LaborHome = lazy(() => import('@/pages/labor/LaborHome'))
const SalesDashboard = lazy(() => import('@/pages/SalesDashboard'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Appointments = lazy(() => import('@/pages/Appointments'))
const Analytics = lazy(() => import('@/pages/Analytics'))
const Users = lazy(() => import('@/pages/Users'))
const AuditLog = lazy(() => import('@/pages/AuditLog'))
const Leads = lazy(() => import('@/pages/Leads'))
const AiScripts = lazy(() => import('@/pages/AiScripts'))
const MobileCall = lazy(() => import('@/pages/MobileCall'))

// 労務管理（配下画面）
const LaborEmployees = lazy(() => import('@/pages/labor/Employees'))
const LaborAttendance = lazy(() => import('@/pages/labor/Attendance'))
const LaborShifts = lazy(() => import('@/pages/labor/Shifts'))
const LaborLeaves = lazy(() => import('@/pages/labor/Leaves'))
const LaborApprovals = lazy(() => import('@/pages/labor/Approvals'))
const LaborPayroll = lazy(() => import('@/pages/labor/Payroll'))
const LaborDocuments = lazy(() => import('@/pages/labor/Documents'))
const LaborAlerts = lazy(() => import('@/pages/labor/Alerts'))
const LaborSettingsPage = lazy(() => import('@/pages/labor/LaborSettings'))
const LaborAuditPage = lazy(() => import('@/pages/labor/LaborAudit'))

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
                {/* /home は労務管理ダッシュボードに変更。営業ホームは /sales-dashboard へ退避 */}
                <Route path="/home" element={<ProtectedRoute><LaborHome /></ProtectedRoute>} />
                <Route path="/sales-dashboard" element={<ProtectedRoute><SalesDashboard /></ProtectedRoute>} />
                <Route path="/appointments" element={<ProtectedRoute><Appointments /></ProtectedRoute>} />
                <Route path="/analytics" element={<ProtectedRoute><Analytics /></ProtectedRoute>} />
                <Route path="/leads" element={<ProtectedRoute><Leads /></ProtectedRoute>} />
                <Route path="/ai-scripts" element={<ProtectedRoute><AiScripts /></ProtectedRoute>} />
                <Route path="/users" element={<ProtectedRoute><Users /></ProtectedRoute>} />
                <Route path="/audit" element={<ProtectedRoute><AuditLog /></ProtectedRoute>} />

                {/* 労務管理 */}
                <Route path="/labor/home" element={<ProtectedRoute><LaborHome /></ProtectedRoute>} />
                <Route path="/labor/employees" element={<ProtectedRoute><LaborEmployees /></ProtectedRoute>} />
                <Route path="/labor/attendance" element={<ProtectedRoute><LaborAttendance /></ProtectedRoute>} />
                <Route path="/labor/shifts" element={<ProtectedRoute><LaborShifts /></ProtectedRoute>} />
                <Route path="/labor/leaves" element={<ProtectedRoute><LaborLeaves /></ProtectedRoute>} />
                <Route path="/labor/approvals" element={<ProtectedRoute><LaborApprovals /></ProtectedRoute>} />
                <Route path="/labor/payroll" element={<ProtectedRoute><LaborPayroll /></ProtectedRoute>} />
                <Route path="/labor/documents" element={<ProtectedRoute><LaborDocuments /></ProtectedRoute>} />
                <Route path="/labor/alerts" element={<ProtectedRoute><LaborAlerts /></ProtectedRoute>} />
                <Route path="/labor/settings" element={<ProtectedRoute><LaborSettingsPage /></ProtectedRoute>} />
                <Route path="/labor/audit" element={<ProtectedRoute><LaborAuditPage /></ProtectedRoute>} />
              </Routes>
            </Suspense>
           </ConfirmProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

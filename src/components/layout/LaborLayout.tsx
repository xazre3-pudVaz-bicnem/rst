import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import TopBar from './TopBar'
import { useAuth } from '@/context/AuthContext'
import { laborPerms } from '@/lib/labor'
import { cn } from '@/lib/utils'

/** 労務管理サブメニュー定義 */
export const LABOR_NAV: { to: string; label: string; manageOnly?: boolean; adminOnly?: boolean }[] = [
  { to: '/home', label: '労務ホーム' },
  { to: '/labor/employees', label: '従業員' },
  { to: '/labor/attendance', label: '勤怠' },
  { to: '/labor/shifts', label: 'シフト' },
  { to: '/labor/leaves', label: '休暇' },
  { to: '/labor/approvals', label: '申請承認' },
  { to: '/labor/payroll', label: '給与連携' },
  { to: '/labor/payroll-calc', label: '給与計算', manageOnly: true },
  { to: '/labor/year-end', label: '年末調整', manageOnly: true },
  { to: '/labor/social-insurance', label: '社会保険', manageOnly: true },
  { to: '/labor/my-number', label: 'マイナンバー', adminOnly: true },
  { to: '/labor/e-applications', label: '電子申請', manageOnly: true },
  { to: '/labor/sharoshi', label: '社労士連携', manageOnly: true },
  { to: '/labor/documents', label: '労務書類' },
  { to: '/labor/alerts', label: 'アラート' },
  { to: '/labor/settings', label: '労務設定', adminOnly: true },
  { to: '/labor/audit', label: '労務監査ログ', manageOnly: true },
]

/**
 * 労務管理配下の共通レイアウト。
 * 上部に本体TopBar、その下に労務サブナビを表示する。
 */
export default function LaborLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { role } = useAuth()
  const perms = laborPerms(role)

  const items = LABOR_NAV.filter((n) => {
    if (n.adminOnly && !perms.canConfigure) return false
    if (n.manageOnly && !perms.canManage) return false
    return true
  })

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex items-center gap-0.5 overflow-x-auto border-b bg-card/60 px-2 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((n) => {
          const active = location.pathname === n.to
          return (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                'shrink-0 rounded px-2 py-1 text-xs transition-colors',
                active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {n.label}
            </Link>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  )
}

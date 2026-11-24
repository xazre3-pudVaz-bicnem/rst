import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import TopBar from './TopBar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/context/AuthContext'
import { laborPerms } from '@/lib/labor'
import { cn } from '@/lib/utils'

export interface LaborNavItem { to: string; label: string; manageOnly?: boolean; adminOnly?: boolean }

/**
 * 労務管理サブメニュー定義。
 * 18項目を横1列に並べていたため、毎日使う画面が埋もれていた。
 * 「毎日使うもの」だけを出し、月次・設定系はまとめて畳む。
 */
export const LABOR_MAIN_NAV: LaborNavItem[] = [
  { to: '/home', label: 'ホーム' },
  { to: '/labor/attendance', label: '勤怠' },
  { to: '/labor/shifts', label: 'シフト' },
  { to: '/labor/leaves', label: '休暇' },
  { to: '/labor/approvals', label: '申請承認' },
  { to: '/labor/travel-expenses', label: '交通費' },
  { to: '/labor/employees', label: '従業員' },
]
/** 月次・年次の給与まわり */
export const LABOR_PAY_NAV: LaborNavItem[] = [
  { to: '/labor/payroll-calc', label: '給与計算', manageOnly: true },
  { to: '/labor/payroll', label: '給与連携' },
  { to: '/labor/year-end', label: '年末調整', manageOnly: true },
  { to: '/labor/social-insurance', label: '社会保険', manageOnly: true },
  { to: '/labor/my-number', label: 'マイナンバー', adminOnly: true },
]
/** たまにしか触らない管理系 */
export const LABOR_ADMIN_NAV: LaborNavItem[] = [
  { to: '/labor/documents', label: '労務書類' },
  { to: '/labor/alerts', label: 'アラート' },
  { to: '/labor/e-applications', label: '電子申請', manageOnly: true },
  { to: '/labor/sharoshi', label: '社労士連携', manageOnly: true },
  { to: '/labor/settings', label: '労務設定', adminOnly: true },
  { to: '/labor/audit', label: '監査ログ', manageOnly: true },
]
/** 旧API互換（コマンドパレット等が参照する全項目） */
export const LABOR_NAV: LaborNavItem[] = [...LABOR_MAIN_NAV, ...LABOR_PAY_NAV, ...LABOR_ADMIN_NAV]

/**
 * 労務管理配下の共通レイアウト。
 * 上部に本体TopBar、その下に労務サブナビを表示する。
 */
export default function LaborLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { role } = useAuth()
  const perms = laborPerms(role)

  const allowed = (n: LaborNavItem) => {
    if (n.adminOnly && !perms.canConfigure) return false
    if (n.manageOnly && !perms.canManage) return false
    return true
  }
  const main = LABOR_MAIN_NAV.filter(allowed)
  const pay = LABOR_PAY_NAV.filter(allowed)
  const adminItems = LABOR_ADMIN_NAV.filter(allowed)

  const linkClass = (active: boolean) => cn(
    'shrink-0 rounded px-2.5 py-1 text-xs transition-colors',
    active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent',
  )

  /** 畳んだメニュー。中のどれかを開いていれば見出しも選択色にする */
  const menu = (label: string, items: LaborNavItem[]) => {
    if (!items.length) return null
    const active = items.some((n) => n.to === location.pathname)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className={cn(linkClass(active), 'flex items-center gap-0.5')}>
            {label}<ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[150px]">
          {items.map((n) => (
            <DropdownMenuItem key={n.to} asChild>
              <Link to={n.to} className="w-full cursor-pointer text-xs">{n.label}</Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex items-center gap-0.5 overflow-x-auto border-b bg-card/60 px-2 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {main.map((n) => (
          <Link key={n.to} to={n.to} className={linkClass(location.pathname === n.to)}>{n.label}</Link>
        ))}
        <span className="mx-1 h-4 w-px shrink-0 bg-border" />
        {menu('給与', pay)}
        {menu('管理', adminItems)}
      </div>
      <div className="flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  )
}

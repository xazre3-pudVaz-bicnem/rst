import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, ListChecks, Calendar, Users, ScrollText, Sparkles, LogOut, Bot, Briefcase, ChevronDown, Handshake } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/context/AuthContext'
import { roleLabel } from '@/lib/constants'
import { LABOR_NAV } from './LaborLayout'
import { laborPerms } from '@/lib/labor'
import KpiBar from './KpiBar'
import NotificationBell from './NotificationBell'
import ThemeToggle from './ThemeToggle'

export default function TopBar() {
  const { displayName, signOut, isAdmin, role } = useAuth()
  const location = useLocation()
  const perms = laborPerms(role)
  const laborActive = location.pathname === '/home' || location.pathname.startsWith('/labor')
  const laborItems = LABOR_NAV.filter((n) => {
    if (n.adminOnly && !perms.canConfigure) return false
    if (n.manageOnly && !perms.canManage) return false
    return true
  })

  const navItem = (to: string, label: string, icon: React.ReactNode) => {
    const active = location.pathname === to
    return (
      <Link
        to={to}
        title={label}
        className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors sm:px-2 ${
          active
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-muted-foreground hover:bg-accent'
        }`}
      >
        {icon}
        <span className="hidden sm:inline">{label}</span>
      </Link>
    )
  }

  return (
    <header className="z-10 flex h-10 items-center justify-between gap-1 border-b bg-card px-2 shadow-sm sm:px-3">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <Link to="/home" className="flex shrink-0 items-center gap-1 text-base font-bold text-primary">
          RST
        </Link>
        <nav className="flex items-center gap-0.5 overflow-x-auto sm:gap-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {navItem('/home', 'ホーム', <LayoutDashboard className="h-3.5 w-3.5" />)}
          {/* 案件は全リロードで検索リセット */}
          <a
            href="/"
            title="案件"
            className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors sm:px-2 ${
              location.pathname === '/' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            <ListChecks className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">案件</span>
          </a>
          {navItem('/leads', 'AI投入', <Sparkles className="h-3.5 w-3.5" />)}
          {navItem('/appointments', '訪問予定', <Calendar className="h-3.5 w-3.5" />)}
          {navItem(
            '/analytics',
            'KPI',
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v18h18M9 17V9m4 8V5m4 12v-6" />
            </svg>,
          )}
          {navItem('/sales-dashboard', '営業ダッシュボード', <LayoutDashboard className="h-3.5 w-3.5" />)}
          {navItem('/deals', '成約案件', <Handshake className="h-3.5 w-3.5" />)}
          {navItem('/users', 'ユーザー', <Users className="h-3.5 w-3.5" />)}

          {/* 労務管理（ドロップダウン） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                title="労務管理"
                className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors sm:px-2 ${
                  laborActive ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                <Briefcase className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">労務管理</span>
                <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[160px]">
              {laborItems.map((n) => (
                <DropdownMenuItem key={n.to} asChild>
                  <Link to={n.to} className="w-full cursor-pointer text-xs">{n.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {isAdmin && navItem('/ai-scripts', 'AIトーク', <Bot className="h-3.5 w-3.5" />)}
          {isAdmin && navItem('/audit', '監査', <ScrollText className="h-3.5 w-3.5" />)}
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <ThemeToggle />
        <NotificationBell />
        {/* KPIバー・担当者名は幅を取るため大画面のみ表示 */}
        <div className="hidden lg:block"><KpiBar /></div>
        <span className="hidden text-2xs text-muted-foreground lg:inline">
          {displayName} <span className="text-primary">/ {roleLabel(role)}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={signOut} title="ログアウト" className="px-1.5 sm:px-3">
          <LogOut className="h-3.5 w-3.5" /><span className="hidden sm:inline">ログアウト</span>
        </Button>
      </div>
    </header>
  )
}

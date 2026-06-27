import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, ListChecks, Calendar, Users, ScrollText, Sparkles, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/context/AuthContext'
import KpiBar from './KpiBar'
import NotificationBell from './NotificationBell'
import ThemeToggle from './ThemeToggle'

export default function TopBar() {
  const { displayName, signOut, isAdmin } = useAuth()
  const location = useLocation()

  const navItem = (to: string, label: string, icon: React.ReactNode) => {
    const active = location.pathname === to
    return (
      <Link
        to={to}
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
          active
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-muted-foreground hover:bg-accent'
        }`}
      >
        {icon}
        {label}
      </Link>
    )
  }

  return (
    <header className="z-10 flex h-10 items-center justify-between border-b bg-card px-3 shadow-sm">
      <div className="flex items-center gap-3">
        <Link to="/home" className="flex items-center gap-1 text-base font-bold text-primary">
          RST
        </Link>
        <nav className="flex items-center gap-1">
          {navItem('/home', 'ホーム', <LayoutDashboard className="h-3.5 w-3.5" />)}
          {/* 案件は全リロードで検索リセット */}
          <a
            href="/"
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
              location.pathname === '/' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            <ListChecks className="h-3.5 w-3.5" />
            案件
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
          {navItem('/users', 'ユーザー', <Users className="h-3.5 w-3.5" />)}
          {isAdmin && navItem('/audit', '監査', <ScrollText className="h-3.5 w-3.5" />)}
        </nav>
      </div>

      <div className="flex items-center gap-2">
        <ThemeToggle />
        <NotificationBell />
        <KpiBar />
        <span className="hidden text-2xs text-muted-foreground sm:inline">
          {displayName}
        </span>
        <Button variant="ghost" size="icon" onClick={signOut} title="ログアウト">
          <LogOut className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  )
}

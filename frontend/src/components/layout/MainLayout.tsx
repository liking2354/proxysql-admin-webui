import { useState, useMemo, useCallback } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { useI18n } from '../../i18n'
import ServerSelector from '../ServerSelector'
import LanguageSwitcher from '../LanguageSwitcher'
import ThemeToggle from '../ThemeToggle'
import GlobalSearch from '../GlobalSearch'
import {
  LayoutDashboard, Wand2, Table, Terminal, RefreshCw,
  Users, Server, LogOut, Menu, X, GitCompare, Settings,
  Network, Rocket, Archive, Search, Database, Route,
} from 'lucide-react'

export default function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const { user, logout } = useAuthStore()
  const { t } = useI18n()
  const navigate = useNavigate()

  // Navigation grouped by ProxySQL operational workflow rather than a flat list.
  // Order reflects the day-to-day path: observe -> configure -> operate -> manage.
  // useMemo keeps the structure stable so NavLink children don't re-render.
  const navGroups = useMemo(() => [
    {
      label: t('nav.groupMonitor'),
      items: [
        { path: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
        { path: '/rules', label: t('nav.rules'), icon: Route },
      ],
    },
    {
      label: t('nav.groupConfig'),
      items: [
        { path: '/tables', label: t('nav.tables'), icon: Table },
        { path: '/sync', label: t('nav.sync'), icon: RefreshCw },
        { path: '/config-diff', label: t('nav.configDiff'), icon: GitCompare },
        { path: '/wizards', label: t('nav.wizards'), icon: Wand2, tourId: 'nav-wizards' },
        { path: '/template', label: t('nav.template'), icon: Rocket },
      ],
    },
    {
      label: t('nav.groupOps'),
      items: [
        { path: '/query', label: t('nav.query'), icon: Terminal },
        { path: '/database', label: t('nav.database'), icon: Database },
        { path: '/backup', label: t('nav.backup'), icon: Archive },
      ],
    },
    {
      label: t('nav.groupSystem'),
      items: [
        { path: '/servers', label: t('nav.servers'), icon: Server },
        { path: '/clusters', label: t('nav.clusters'), icon: Network },
        { path: '/users', label: t('nav.users'), icon: Users },
        { path: '/settings', label: t('nav.settings'), icon: Settings },
      ],
    },
  ], [t])

  // useCallback: stable handler across renders
  const handleLogout = useCallback(() => {
    logout()
    navigate('/login')
  }, [logout, navigate])

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev)
  }, [])

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-slate-900">
      {/* Sidebar */}
      <aside
        data-tour="sidebar"
        role="navigation"
        aria-label={t('nav.sidebar') || 'Main navigation'}
        className={`${sidebarOpen ? 'w-64' : 'w-16'} bg-white dark:bg-slate-800 border-r border-gray-200 dark:border-slate-700 flex flex-col transition-all duration-200`}
      >
        <div className="h-14 flex items-center justify-between px-4 border-b border-gray-200 dark:border-slate-700">
          {sidebarOpen && <h1 className="text-lg font-bold text-blue-600 dark:text-blue-400">{t('login.title')}</h1>}
          <button
            onClick={handleToggleSidebar}
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            className="p-1 hover:bg-gray-100 dark:hover:bg-slate-700 rounded"
          >
            {sidebarOpen ? <X size={18} className="text-gray-600 dark:text-slate-400" /> : <Menu size={18} className="text-gray-600 dark:text-slate-400" />}
          </button>
        </div>

        <nav className="flex-1 py-3 overflow-y-auto">
          {navGroups.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? 'mt-3' : ''}>
              {sidebarOpen ? (
                <p className="px-4 mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500">
                  {group.label}
                </p>
              ) : (
                gi > 0 && <div className="mx-3 mb-2 border-t border-gray-200 dark:border-slate-700" />
              )}
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  title={sidebarOpen ? undefined : item.label}
                  data-tour={(item as { tourId?: string }).tourId}
                  className={({ isActive }) =>
                    `flex items-center px-4 py-2 mx-2 rounded-lg mb-0.5 transition-colors ${
                      isActive
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                        : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
                    }`
                  }
                >
                  <item.icon size={18} className="shrink-0" />
                  {sidebarOpen && <span className="ml-3 text-sm">{item.label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-200 dark:border-slate-700">
          {sidebarOpen && (
            <div className="mb-3">
              <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{user?.username}</p>
              <p className="text-xs text-gray-500 dark:text-slate-400 capitalize">{user?.role}</p>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center text-sm text-gray-600 dark:text-slate-400 hover:text-red-600 w-full"
          >
            <LogOut size={18} />
            {sidebarOpen && <span className="ml-2">{t('layout.logout')}</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto" role="main">
        {/* Top bar with server selector, search, and language switcher */}
        <header className="h-14 flex items-center justify-between px-6 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800">
          <div data-tour="server-selector">
            <ServerSelector />
          </div>
          <div className="flex items-center gap-3">
            {/* Global search trigger */}
            <button
              data-search-trigger
              data-tour="search-trigger"
              onClick={() => setSearchOpen(true)}
              className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-slate-600 transition-colors min-w-[180px]"
            >
              <Search size={13} />
              <span className="flex-1 text-left">{t('search.placeholder')}</span>
              <kbd className="text-[10px] text-gray-400 dark:text-slate-500 bg-white dark:bg-slate-800 px-1 py-0.5 rounded border border-gray-200 dark:border-slate-600">
                ⌘K
              </kbd>
            </button>
            <div data-tour="theme-language" className="flex items-center gap-3">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
            <div className="text-sm text-gray-500 dark:text-slate-400">
              {user?.username} <span>({t(`layout.role.${user?.role}`) !== `layout.role.${user?.role}` ? t(`layout.role.${user?.role}`) : user?.role})</span>
            </div>
          </div>
        </header>
        {/* Global Search Modal */}
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
        <div className="p-6" role="region" aria-label="Page content">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

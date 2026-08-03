import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import { Search, ArrowRight, X, Hash } from 'lucide-react'

interface SearchItem {
  id: string
  label: string
  keywords: string[]
  path: string
  category: string
  icon?: string
}

/**
 * Build a static search index from all known pages, wizards, and sections.
 * Keep this in sync with MainLayout navItems and wizard definitions.
 */
function buildSearchIndex(t: (key: string) => string): SearchItem[] {
  return [
    // ── Pages ──
    { id: 'page-dashboard', label: t('nav.dashboard'), keywords: ['dashboard', '仪表盘', 'overview', '概览', 'status', '状态'], path: '/dashboard', category: 'search.page' },
    { id: 'page-rules', label: t('nav.rules'), keywords: ['rule', '规则', 'route', '路由', 'query_rules', 'hostgroup', '主机组', 'simulate', '模拟', 'force_master', 'digest', 'pattern'], path: '/rules', category: 'search.page' },
    { id: 'page-wizards', label: t('nav.wizards'), keywords: ['wizard', '向导', 'configure', '配置'], path: '/wizards', category: 'search.page' },
    { id: 'page-template', label: t('nav.template'), keywords: ['template', '模板', 'quick', '快速', 'deploy', '部署'], path: '/template', category: 'search.page' },
    { id: 'page-tables', label: t('nav.tables'), keywords: ['table', '表', 'browser', '浏览器', 'data', '数据'], path: '/tables', category: 'search.page' },
    { id: 'page-query', label: t('nav.query'), keywords: ['sql', 'console', '控制台', 'query', '查询', 'execute', '执行'], path: '/query', category: 'search.page' },
    { id: 'page-sync', label: t('nav.sync'), keywords: ['sync', '同步', 'apply', '应用', 'save', '保存', 'config', '配置'], path: '/sync', category: 'search.page' },
    { id: 'page-configdiff', label: t('nav.configDiff'), keywords: ['diff', '对比', 'compare', '比较', 'difference', '差异'], path: '/config-diff', category: 'search.page' },
    { id: 'page-servers', label: t('nav.servers'), keywords: ['server', '服务器', 'instance', '实例', 'add', '添加', 'manage', '管理'], path: '/servers', category: 'search.page' },
    { id: 'page-clusters', label: t('nav.clusters'), keywords: ['cluster', '集群', 'group', '组', 'node', '节点'], path: '/clusters', category: 'search.page' },
    { id: 'page-backup', label: t('nav.backup'), keywords: ['backup', '备份', 'restore', '恢复', 'snapshot', '快照'], path: '/backup', category: 'search.page' },
    { id: 'page-database', label: t('nav.database'), keywords: ['database', '数据库', 'mysql', 'table', '表', 'sql', 'data', '数据'], path: '/database', category: 'search.page' },
    { id: 'page-users', label: t('nav.users'), keywords: ['user', '用户', 'role', '角色', 'permission', '权限', 'account', '账号'], path: '/users', category: 'search.page' },
    { id: 'page-settings', label: t('nav.settings'), keywords: ['settings', '设置', 'system', '系统', 'audit', '审计', 'info', '信息'], path: '/settings', category: 'search.page' },
    // ── Wizard categories (W01-W63, added as scannable entries) ──
    { id: 'wiz-backend-servers', label: t('wizard.category.backend_servers'), keywords: ['backend', '后端', 'mysql', 'pgsql', 'server', '服务器'], path: '/wizards', category: 'search.wizard' },
    { id: 'wiz-user-auth', label: t('wizard.category.backend_users'), keywords: ['user', '用户', 'auth', '认证', 'credential', '凭据'], path: '/wizards', category: 'search.wizard' },
    { id: 'wiz-query-routing', label: t('wizard.category.query_routing'), keywords: ['routing', '路由', 'read', 'write', '读写', 'split', '分离'], path: '/wizards', category: 'search.wizard' },
    { id: 'wiz-replication', label: t('wizard.category.replication_topology'), keywords: ['replication', '复制', 'topology', '拓扑', 'cluster', '集群'], path: '/wizards', category: 'search.wizard' },
    { id: 'wiz-system', label: t('wizard.category.system_config'), keywords: ['system', '系统', 'variable', '变量', 'pool', '连接池'], path: '/wizards', category: 'search.wizard' },
    { id: 'wiz-firewall', label: t('wizard.category.firewall_security'), keywords: ['firewall', '防火墙', 'security', '安全', 'whitelist', '白名单'], path: '/wizards', category: 'search.wizard' },
    { id: 'wiz-operations', label: t('wizard.category.operations'), keywords: ['operations', '运维', 'backup', '备份', 'restore', '恢复'], path: '/wizards', category: 'search.wizard' },
    { id: 'wiz-monitoring', label: t('wizard.category.monitoring'), keywords: ['monitoring', '监控', 'diagnostics', '诊断', 'stats', '统计'], path: '/wizards', category: 'search.wizard' },
    // ── Specific high-value wizards ──
    { id: 'wiz-W16', label: t('wizard.W16.name'), keywords: ['read-write', '读写分离', 'split', 'routing', '路由'], path: '/wizards/W16', category: 'search.wizard' },
    { id: 'wiz-W46', label: t('wizard.W46.name'), keywords: ['apply', '应用', 'runtime', '运行时', '生效'], path: '/wizards/W46', category: 'search.wizard' },
    { id: 'wiz-W47', label: t('wizard.W47.name'), keywords: ['save', '保存', 'disk', '磁盘', 'persist', '持久化'], path: '/wizards/W47', category: 'search.wizard' },
    // ── Key config tables ──
    { id: 'table-mysql_servers', label: 'mysql_servers', keywords: ['mysql', 'server', '后端', 'backend', 'hostgroup'], path: '/tables/mysql_servers', category: 'search.table' },
    { id: 'table-mysql_users', label: 'mysql_users', keywords: ['user', '用户', 'auth', 'credential'], path: '/tables/mysql_users', category: 'search.table' },
    { id: 'table-mysql_query_rules', label: 'mysql_query_rules', keywords: ['rule', '规则', 'routing', '路由', 'query'], path: '/tables/mysql_query_rules', category: 'search.table' },
  ]
}

/** Simple fuzzy match: score items by substring match in label and keywords. */
function fuzzyMatch(items: SearchItem[], query: string): SearchItem[] {
  if (!query.trim()) return items
  const q = query.toLowerCase()
  return items
    .map((item) => {
      let score = 0
      const lbl = item.label.toLowerCase()
      if (lbl === q) score += 100
      else if (lbl.startsWith(q)) score += 50
      else if (lbl.includes(q)) score += 30
      for (const kw of item.keywords) {
        if (kw.toLowerCase().includes(q)) score += 20
      }
      return { item, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item)
}

interface GlobalSearchProps {
  /** Open state; managed by parent */
  open: boolean
  /** Callback to close */
  onClose: () => void
}

export default function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const index = useMemo(() => buildSearchIndex(t), [t])
  const results = useMemo(() => fuzzyMatch(index, query), [index, query])

  // Reset state when opening/closing
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Clamp active index
  useEffect(() => {
    if (activeIdx >= results.length && results.length > 0) {
      setActiveIdx(results.length - 1)
    }
  }, [results.length, activeIdx])

  const navigateTo = useCallback(
    (path: string) => {
      navigate(path)
      onClose()
    },
    [navigate, onClose]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((prev) => (prev + 1) % results.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((prev) => (prev - 1 + results.length) % results.length)
      } else if (e.key === 'Enter' && results[activeIdx]) {
        e.preventDefault()
        navigateTo(results[activeIdx].path)
      } else if (e.key === 'Escape') {
        onClose()
      }
    },
    [results, activeIdx, navigateTo, onClose]
  )

  // Global keyboard listener for Ctrl+K / Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (open) onClose()
        else {
          // Toggle: parent will set open=true
          ;(document.querySelector('[data-search-trigger]') as HTMLButtonElement)?.click()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      {/* Dialog */}
      <div className="relative z-10 w-full max-w-xl mx-4 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-2xl overflow-hidden">
        {/* Input */}
        <div className="flex items-center px-4 border-b border-gray-200 dark:border-slate-700">
          <Search size={18} className="text-gray-400 dark:text-slate-500 mr-3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0) }}
            onKeyDown={handleKeyDown}
            placeholder={t('search.placeholder')}
            className="flex-1 py-3.5 bg-transparent text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 outline-none text-sm"
          />
          {/* Keyboard shortcut badge */}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 dark:text-slate-500 bg-gray-100 dark:bg-slate-700 rounded border border-gray-200 dark:border-slate-600 ml-2">
            <span className="text-xs">⌘</span>K
          </kbd>
          <button onClick={onClose} className="ml-2 p-1 hover:bg-gray-100 dark:hover:bg-slate-700 rounded">
            <X size={16} className="text-gray-400 dark:text-slate-500" />
          </button>
        </div>
        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {results.length === 0 && query && (
            <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-slate-500">
              {t('search.noResults')}
            </div>
          )}
          {results.map((item, idx) => (
            <button
              key={item.id}
              onClick={() => navigateTo(item.path)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                idx === activeIdx
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/50'
              }`}
              onMouseEnter={() => setActiveIdx(idx)}
            >
              {/* Category icon or hash */}
              <span className="w-6 h-6 flex items-center justify-center rounded bg-gray-100 dark:bg-slate-700 text-xs text-gray-500 dark:text-slate-400 shrink-0">
                <Hash size={12} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{item.label}</div>
                <div className="text-[11px] text-gray-400 dark:text-slate-500 truncate">
                  {t(item.category) !== item.category ? t(item.category) : item.category}
                </div>
              </div>
              <ArrowRight size={14} className="text-gray-300 dark:text-slate-600 shrink-0" />
            </button>
          ))}
          {!query && (
            <div className="px-4 py-2 text-[11px] text-gray-400 dark:text-slate-500">
              {t('search.typeToSearch')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

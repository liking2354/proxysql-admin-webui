import { useMemo, useRef, useState, useEffect } from 'react'
import { useServerStore } from '../stores/serverStore'
import { useAuthStore } from '../stores/authStore'
import { useI18n } from '../i18n'
import { useWebSocket } from '../hooks/useWebSocket'
import { useNavigate } from 'react-router-dom'
import {
  Activity, Database, Zap, Server, Wifi, WifiOff, Clock, TrendingUp,
  AlertTriangle, Route, ChevronRight, Gauge,
} from 'lucide-react'

/** Dashboard snapshot data shape (matches backend dashboard_service response). */
interface ConnectionInfo {
  used: number
  free: number
  ok?: number
  error?: number
  [key: string]: unknown
}

interface HostgroupRow {
  hostgroup: string
  srv_host: string
  srv_port: number
  status: string
  ConnUsed: number
  ConnFree: number
  ConnOK?: number
  ConnERR?: number
  Queries?: number
  Latency_us?: number
  [key: string]: unknown
}

/** One row of stats_mysql_query_digest — the primary tool for perf triage. */
interface DigestRow {
  hostgroup: number | string
  schemaname: string | null
  username: string | null
  digest_text: string
  count_star: number | string
  sum_time: number | string
  min_time: number | string
  max_time: number | string
  [key: string]: unknown
}

interface DashboardSnapshot {
  connections: ConnectionInfo[]
  qps: { questions: number }[]
  traffic: { queries: number }[]
  hostgroups: HostgroupRow[]
  query_digest?: DigestRow[] | { error: string }
  timestamp?: string
  [key: string]: unknown
}

interface DashboardWsMessage {
  type: string
  server_id: string
  data: DashboardSnapshot
}

const POLL_INTERVAL_SEC = 5

function buildWsUrl(serverId: string, token: string | null): string | null {
  if (!serverId || !token) return null
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const params = new URLSearchParams({ token, interval: String(POLL_INTERVAL_SEC) })
  return `${protocol}//${host}/ws/dashboard/${serverId}?${params.toString()}`
}

/** Format microseconds into a human-readable duration. */
function fmtUs(us: number): string {
  if (!Number.isFinite(us) || us < 0) return '-'
  if (us < 1000) return `${us} µs`
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`
  return `${(us / 1_000_000).toFixed(2)} s`
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '-'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Tiny inline sparkline (no chart lib needed). */
function Sparkline({ data, color = '#3b82f6' }: { data: number[]; color?: string }) {
  if (data.length < 2) return <div className="h-8" />
  const w = 100
  const h = 32
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-8">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5"
                vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={color} opacity="0.12" />
    </svg>
  )
}

export default function DashboardPage() {
  const selectedId = useServerStore((s) => s.selectedId)
  const token = useAuthStore((s) => s.token)
  const { t } = useI18n()
  const navigate = useNavigate()

  const wsUrl = useMemo(() => buildWsUrl(selectedId!, token), [selectedId, token])
  const { data, isConnected, error, reconnect } = useWebSocket<DashboardWsMessage>(wsUrl, !!selectedId)

  // Debounce the disconnect indicator: a brief drop (e.g. during HMR or a
  // single missed frame) shouldn't flash the "reconnecting" badge. Only report
  // a disconnect once it has persisted for a couple of seconds.
  const [showDisconnected, setShowDisconnected] = useState(false)
  useEffect(() => {
    if (isConnected) {
      setShowDisconnected(false)
      return
    }
    const timer = setTimeout(() => setShowDisconnected(true), 2000)
    return () => clearTimeout(timer)
  }, [isConnected])

  const snapshot: DashboardSnapshot = data?.data || {
    connections: [], qps: [], traffic: [], hostgroups: [],
  }
  const connections = snapshot.connections?.[0] || {}
  const questionsTotal = Number(snapshot.qps?.[0]?.questions || 0)
  const trafficTotal = Number(snapshot.traffic?.[0]?.queries || 0)

  // ── Derive a real QPS rate from the cumulative Questions counter ──
  // ProxySQL's stats_mysql_global.Questions is monotonically increasing, so the
  // raw value is NOT a rate. We diff consecutive samples to get queries/sec.
  const prevRef = useRef<{ questions: number; ts: number } | null>(null)
  const [qpsRate, setQpsRate] = useState(0)
  const [qpsHistory, setQpsHistory] = useState<number[]>([])
  const [connHistory, setConnHistory] = useState<number[]>([])

  const snapshotTs = snapshot.timestamp
  const usedConns = Number(connections.used || 0)

  // Effect (not render-phase) so state updates never cause a render loop.
  useEffect(() => {
    if (!snapshotTs) return
    const now = Date.parse(snapshotTs) || Date.now()
    const prev = prevRef.current
    prevRef.current = { questions: questionsTotal, ts: now }

    // First sample only establishes the baseline.
    if (!prev || now <= prev.ts || questionsTotal < prev.questions) return

    const rate = (questionsTotal - prev.questions) / ((now - prev.ts) / 1000)
    setQpsRate(rate)
    setQpsHistory((h) => [...h, rate].slice(-40))
    setConnHistory((h) => [...h, usedConns].slice(-40))
  }, [snapshotTs, questionsTotal, usedConns])

  const hostgroups: HostgroupRow[] = snapshot.hostgroups || []
  const digestRaw = snapshot.query_digest
  const digestRows: DigestRow[] = Array.isArray(digestRaw) ? digestRaw : []
  const digestError = !Array.isArray(digestRaw) && digestRaw?.error ? digestRaw.error : null

  // Aggregate per-hostgroup traffic share — shows if cross-cloud routing is balanced
  const hgShare = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of digestRows) {
      const k = String(d.hostgroup)
      m.set(k, (m.get(k) || 0) + Number(d.count_star || 0))
    }
    const total = [...m.values()].reduce((a, b) => a + b, 0) || 1
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([hg, cnt]) => ({ hg, cnt, pct: (cnt / total) * 100 }))
  }, [digestRows])

  const cards = useMemo(() => [
    {
      label: t('dashboard.activeConnections'),
      value: fmtNum(Number(connections.used || 0)),
      icon: Activity,
      iconCls: 'text-blue-500',
      spark: connHistory,
      sparkColor: '#3b82f6',
      hint: `${t('dashboard.freeConnections')}: ${fmtNum(Number(connections.free || 0))}`,
    },
    {
      label: t('dashboard.qps'),
      value: qpsRate > 0 ? qpsRate.toFixed(1) : '—',
      icon: Gauge,
      iconCls: 'text-orange-500',
      spark: qpsHistory,
      sparkColor: '#f97316',
      hint: t('dashboard.qpsHint'),
    },
    {
      label: t('dashboard.totalQuestions'),
      value: fmtNum(questionsTotal),
      icon: TrendingUp,
      iconCls: 'text-purple-500',
      hint: t('dashboard.cumulativeHint'),
    },
    {
      label: t('dashboard.totalQueries'),
      value: fmtNum(trafficTotal),
      icon: Database,
      iconCls: 'text-green-500',
      hint: t('dashboard.commandsHint'),
    },
  ], [connections.used, connections.free, qpsRate, questionsTotal, trafficTotal, qpsHistory, connHistory, t])

  if (!selectedId) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-amber-700 dark:text-amber-400">
        {t('dashboard.noServerSelected')}
      </div>
    )
  }

  const offlineHgs = hostgroups.filter((h) => h.status !== 'ONLINE')

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">{t('dashboard.title')}</h2>
          {snapshot.timestamp && (
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 inline-flex items-center gap-1">
              <Clock size={12} />
              {t('dashboard.lastUpdate')}: {new Date(snapshot.timestamp).toLocaleTimeString()}
              <span className="text-gray-400 dark:text-slate-500">· {POLL_INTERVAL_SEC}s</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!showDisconnected ? (
            <span className="inline-flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
              <Wifi size={16} /> {t('dashboard.connected')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-slate-400">
              <WifiOff size={16} /> {t('dashboard.reconnecting')}
            </span>
          )}
          {error && showDisconnected && (
            <button onClick={reconnect} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
              {t('common.retry')}
            </button>
          )}
        </div>
      </div>

      {/* ── Backend health alert ── */}
      {offlineHgs.length > 0 && (
        <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg px-4 py-3">
          <AlertTriangle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm text-red-700 dark:text-red-400">
            <p className="font-medium">{t('dashboard.backendUnhealthy')}</p>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
              {offlineHgs.map((h, i) => (
                <li key={i}>HG{h.hostgroup} · {h.srv_host}:{h.srv_port} → {h.status}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── Metric Cards ── */}
      <div data-tour="dashboard-cards" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div key={card.label} className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-500 dark:text-slate-400">{card.label}</span>
              <card.icon size={18} className={card.iconCls} />
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-slate-100 tabular-nums">{card.value}</p>
            {card.spark && card.spark.length > 1 ? (
              <Sparkline data={card.spark} color={card.sparkColor} />
            ) : (
              <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1 h-8 flex items-end">{card.hint}</p>
            )}
          </div>
        ))}
      </div>

      {/* ── Hostgroup traffic share (cross-cloud routing balance) ── */}
      {hgShare.length > 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
              <Route size={18} className="text-blue-600 dark:text-blue-400" />
              {t('dashboard.routingShare')}
            </h3>
            <button
              onClick={() => navigate('/rules')}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
            >
              {t('dashboard.viewRules')} <ChevronRight size={14} />
            </button>
          </div>
          <div className="space-y-2.5">
            {hgShare.map(({ hg, cnt, pct }) => {
              const hosts = hostgroups.filter((h) => String(h.hostgroup) === hg)
              return (
                <div key={hg}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-mono font-medium text-gray-800 dark:text-slate-200">
                      HG{hg}
                      {hosts.length > 0 && (
                        <span className="ml-2 text-xs font-normal text-gray-500 dark:text-slate-400">
                          {hosts.map((h) => `${h.srv_host}:${h.srv_port}`).join(', ')}
                        </span>
                      )}
                    </span>
                    <span className="text-gray-600 dark:text-slate-400 tabular-nums">
                      {fmtNum(cnt)} <span className="text-xs text-gray-400">({pct.toFixed(1)}%)</span>
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-500 dark:bg-blue-400 transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-3">{t('dashboard.shareHint')}</p>
        </div>
      )}

      {/* ── Top slow queries — the #1 perf triage tool, previously discarded ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
            <Zap size={18} className="text-amber-500" />
            {t('dashboard.topQueries')}
          </h3>
          <span className="text-xs text-gray-500 dark:text-slate-400">{t('dashboard.topQueriesHint')}</span>
        </div>
        {digestError ? (
          <div className="px-5 py-4 text-sm text-red-600 dark:text-red-400 font-mono">{digestError}</div>
        ) : digestRows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400 dark:text-slate-500">
            {t('dashboard.noDigest')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                  <th className="text-left py-2 px-3 font-medium text-gray-600 dark:text-slate-400 w-14">HG</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600 dark:text-slate-400">SQL</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400 w-20">{t('dashboard.calls')}</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400 w-24">{t('dashboard.sumTime')}</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400 w-24">{t('dashboard.avgTime')}</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400 w-24">{t('dashboard.maxTime')}</th>
                </tr>
              </thead>
              <tbody>
                {digestRows.map((d, i) => {
                  const calls = Number(d.count_star || 0)
                  const sum = Number(d.sum_time || 0)
                  const avg = calls > 0 ? sum / calls : 0
                  // Highlight queries whose average latency looks cross-cloud (>5ms)
                  const slow = avg > 5000
                  return (
                    <tr key={i} className="border-b border-gray-100 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700/40">
                      <td className="py-2 px-3">
                        <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300">
                          {d.hostgroup}
                        </span>
                      </td>
                      <td className="py-2 px-3 max-w-md">
                        <code
                          title={d.digest_text}
                          className="block font-mono text-xs text-gray-700 dark:text-slate-300 truncate"
                        >
                          {d.digest_text}
                        </code>
                        {(d.schemaname || d.username) && (
                          <span className="text-[11px] text-gray-400 dark:text-slate-500">
                            {d.schemaname}{d.username ? ` · ${d.username}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-gray-700 dark:text-slate-300">{fmtNum(calls)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-gray-700 dark:text-slate-300">{fmtUs(sum)}</td>
                      <td className={`py-2 px-3 text-right tabular-nums font-medium ${slow ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-slate-300'}`}>
                        {fmtUs(avg)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-gray-500 dark:text-slate-400">{fmtUs(Number(d.max_time || 0))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Connection Pool ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
            <Server size={18} className="text-blue-600 dark:text-blue-400" />
            {t('dashboard.connectionPool')}
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="text-left py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('dashboard.hostgroup')}</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('dashboard.host')}</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('dashboard.port')}</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('common.status')}</th>
                <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('dashboard.used')}</th>
                <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('dashboard.free')}</th>
                <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('dashboard.queries')}</th>
                <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{t('dashboard.latency')}</th>
              </tr>
            </thead>
            <tbody>
              {hostgroups.map((hg: HostgroupRow, i: number) => {
                const lat = Number(hg.Latency_us || 0)
                // >5ms typically indicates a cross-cloud (rather than local) backend
                const crossCloud = lat > 5000
                return (
                  <tr key={i} className="border-b border-gray-100 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700/40">
                    <td className="py-2 px-3 font-mono">{hg.hostgroup}</td>
                    <td className="py-2 px-3 font-mono text-xs">{hg.srv_host}</td>
                    <td className="py-2 px-3 font-mono text-xs">{hg.srv_port}</td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                        hg.status === 'ONLINE' ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' :
                        hg.status === 'SHUNNED' ? 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400' :
                        'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                      }`}>
                        {hg.status}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{hg.ConnUsed}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{hg.ConnFree}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{fmtNum(Number(hg.Queries || 0))}</td>
                    <td className={`py-2 px-3 text-right tabular-nums ${crossCloud ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}
                        title={crossCloud ? t('dashboard.crossCloudHint') : undefined}>
                      {fmtUs(lat)}
                    </td>
                  </tr>
                )
              })}
              {hostgroups.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-gray-400 dark:text-slate-500">
                    {t('dashboard.noBackends')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

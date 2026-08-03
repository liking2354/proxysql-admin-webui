import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tablesApi, syncApi } from '../api/client'
import { useServerStore } from '../stores/serverStore'
import { useI18n } from '../i18n'
import {
  Route, Play, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2,
  Copy, Check, Zap, ArrowDown, Server, Layers, RefreshCw, Save,
  Eye, EyeOff, Search, X,
} from 'lucide-react'

/** A row from mysql_query_rules. */
interface QueryRule {
  rule_id: number
  active: number | string
  match_digest: string | null
  match_pattern: string | null
  negate_match_pattern: number | string
  re_modifiers: string | null
  destination_hostgroup: number | string | null
  apply: number | string
  comment: string | null
  username: string | null
  schemaname: string | null
  flagIN: number | string | null
  flagOUT: number | string | null
  client_addr: string | null
  proxy_addr: string | null
  proxy_port: number | string | null
  digest: string | null
  error_msg: string | null
  timeout: number | string | null
  retries: number | string | null
  delay: number | string | null
  mirror_hostgroup: number | string | null
  log: number | string | null
  multiplex: number | string | null
  [key: string]: unknown
}

interface ServerRow {
  hostgroup_id: number | string
  hostname: string
  port: number | string
  status: string
  [key: string]: unknown
}

interface MysqlUser {
  username: string
  default_hostgroup: number | string
  active: number | string
  transaction_persistent: number | string
  [key: string]: unknown
}

/** Result of simulating one SQL statement against the rule chain. */
interface SimResult {
  sql: string
  matchedRuleId: number | null
  matchedField: 'match_pattern' | 'match_digest' | null
  hostgroup: number | string | null
  isDefault: boolean
  /** Rules evaluated but not matched, in order. */
  evaluated: { rule_id: number; matched: boolean; reason?: string }[]
  regexError?: string
}

/**
 * Convert a ProxySQL (RE2) regex into a JS RegExp.
 *
 * ProxySQL uses RE2 by default with the CASELESS modifier controlling case
 * sensitivity. Inline `(?i)` is also honoured. JS RegExp is close enough for
 * the common table-name / hint patterns used in routing rules; unsupported
 * RE2 constructs will surface as a regex error in the UI rather than silently
 * producing wrong results.
 */
function toJsRegex(pattern: string, reModifiers: string | null): RegExp {
  let src = pattern
  let flags = ''

  // Inline (?i) at the start -> JS 'i' flag (JS doesn't support inline groups)
  if (/^\(\?i\)/.test(src)) {
    src = src.replace(/^\(\?i\)/, '')
    flags += 'i'
  }
  // ProxySQL re_modifiers column, e.g. "CASELESS" or "CASELESS,GLOBAL"
  if (reModifiers && /CASELESS/i.test(reModifiers) && !flags.includes('i')) {
    flags += 'i'
  }
  return new RegExp(src, flags)
}

/**
 * Simulate ProxySQL's query-rule evaluation for a single SQL statement.
 *
 * Mirrors ProxySQL semantics:
 *  - rules are evaluated in ascending rule_id order
 *  - inactive rules (active=0) are skipped
 *  - match_pattern runs against the raw SQL, match_digest against the
 *    normalised digest (approximated here by replacing literals with '?')
 *  - negate_match_pattern inverts the match
 *  - apply=1 short-circuits the chain
 *  - if nothing matches, the user's default_hostgroup wins
 */
function simulate(
  sql: string,
  rules: QueryRule[],
  defaultHostgroup: number | string | null,
): SimResult {
  const evaluated: SimResult['evaluated'] = []
  const digest = approximateDigest(sql)

  const sorted = [...rules].sort((a, b) => Number(a.rule_id) - Number(b.rule_id))

  for (const r of sorted) {
    if (Number(r.active) !== 1) {
      evaluated.push({ rule_id: Number(r.rule_id), matched: false, reason: 'inactive' })
      continue
    }
    const usePattern = r.match_pattern != null && r.match_pattern !== ''
    const useDigest = r.match_digest != null && r.match_digest !== ''
    if (!usePattern && !useDigest) {
      evaluated.push({ rule_id: Number(r.rule_id), matched: false, reason: 'no-regex' })
      continue
    }

    const raw = (usePattern ? r.match_pattern : r.match_digest) as string
    const subject = usePattern ? sql : digest

    let hit: boolean
    try {
      hit = toJsRegex(raw, r.re_modifiers).test(subject)
    } catch (e) {
      return {
        sql,
        matchedRuleId: null,
        matchedField: null,
        hostgroup: null,
        isDefault: false,
        evaluated,
        regexError: `rule_id=${r.rule_id}: ${(e as Error).message}`,
      }
    }

    if (Number(r.negate_match_pattern) === 1) hit = !hit

    evaluated.push({ rule_id: Number(r.rule_id), matched: hit })

    if (hit && r.destination_hostgroup != null && r.destination_hostgroup !== '') {
      // apply=1 -> stop evaluating further rules
      if (Number(r.apply) === 1) {
        return {
          sql,
          matchedRuleId: Number(r.rule_id),
          matchedField: usePattern ? 'match_pattern' : 'match_digest',
          hostgroup: r.destination_hostgroup,
          isDefault: false,
          evaluated,
        }
      }
    }
  }

  return {
    sql,
    matchedRuleId: null,
    matchedField: null,
    hostgroup: defaultHostgroup,
    isDefault: true,
    evaluated,
  }
}

/**
 * Approximate ProxySQL's query digest normalisation.
 *
 * ProxySQL replaces literals with '?' when building digest_text. This is a
 * best-effort client-side approximation used only for match_digest simulation.
 * Note: ProxySQL strips comments before digest computation, which is exactly
 * why hint-based rules must use match_pattern instead of match_digest.
 */
function approximateDigest(sql: string): string {
  return sql
    // strip comments (ProxySQL does this before computing the digest)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    // string literals -> ?
    .replace(/'(?:[^'\\]|\\.)*'/g, '?')
    .replace(/"(?:[^"\\]|\\.)*"/g, '?')
    // numeric literals -> ?
    .replace(/\b\d+\.?\d*\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Preset SQL samples covering the routing scenarios of this deployment. */
const PRESET_SQLS = [
  'SELECT /* FORCE_MASTER */ * FROM any_table WHERE id = 1',
  'SELECT COUNT(*) FROM sexytea_order.t_order',
  'UPDATE t_order SET status = 1 WHERE id = 100',
  'INSERT INTO pay_flow_info (id) VALUES (1)',
  'SELECT * FROM t_sys_config',
  'SELECT VERSION()',
]

export default function QueryRulesPage() {
  const selectedId = useServerStore((s) => s.selectedId)
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [layer, setLayer] = useState<'memory' | 'runtime'>('runtime')
  const [simSql, setSimSql] = useState(PRESET_SQLS[0])
  const [expandedRule, setExpandedRule] = useState<number | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [regexFilter, setRegexFilter] = useState('')
  const [showFullRegex, setShowFullRegex] = useState<Record<number, boolean>>({})

  const rulesTable = layer === 'runtime' ? 'runtime_mysql_query_rules' : 'mysql_query_rules'
  const serversTable = layer === 'runtime' ? 'runtime_mysql_servers' : 'mysql_servers'
  const usersTable = layer === 'runtime' ? 'runtime_mysql_users' : 'mysql_users'

  const { data: rulesRes, isLoading, refetch } = useQuery({
    queryKey: ['qr-rules', selectedId, rulesTable],
    queryFn: () => tablesApi.getData(selectedId!, rulesTable, { limit: 500 }),
    enabled: !!selectedId,
  })
  const { data: serversRes } = useQuery({
    queryKey: ['qr-servers', selectedId, serversTable],
    queryFn: () => tablesApi.getData(selectedId!, serversTable, { limit: 200 }),
    enabled: !!selectedId,
  })
  const { data: usersRes } = useQuery({
    queryKey: ['qr-users', selectedId, usersTable],
    queryFn: () => tablesApi.getData(selectedId!, usersTable, { limit: 200 }),
    enabled: !!selectedId,
  })
  const { data: hitsRes } = useQuery({
    queryKey: ['qr-hits', selectedId],
    queryFn: () => tablesApi.getData(selectedId!, 'stats_mysql_query_rules', { limit: 500 }),
    enabled: !!selectedId,
    refetchInterval: 10000,
  })

  const applyMut = useMutation({
    mutationFn: () => syncApi.apply(selectedId!, ['mysql_query_rules']),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['qr-rules'] }),
  })
  const saveMut = useMutation({
    mutationFn: () => syncApi.save(selectedId!, ['mysql_query_rules']),
  })

  const rules: QueryRule[] = useMemo(() => {
    const raw = rulesRes?.data?.rows || []
    return [...raw].sort((a: QueryRule, b: QueryRule) => Number(a.rule_id) - Number(b.rule_id))
  }, [rulesRes])

  const servers: ServerRow[] = serversRes?.data?.rows || []
  const users: MysqlUser[] = usersRes?.data?.rows || []

  /** hostgroup_id -> "host:port" list, for showing where a rule actually sends traffic. */
  const hgMap = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of servers) {
      const k = String(s.hostgroup_id)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(`${s.hostname}:${s.port}`)
    }
    return m
  }, [servers])

  /** rule_id -> hits, from stats_mysql_query_rules. */
  const hitsMap = useMemo(() => {
    const m = new Map<number, number>()
    for (const row of (hitsRes?.data?.rows || []) as { rule_id: number; hits: number }[]) {
      m.set(Number(row.rule_id), Number(row.hits))
    }
    return m
  }, [hitsRes])

  const defaultHg = users[0]?.default_hostgroup ?? null
  const defaultUser = users[0]?.username ?? '-'

  const simResult = useMemo(
    () => (simSql.trim() ? simulate(simSql, rules, defaultHg) : null),
    [simSql, rules, defaultHg],
  )

  const filteredRules = useMemo(() => {
    if (!regexFilter.trim()) return rules
    const q = regexFilter.toLowerCase()
    return rules.filter((r) =>
      String(r.rule_id).includes(q) ||
      (r.comment || '').toLowerCase().includes(q) ||
      (r.match_pattern || '').toLowerCase().includes(q) ||
      (r.match_digest || '').toLowerCase().includes(q),
    )
  }, [rules, regexFilter])

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1200)
    } catch { /* clipboard unavailable */ }
  }

  if (!selectedId) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-amber-700 dark:text-amber-400">
        {t('rules.noServer')}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
            <Route size={24} className="text-blue-600 dark:text-blue-400" />
            {t('rules.title')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">{t('rules.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Layer switch */}
          <div className="flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden">
            {(['runtime', 'memory'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLayer(l)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  layer === l
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700'
                }`}
              >
                {l === 'runtime' ? t('rules.layerRuntime') : t('rules.layerMemory')}
              </button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700"
          >
            <RefreshCw size={14} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* ── Layer warning: memory != runtime means unapplied changes ── */}
      {layer === 'memory' && (
        <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg px-4 py-3">
          <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm text-amber-800 dark:text-amber-300">
            <p className="font-medium">{t('rules.memoryWarnTitle')}</p>
            <p className="mt-0.5">{t('rules.memoryWarnDesc')}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => applyMut.mutate()}
              disabled={applyMut.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg"
            >
              <Zap size={13} />
              {applyMut.isPending ? t('common.loading') : t('rules.applyRuntime')}
            </button>
            <button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300 border border-amber-400 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50 rounded-lg"
            >
              <Save size={13} />
              {saveMut.isPending ? t('common.loading') : t('rules.saveDisk')}
            </button>
          </div>
        </div>
      )}
      {applyMut.isSuccess && (
        <div className="flex items-center gap-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg px-4 py-2 text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 size={16} /> {t('rules.applied')}
        </div>
      )}

      {/* ── Route Simulator ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 bg-gradient-to-r from-blue-50 to-transparent dark:from-slate-700/50">
          <h3 className="font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
            <Play size={18} className="text-blue-600 dark:text-blue-400" />
            {t('rules.simulatorTitle')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{t('rules.simulatorDesc')}</p>
        </div>
        <div className="p-5 space-y-3">
          <textarea
            value={simSql}
            onChange={(e) => setSimSql(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={t('rules.simulatorPlaceholder')}
            className="w-full px-3 py-2 font-mono text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />

          {/* Preset samples */}
          <div className="flex flex-wrap gap-1.5">
            {PRESET_SQLS.map((s, i) => (
              <button
                key={i}
                onClick={() => setSimSql(s)}
                title={s}
                className="px-2 py-1 text-xs font-mono text-gray-600 dark:text-slate-400 bg-gray-100 dark:bg-slate-700 hover:bg-blue-100 dark:hover:bg-slate-600 rounded transition-colors max-w-[240px] truncate"
              >
                {s}
              </button>
            ))}
          </div>

          {/* Simulation verdict */}
          {simResult && (
            <div className="space-y-3">
              {simResult.regexError ? (
                <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg px-4 py-3 text-sm text-red-700 dark:text-red-400">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">{t('rules.regexError')}</p>
                    <p className="font-mono text-xs mt-1">{simResult.regexError}</p>
                  </div>
                </div>
              ) : (
                <div className={`rounded-lg border-2 px-4 py-3 ${
                  simResult.isDefault
                    ? 'bg-slate-50 dark:bg-slate-900/40 border-slate-300 dark:border-slate-600'
                    : 'bg-blue-50 dark:bg-blue-900/20 border-blue-400 dark:border-blue-600'
                }`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="text-sm text-gray-500 dark:text-slate-400">{t('rules.verdict')}</span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 font-mono text-sm font-bold text-gray-900 dark:text-slate-100">
                      <Server size={14} className="text-blue-600 dark:text-blue-400" />
                      HG{simResult.hostgroup ?? '-'}
                    </span>
                    {hgMap.get(String(simResult.hostgroup))?.length ? (
                      <span className="font-mono text-xs text-gray-600 dark:text-slate-400">
                        → {hgMap.get(String(simResult.hostgroup))!.join(', ')}
                      </span>
                    ) : null}
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-slate-700 text-gray-700 dark:text-slate-300">
                      {simResult.isDefault
                        ? `${t('rules.viaDefault')} (${defaultUser}.default_hostgroup)`
                        : `${t('rules.viaRule')} rule_id=${simResult.matchedRuleId} · ${simResult.matchedField}`}
                    </span>
                  </div>

                  {/* Evaluation trace */}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {simResult.evaluated.map((e, i) => (
                      <span key={i} className="inline-flex items-center gap-1">
                        <span className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${
                          e.matched
                            ? 'bg-green-200 dark:bg-green-900/50 text-green-800 dark:text-green-300 font-bold'
                            : e.reason
                              ? 'bg-gray-200 dark:bg-slate-700 text-gray-400 dark:text-slate-500 line-through'
                              : 'bg-gray-200 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
                        }`}>
                          #{e.rule_id}{e.reason ? ` (${e.reason})` : ''}
                        </span>
                        {i < simResult.evaluated.length - 1 && (
                          <ChevronRight size={11} className="text-gray-400 dark:text-slate-600" />
                        )}
                      </span>
                    ))}
                    {simResult.isDefault && (
                      <>
                        <ChevronRight size={11} className="text-gray-400 dark:text-slate-600" />
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-slate-300 dark:bg-slate-600 text-slate-800 dark:text-slate-200 font-bold">
                          {t('rules.defaultFallback')}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Comment-stripping caveat: the #1 gotcha when testing hint rules */}
              {/\/\*/.test(simSql) && (
                <div className="flex items-start gap-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded-lg px-3 py-2 text-xs text-yellow-800 dark:text-yellow-300">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium">{t('rules.commentTipTitle')}</span>{' '}
                    {t('rules.commentTipDesc')}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Rule chain ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
            <Layers size={18} className="text-blue-600 dark:text-blue-400" />
            {t('rules.chainTitle')}
            <span className="text-sm font-normal text-gray-500 dark:text-slate-400">
              ({filteredRules.length}{regexFilter ? ` / ${rules.length}` : ''})
            </span>
          </h3>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={regexFilter}
              onChange={(e) => setRegexFilter(e.target.value)}
              placeholder={t('rules.filterPlaceholder')}
              className="pl-8 pr-8 py-1.5 text-sm w-56 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-gray-800 dark:text-slate-200"
            />
            {regexFilter && (
              <button
                onClick={() => setRegexFilter('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="p-5">
          {isLoading ? (
            <p className="text-sm text-gray-500 dark:text-slate-400">{t('common.loading')}</p>
          ) : filteredRules.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-slate-500 text-center py-6">{t('rules.noRules')}</p>
          ) : (
            <div className="space-y-2">
              {filteredRules.map((r, idx) => {
                const rid = Number(r.rule_id)
                const isOpen = expandedRule === rid
                const inactive = Number(r.active) !== 1
                const field: 'match_pattern' | 'match_digest' | null =
                  r.match_pattern ? 'match_pattern' : r.match_digest ? 'match_digest' : null
                const regex = (r.match_pattern || r.match_digest || '') as string
                const hits = hitsMap.get(rid)
                const isSimMatch = simResult?.matchedRuleId === rid
                const full = showFullRegex[rid]

                return (
                  <div key={rid}>
                    <div
                      className={`rounded-lg border transition-colors ${
                        isSimMatch
                          ? 'border-green-400 dark:border-green-600 bg-green-50 dark:bg-green-900/20 ring-1 ring-green-300 dark:ring-green-700'
                          : inactive
                            ? 'border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 opacity-60'
                            : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-blue-300 dark:hover:border-blue-700'
                      }`}
                    >
                      <div
                        onClick={() => setExpandedRule(isOpen ? null : rid)}
                        className="px-4 py-3 cursor-pointer"
                      >
                        <div className="flex items-start gap-3">
                          {/* Priority index */}
                          <div className="flex flex-col items-center shrink-0 pt-0.5">
                            <span className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-bold flex items-center justify-center">
                              {idx + 1}
                            </span>
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1.5">
                              <span className="font-mono text-sm font-bold text-gray-900 dark:text-slate-100">
                                rule_id={rid}
                              </span>
                              {field && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 font-mono">
                                  {field}
                                </span>
                              )}
                              {Number(r.negate_match_pattern) === 1 && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300">
                                  NEGATE
                                </span>
                              )}
                              {Number(r.apply) === 1 && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                                  {t('rules.shortCircuit')}
                                </span>
                              )}
                              {inactive && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-400">
                                  {t('rules.inactive')}
                                </span>
                              )}
                              {isSimMatch && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-200 dark:bg-green-900/50 text-green-800 dark:text-green-300 font-bold inline-flex items-center gap-1">
                                  <CheckCircle2 size={11} /> {t('rules.simMatched')}
                                </span>
                              )}
                            </div>

                            {r.comment && (
                              <p className="text-sm text-gray-700 dark:text-slate-300 mb-1.5">{r.comment}</p>
                            )}

                            {/* Regex preview / full */}
                            {regex && (
                              <div className="flex items-start gap-1.5">
                                <code className={`flex-1 text-xs font-mono text-gray-600 dark:text-slate-400 bg-gray-100 dark:bg-slate-900 rounded px-2 py-1 ${full ? 'break-all whitespace-pre-wrap' : 'truncate'}`}>
                                  {regex}
                                </code>
                                <span className="text-[11px] text-gray-400 dark:text-slate-500 shrink-0 pt-1 tabular-nums">
                                  {regex.length}
                                </span>
                                {regex.length > 80 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setShowFullRegex((p) => ({ ...p, [rid]: !full }))
                                    }}
                                    title={full ? t('rules.collapse') : t('rules.expandRegex')}
                                    className="shrink-0 mt-0.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                                  >
                                    {full ? <EyeOff size={13} /> : <Eye size={13} />}
                                  </button>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleCopy(`r${rid}`, regex) }}
                                  title={t('rules.copyRegex')}
                                  className="shrink-0 mt-0.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                                >
                                  {copiedKey === `r${rid}` ? <Check size={13} /> : <Copy size={13} />}
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Destination + hits */}
                          <div className="shrink-0 text-right">
                            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-100 dark:bg-slate-700 font-mono text-sm font-bold text-gray-900 dark:text-slate-100">
                              <Server size={13} className="text-blue-600 dark:text-blue-400" />
                              HG{r.destination_hostgroup ?? '-'}
                            </div>
                            {hgMap.get(String(r.destination_hostgroup))?.length ? (
                              <p className="text-[11px] font-mono text-gray-500 dark:text-slate-400 mt-1">
                                {hgMap.get(String(r.destination_hostgroup))!.join(', ')}
                              </p>
                            ) : null}
                            {hits !== undefined && (
                              <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-1 tabular-nums">
                                {t('rules.hits')}: <span className="font-bold text-gray-700 dark:text-slate-300">{hits.toLocaleString()}</span>
                              </p>
                            )}
                          </div>

                          <ChevronDown
                            size={16}
                            className={`shrink-0 mt-1 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          />
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {isOpen && (
                        <div className="border-t border-gray-200 dark:border-slate-700 px-4 py-3 bg-gray-50 dark:bg-slate-900/40">
                          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                            {([
                              ['username', r.username],
                              ['schemaname', r.schemaname],
                              ['client_addr', r.client_addr],
                              ['proxy_addr', r.proxy_addr],
                              ['proxy_port', r.proxy_port],
                              ['flagIN', r.flagIN],
                              ['flagOUT', r.flagOUT],
                              ['re_modifiers', r.re_modifiers],
                              ['timeout', r.timeout],
                              ['retries', r.retries],
                              ['delay', r.delay],
                              ['mirror_hostgroup', r.mirror_hostgroup],
                              ['log', r.log],
                              ['multiplex', r.multiplex],
                              ['error_msg', r.error_msg],
                              ['digest', r.digest],
                            ] as [string, unknown][]).map(([k, v]) => (
                              <div key={k}>
                                <dt className="text-gray-500 dark:text-slate-500 font-mono">{k}</dt>
                                <dd className="text-gray-800 dark:text-slate-300 font-mono break-all">
                                  {v === null || v === undefined || v === ''
                                    ? <span className="text-gray-400 dark:text-slate-600 italic">NULL</span>
                                    : String(v)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      )}
                    </div>

                    {/* Chain arrow */}
                    {idx < filteredRules.length - 1 && (
                      <div className="flex justify-center py-0.5">
                        <ArrowDown size={14} className="text-gray-300 dark:text-slate-600" />
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Default fallback card */}
              {!regexFilter && (
                <>
                  <div className="flex justify-center py-0.5">
                    <ArrowDown size={14} className="text-gray-300 dark:text-slate-600" />
                  </div>
                  <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/40 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400 text-xs font-bold flex items-center justify-center shrink-0">
                        ∞
                      </span>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-800 dark:text-slate-200">
                          {t('rules.defaultTitle')}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                          {t('rules.defaultDesc')} · <code className="font-mono">{defaultUser}</code>
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-200 dark:bg-slate-700 font-mono text-sm font-bold text-gray-900 dark:text-slate-100">
                          <Server size={13} />
                          HG{defaultHg ?? '-'}
                        </div>
                        {hgMap.get(String(defaultHg))?.length ? (
                          <p className="text-[11px] font-mono text-gray-500 dark:text-slate-400 mt-1">
                            {hgMap.get(String(defaultHg))!.join(', ')}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Hostgroup topology ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
            <Server size={18} className="text-blue-600 dark:text-blue-400" />
            {t('rules.topologyTitle')}
          </h3>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...hgMap.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([hg, hosts]) => {
            const usedBy = rules.filter((r) => String(r.destination_hostgroup) === hg).map((r) => Number(r.rule_id))
            const isDefault = String(defaultHg) === hg
            return (
              <div key={hg} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold text-gray-900 dark:text-slate-100">HG{hg}</span>
                  {isDefault && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                      {t('rules.isDefault')}
                    </span>
                  )}
                </div>
                <ul className="space-y-0.5 mb-2">
                  {hosts.map((h) => (
                    <li key={h} className="font-mono text-xs text-gray-600 dark:text-slate-400">{h}</li>
                  ))}
                </ul>
                <p className="text-[11px] text-gray-500 dark:text-slate-500">
                  {usedBy.length > 0
                    ? `${t('rules.usedByRules')}: ${usedBy.map((r) => `#${r}`).join(', ')}`
                    : t('rules.noRuleTargets')}
                </p>
              </div>
            )
          })}
          {hgMap.size === 0 && (
            <p className="text-sm text-gray-400 dark:text-slate-500">{t('rules.noServers')}</p>
          )}
        </div>
      </div>
    </div>
  )
}

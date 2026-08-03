import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tablesApi, exportApi } from '../api/client'
import { useServerStore } from '../stores/serverStore'
import { useI18n } from '../i18n'
import { Table, Database, HardDrive, Cpu, Zap, BarChart3, Monitor, History, ChevronDown, ChevronRight, Lightbulb, Download, Edit2, Trash2, Plus, X, Copy, Check, type LucideIcon } from 'lucide-react'

type GroupName = string

interface TableGroups {
  [key: string]: string[]
}

interface TableListResponse {
  groups: TableGroups
  table_db: Record<string, string>
}

interface LayerConfigItem {
  key: GroupName
  label: string
  icon: LucideIcon
  color: string
}

// Known layer configs — fallback for groups the backend may return.
const KNOWN_LAYERS_KEYS = ['disk', 'memory', 'runtime', 'stats', 'monitor', 'stats_history']

function buildLayerConfigs(groups: TableGroups, t: (key: string) => string): LayerConfigItem[] {
  const iconMap: Record<string, LucideIcon> = {
    disk: HardDrive,
    memory: Cpu,
    runtime: Zap,
    stats: BarChart3,
    monitor: Monitor,
    stats_history: History,
  }
  const colorMap: Record<string, string> = {
    disk: 'text-amber-600 dark:text-amber-400',
    memory: 'text-blue-600 dark:text-blue-400',
    runtime: 'text-green-600 dark:text-green-400',
    stats: 'text-purple-600 dark:text-purple-400',
    monitor: 'text-orange-600 dark:text-orange-400',
    stats_history: 'text-teal-600 dark:text-teal-400',
  }
  return Object.keys(groups).map(key => {
    if (KNOWN_LAYERS_KEYS.includes(key)) {
      return { key, label: t(`tables.layer.${key}`), icon: iconMap[key] || Database, color: colorMap[key] || 'text-gray-600 dark:text-gray-400' }
    }
    return { key, label: t('tables.layer.other'), icon: Database, color: 'text-gray-600 dark:text-gray-400' }
  })
}

function dbForTable(tableName: string, layer: string, tableDb: Record<string, string>): string {
  if (tableDb[tableName]) return tableDb[tableName]
  // fallback
  switch (layer) {
    case 'disk':       return 'disk'
    case 'monitor':    return 'monitor'
    case 'stats_history': return 'stats_history'
    case 'stats':      return 'main'
    case 'runtime':    return 'main'
    default:           return 'main'
  }
}

export default function TableBrowserPage() {
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [selectedLayer, setSelectedLayer] = useState<string>('memory')
  const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set())
  const selectedId = useServerStore((s) => s.selectedId)
  const { t } = useI18n()

  const { data: tablesRes, isLoading: tablesLoading } = useQuery({
    queryKey: ['tables', selectedId],
    queryFn: () => tablesApi.list(selectedId!),
    enabled: !!selectedId,
  })

  const groups: TableGroups = tablesRes?.data?.groups || {}
  const tableDb: Record<string, string> = tablesRes?.data?.table_db || {}
  const layerConfigs = useMemo(() => buildLayerConfigs(groups, t), [groups, t])

  const selectedDatabase = useMemo(
    () => (selectedTable ? dbForTable(selectedTable, selectedLayer, tableDb) : 'main'),
    [selectedTable, selectedLayer, tableDb],
  )

  const { data: tableData, isLoading: dataLoading } = useQuery({
    queryKey: ['tables', selectedId, selectedTable, selectedLayer, selectedDatabase],
    queryFn: () => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const params: Record<string, unknown> = { page_size: 100, layer: selectedLayer }
      if (selectedDatabase) params.database = selectedDatabase
      return tablesApi.getData(selectedId!, selectedTable!, params)
    },
    enabled: !!selectedId && !!selectedTable,
  })

  const [showExportMenu, setShowExportMenu] = useState(false)

  // ── Row CRUD state ──
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null)
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null)
  const [creating, setCreating] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const dataQueryKey = ['tables', selectedId, selectedTable, selectedLayer, selectedDatabase] as const

  const insertMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => tablesApi.insertRow(selectedId!, selectedTable!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataQueryKey })
      setCreating(false)
    },
  })
  const updateMut = useMutation({
    mutationFn: (vars: { pk: Record<string, unknown>; data: Record<string, unknown> }) =>
      tablesApi.updateRow(selectedId!, selectedTable!, vars.pk, vars.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataQueryKey })
      setEditingRow(null)
    },
  })
  const deleteMut = useMutation({
    mutationFn: (pk: Record<string, unknown>) => tablesApi.deleteRow(selectedId!, selectedTable!, pk),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataQueryKey })
      setDetailRow(null)
    },
  })

  // Identify primary key columns from schema (heuristic: prefer known PKs, else first column)
  const { data: schemaRes } = useQuery({
    queryKey: ['schema', selectedId, selectedTable, selectedLayer],
    queryFn: () => tablesApi.getSchema(selectedId!, selectedTable!, selectedLayer),
    enabled: !!selectedId && !!selectedTable,
  })
  const columns = tableData?.data?.column_names || []
  const pkColumns = useMemo<string[]>(() => {
    const cols = schemaRes?.data?.columns || []
    const pks = cols.filter((c: any) => c.key === 'PRI' || c.primary_key).map((c: any) => c.name)
    if (pks.length > 0) return pks
    // Fallback: use well-known PK names
    const known = ['rule_id', 'username', 'hostgroup_id', 'hostname', 'port', 'name', 'id']
    const fallback = known.filter((k) => columns.includes(k))
    return fallback.length > 0 ? fallback : columns.length > 0 ? [columns[0]] : []
  }, [schemaRes, columns])

  const buildPk = (row: Record<string, unknown>) => {
    const pk: Record<string, unknown> = {}
    for (const c of pkColumns) pk[c] = row[c]
    return pk
  }

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1200)
    } catch {
      /* ignore */
    }
  }

  const toggleLayer = (key: string) => {
    setCollapsedLayers(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const handleExportTable = async (format: 'csv' | 'json') => {
    if (!selectedId || !selectedTable) return
    try {
      const layer = selectedLayer === 'runtime' ? 'runtime' : selectedLayer === 'disk' ? 'disk' : 'memory'
      const resp = await exportApi.tableData(selectedId, selectedTable, format, layer)
      const ext = format === 'csv' ? 'csv' : 'json'
      const mime = format === 'csv' ? 'text/csv' : 'application/json'
      const url = window.URL.createObjectURL(new Blob([resp.data], { type: mime }))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `${selectedTable}_${selectedLayer}.${ext}`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      // silently fail
    } finally {
      setShowExportMenu(false)
    }
  }

  // Guide text for the currently selected table.
  const guideKey = selectedTable ? `tables.guide.${selectedTable}` : ''
  const guideText = t(guideKey)
  const hasSpecificGuide = guideText !== '' && guideText !== guideKey
  const displayGuide = hasSpecificGuide ? guideText : t('tables.guide._default')

  if (!selectedId) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-amber-700 dark:text-amber-400">
        {t('tables.noServerSelected')}
      </div>
    )
  }

  if (tablesLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  const rows = tableData?.data?.rows || []

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Table size={28} className="text-blue-600 dark:text-blue-400" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">{t('tables.title')}</h2>
      </div>

      <div className="flex gap-4">
        {/* Table List – grouped by layer */}
        <div className="w-72 shrink-0">
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase mb-3">{t('nav.tables')}</h3>
            <div className="space-y-2">
              {layerConfigs.map(({ key, label, icon: Icon, color }) => {
                const tableList = groups[key] || []
                if (tableList.length === 0) return null
                const isCollapsed = collapsedLayers.has(key)
                return (
                  <div key={key}>
                    <button
                      onClick={() => toggleLayer(key)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
                    >
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <Icon size={14} className={color} />
                      <span className={color}>{label}</span>
                      <span className="ml-auto text-gray-400 dark:text-slate-500 font-normal">{tableList.length}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="ml-2 space-y-0.5 mt-1">
                        {tableList.map((name: string) => (
                          <button
                            key={key + name}
                            onClick={() => { setSelectedTable(name); setSelectedLayer(key) }}
                            className={`w-full text-left pl-7 pr-3 py-1.5 rounded-md text-sm transition-colors ${
                              selectedTable === name && selectedLayer === key
                                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Database size={12} className="shrink-0" />
                              <span className="truncate">{name}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Table Data */}
        <div className="flex-1">
          {selectedTable ? (
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700">
              <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">
                  {selectedTable}
                  <span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500 uppercase">
                    ({selectedLayer}{selectedDatabase !== 'main' ? ` · ${selectedDatabase}` : ''})
                  </span>
                </h3>
                <div className="flex items-center gap-3">
                  {selectedLayer === 'memory' && pkColumns.length > 0 && (
                    <button
                      onClick={() => setCreating(true)}
                      className="flex items-center gap-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 px-2.5 py-1 rounded-lg transition-colors"
                    >
                      <Plus size={14} />
                      {t('tables.addRowBtn')}
                    </button>
                  )}
                  <span className="text-sm text-gray-500 dark:text-slate-400">{rows.length} {t('tables.rows')}</span>
                  {rows.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => setShowExportMenu((v) => !v)}
                        className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 border border-gray-300 dark:border-slate-600 px-2 py-1 rounded-lg transition-colors"
                      >
                        <Download size={14} />
                        {t('tables.exportBtn')}
                      </button>
                      {showExportMenu && (
                        <div className="absolute right-0 top-full mt-1 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg z-10 py-1 min-w-[140px]">
                          <button
                            onClick={() => handleExportTable('csv')}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
                          >
                            {t('tables.exportCsv')}
                          </button>
                          <button
                            onClick={() => handleExportTable('json')}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
                          >
                            {t('tables.exportJson')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Beginner's Guide Panel ── */}
              <div className="mx-4 mt-3 mb-1 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg px-4 py-3">
                <div className="flex items-start gap-2">
                  <Lightbulb size={18} className="text-blue-500 dark:text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <h4 className="text-sm font-semibold text-blue-700 dark:text-blue-300 mb-1">
                      {t('tables.guideTitle')}
                    </h4>
                    <p className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed whitespace-pre-line">
                      {displayGuide}
                    </p>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                {dataLoading ? (
                  <div className="p-8 text-center text-gray-500 dark:text-slate-400">{t('common.loading')}</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700">
                        {columns.map((col: string) => (
                          <th key={col} className="text-left py-2 px-3 font-medium text-gray-600 dark:text-slate-400">{col}</th>
                        ))}
                        <th className="text-right py-2 px-3 font-medium text-gray-600 dark:text-slate-400 w-24">{t('tables.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row: any, i: number) => (
                        <tr
                          key={i}
                          onClick={() => setDetailRow(row)}
                          className="border-b border-gray-100 dark:border-slate-700 hover:bg-blue-50 dark:hover:bg-slate-700 cursor-pointer"
                        >
                          {columns.map((col: string, j: number) => {
                            const value = row[col]
                            const isLong = value !== null && value !== undefined && String(value).length > 40
                            const isPunct = col === 'match_digest' || col === 'match_pattern' || col === 'replace_pattern' || col === 'negate_match_pattern'
                            return (
                              <td
                                key={j}
                                title={value !== null && value !== undefined ? String(value) : ''}
                                className={`py-2 px-3 text-gray-700 dark:text-slate-300 max-w-xs ${isLong ? 'truncate' : ''} ${isPunct && value ? 'font-mono text-xs' : ''}`}
                              >
                                {value !== null && value !== undefined ? String(value) : <span className="text-gray-400 dark:text-slate-500 italic">{t('tables.null')}</span>}
                              </td>
                            )
                          })}
                          <td className="py-2 px-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                            {selectedLayer === 'memory' && pkColumns.length > 0 && (
                              <>
                                <button
                                  onClick={() => setEditingRow(row)}
                                  className="inline-flex items-center justify-center w-7 h-7 text-gray-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-600 rounded transition-colors"
                                  title={t('tables.edit')}
                                >
                                  <Edit2 size={14} />
                                </button>
                                <button
                                  onClick={() => {
                                    if (confirm(t('tables.confirmDelete'))) {
                                      deleteMut.mutate(buildPk(row))
                                    }
                                  }}
                                  className="inline-flex items-center justify-center w-7 h-7 text-gray-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-slate-600 rounded transition-colors"
                                  title={t('tables.delete')}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={columns.length + 1} className="py-8 text-center text-gray-400 dark:text-slate-500">
                            {t('tables.empty')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-12 text-center">
              <Lightbulb size={48} className="mx-auto text-gray-300 dark:text-slate-600 mb-4" />
              <p className="text-gray-500 dark:text-slate-400">{t('tables.selectTable')}</p>
              <p className="text-gray-400 dark:text-slate-500 text-sm mt-2 max-w-md mx-auto">{t('tables.guideHint')}</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Detail Drawer ── */}
      {detailRow && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setDetailRow(null)}>
          <div className="flex-1 bg-black/40" />
          <div
            className="w-full max-w-2xl bg-white dark:bg-slate-800 h-full overflow-y-auto shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-5 py-3 flex items-center justify-between z-10">
              <h3 className="font-semibold text-gray-900 dark:text-slate-100">
                {t('tables.detailTitle')} · <span className="text-gray-500 dark:text-slate-400 font-normal">{selectedTable}</span>
              </h3>
              <button
                onClick={() => setDetailRow(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-5 space-y-2">
              {columns.map((col: string) => {
                const value = detailRow[col]
                const text = value !== null && value !== undefined ? String(value) : ''
                const isPunct = col === 'match_digest' || col === 'match_pattern' || col === 'replace_pattern' || col === 'negate_match_pattern'
                return (
                  <div key={col} className="border-b border-gray-100 dark:border-slate-700 pb-2 last:border-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide">{col}</span>
                      {text && (
                        <button
                          onClick={() => handleCopy(`${col}-${text.length}`, text)}
                          className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                          title={t('tables.copy')}
                        >
                          {copiedKey === `${col}-${text.length}` ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      )}
                    </div>
                    <pre className={`whitespace-pre-wrap break-all text-sm text-gray-800 dark:text-slate-200 ${isPunct ? 'font-mono text-xs' : ''}`}>
                      {value !== null && value !== undefined ? text : <span className="text-gray-400 dark:text-slate-500 italic">{t('tables.null')}</span>}
                    </pre>
                  </div>
                )
              })}
            </div>
            {selectedLayer === 'memory' && pkColumns.length > 0 && (
              <div className="sticky bottom-0 bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-5 py-3 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setDetailRow(null)
                    setEditingRow(detailRow)
                  }}
                  className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 border border-blue-300 dark:border-blue-600 hover:bg-blue-50 dark:hover:bg-slate-700 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <Edit2 size={14} />
                  {t('tables.edit')}
                </button>
                <button
                  onClick={() => {
                    if (confirm(t('tables.confirmDelete'))) {
                      deleteMut.mutate(buildPk(detailRow))
                    }
                  }}
                  className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400 border border-red-300 dark:border-red-600 hover:bg-red-50 dark:hover:bg-slate-700 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <Trash2 size={14} />
                  {t('tables.delete')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Edit / Create Modal ── */}
      {(editingRow || creating) && (
        <RowFormModal
          columns={columns}
          pkColumns={pkColumns}
          initial={editingRow || {}}
          isEdit={!!editingRow}
          submitting={updateMut.isPending || insertMut.isPending}
          error={updateMut.error || insertMut.error}
          onSubmit={(data) => {
            if (editingRow) {
              updateMut.mutate({ pk: buildPk(editingRow), data })
            } else {
              // Strip empty strings for insert (don't send empty values)
              const clean: Record<string, unknown> = {}
              for (const [k, v] of Object.entries(data)) {
                if (v !== '') clean[k] = v
              }
              insertMut.mutate(clean)
            }
          }}
          onClose={() => {
            setEditingRow(null)
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

// ── Row Form Modal (used for create & edit) ──
function RowFormModal({
  columns,
  pkColumns,
  initial,
  isEdit,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  columns: string[]
  pkColumns: string[]
  initial: Record<string, unknown>
  isEdit: boolean
  submitting: boolean
  error: unknown
  onSubmit: (data: Record<string, unknown>) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const c of columns) {
      const v = initial[c]
      f[c] = v !== null && v !== undefined ? String(v) : ''
    }
    return f
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-slate-100">
            {isEdit ? t('tables.editTitle') : t('tables.createTitle')}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200">
            <X size={20} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(form)
          }}
          className="overflow-y-auto p-5 space-y-3"
        >
          {columns.map((col) => {
            const isPk = pkColumns.includes(col)
            return (
              <div key={col}>
                <label className="flex items-center justify-between text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">
                  <span>{col}</span>
                  {isPk && <span className="text-[10px] text-amber-600 dark:text-amber-400 uppercase">PK</span>}
                </label>
                {(col === 'match_digest' || col === 'match_pattern' || col === 'replace_pattern' || col === 'negate_match_pattern' || col === 'comment') ? (
                  <textarea
                    value={form[col] || ''}
                    onChange={(e) => setForm({ ...form, [col]: e.target.value })}
                    disabled={isEdit && isPk}
                    rows={col === 'comment' ? 2 : 3}
                    className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 text-gray-800 dark:text-slate-200 disabled:bg-gray-100 dark:disabled:bg-slate-700 disabled:text-gray-500"
                  />
                ) : (
                  <input
                    type="text"
                    value={form[col] || ''}
                    onChange={(e) => setForm({ ...form, [col]: e.target.value })}
                    disabled={isEdit && isPk}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 text-gray-800 dark:text-slate-200 disabled:bg-gray-100 dark:disabled:bg-slate-700 disabled:text-gray-500"
                  />
                )}
              </div>
            )
          })}
          {error != null && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded px-3 py-2">
              {String(
                (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
                (error as Error)?.message ||
                error,
              )}
            </div>
          )}
        </form>
        <div className="px-5 py-3 border-t border-gray-200 dark:border-slate-700 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-700 dark:text-slate-300 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onSubmit(form)}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 disabled:opacity-50 rounded-lg"
          >
            {submitting ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

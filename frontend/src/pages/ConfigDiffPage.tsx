import { useQuery } from '@tanstack/react-query'
import { configDiffApi } from '../api/client'
import { useServerStore } from '../stores/serverStore'
import { useI18n } from '../i18n'
import { GitCompare, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react'

export default function ConfigDiffPage() {
  const selectedId = useServerStore((s) => s.selectedId)
  const { t } = useI18n()

  const { data, isLoading } = useQuery({
    queryKey: ['config-diff', selectedId],
    queryFn: () => configDiffApi.getDiff(selectedId!),
    enabled: !!selectedId,
    refetchInterval: 15000,
  })

  if (!selectedId) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-amber-700 dark:text-amber-400">
        {t('configDiff.noServerSelected')}
      </div>
    )
  }

  const result = data?.data || {}
  const tables = result.tables || []

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <GitCompare size={28} className="text-blue-600 dark:text-blue-400" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">{t('configDiff.title')}</h2>
      </div>

      <p className="text-gray-500 dark:text-slate-400 mb-4">{t('configDiff.subtitle')}</p>

      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <>
          {/* Summary banner */}
          <div className={`rounded-lg p-4 mb-4 ${result.total_out_of_sync > 0 ? 'bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-700' : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700'}`}>
            <div className="flex items-center gap-2">
              {result.total_out_of_sync > 0 ? (
                <>
                  <AlertTriangle size={20} className="text-orange-600 dark:text-orange-400" />
                  <span className="text-orange-700 dark:text-orange-400 font-medium">
                    {t('configDiff.totalOutOfSync', { count: result.total_out_of_sync })}
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle size={20} className="text-green-600 dark:text-green-400" />
                  <span className="text-green-700 dark:text-green-400 font-medium">{t('configDiff.allInSync')}</span>
                </>
              )}
            </div>
          </div>

          {/* Diff table */}
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700">
                    <th className="text-left py-2 px-3 text-gray-600 dark:text-slate-400">{t('configDiff.table')}</th>
                    <th className="text-right py-2 px-3 text-gray-600 dark:text-slate-400">{t('configDiff.memoryRows')}</th>
                    <th className="text-right py-2 px-3 text-gray-600 dark:text-slate-400">{t('configDiff.runtimeRows')}</th>
                    <th className="text-right py-2 px-3 text-gray-600 dark:text-slate-400">{t('configDiff.onlyMemory')}</th>
                    <th className="text-right py-2 px-3 text-gray-600 dark:text-slate-400">{t('configDiff.onlyRuntime')}</th>
                    <th className="text-center py-2 px-3 text-gray-600 dark:text-slate-400">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map((table: any, i: number) => (
                    <tr key={i} className="border-b border-gray-100 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700">
                      <td className="py-2 px-3 font-medium text-gray-800 dark:text-slate-300">{table.table}</td>
                      <td className="py-2 px-3 text-right">{table.memory_rows}</td>
                      <td className="py-2 px-3 text-right">{table.runtime_rows}</td>
                      <td className="py-2 px-3 text-right">
                        {table.only_in_memory > 0 ? (
                          <span className="text-orange-600 dark:text-orange-400 font-medium">+{table.only_in_memory}</span>
                        ) : '—'}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {table.only_in_runtime > 0 ? (
                          <span className="text-red-600 dark:text-red-400 font-medium">-{table.only_in_runtime}</span>
                        ) : '—'}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {table.applicable === false ? (
                          <span
                            title={t('configDiff.notApplicableHint')}
                            className="text-gray-400 dark:text-slate-500 text-xs"
                          >
                            {t('configDiff.notApplicable')}
                          </span>
                        ) : table.in_sync ? (
                          <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 text-xs font-medium">
                            <CheckCircle size={12} />
                            {t('configDiff.synced')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400 text-xs font-medium">
                            <AlertTriangle size={12} />
                            {t('configDiff.outOfSync')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {tables.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-gray-400 dark:text-slate-500">
                        {t('common.loading')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

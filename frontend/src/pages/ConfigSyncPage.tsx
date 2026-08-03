import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { syncApi } from '../api/client'
import { useServerStore } from '../stores/serverStore'
import { useI18n } from '../i18n'
import { RefreshCw, Save, Upload, Download, RotateCcw, AlertTriangle } from 'lucide-react'

type ActionKey = 'apply' | 'save' | 'discard' | 'load'

function useActionConfig(): Record<ActionKey, { label: string; pending: string; icon: any; className: string }> {
  const { t } = useI18n()
  return {
    apply: {
      label: t('sync.apply'),
      pending: t('sync.applying'),
      icon: Upload,
      className: 'bg-green-600 hover:bg-green-700',
    },
    save: {
      label: t('sync.save'),
      pending: t('sync.saving'),
      icon: Save,
      className: 'bg-blue-600 hover:bg-blue-700',
    },
    discard: {
      label: t('sync.discard'),
      pending: t('sync.discarding'),
      icon: RotateCcw,
      className: 'bg-amber-600 hover:bg-amber-700',
    },
    load: {
      label: t('sync.load'),
      pending: t('sync.loading'),
      icon: Download,
      className: 'bg-purple-600 hover:bg-purple-700',
    },
  }
}

export default function ConfigSyncPage() {
  const queryClient = useQueryClient()
  const selectedId = useServerStore((s) => s.selectedId)
  const { t } = useI18n()
  const ACTION_CONFIG = useActionConfig()
  const [lastError, setLastError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['sync', selectedId],
    queryFn: () => syncApi.getStatus(selectedId!),
    enabled: !!selectedId,
    refetchInterval: 10000,
  })

  const mutations: Record<ActionKey, ReturnType<typeof useMutation>> = {
    apply: useMutation({
      mutationFn: () => syncApi.apply(selectedId!),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync'] }),
    }),
    save: useMutation({
      mutationFn: () => syncApi.save(selectedId!),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync'] }),
    }),
    discard: useMutation({
      mutationFn: () => syncApi.discard(selectedId!),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync'] }),
    }),
    load: useMutation({
      mutationFn: () => syncApi.load(selectedId!),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync'] }),
    }),
  }

  if (!selectedId) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-amber-700 dark:text-amber-400">
        {t('sync.noServerSelected')}
      </div>
    )
  }

  const status = data?.data || {}

  const handleAction = (key: ActionKey) => {
    const m = mutations[key]
    setLastError(null)
    m.mutate(undefined, {
      onError: (err: any) => {
        console.error('[Sync]', err.response?.data?.detail || err.message)
        setLastError(t('sync.actionFailed', { action: t(`sync.${key}`) }))
      },
    })
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <RefreshCw size={28} className="text-blue-600 dark:text-blue-400" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">{t('sync.title')}</h2>
      </div>

      <p className="text-gray-500 dark:text-slate-400 mb-4">{t('sync.subtitle')}</p>

      {/* Action Buttons: all four sync operations */}
      <div className="flex flex-wrap gap-3 mb-6">
        {(Object.keys(ACTION_CONFIG) as ActionKey[]).map((key) => {
          const cfg = ACTION_CONFIG[key]
          const m = mutations[key]
          const Icon = cfg.icon
          return (
            <button
              key={key}
              onClick={() => handleAction(key)}
              disabled={m.isPending}
              className={`flex items-center gap-2 text-white px-4 py-2 rounded-lg disabled:opacity-50 text-sm font-medium ${cfg.className}`}
            >
              <Icon size={16} />
              {m.isPending ? cfg.pending : cfg.label}
            </button>
          )
        })}
      </div>

      {/* Error banner */}
      {lastError && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm mb-4">
          <AlertTriangle size={16} />
          {lastError}
        </div>
      )}

      {/* Sync Status */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
            <span className="font-semibold text-gray-900 dark:text-slate-100">{t('sync.status')}</span>
            <span className={`text-sm ${status.total_unapplied > 0 ? 'text-orange-600 dark:text-orange-400 font-medium' : 'text-green-600 dark:text-green-400'}`}>
              {status.total_unapplied > 0
                ? t('sync.unapplied', { count: status.total_unapplied })
                : t('sync.allInSync')}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700">
                  <th className="text-left py-2 px-3 text-gray-600 dark:text-slate-400">{t('sync.module')}</th>
                  <th className="text-right py-2 px-3 text-gray-600 dark:text-slate-400">{t('sync.memoryRows')}</th>
                  <th className="text-right py-2 px-3 text-gray-600 dark:text-slate-400">{t('sync.runtimeRows')}</th>
                  <th className="text-center py-2 px-3 text-gray-600 dark:text-slate-400">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {(status.tables || []).map((table: any, i: number) => (
                  <tr key={i} className="border-b border-gray-100 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700">
                    <td className="py-2 px-3 font-medium text-gray-800 dark:text-slate-300">{table.table}</td>
                    <td className="py-2 px-3 text-right">{table.memory_rows}</td>
                    <td className="py-2 px-3 text-right">{table.runtime_rows}</td>
                    <td className="py-2 px-3 text-center">
                      {table.applicable === false ? (
                        <span
                          title={t('sync.notApplicableHint')}
                          className="text-gray-400 dark:text-slate-500 text-xs"
                        >
                          {t('sync.notApplicable')}
                        </span>
                      ) : table.has_unapplied ? (
                        <span className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400 text-xs font-medium">
                          <RotateCcw size={12} />
                          {t('sync.unappliedShort')}
                        </span>
                      ) : (
                        <span className="text-green-600 dark:text-green-400 text-xs font-medium">{t('sync.synced')}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {(status.tables || []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-gray-400 dark:text-slate-500">
                      {t('sync.noTables')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

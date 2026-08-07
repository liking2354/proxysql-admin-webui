import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backupApi } from '../api/client'
import { useServerStore } from '../stores/serverStore'
import { useI18n } from '../i18n'
import {
  Archive, Download, Upload, Trash2, Plus, Loader, Clock,
  Database, FileJson, AlertTriangle, CheckCircle, XCircle,
} from 'lucide-react'

interface Backup {
  id: number
  server_id: string
  name: string
  description: string
  table_count: number
  row_count: number
  size_bytes: number
  created_at: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso + 'Z')
    return d.toLocaleString()
  } catch {
    return iso
  }
}

export default function BackupPage() {
  const selectedId = useServerStore((s) => s.selectedId)
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [backupName, setBackupName] = useState('')
  const [restoringId, setRestoringId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const { data: backupsRes, isLoading, isError: isListError, refetch: refetchBackups } = useQuery({
    queryKey: ['backups', selectedId],
    queryFn: () => backupApi.list(selectedId!),
    enabled: !!selectedId,
  })

  const backups: Backup[] = backupsRes?.data?.backups || []

  function extractErrorMessage(err: unknown, fallback: string): string {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    return detail || fallback
  }

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      backupApi.create(selectedId!, { name, description: '' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups', selectedId] })
      setBackupName('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (backupId: number) =>
      backupApi.delete(selectedId!, backupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups', selectedId] })
      setConfirmDelete(null)
    },
  })

  const restoreMutation = useMutation({
    mutationFn: (backupId: number) =>
      backupApi.restore(selectedId!, backupId),
    onSuccess: () => {
      setRestoringId(null)
      alert(t('backup.restoreSuccess'))
    },
    onError: () => {
      setRestoringId(null)
    },
  })

  const handleDownload = useCallback(async (backupId: number) => {
    try {
      const resp = await backupApi.download(selectedId!, backupId)
      const url = window.URL.createObjectURL(new Blob([resp.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `backup-${backupId}.json`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      // handled silently
    }
  }, [selectedId])

  const handleCreate = useCallback(() => {
    createMutation.mutate(backupName || undefined as unknown as string)
  }, [backupName, createMutation])

  if (!selectedId) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-amber-700 dark:text-amber-400">
        {t('backup.noServerSelected')}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Archive size={28} className="text-blue-600 dark:text-blue-400" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">{t('backup.title')}</h2>
      </div>

      <p className="text-gray-500 dark:text-slate-400 mb-6">{t('backup.subtitle')}</p>

      {/* Create Backup */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-4 mb-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-slate-300 mb-3">{t('backup.createNew')}</h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={backupName}
            onChange={(e) => setBackupName(e.target.value)}
            placeholder={t('backup.namePlaceholder')}
            className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-gray-50 dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
          />
          <button
            onClick={handleCreate}
            disabled={createMutation.isPending}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {createMutation.isPending ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
            {t('backup.create')}
          </button>
        </div>
        {createMutation.isError && (
          <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <XCircle size={14} />
            {extractErrorMessage(createMutation.error, t('backup.createFailed'))}
          </div>
        )}
      </div>

      {/* Backup List */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-slate-100">
            {t('backup.history')} ({backups.length})
          </h3>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-gray-500 dark:text-slate-400">{t('common.loading')}</div>
        ) : isListError ? (
          <div className="p-8 text-center text-red-500 dark:text-red-400">
            <XCircle size={40} className="mx-auto mb-3 opacity-60" />
            <p>{t('backup.listLoadFailed')}</p>
            <button
              onClick={() => refetchBackups()}
              className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-red-300 dark:border-red-700 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              {t('backup.retry')}
            </button>
          </div>
        ) : backups.length === 0 ? (
          <div className="p-8 text-center text-gray-400 dark:text-slate-500">
            <Archive size={40} className="mx-auto mb-3 opacity-40" />
            <p>{t('backup.empty')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700">
                  <th className="text-left py-2 px-4 font-medium text-gray-600 dark:text-slate-400">{t('common.name')}</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-600 dark:text-slate-400">{t('backup.tables')}</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-600 dark:text-slate-400">{t('backup.rows')}</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-600 dark:text-slate-400">{t('backup.size')}</th>
                  <th className="text-left py-2 px-4 font-medium text-gray-600 dark:text-slate-400">{t('backup.created')}</th>
                  <th className="text-right py-2 px-4 font-medium text-gray-600 dark:text-slate-400">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id} className="border-b border-gray-100 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700">
                    <td className="py-3 px-4 text-gray-900 dark:text-slate-100 font-medium">{b.name}</td>
                    <td className="py-3 px-4 text-gray-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Database size={12} />{b.table_count}
                      </span>
                    </td>
                 <td className="py-3 px-4 text-gray-600 dark:text-slate-400">{(b.row_count ?? 0).toLocaleString()}</td>
        <td className="py-3 px-4 text-gray-600 dark:text-slate-400">{formatSize(b.size_bytes ?? 0)}</td>
                    <td className="py-3 px-4 text-gray-500 dark:text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={12} />{formatDate(b.created_at)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleDownload(b.id)}
                          className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                          title={t('backup.download')}
                        >
                          <Download size={16} />
                        </button>
                        <button
                          onClick={() => setRestoringId(b.id)}
                          disabled={restoreMutation.isPending}
                          className="p-1.5 text-gray-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors disabled:opacity-50"
                          title={t('backup.restore')}
                        >
                          {restoringId === b.id && restoreMutation.isPending ? <Loader size={16} className="animate-spin" /> : <Upload size={16} />}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(b.id)}
                          className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                          title={t('common.delete')}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Restore Confirmation Dialog */}
      {restoringId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={24} className="text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">{t('backup.restoreConfirmTitle')}</h3>
                <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">{t('backup.restoreConfirmDesc')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setRestoringId(null)}
                className="px-4 py-2 text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => restoreMutation.mutate(restoringId)}
                disabled={restoreMutation.isPending}
                className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {restoreMutation.isPending ? t('backup.restoring') : t('backup.restoreConfirm')}
              </button>
            </div>
            {restoreMutation.isError && (
              <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <XCircle size={14} />{t('backup.restoreFailed')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {confirmDelete !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={24} className="text-red-500 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">{t('backup.deleteConfirmTitle')}</h3>
                <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">{t('backup.deleteConfirmDesc')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => deleteMutation.mutate(confirmDelete)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleteMutation.isPending ? t('backup.deleting') : t('common.delete')}
              </button>
            </div>
            {deleteMutation.isError && (
              <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <XCircle size={14} />
                {extractErrorMessage(deleteMutation.error, t('backup.deleteFailed'))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Restore Success Toast */}
      {restoreMutation.isSuccess && (
        <div className="fixed bottom-6 right-6 z-50 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-lg px-4 py-3 flex items-center gap-2 text-green-700 dark:text-green-400 shadow-lg">
          <CheckCircle size={18} />
          <span className="text-sm">{t('backup.restoreSuccessAlert')}</span>
        </div>
      )}
    </div>
  )
}

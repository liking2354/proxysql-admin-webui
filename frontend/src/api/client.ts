import axios from 'axios'

export const apiClient = axios.create({
  baseURL: '',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor: attach JWT token from Zustand memory store
apiClient.interceptors.request.use((config) => {
  const state = window.__AUTH_STORE__ || null
  const token = state ? state.token : null
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Response interceptor: handle 401 via token refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401 && error.config && !error.config._retry) {
      error.config._retry = true
      try {
        const resp = await axios.post('/api/v1/auth/refresh', {}, {
          withCredentials: true,
        })
        const newToken = resp.data.access_token
        if (window.__AUTH_STORE__) {
          window.__AUTH_STORE__.setToken(newToken)
        }
        error.config.headers.Authorization = `Bearer ${newToken}`
        return apiClient(error.config)
      } catch {
        if (window.__AUTH_STORE__) {
          window.__AUTH_STORE__.setToken(null)
        }
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

// Expose the auth store to the axios interceptor (avoids circular import)
// This is set in main.tsx after the store is created.
declare global {
  interface Window {
    __AUTH_STORE__: { token: string | null; setToken: (t: string | null) => void } | null
  }
}

// Wizard API
export const wizardApi = {
  getDefinitions: () => apiClient.get('/api/v1/wizards/definitions'),
  getDefinition: (wizardId: string) => apiClient.get(`/api/v1/wizards/definitions/${wizardId}`),
  preview: (wizardId: string, serverId: string, fields: Record<string, unknown>) =>
    apiClient.post('/api/v1/wizards/preview', { wizard_id: wizardId, server_id: serverId, fields }),
  execute: (wizardId: string, serverId: string, fields: Record<string, unknown>, options?: Record<string, unknown>) =>
    apiClient.post('/api/v1/wizards/execute', {
      wizard_id: wizardId,
      server_id: serverId,
      fields,
      options: options || { auto_apply: false, auto_save: false },
    }),
  getHistory: (serverId: string, limit?: number) =>
    apiClient.get(`/api/v1/wizards/history/${serverId}`, { params: { limit } }),
  lookupOptions: (serverId: string, wizardId: string, fieldName: string) =>
    apiClient.post('/api/v1/wizards/lookup-options', { server_id: serverId, wizard_id: wizardId, field_name: fieldName }),
}

// Template API
export const templateApi = {
  getTemplates: () => apiClient.get('/api/v1/wizards/templates'),
  getTemplate: (templateId: string) => apiClient.get(`/api/v1/wizards/templates/${templateId}`),
  getSteps: (templateId: string, architectureMode: string) =>
    apiClient.get(`/api/v1/wizards/templates/${templateId}/steps`, { params: { architecture_mode: architectureMode } }),
  preview: (data: {
    template_id: string
    server_id: string
    architecture_mode: string
    shared_values: Record<string, unknown>
    step_values: Record<string, Record<string, unknown>>
    skipped_steps: string[]
  }) => apiClient.post('/api/v1/wizards/templates/preview', data),
  execute: (data: {
    template_id: string
    server_id: string
    architecture_mode: string
    shared_values: Record<string, unknown>
    step_values: Record<string, Record<string, unknown>>
    skipped_steps: string[]
    options: Record<string, unknown>
  }) => apiClient.post('/api/v1/wizards/templates/execute', data),
}

// Dashboard API
export const dashboardApi = {
  getSnapshot: (serverId: string) => apiClient.get(`/api/v1/dashboard/${serverId}/snapshot`),
}

// Tables API
export const tablesApi = {
  list: (serverId: string) => apiClient.get(`/api/v1/${serverId}/tables`),
  getData: (serverId: string, tableName: string, params?: Record<string, unknown>) =>
    apiClient.get(`/api/v1/${serverId}/tables/${tableName}`, { params }),
  getSchema: (serverId: string, tableName: string, layer?: string) =>
    apiClient.get(`/api/v1/${serverId}/tables/${tableName}/schema`, { params: layer ? { layer } : {} }),
  // Row-level DML. All three endpoints take a single JSON body with named
  // fields (`data` / `pk_values`) — see backend RowInsertRequest et al.
  insertRow: (serverId: string, tableName: string, data: Record<string, unknown>) =>
    apiClient.post(`/api/v1/${serverId}/tables/${tableName}/row`, { data }),
  updateRow: (serverId: string, tableName: string, pkValues: Record<string, unknown>, data: Record<string, unknown>) =>
    apiClient.put(`/api/v1/${serverId}/tables/${tableName}/row`, { pk_values: pkValues, data }),
  deleteRow: (serverId: string, tableName: string, pkValues: Record<string, unknown>) =>
    apiClient.delete(`/api/v1/${serverId}/tables/${tableName}/row`, { data: { pk_values: pkValues } }),
}

// Sync API
export const syncApi = {
  getStatus: (serverId: string) => apiClient.get(`/api/v1/sync/${serverId}/status`),
  apply: (serverId: string, tables?: string[]) => apiClient.post(`/api/v1/sync/${serverId}/apply`, tables),
  save: (serverId: string, tables?: string[]) => apiClient.post(`/api/v1/sync/${serverId}/save`, tables),
  discard: (serverId: string, tables?: string[]) => apiClient.post(`/api/v1/sync/${serverId}/discard`, tables),
  load: (serverId: string, tables?: string[]) => apiClient.post(`/api/v1/sync/${serverId}/load`, tables),
}

// Query API
export const queryApi = {
  execute: (serverId: string, sql: string, target?: string) =>
    apiClient.post(`/api/v1/query/${serverId}/execute`, { sql, target: target || 'admin' }),
  getSchema: (serverId: string) => apiClient.get(`/api/v1/query/${serverId}/schema`),
  getHistory: (serverId: string, params?: Record<string, unknown>) =>
    apiClient.get(`/api/v1/query/${serverId}/history`, { params }),
  clearHistory: (serverId: string) =>
    apiClient.delete(`/api/v1/query/${serverId}/history`),
  deleteHistoryItem: (serverId: string, historyId: number) =>
    apiClient.delete(`/api/v1/query/${serverId}/history/${historyId}`),
}

// Servers API
export const serversApi = {
  list: () => apiClient.get('/api/v1/servers'),
  create: (data: Record<string, unknown>) => apiClient.post('/api/v1/servers', data),
  update: (id: string, data: Record<string, unknown>) => apiClient.put(`/api/v1/servers/${id}`, data),
  delete: (id: string) => apiClient.delete(`/api/v1/servers/${id}`),
  test: (id: string) => apiClient.post(`/api/v1/servers/${id}/test`),
}

// Users API
export const usersApi = {
  list: () => apiClient.get('/api/v1/users'),
  create: (data: Record<string, unknown>) => apiClient.post('/api/v1/users', data),
  update: (id: number, data: Record<string, unknown>) => apiClient.put(`/api/v1/users/${id}`, data),
  delete: (id: number) => apiClient.delete(`/api/v1/users/${id}`),
}

// Config Diff API
export const configDiffApi = {
  getDiff: (serverId: string, table?: string) =>
    apiClient.get(`/api/v1/config-diff/${serverId}`, { params: table ? { table } : {} }),
}

// Settings API
export const settingsApi = {
  getSystemInfo: () => apiClient.get('/api/v1/settings/info'),
  getAuditLogs: (params?: Record<string, unknown>) =>
    apiClient.get('/api/v1/settings/audit-logs', { params }),
  clearAuditLogs: (before?: string) =>
    apiClient.delete('/api/v1/settings/audit-logs', { params: before ? { before } : {} }),
}

// Clusters API
export const clustersApi = {
  list: () => apiClient.get('/api/v1/clusters'),
  create: (data: Record<string, unknown>) => apiClient.post('/api/v1/clusters', data),
  get: (id: string) => apiClient.get(`/api/v1/clusters/${id}`),
  update: (id: string, data: Record<string, unknown>) => apiClient.put(`/api/v1/clusters/${id}`, data),
  delete: (id: string) => apiClient.delete(`/api/v1/clusters/${id}`),
  listMembers: (id: string) => apiClient.get(`/api/v1/clusters/${id}/members`),
  addMember: (clusterId: string, data: Record<string, unknown>) =>
    apiClient.post(`/api/v1/clusters/${clusterId}/members`, data),
  removeMember: (clusterId: string, serverId: string) =>
    apiClient.delete(`/api/v1/clusters/${clusterId}/members/${serverId}`),
  getStatus: (id: string) => apiClient.get(`/api/v1/clusters/${id}/status`),
  sync: (id: string, data: Record<string, unknown>) =>
    apiClient.post(`/api/v1/clusters/${id}/sync`, data),
  configureVariables: (id: string, variables: Record<string, string>) =>
    apiClient.post(`/api/v1/clusters/${id}/configure-variables`, variables),
  discover: (id: string) => apiClient.get(`/api/v1/clusters/${id}/discover`),
  getSyncLogs: (id: string, limit?: number) =>
    apiClient.get(`/api/v1/clusters/${id}/sync-logs`, { params: { limit: limit || 50 } }),
}

// Backup API
export const backupApi = {
  create: (serverId: string, data?: Record<string, unknown>) =>
    apiClient.post(`/api/v1/backup/${serverId}/create`, data || {}),
  list: (serverId: string) =>
    apiClient.get(`/api/v1/backup/${serverId}/list`),
  download: (serverId: string, backupId: number) =>
    apiClient.get(`/api/v1/backup/${serverId}/${backupId}/download`, { responseType: 'blob' }),
  restore: (serverId: string, backupId: number, data?: Record<string, unknown>) =>
    apiClient.post(`/api/v1/backup/${serverId}/${backupId}/restore`, data || {}),
  delete: (serverId: string, backupId: number) =>
    apiClient.delete(`/api/v1/backup/${serverId}/${backupId}`),
}

// Export API
export const exportApi = {
  queryResult: (serverId: string, sql: string, format: string = 'csv') =>
    apiClient.post(`/api/v1/export/${serverId}/query-result`, null, {
      params: { sql, format },
      responseType: 'blob',
    }),
  tableData: (serverId: string, tableName: string, format: string = 'csv', layer: string = 'memory') =>
    apiClient.get(`/api/v1/export/${serverId}/table/${tableName}`, {
      params: { format, layer },
      responseType: 'blob',
    }),
}

// Database Manager API — direct backend MySQL management
export const dbManagerApi = {
  listBackends: (serverId: string) =>
    apiClient.get(`/api/v1/db-manager/${serverId}/backends`),
  testConnection: (serverId: string, hostname: string, port: number, username: string) =>
    apiClient.post(`/api/v1/db-manager/${serverId}/test-connection`, null, {
      params: { hostname, port, username },
    }),
  listDatabases: (serverId: string, hostname: string, port: number, username: string) =>
    apiClient.get(`/api/v1/db-manager/${serverId}/databases`, {
      params: { hostname, port, username },
    }),
  listTables: (serverId: string, hostname: string, port: number, database: string, username: string) =>
    apiClient.get(`/api/v1/db-manager/${serverId}/tables`, {
      params: { hostname, port, database, username },
    }),
  getTableSchema: (serverId: string, hostname: string, port: number, database: string, table: string, username: string) =>
    apiClient.get(`/api/v1/db-manager/${serverId}/table-schema`, {
      params: { hostname, port, database, table, username },
    }),
  getTableData: (serverId: string, hostname: string, port: number, database: string, table: string, username: string, page: number = 1, pageSize: number = 50) =>
    apiClient.get(`/api/v1/db-manager/${serverId}/table-data`, {
      params: { hostname, port, database, table, username, page, page_size: pageSize },
    }),
  executeSQL: (serverId: string, data: {
    sql: string
    database?: string
    hostname: string
    port: number
    username: string
    limit?: number
  }) => apiClient.post(`/api/v1/db-manager/${serverId}/execute`, data),
}

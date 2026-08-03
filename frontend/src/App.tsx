import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import LoadingFallback from './components/LoadingFallback'
import PageSkeleton from './components/PageSkeleton'
import { ErrorBoundary } from './components/ErrorBoundary'

/**
 * Route-level code splitting with named chunks.
 *
 * Each page is lazy-loaded with a webpackChunkName comment so Vite/Rollup
 * outputs a named chunk file (e.g. "page-DashboardPage-[hash].js") instead
 * of auto-generated numbers. This makes bundle analysis easier, improves
 * cache granularity, and keeps chunk names debuggable in production.
 *
 * The Suspense fallback uses a <PageSkeleton> that mimics the page layout,
 * reducing perceived CLS (Cumulative Layout Shift) while the chunk loads.
 */
const LoginPage = lazy(() => import(/* webpackChunkName: "page-LoginPage" */ './pages/LoginPage'))
const DashboardPage = lazy(() => import(/* webpackChunkName: "page-DashboardPage" */ './pages/DashboardPage'))
const WizardsPage = lazy(() => import(/* webpackChunkName: "page-WizardsPage" */ './pages/WizardsPage'))
const TemplateWizardPage = lazy(() => import(/* webpackChunkName: "page-TemplateWizardPage" */ './pages/TemplateWizardPage'))
const TableBrowserPage = lazy(() => import(/* webpackChunkName: "page-TableBrowserPage" */ './pages/TableBrowserPage'))
const QueryConsolePage = lazy(() => import(/* webpackChunkName: "page-QueryConsolePage" */ './pages/QueryConsolePage'))
const ConfigSyncPage = lazy(() => import(/* webpackChunkName: "page-ConfigSyncPage" */ './pages/ConfigSyncPage'))
const UsersPage = lazy(() => import(/* webpackChunkName: "page-UsersPage" */ './pages/UsersPage'))
const ServersPage = lazy(() => import(/* webpackChunkName: "page-ServersPage" */ './pages/ServersPage'))
const ConfigDiffPage = lazy(() => import(/* webpackChunkName: "page-ConfigDiffPage" */ './pages/ConfigDiffPage'))
const SettingsPage = lazy(() => import(/* webpackChunkName: "page-SettingsPage" */ './pages/SettingsPage'))
const ClustersPage = lazy(() => import(/* webpackChunkName: "page-ClustersPage" */ './pages/ClustersPage'))
const ClusterDetailPage = lazy(() => import(/* webpackChunkName: "page-ClusterDetailPage" */ './pages/ClusterDetailPage'))
const BackupPage = lazy(() => import(/* webpackChunkName: "page-BackupPage" */ './pages/BackupPage'))
const DatabaseManagerPage = lazy(() => import(/* webpackChunkName: "page-DatabaseManagerPage" */ './pages/DatabaseManagerPage'))
const QueryRulesPage = lazy(() => import(/* webpackChunkName: "page-QueryRulesPage" */ './pages/QueryRulesPage'))
// MainLayout is eager-loaded because it's needed immediately after login
import MainLayout from './components/layout/MainLayout'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isInitialized } = useAuthStore()
  // Show loading spinner while checkAuth() is still in-flight.
  // This prevents a flash of the login page when the user has a valid
  // refresh_token cookie but the auth check hasn't completed yet.
  if (!isInitialized) {
    return <LoadingFallback />
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
      <Route path="/login" element={
        <Suspense fallback={<LoadingFallback />}>
          <LoginPage />
        </Suspense>
      } />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        {/* Each route wrapped in Suspense for lazy-loaded page chunks */}
        <Route path="dashboard" element={
          <Suspense fallback={<PageSkeleton type="dashboard" />}>
            <DashboardPage />
          </Suspense>
        } />
        <Route path="wizards" element={
          <Suspense fallback={<PageSkeleton />}>
            <WizardsPage />
          </Suspense>
        } />
        <Route path="wizards/:wizardId" element={
          <Suspense fallback={<PageSkeleton />}>
            <WizardsPage />
          </Suspense>
        } />
        <Route path="template" element={
          <Suspense fallback={<PageSkeleton />}>
            <TemplateWizardPage />
          </Suspense>
        } />
        <Route path="tables" element={
          <Suspense fallback={<PageSkeleton type="table" />}>
            <TableBrowserPage />
          </Suspense>
        } />
        <Route path="tables/:tableName" element={
          <Suspense fallback={<PageSkeleton type="table" />}>
            <TableBrowserPage />
          </Suspense>
        } />
        <Route path="rules" element={
          <Suspense fallback={<PageSkeleton />}>
            <QueryRulesPage />
          </Suspense>
        } />
        <Route path="query" element={
          <Suspense fallback={<PageSkeleton />}>
            <QueryConsolePage />
          </Suspense>
        } />
        <Route path="sync" element={
          <Suspense fallback={<PageSkeleton />}>
            <ConfigSyncPage />
          </Suspense>
        } />
        <Route path="config-diff" element={
          <Suspense fallback={<PageSkeleton />}>
            <ConfigDiffPage />
          </Suspense>
        } />
        <Route path="users" element={
          <Suspense fallback={<PageSkeleton />}>
            <UsersPage />
          </Suspense>
        } />
        <Route path="servers" element={
          <Suspense fallback={<PageSkeleton />}>
            <ServersPage />
          </Suspense>
        } />
        <Route path="clusters" element={
          <Suspense fallback={<PageSkeleton />}>
            <ClustersPage />
          </Suspense>
        } />
        <Route path="clusters/:clusterId" element={
          <Suspense fallback={<PageSkeleton />}>
            <ClusterDetailPage />
          </Suspense>
        } />
        <Route path="backup" element={
          <Suspense fallback={<PageSkeleton />}>
            <BackupPage />
          </Suspense>
        } />
        <Route path="settings" element={
          <Suspense fallback={<PageSkeleton />}>
            <SettingsPage />
          </Suspense>
        } />
        <Route path="database" element={
          <Suspense fallback={<PageSkeleton />}>
            <DatabaseManagerPage />
          </Suspense>
        } />
      </Route>
    </Routes>
    </ErrorBoundary>
  )
}

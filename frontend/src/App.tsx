import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import Layout from './components/Layout'
import Login from './pages/Login'

import { lazy, Suspense } from 'react'
const Dashboard   = lazy(() => import('./pages/Dashboard'))
const Alerts      = lazy(() => import('./pages/Alerts'))
const Logs        = lazy(() => import('./pages/Logs'))
const Settings    = lazy(() => import('./pages/Settings'))
const Collectors  = lazy(() => import('./pages/Collectors'))
const OidCatalog  = lazy(() => import('./pages/OidCatalog'))
const Devices     = lazy(() => import('./pages/Devices'))
const MetricsPage = lazy(() => import('./pages/MetricsPage'))

function PageFallback() {
  return <div className="flex items-center justify-center h-48 text-white">Loading…</div>
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  if (isLoading) return <PageFallback />
  if (!user) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  if (isLoading) return <PageFallback />
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/" replace />
  return <Layout>{children}</Layout>
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Dashboard /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/alerts" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Alerts /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/logs" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Logs /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/settings" element={
            <AdminRoute>
              <Suspense fallback={<PageFallback />}><Settings /></Suspense>
            </AdminRoute>
          } />
          <Route path="/collectors" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Collectors /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/oid-catalog" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><OidCatalog /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/devices" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Devices /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/metrics" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><MetricsPage /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/users" element={<Navigate to="/settings" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

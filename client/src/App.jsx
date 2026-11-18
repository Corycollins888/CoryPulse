import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth.jsx'
import { ToastProvider } from './components.jsx'
import Layout from './Layout.jsx'
import Setup from './pages/Setup.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Sites from './pages/Sites.jsx'
import SiteDetail from './pages/SiteDetail.jsx'
import Plans from './pages/Plans.jsx'
import Vouchers from './pages/Vouchers.jsx'
import Customers from './pages/Customers.jsx'
import Payments from './pages/Payments.jsx'
import Reports from './pages/Reports.jsx'
import Settings from './pages/Settings.jsx'
import Portal from './pages/Portal.jsx'
import PulseWall from './pages/PulseWall.jsx'

function Splash() {
  return (
    <div className="splash">
      <div className="brand-mark large">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M2 12h4l3-8 4 16 3-8h6" />
        </svg>
      </div>
      <div className="splash-text">CoryPulse</div>
      <span className="spinner" />
    </div>
  )
}

function Protected({ children }) {
  const { user, setup, loading } = useAuth()
  if (loading) return <Splash />
  if (!setup) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace />
  return children
}

function SetupGate() {
  const { user, setup, loading } = useAuth()
  if (loading) return <Splash />
  if (setup) return <Navigate to={user ? '/' : '/login'} replace />
  return <Setup />
}

function LoginGate() {
  const { user, setup, loading } = useAuth()
  if (loading) return <Splash />
  if (setup === false) return <Navigate to="/setup" replace />
  if (user) return <Navigate to="/" replace />
  return <Login />
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <ScrollToTop />
          <Routes>
            <Route path="/setup" element={<SetupGate />} />
            <Route path="/login" element={<LoginGate />} />
            <Route path="/portal/:siteId" element={<Portal />} />
            <Route
              path="/wall"
              element={
                <Protected>
                  <PulseWall />
                </Protected>
              }
            />
            <Route
              element={
                <Protected>
                  <Layout />
                </Protected>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="sites" element={<Sites />} />
              <Route path="sites/:id" element={<SiteDetail />} />
              <Route path="plans" element={<Plans />} />
              <Route path="vouchers" element={<Vouchers />} />
              <Route path="customers" element={<Customers />} />
              <Route path="payments" element={<Payments />} />
              <Route path="reports" element={<Reports />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}

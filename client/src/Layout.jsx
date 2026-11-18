import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import Icon from './icons.jsx'
import CommandPalette from './CommandPalette.jsx'
import { useAuth } from './auth.jsx'
import { LIVE_EVENTS } from './api.js'

const NAV = [
  { label: 'Operations', items: [
    { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
    { to: '/wall', label: 'Pulse wall', icon: 'pulse' },
    { to: '/sites', label: 'Sites & routers', icon: 'sites' },
    { to: '/vouchers', label: 'Vouchers', icon: 'vouchers' },
    { to: '/payments', label: 'Payments', icon: 'payments' },
  ] },
  { label: 'Business', items: [
    { to: '/plans', label: 'Plans', icon: 'plans' },
    { to: '/customers', label: 'Customers', icon: 'customers' },
    { to: '/reports', label: 'Reports', icon: 'reports' },
  ] },
  { label: 'System', items: [
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ] },
]

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [live, setLive] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const source = new EventSource('/api/stream')
    source.onopen = () => setLive(true)
    source.onerror = () => setLive(false)
    const listeners = LIVE_EVENTS.map((name) => {
      const handler = (event) => {
        try {
          const detail = { type: name, data: JSON.parse(event.data) }
          window.dispatchEvent(new CustomEvent('cp:live', { detail }))
        } catch {
          // ignore malformed frames
        }
      }
      source.addEventListener(name, handler)
      return [name, handler]
    })
    return () => {
      for (const [name, handler] of listeners) source.removeEventListener(name, handler)
      source.close()
    }
  }, [])

  const onLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="pulse" size={22} strokeWidth={2} />
          </div>
          <div>
            <div className="brand-name">CoryPulse</div>
            <div className="brand-tag">Wi-Fi operations</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                >
                  <Icon name={item.icon} size={17} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="live-row">
            <span className={`live-dot ${live ? '' : 'off'}`} />
            <span>{live ? 'Live feed connected' : 'Reconnecting…'}</span>
          </div>
          <div className="user-row">
            <span className="user-name">{user?.username}</span>
            <button className="icon-btn" onClick={onLogout} title="Sign out" aria-label="Sign out">
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-note">Operator console</div>
          <div className="topbar-right">
            <button className="topbar-search" onClick={() => setPaletteOpen(true)}>
              <Icon name="search" size={15} />
              <span>Jump to…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <span className={`live-pill ${live ? 'on' : ''}`}>
              <span className={`live-dot ${live ? '' : 'off'}`} />
              {live ? 'Live' : 'Offline'}
            </span>
            <span className="user-chip">{user?.username?.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import Icon from './icons.jsx'
import { money, statusTone, statusLabel, copyText, dateShort } from './utils.js'

/* ------------------------------------------------------------------ toasts */

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback((message, tone = 'success') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((list) => [...list, { id, message, tone }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            <Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'spark'} size={16} />
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext) || (() => {})
}

/* --------------------------------------------------------------- primitives */

export function PageHeader({ eyebrow, title, sub, actions }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

export function Modal({ title, subtitle, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="card-title">{title}</div>
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, children, full = false }) {
  return (
    <label className={`field ${full ? 'full' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

export function StatusPill({ status, label }) {
  return (
    <span className={`pill ${statusTone(status)}`}>
      <i className="dot" />
      {label || statusLabel(status)}
    </span>
  )
}

export function ModePill({ mode }) {
  return <span className={`pill ${mode === 'routeros' ? 'green' : 'violet'}`}>{statusLabel(mode)}</span>
}

/* ------------------------------------------------------------------ charts */

export function Sparkline({ values = [], width = 120, height = 36, color = '#22d3a7', className = '' }) {
  const data = values.length ? values : [0, 0]
  const max = Math.max(...data, 1)
  const step = width / Math.max(1, data.length - 1)
  const points = data.map((value, index) => {
    const x = index * step
    const y = height - 3 - (Number(value) / max) * (height - 6)
    return [x, y]
  })
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`sparkline ${className}`} aria-hidden="true">
      <path d={area} fill={color} opacity="0.1" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function Bars({ data = [], valueKey = 'revenue', labelKey = 'day', height = 180, format = (v) => v }) {
  const max = Math.max(...data.map((row) => Number(row[valueKey]) || 0), 1)
  const labelEvery = Math.max(1, Math.ceil(data.length / 14))
  return (
    <div className="bars" style={{ height }}>
      {data.map((row, index) => {
        const value = Number(row[valueKey]) || 0
        const pctHeight = (value / max) * 100
        return (
          <div className="bar-col" key={row[labelKey]} title={`${dateShort(row[labelKey])}: ${format(value)}`}>
            <div className="bar-track">
              <div className="bar" style={{ height: `${Math.max(value > 0 ? 4 : 1, pctHeight)}%` }} />
            </div>
            <span>{index % labelEvery === 0 ? dateShort(row[labelKey]) : '\u00a0'}</span>
          </div>
        )
      })}
    </div>
  )
}

export function Gauge({ value = 0, label = '' }) {
  const percent = Math.max(0, Math.min(100, Math.round(value)))
  const radius = 34
  const circumference = 2 * Math.PI * radius
  const color = percent >= 75 ? '#22d3a7' : percent >= 40 ? '#f5a524' : '#ff5c72'
  return (
    <div className="gauge">
      <svg width="92" height="92" viewBox="0 0 92 92">
        <circle cx="46" cy="46" r={radius} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="8" />
        <circle
          cx="46"
          cy="46"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
          transform="rotate(-90 46 46)"
        />
        <text x="46" y="51" textAnchor="middle" fontSize="17" fontWeight="700" fill="#e6f1f5">
          {percent}%
        </text>
      </svg>
      {label && <span>{label}</span>}
    </div>
  )
}

/* ----------------------------------------------------------------- elements */

export function EmptyState({ icon = 'spark', title, text, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function Spinner({ label }) {
  return (
    <div className="loading-row">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  )
}

export function CopyButton({ value, label = 'Copy', className = 'btn small ghost' }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    const ok = await copyText(value)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }
  return (
    <button type="button" className={className} onClick={onCopy}>
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied ? 'Copied' : label}
    </button>
  )
}

export function Toggle({ checked, onChange, label, description }) {
  return (
    <div className="toggle-row">
      <div>
        <div className="toggle-label">{label}</div>
        {description && <div className="card-sub">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </div>
  )
}

export function SiteCard({ site, currency = 'KES', actions }) {
  const total = Number(site.routers_total || 0)
  const online = Number(site.routers_online || 0)
  const status = total === 0 ? 'unknown' : online > 0 ? 'online' : 'offline'
  return (
    <div className="site-card" style={{ '--site-color': site.color || '#22d3a7' }}>
      <div className="site-top">
        <div>
          <div className="site-name">{site.name}</div>
          <div className="site-ssid">
            <Icon name="wifi" size={13} />
            {site.ssid || 'No SSID set'}
          </div>
        </div>
        <StatusPill status={status} label={status === 'unknown' ? 'No router' : undefined} />
      </div>
      <div className="site-stats">
        <div className="site-stat">
          <span>Online</span>
          <strong>{site.active_users ?? 0}</strong>
        </div>
        <div className="site-stat">
          <span>Today</span>
          <strong>{money(site.revenue_today, currency)}</strong>
        </div>
        <div className="site-stat">
          <span>Stock</span>
          <strong>{site.vouchers_unused ?? 0}</strong>
        </div>
      </div>
      <div className="site-foot">
        {actions || (
          <Link to={`/sites/${site.id}`} className="link">
            Open site <Icon name="chevron" size={14} />
          </Link>
        )}
      </div>
    </div>
  )
}

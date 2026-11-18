import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from './api.js'
import Icon from './icons.jsx'

const PAGES = [
  { label: 'Dashboard', hint: 'Live pulse and today’s numbers', icon: 'dashboard', group: 'Pages', to: '/' },
  { label: 'Pulse wall', hint: 'Full-screen fleet ECG and live incidents', icon: 'pulse', group: 'Pages', to: '/wall' },
  { label: 'Sites & routers', hint: 'Locations, routers and sync', icon: 'sites', group: 'Pages', to: '/sites' },
  { label: 'Vouchers', hint: 'Stock, activation and printing', icon: 'vouchers', group: 'Pages', to: '/vouchers' },
  { label: 'Payments', hint: 'Ledger, refunds and retries', icon: 'payments', group: 'Pages', to: '/payments' },
  { label: 'Plans', hint: 'Packages and pricing', icon: 'plans', group: 'Pages', to: '/plans' },
  { label: 'Customers', hint: 'Guest accounts and spend', icon: 'customers', group: 'Pages', to: '/customers' },
  { label: 'Reports', hint: 'Revenue and performance', icon: 'reports', group: 'Pages', to: '/reports' },
  { label: 'Settings', hint: 'M-Pesa, currency and demo', icon: 'settings', group: 'Pages', to: '/settings' },
]

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate()
  const { data } = useApi(open ? '/sites' : null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const commands = useMemo(() => {
    const actions = [
      {
        label: 'Generate vouchers',
        hint: 'Create a fresh stock batch',
        icon: 'vouchers',
        group: 'Actions',
        run: () => navigate('/vouchers', { state: { generate: true } }),
      },
      {
        label: 'Add a site',
        hint: 'Set up a new Wi-Fi location',
        icon: 'plus',
        group: 'Actions',
        run: () => navigate('/sites'),
      },
      {
        label: 'Open guest portal',
        hint: 'See what guests see',
        icon: 'globe',
        group: 'Actions',
        run: () => {
          const first = data?.sites?.[0]
          window.open(first ? `/portal/${first.id}` : '/sites', '_blank', 'noopener')
        },
      },
    ]
    const portals = (data?.sites || []).map((site) => ({
      label: `Guest portal · ${site.name}`,
      hint: site.ssid || 'Open in a new tab',
      icon: 'wifi',
      group: 'Portals',
      run: () => window.open(`/portal/${site.id}`, '_blank', 'noopener'),
    }))
    return [
      ...PAGES.map((page) => ({ ...page, run: () => navigate(page.to) })),
      ...actions,
      ...portals,
    ]
  }, [data, navigate])

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((command) =>
      `${command.label} ${command.hint || ''} ${command.group || ''}`.toLowerCase().includes(needle)
    )
  }, [commands, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const timer = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    const el = listRef.current?.querySelector('.palette-item.active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const choose = (command) => {
    onClose()
    command.run()
  }

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (results.length ? (index + 1) % results.length : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (results.length ? (index - 1 + results.length) % results.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const command = results[active]
      if (command) choose(command)
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page, site or action…"
            aria-label="Search commands"
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="palette-empty">Nothing matches “{query}”. Try “vouchers” or a site name.</div>
          ) : (
            results.map((command, index) => (
              <button
                key={`${command.group}-${command.label}`}
                className={`palette-item ${index === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(command)}
              >
                <span className="palette-icon"><Icon name={command.icon} size={16} /></span>
                <span className="palette-text">
                  <strong>{command.label}</strong>
                  {command.hint && <small>{command.hint}</small>}
                </span>
                <span className="palette-group">{command.group}</span>
              </button>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

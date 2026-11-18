import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { bpsText, money } from './utils.js'

const TAU = Math.PI * 2
const CENTER = 210
const ORBIT = 142

function hash(text) {
  let value = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0) / 4294967295
}

export default function PulseRadar({ sites = [], clients = [], throughput = {}, currency = 'KES', total = 0 }) {
  const navigate = useNavigate()
  const [hovered, setHovered] = useState(null)

  const nodes = useMemo(() => {
    const list = [...sites]
      .sort((a, b) => Number(b.active_users || 0) - Number(a.active_users || 0))
      .slice(0, 7)
      .sort((a, b) => a.id - b.id)
    return list.map((site, index) => {
      const angle = index * 2.399963 - Math.PI / 2
      const radius = list.length === 1 ? 0 : ORBIT
      const siteClients = clients.filter((client) => client.site_id === site.id)
      return {
        site,
        angle,
        x: CENTER + Math.cos(angle) * radius,
        y: CENTER + Math.sin(angle) * radius,
        clients: siteClients,
      }
    })
  }, [sites, clients])

  const ranked = useMemo(
    () => [...sites].sort((a, b) => Number(b.active_users || 0) - Number(a.active_users || 0)),
    [sites]
  )
  const routersTotal = sites.reduce((sum, site) => sum + Number(site.routers_total || 0), 0)
  const routersOnline = sites.reduce((sum, site) => sum + Number(site.routers_online || 0), 0)
  const totalOnline = Math.max(total, clients.length)

  return (
    <section className="card pulse-card">
      <div className="card-head">
        <div>
          <div className="card-title">Network pulse</div>
          <div className="card-sub">Every device on your hotspots, right now.</div>
        </div>
        <span className="live-pill on">
          <span className="live-dot" />
          live
        </span>
      </div>

      <div className="pulse-layout">
        <div className="radar-stage">
          <div className="radar-grid" aria-hidden="true" />
          <div className="radar-sweep" aria-hidden="true" />
          <svg viewBox="0 0 420 420" className="radar-svg" role="img" aria-label={`${totalOnline} devices online across ${sites.length} sites`}>
            {[52, 96, 140, 184].map((radius) => (
              <circle key={radius} cx={CENTER} cy={CENTER} r={radius} className="radar-ring" />
            ))}
            <line x1="26" y1={CENTER} x2="394" y2={CENTER} className="radar-axis" />
            <line x1={CENTER} y1="26" x2={CENTER} y2="394" className="radar-axis" />

            {nodes.map((node) => {
              const color = node.site.color || '#22d3a7'
              const count = node.clients.length
              const pulseRadius = 24 + Math.min(12, count * 3)
              return (
                <g
                  key={node.site.id}
                  className={`radar-node ${hovered && hovered !== node.site.id ? 'dim' : ''} ${hovered === node.site.id ? 'hot' : ''}`}
                  onClick={() => navigate(`/sites/${node.site.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') navigate(`/sites/${node.site.id}`)
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.site.name}, ${count} online`}
                >
                  <title>{`${node.site.name} · ${count} online`}</title>
                  <circle cx={node.x} cy={node.y} r={pulseRadius + 9} fill="transparent" />
                  {count > 0 && (
                    <circle cx={node.x} cy={node.y} r={pulseRadius} className="radar-node-pulse" style={{ stroke: color }} />
                  )}
                  <circle cx={node.x} cy={node.y} r="16" fill="#08121c" stroke={color} strokeWidth="1.6" />
                  <text x={node.x} y={node.y + 4.2} className="radar-count" textAnchor="middle">{count}</text>
                  {node.clients.slice(0, 10).map((client, index) => {
                    const seed = hash(`${client.username}:${client.address}`)
                    const dotAngle = seed * TAU
                    const dotRadius = 22 + hash(`${client.username}:${node.site.id}`) * 16
                    return (
                      <circle
                        key={`${client.username}-${index}`}
                        cx={node.x + Math.cos(dotAngle) * dotRadius}
                        cy={node.y + Math.sin(dotAngle) * dotRadius}
                        r="2.1"
                        fill={color}
                        opacity="0.85"
                        className="radar-client"
                        style={{ animationDelay: `${(index % 6) * 0.4}s` }}
                      />
                    )
                  })}
                </g>
              )
            })}

            {nodes.length === 0 && (
              <text x={CENTER} y={CENTER + 4} textAnchor="middle" className="radar-empty">No sites yet</text>
            )}
          </svg>
          <div className="radar-hub">
            <span className="radar-total">{totalOnline}</span>
            <span className="radar-total-label">devices online</span>
          </div>
        </div>

        <div className="pulse-side">
          <div className="pulse-metrics">
            <div className="pulse-metric">
              <span>Download</span>
              <strong>{bpsText(throughput.rx_bps)}</strong>
            </div>
            <div className="pulse-metric">
              <span>Upload</span>
              <strong>{bpsText(throughput.tx_bps)}</strong>
            </div>
            <div className="pulse-metric">
              <span>Routers</span>
              <strong>{routersOnline}/{routersTotal} online</strong>
            </div>
          </div>

          <div className="pulse-sites">
            {ranked.map((site) => {
              const percent = totalOnline ? Math.round((Number(site.active_users || 0) / totalOnline) * 100) : 0
              return (
                <button
                  key={site.id}
                  className="pulse-site"
                  onClick={() => navigate(`/sites/${site.id}`)}
                  onMouseEnter={() => setHovered(site.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(site.id)}
                  onBlur={() => setHovered(null)}
                  style={{ '--site-color': site.color || '#22d3a7' }}
                >
                  <span className="pulse-site-dot" />
                  <span className="pulse-site-name">
                    {site.name || 'Site'}
                    <small>{money(site.revenue_today, currency)} today</small>
                  </span>
                  <span className="pulse-site-bar">
                    <i style={{ width: `${percent}%` }} />
                  </span>
                  <span className="pulse-site-count">{site.active_users || 0}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

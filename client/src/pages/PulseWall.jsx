import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi, useDebouncedReload } from '../api.js'
import Icon from '../icons.jsx'
import FleetECG from '../FleetECG.jsx'
import { Spinner } from '../components.jsx'
import { money, num, timeAgo } from '../utils.js'

function gradeColor(score) {
  if (score >= 92) return 'var(--green)'
  if (score >= 80) return 'var(--cyan)'
  if (score >= 65) return 'var(--amber)'
  return 'var(--red)'
}

function clockText(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function ScoreDial({ pulse }) {
  const radius = 62
  const circumference = 2 * Math.PI * radius
  const score = pulse?.score ?? 0
  const offset = circumference - (Math.min(100, Math.max(0, score)) / 100) * circumference
  return (
    <div className="score-dial">
      <svg viewBox="0 0 160 160" role="img" aria-label={`Pulse score ${score} out of 100, grade ${pulse?.grade || '—'}`}>
        <circle cx="80" cy="80" r={radius} className="score-track" />
        <circle
          cx="80"
          cy="80"
          r={radius}
          className="score-progress"
          style={{ stroke: gradeColor(score), strokeDasharray: circumference, strokeDashoffset: offset }}
        />
      </svg>
      <div className="score-center">
        <strong>{score}</strong>
        <span>grade {pulse?.grade || '—'}</span>
      </div>
    </div>
  )
}

export default function PulseWall() {
  const navigate = useNavigate()
  const { data: fleet, loading, reload: reloadFleet } = useApi('/network/fleet')
  const { data: overview, reload: reloadOverview } = useApi('/network/overview')
  const { data: dash, reload: reloadDash } = useApi('/dashboard')
  const { data: feed, reload: reloadFeed } = useApi('/events?limit=60')
  const [now, setNow] = useState(new Date())
  useDebouncedReload(reloadFleet)

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000)
    const refresh = setInterval(() => {
      reloadFleet()
      reloadOverview()
      reloadFeed()
    }, 6000)
    const slow = setInterval(reloadDash, 30_000)
    return () => {
      clearInterval(tick)
      clearInterval(refresh)
      clearInterval(slow)
    }
  }, [reloadFleet, reloadOverview, reloadFeed, reloadDash])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') navigate('/')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const incidents = useMemo(
    () => (feed?.events || []).filter((event) => event.severity === 'critical' || event.severity === 'warning').slice(0, 7),
    [feed]
  )
  const kpis = dash?.kpis || {}
  const currency = dash?.currency || 'KES'
  const pulse = overview?.pulse
  const ingest = overview?.ingest
  const packets = ingest ? ingest.radius.messages + ingest.syslog.messages : 0
  const rate = ingest?.uptime_s > 0 ? Math.round(packets / ingest.uptime_s) : 0

  if (!fleet && loading) return <Spinner label="Waking the pulse wall…" />

  return (
    <div className="wall">
      <header className="wall-head">
        <div className="wall-brand">
          <div className="brand-mark">
            <Icon name="pulse" size={22} strokeWidth={2} />
          </div>
          <div>
            <div className="wall-title">Pulse wall</div>
            <div className="wall-sub">
              <span className="live-dot" /> live fleet heartbeat · {num(fleet?.routers?.length || 0)} routers
            </div>
          </div>
        </div>
        <div className="wall-head-right">
          <div className="wall-clock">{clockText(now)}</div>
          <Link className="wall-btn" to="/">
            <Icon name="dashboard" size={15} /> Console
          </Link>
          <button className="wall-btn" onClick={() => navigate('/')}>
            Exit <kbd>esc</kbd>
          </button>
        </div>
      </header>

      <div className="wall-grid">
        <section className="wall-stage">
          <div className="wall-stage-head">
            <div>
              <div className="wall-stage-title">Fleet ECG</div>
              <div className="wall-stage-sub">One heartbeat per router · height shows load · colour shows health</div>
            </div>
            <div className="ecg-legend">
              <span><i style={{ background: 'var(--green)' }} /> reporting</span>
              <span><i style={{ background: 'var(--amber)' }} /> stale</span>
              <span><i style={{ background: 'var(--red)' }} /> offline</span>
            </div>
          </div>
          <div className="wall-ecg">
            <FleetECG sites={fleet?.sites || []} routers={fleet?.routers || []} onOpenSite={(id) => navigate(`/sites/${id}`)} />
          </div>
          <div className="wall-ticker">
            <div><span>Revenue today</span><strong>{money(kpis.revenue_today ?? 0, currency)}</strong></div>
            <div><span>Guests online</span><strong>{num(kpis.active_users ?? 0)}</strong></div>
            <div><span>Vouchers in hand</span><strong>{num(kpis.unused_vouchers ?? 0)}</strong></div>
            <div><span>Telemetry rate</span><strong>{num(rate)}/s</strong></div>
            <div><span>Sessions held</span><strong>{num(overview?.active_sessions ?? 0)}</strong></div>
          </div>
        </section>

        <aside className="wall-rail">
          <div className="wall-card score-card">
            <div className="wall-card-head">
              <span>Pulse score</span>
              <span className="wall-card-tag">explainable</span>
            </div>
            {pulse ? (
              <>
                <div className="score-row">
                  <ScoreDial pulse={pulse} />
                  <div className="score-copy">
                    <strong>{pulse.headline}</strong>
                    <span>The four telemetry paths below decide the grade.</span>
                  </div>
                </div>
                <div className="factor-list">
                  {pulse.factors.map((factor) => (
                    <div className="factor" key={factor.key}>
                      <div className="factor-top">
                        <span>{factor.label}</span>
                        <strong>{factor.value}%</strong>
                      </div>
                      <div className="factor-bar">
                        <i
                          style={{
                            width: `${factor.value}%`,
                            background:
                              factor.value >= 90 ? 'var(--green)' : factor.value >= 70 ? 'var(--amber)' : 'var(--red)',
                          }}
                        />
                      </div>
                      <small>{factor.detail}</small>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="wall-muted">Waiting for telemetry…</div>
            )}
          </div>

          <div className="wall-card incidents-card">
            <div className="wall-card-head">
              <span>Incident tape</span>
              <span className="wall-card-tag">{incidents.length} open</span>
            </div>
            {incidents.length === 0 ? (
              <div className="wall-muted">Nothing needs attention.</div>
            ) : (
              <div className="incident-list">
                {incidents.map((event) => (
                  <div className="incident" key={event.id}>
                    <span className={`incident-bar ${event.severity}`} />
                    <div>
                      <div className="incident-msg">{event.message}</div>
                      <div className="incident-meta">
                        {event.source || 'system'} · {timeAgo(event.ts)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

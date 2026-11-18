import { Link } from 'react-router-dom'
import { api, useApi, useDebouncedReload } from '../api.js'
import {
  PageHeader,
  Bars,
  Sparkline,
  Gauge,
  SiteCard,
  EmptyState,
  Spinner,
  StatusPill,
  useToast,
} from '../components.jsx'
import Icon from '../icons.jsx'
import PulseRadar from '../PulseRadar.jsx'
import { money, num, pct, dateLong, timeAgo } from '../utils.js'

export default function Dashboard() {
  const { data, loading, error, reload } = useApi('/dashboard')
  const { data: telemetry, reload: reloadTelemetry } = useApi('/network/overview')
  useDebouncedReload(reload)
  useDebouncedReload(reloadTelemetry)
  const toast = useToast()

  if (!data && loading) return <Spinner label="Loading operations…" />
  if (!data) {
    return <EmptyState icon="alert" title="Could not load the dashboard" text={error?.message} action={<button className="btn" onClick={reload}>Try again</button>} />
  }

  const { kpis, sites, series, pulse, recent_payments: payments, recent_events: events, currency, company_name: company } = data
  const health = pct(kpis.routers_online, kpis.routers_total)
  const weekRevenue = series.slice(-7).reduce((sum, row) => sum + row.revenue, 0)
  const firstSite = sites[0]

  const loadDemo = async () => {
    try {
      await api('/demo/load', { method: 'POST' })
      toast('Demo workspace loaded.')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Command center"
        title={company}
        sub={`${dateLong(new Date().toISOString())} · live across ${sites.length} site${sites.length === 1 ? '' : 's'}`}
        actions={
          <>
            {firstSite && (
              <a className="btn" href={`/portal/${firstSite.id}`} target="_blank" rel="noreferrer">
                <Icon name="globe" size={16} /> Guest portal
              </a>
            )}
            <Link className="btn" to="/wall">
              <Icon name="pulse" size={16} /> Pulse wall
            </Link>
            <Link className="btn primary" to="/vouchers" state={{ generate: true }}>
              <Icon name="plus" size={16} /> Generate vouchers
            </Link>
          </>
        }
      />

      <div className="grid-kpi">
        <div className="kpi">
          <div className="kpi-label">Revenue today</div>
          <div className="kpi-value">{money(kpis.revenue_today, currency)}</div>
          <div className="kpi-foot">
            <Icon name="money" size={13} /> {kpis.sales_today} sale{kpis.sales_today === 1 ? '' : 's'} today
          </div>
          <Sparkline values={series.slice(-10).map((row) => row.revenue)} className="kpi-spark" />
        </div>

        <div className="kpi">
          <div className="kpi-label">Active users</div>
          <div className="kpi-value">{num(kpis.active_users)}</div>
          <div className="kpi-foot">
            <span className="live-dot" /> connected right now
          </div>
          <Sparkline values={series.slice(-10).map((row) => row.sales)} color="#38bdf8" className="kpi-spark" />
        </div>

        <div className="kpi">
          <div className="kpi-label">Vouchers in stock</div>
          <div className="kpi-value">{num(kpis.unused_vouchers)}</div>
          <div className="kpi-foot">
            <Icon name="vouchers" size={13} /> ready to sell
          </div>
          <Sparkline values={series.slice(-10).map((row) => row.sales)} color="#f5a524" className="kpi-spark" />
        </div>

        <div className="kpi">
          <div className="kpi-label">Network health</div>
          <div className="kpi-value">
            {kpis.routers_online}/{kpis.routers_total}
          </div>
          <div className="kpi-foot">
            <Icon name="router" size={13} /> routers online
          </div>
          <div className="kpi-gauge">
            <Gauge value={health} />
          </div>
        </div>
      </div>

      {telemetry && (
        <div className="mini-grid telemetry-strip">
          <div className="mini">
            <span>Routers reporting</span>
            <strong>
              {num(telemetry.coverage.fresh)} <em>/ {num(telemetry.coverage.total)}</em>
            </strong>
            <span className="mini-sub">
              {telemetry.coverage.stale > 0 ? `${telemetry.coverage.stale} awaiting telemetry` : 'full coverage'}
            </span>
          </div>
          <div className="mini">
            <span>Sessions held</span>
            <strong>{num(telemetry.active_sessions)}</strong>
            <span className="mini-sub">{num(telemetry.radius_active_sessions)} via RADIUS</span>
          </div>
          <div className="mini">
            <span>Ingest volume</span>
            <strong>{num(telemetry.ingest.radius.messages + telemetry.ingest.syslog.messages)}</strong>
            <span className="mini-sub">
              {telemetry.ingest.uptime_s > 0
                ? `${num(telemetry.ingest.radius.errors + telemetry.ingest.syslog.errors)} errors · ${num(telemetry.ingest.radius.starts)} logins seen`
                : 'listener starting'}
            </span>
          </div>
          <div className="mini">
            <span>Write buffer</span>
            <strong>
              {num(
                telemetry.ingest.buffered.radius_sessions +
                  telemetry.ingest.buffered.active_sessions +
                  telemetry.ingest.buffered.logs +
                  telemetry.ingest.buffered.session_events
              )}
            </strong>
            <span className="mini-sub">batched rows waiting</span>
          </div>
          {telemetry.pulse && (
            <Link className="mini mini-link" to="/wall">
              <span>Pulse score</span>
              <strong style={{ color: telemetry.pulse.score >= 92 ? 'var(--green)' : telemetry.pulse.score >= 80 ? 'var(--cyan)' : telemetry.pulse.score >= 65 ? 'var(--amber)' : 'var(--red)' }}>
                {telemetry.pulse.score} <em>grade {telemetry.pulse.grade}</em>
              </strong>
              <span className="mini-sub">{telemetry.pulse.headline} · open wall</span>
            </Link>
          )}
        </div>
      )}

      {sites.length > 0 && (
        <PulseRadar
          sites={sites}
          clients={pulse?.clients || []}
          throughput={pulse?.throughput || {}}
          currency={currency}
          total={kpis.active_users}
        />
      )}

      <div className="grid-main">
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Revenue pulse</div>
              <div className="card-sub">Last 14 days</div>
            </div>
            <div className="card-figure">
              <span>7-day total</span>
              <strong>{money(weekRevenue, currency)}</strong>
            </div>
          </div>
          <Bars data={series} valueKey="revenue" labelKey="day" format={(value) => money(value, currency)} />
        </section>

        <section className="card">
          <div className="card-head">
            <div className="card-title">Activity</div>
            <Link className="link small-link" to="/sites">View sites</Link>
          </div>
          {events.length === 0 ? (
            <EmptyState icon="pulse" title="No activity yet" text="Sales and router events will stream in here." />
          ) : (
            <div className="event-list">
              {events.map((event) => (
                <div className="event" key={event.id}>
                  <span className={`event-dot ${event.severity}`} />
                  <div className="event-body">
                    <div className="event-msg">{event.message}</div>
                    <div className="event-meta">
                      {event.kind.replaceAll('_', ' ')} · {timeAgo(event.ts)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="section-head">
        <div>
          <div className="card-title">Sites</div>
          <div className="card-sub">Live status, stock and daily revenue</div>
        </div>
        <Link className="link small-link" to="/sites">Manage sites <Icon name="chevron" size={13} /></Link>
      </div>

      {sites.length === 0 ? (
        <EmptyState
          icon="sites"
          title="No sites yet"
          text="Add your first Wi-Fi site, or load demo data to explore the console."
          action={
            <div className="actions">
              <Link className="btn" to="/sites">Add a site</Link>
              <button className="btn primary" onClick={loadDemo}>Load demo data</button>
            </div>
          }
        />
      ) : (
        <div className="sites-grid">
          {sites.map((site) => (
            <SiteCard key={site.id} site={site} currency={currency} />
          ))}
        </div>
      )}

      <section className="card spaced">
        <div className="card-head">
          <div>
            <div className="card-title">Recent sales</div>
            <div className="card-sub">Newest purchases first</div>
          </div>
          <Link className="link small-link" to="/payments">All payments</Link>
        </div>
        {payments.length === 0 ? (
          <EmptyState icon="payments" title="No sales yet" text="Voucher purchases will appear here as soon as they are paid." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Plan</th>
                  <th>Site</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{payment.customer_name || 'Walk-in'}</td>
                    <td>{payment.plan_name || '—'}</td>
                    <td className="muted-cell">{payment.site_name || '—'}</td>
                    <td className="num">{money(payment.amount, payment.currency)}</td>
                    <td><StatusPill status={payment.status} /></td>
                    <td className="muted-cell">{timeAgo(payment.paid_at || payment.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

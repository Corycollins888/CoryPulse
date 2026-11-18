import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, useApi, useDebouncedReload } from '../api.js'
import {
  PageHeader,
  Modal,
  Field,
  StatusPill,
  ModePill,
  EmptyState,
  Spinner,
  useToast,
} from '../components.jsx'
import Icon from '../icons.jsx'
import { money, num, duration, timeAgo, statusLabel } from '../utils.js'

const BLANK_ROUTER = {
  name: '',
  mode: 'simulated',
  host: '',
  nas_ip: '',
  radius_secret: '',
  port: 8728,
  username: '',
  password: '',
  use_tls: false,
  hotspot_server: 'hotspot1',
  hotspot_profile: 'default',
}

export default function SiteDetail() {
  const { id } = useParams()
  const toast = useToast()
  const { data, loading, reload } = useApi(`/sites/${id}`)
  useDebouncedReload(reload)
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(BLANK_ROUTER)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionId, setActionId] = useState(null)

  if (!data && loading) return <Spinner label="Loading site…" />
  if (!data) return <EmptyState icon="alert" title="Site not found" action={<Link className="btn" to="/sites">Back to sites</Link>} />

  const { site, routers, stats, payments, events, currency = 'KES' } = data

  const openCreate = () => {
    setForm(BLANK_ROUTER)
    setError('')
    setModal({ mode: 'create' })
  }

  const openEdit = (router) => {
    setForm({
      name: router.name || '',
      mode: router.mode || 'simulated',
      host: router.host || '',
      nas_ip: router.nas_ip || '',
      radius_secret: '',
      port: router.port || 8728,
      username: router.username || '',
      password: '',
      use_tls: Boolean(router.use_tls),
      hotspot_server: router.hotspot_server || 'hotspot1',
      hotspot_profile: router.hotspot_profile || 'default',
    })
    setError('')
    setModal({ mode: 'edit', router })
  }

  const saveRouter = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (modal.mode === 'create') {
        await api(`/sites/${site.id}/routers`, { method: 'POST', body: form })
        toast('Router added.')
      } else {
        await api(`/routers/${modal.router.id}`, { method: 'PATCH', body: form })
        toast('Router updated.')
      }
      setModal(null)
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const testRouter = async (router) => {
    setActionId(router.id)
    try {
      const result = await api(`/routers/${router.id}/test`, { method: 'POST' })
      toast(`Connected to ${result.identity} · ${result.version}`)
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setActionId(null)
    }
  }

  const syncRouter = async (router) => {
    setActionId(router.id)
    try {
      const result = await api(`/routers/${router.id}/sync`, { method: 'POST' })
      toast(`Synced · ${result.metrics.users} active sessions`)
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setActionId(null)
    }
  }

  const removeRouter = async (router) => {
    if (!window.confirm(`Remove ${router.name} from this site?`)) return
    try {
      await api(`/routers/${router.id}`, { method: 'DELETE' })
      toast('Router removed.')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      <Link className="back-link" to="/sites">← All sites</Link>
      <PageHeader
        eyebrow="Site"
        title={site.name}
        sub={`${site.ssid || 'No SSID'} · ${site.address || 'No address'}${site.notes ? ' · ' + site.notes : ''}`}
        actions={
          <>
            <a className="btn" href={`/portal/${site.id}`} target="_blank" rel="noreferrer">
              <Icon name="external" size={16} /> Guest portal
            </a>
            <button className="btn primary" onClick={openCreate}>
              <Icon name="plus" size={16} /> Add router
            </button>
          </>
        }
      />

      <div className="mini-grid">
        <div className="mini">
          <span>Active users</span>
          <strong>{num(stats.active_users)}</strong>
          <i className="live-dot" />
        </div>
        <div className="mini">
          <span>Revenue today</span>
          <strong>{money(stats.revenue_today, currency)}</strong>
        </div>
        <div className="mini">
          <span>Revenue · 30 days</span>
          <strong>{money(stats.revenue_month, currency)}</strong>
        </div>
        <div className="mini">
          <span>Vouchers</span>
          <strong>{num(stats.unused_vouchers)} <em>in stock</em></strong>
          <span className="mini-sub">{stats.active_vouchers} active</span>
        </div>
      </div>

      <div className="section-head">
        <div>
          <div className="card-title">Routers</div>
          <div className="card-sub">RADIUS accounting, syslog and API polling feed every router</div>
        </div>
      </div>

      {routers.length === 0 ? (
        <EmptyState
          icon="router"
          title="No router attached"
          text="Add the MikroTik router for this site, or keep a simulated router to demonstrate the console."
          action={<button className="btn primary" onClick={openCreate}>Add router</button>}
        />
      ) : (
        <div className="router-grid">
          {routers.map((router) => {
            const cpu = Math.min(100, Math.max(0, Number(router.cpu || 0)))
            return (
              <div className="router-card" key={router.id}>
                <div className="router-top">
                  <div>
                    <div className="router-name">{router.name}</div>
                    <div className="router-host">
                      {router.mode === 'routeros' ? router.host || 'No host' : 'Virtual router for demos'}
                    </div>
                    {router.nas_ip && (
                      <div className="router-host">
                        Telemetry · NAS {router.nas_ip} · {router.has_radius_secret ? 'RADIUS secured' : 'no RADIUS secret'}
                      </div>
                    )}
                  </div>
                  <div className="router-badges">
                    <ModePill mode={router.mode} />
                    <StatusPill status={router.status} label={router.status === 'unknown' ? 'Not checked' : undefined} />
                  </div>
                </div>

                <div className="router-stats">
                  <div>
                    <span>Users</span>
                    <strong>{router.active_users || 0}</strong>
                  </div>
                  <div>
                    <span>Uptime</span>
                    <strong>{router.uptime_s ? duration(Math.floor(router.uptime_s / 60)) : '—'}</strong>
                  </div>
                  <div>
                    <span>Hotspot</span>
                    <strong>{router.hotspot_server || 'hotspot1'}</strong>
                  </div>
                </div>

                <div className="meter-row">
                  <span>CPU</span>
                  <div className="meter"><i style={{ width: `${cpu}%` }} /></div>
                  <span className="num">{cpu}%</span>
                </div>

                {router.last_error && <div className="inline-error">{router.last_error}</div>}

                <div className="router-actions">
                  <button className="btn small" onClick={() => testRouter(router)} disabled={actionId === router.id}>
                    {actionId === router.id ? 'Working…' : 'Test'}
                  </button>
                  <button className="btn small" onClick={() => syncRouter(router)} disabled={actionId === router.id}>
                    Sync now
                  </button>
                  <button className="btn small ghost" onClick={() => openEdit(router)}>Edit</button>
                  <button className="icon-btn danger-icon" onClick={() => removeRouter(router)} title="Remove router">
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="split spaced">
        <section className="card">
          <div className="card-head">
            <div className="card-title">Recent payments</div>
            <Link className="link small-link" to="/payments">View all</Link>
          </div>
          {payments.length === 0 ? (
            <EmptyState icon="payments" title="No payments yet" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Plan</th>
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

        <section className="card">
          <div className="card-head">
            <div className="card-title">Site activity</div>
          </div>
          {events.length === 0 ? (
            <EmptyState icon="pulse" title="Nothing logged yet" />
          ) : (
            <div className="event-list">
              {events.map((event) => (
                <div className="event" key={event.id}>
                  <span className={`event-dot ${event.severity}`} />
                  <div className="event-body">
                    <div className="event-msg">{event.message}</div>
                    <div className="event-meta">{statusLabel(event.kind)} · {timeAgo(event.ts)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {modal && (
        <Modal
          wide
          title={modal.mode === 'create' ? 'Add router' : 'Edit router'}
          subtitle="Use a dedicated RouterOS API user with a strong password."
          onClose={() => setModal(null)}
        >
          <form className="form-grid" onSubmit={saveRouter}>
            <Field label="Router name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Riverside Core" autoFocus />
            </Field>
            <Field label="Connection type">
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="simulated">Simulated (demo)</option>
                <option value="routeros">MikroTik RouterOS</option>
              </select>
            </Field>

            {form.mode === 'routeros' ? (
              <>
                <Field label="Host or IP">
                  <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.88.1" />
                </Field>
                <Field label="API port">
                  <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
                </Field>
                <Field label="API username">
                  <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="corypulse" autoComplete="off" />
                </Field>
                <Field label="API password (leave blank to keep)">
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
                </Field>
                <Field label="NAS IP (router source address)">
                  <input value={form.nas_ip} onChange={(e) => setForm({ ...form, nas_ip: e.target.value })} placeholder="197.232.10.14" />
                </Field>
                <Field label={modal.mode === 'edit' && modal.router.has_radius_secret ? 'RADIUS secret (leave blank to keep)' : 'RADIUS secret'}>
                  <input type="password" value={form.radius_secret} onChange={(e) => setForm({ ...form, radius_secret: e.target.value })} autoComplete="new-password" />
                </Field>
                <label className="checkbox full">
                  <input type="checkbox" checked={form.use_tls} onChange={(e) => setForm({ ...form, use_tls: e.target.checked })} />
                  <span>Use API-SSL (port 8729)</span>
                </label>
                <div className="form-note full">
                  Enable the API service on the router and allow this server's IP. CoryPulse only creates and removes hotspot users; it never changes router-wide settings.
                  Point the router's RADIUS accounting server and remote syslog at this host, using the same secret, to stream every session and log line.
                </div>
              </>
            ) : (
              <div className="form-note full">
                Simulated routers generate live traffic and clients so you can demonstrate and test every screen without hardware.
              </div>
            )}

            <Field label="Hotspot server">
              <input value={form.hotspot_server} onChange={(e) => setForm({ ...form, hotspot_server: e.target.value })} />
            </Field>
            <Field label="Hotspot profile">
              <input value={form.hotspot_profile} onChange={(e) => setForm({ ...form, hotspot_profile: e.target.value })} />
            </Field>

            {error && <div className="form-error full">{error}</div>}
            <div className="form-actions full">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save router'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

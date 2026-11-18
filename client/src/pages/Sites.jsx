import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, useApi } from '../api.js'
import { PageHeader, Modal, Field, SiteCard, EmptyState, Spinner, useToast } from '../components.jsx'
import Icon from '../icons.jsx'

const COLORS = ['#22d3a7', '#38bdf8', '#a78bfa', '#f5a524', '#ff5c72', '#4ade80']

const BLANK = { name: '', ssid: '', address: '', color: '#22d3a7', notes: '' }

export default function Sites() {
  const { data, loading, reload } = useApi('/sites')
  const toast = useToast()
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const openCreate = () => {
    setForm(BLANK)
    setError('')
    setModal({ mode: 'create' })
  }

  const openEdit = (site) => {
    setForm({
      name: site.name || '',
      ssid: site.ssid || '',
      address: site.address || '',
      color: site.color || '#22d3a7',
      notes: site.notes || '',
    })
    setError('')
    setModal({ mode: 'edit', site })
  }

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (modal.mode === 'create') {
        await api('/sites', { method: 'POST', body: form })
        toast('Site added.')
      } else {
        await api(`/sites/${modal.site.id}`, { method: 'PATCH', body: form })
        toast('Site updated.')
      }
      setModal(null)
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (site) => {
    if (!window.confirm(`Delete ${site.name}? Routers attached to it will also be removed.`)) return
    try {
      await api(`/sites/${site.id}`, { method: 'DELETE' })
      toast('Site deleted.')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!data && loading) return <Spinner label="Loading sites…" />
  const sites = data?.sites || []

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Sites & routers"
        sub="Each site groups a location, its router, hotspot identity and sales."
        actions={
          <button className="btn primary" onClick={openCreate}>
            <Icon name="plus" size={16} /> New site
          </button>
        }
      />

      {sites.length === 0 ? (
        <EmptyState
          icon="sites"
          title="No sites yet"
          text="Create a site to represent a café, apartment block, or hotspot location."
          action={<button className="btn primary" onClick={openCreate}>Add your first site</button>}
        />
      ) : (
        <div className="sites-grid">
          {sites.map((site) => (
            <SiteCard
              key={site.id}
              site={site}
              currency={data?.currency || 'KES'}
              actions={
                <div className="site-actions">
                  <Link className="link" to={`/sites/${site.id}`}>
                    Manage <Icon name="chevron" size={13} />
                  </Link>
                  <div>
                    <a
                      className="icon-btn"
                      href={`/portal/${site.id}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open guest portal"
                    >
                      <Icon name="external" size={15} />
                    </a>
                    <button className="icon-btn" onClick={() => openEdit(site)} title="Edit site">
                      <Icon name="edit" size={15} />
                    </button>
                    <button className="icon-btn danger-icon" onClick={() => remove(site)} title="Delete site">
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              }
            />
          ))}
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'create' ? 'New site' : 'Edit site'}
          subtitle="The SSID is what guests see on their phones."
          onClose={() => setModal(null)}
        >
          <form className="form-grid" onSubmit={save}>
            <Field label="Site name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Riverside Cafe" autoFocus />
            </Field>
            <Field label="Wi-Fi name (SSID)">
              <input value={form.ssid} onChange={(e) => setForm({ ...form, ssid: e.target.value })} placeholder="Riverside-Guest" />
            </Field>
            <Field label="Address" full>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Kilimani, Nairobi" />
            </Field>
            <Field label="Accent colour" full>
              <div className="swatches">
                {COLORS.map((color) => (
                  <button
                    type="button"
                    key={color}
                    className={`swatch ${form.color === color ? 'selected' : ''}`}
                    style={{ background: color }}
                    onClick={() => setForm({ ...form, color })}
                    aria-label={color}
                  />
                ))}
              </div>
            </Field>
            <Field label="Notes" full>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Access notes, contact person, coverage details…" />
            </Field>
            {error && <div className="form-error full">{error}</div>}
            <div className="form-actions full">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save site'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

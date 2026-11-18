import { useState } from 'react'
import { api, useApi } from '../api.js'
import { PageHeader, Modal, Field, EmptyState, Spinner, useToast } from '../components.jsx'
import Icon from '../icons.jsx'
import { money, dateTime } from '../utils.js'

const BLANK = { name: '', phone: '', email: '', site_id: '', notes: '' }

export default function Customers() {
  const toast = useToast()
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { data, loading, reload } = useApi(`/customers?q=${encodeURIComponent(q)}`, [q])
  const { data: siteData } = useApi('/sites')

  if (!data && loading) return <Spinner label="Loading customers…" />

  const customers = data?.customers || []
  const sites = siteData?.sites || []
  const currency = data?.currency || 'KES'

  const openCreate = () => {
    setForm(BLANK)
    setError('')
    setModal({ mode: 'create' })
  }

  const openEdit = (customer) => {
    setForm({
      name: customer.name || '',
      phone: customer.phone || '',
      email: customer.email || '',
      site_id: customer.site_id || '',
      notes: customer.notes || '',
    })
    setError('')
    setModal({ mode: 'edit', customer })
  }

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = { ...form, site_id: form.site_id ? Number(form.site_id) : null }
      if (modal.mode === 'create') {
        await api('/customers', { method: 'POST', body })
        toast('Customer added.')
      } else {
        await api(`/customers/${modal.customer.id}`, { method: 'PATCH', body })
        toast('Customer updated.')
      }
      setModal(null)
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (customer) => {
    if (!window.confirm(`Delete ${customer.name}? Their payment history is kept.`)) return
    try {
      await api(`/customers/${customer.id}`, { method: 'DELETE' })
      toast('Customer deleted.')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Customers"
        sub="Everyone who has bought access, with lifetime spend."
        actions={<button className="btn primary" onClick={openCreate}><Icon name="plus" size={16} /> New customer</button>}
      />

      <div className="filter-bar">
        <div className="filter-controls">
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault()
              setQ(qInput)
            }}
          >
            <Icon name="search" size={15} />
            <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search name or phone" />
          </form>
        </div>
      </div>

      {customers.length === 0 ? (
        <EmptyState
          icon="customers"
          title={q ? 'No matching customers' : 'No customers yet'}
          text={q ? 'Try another name or number.' : 'Customers appear here automatically when they buy through the portal.'}
          action={!q ? <button className="btn primary" onClick={openCreate}>Add a customer</button> : null}
        />
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Site</th>
                  <th>Purchases</th>
                  <th>Total spend</th>
                  <th>Last purchase</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <div>{customer.name}</div>
                      {customer.email && <div className="tiny muted-cell">{customer.email}</div>}
                    </td>
                    <td>{customer.phone || '—'}</td>
                    <td className="muted-cell">{customer.site_name || '—'}</td>
                    <td className="num">{customer.purchases}</td>
                    <td className="num">{money(customer.spend, currency)}</td>
                    <td className="muted-cell">{customer.last_purchase ? dateTime(customer.last_purchase) : '—'}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn small ghost" onClick={() => openEdit(customer)}>Edit</button>
                        <button className="icon-btn danger-icon" onClick={() => remove(customer)} title="Delete customer">
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'create' ? 'New customer' : 'Edit customer'}
          subtitle="Phone numbers are normalised to the 254… format."
          onClose={() => setModal(null)}
        >
          <form className="form-grid" onSubmit={save}>
            <Field label="Name" full>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </Field>
            <Field label="Phone">
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0712 345 678" />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Home site">
              <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })}>
                <option value="">No site</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>{site.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Notes" full>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
            {error && <div className="form-error full">{error}</div>}
            <div className="form-actions full">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save customer'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

import { useState } from 'react'
import { api, useApi } from '../api.js'
import {
  PageHeader,
  Modal,
  Field,
  StatusPill,
  EmptyState,
  Spinner,
  useToast,
} from '../components.jsx'
import Icon from '../icons.jsx'
import { money, duration, dataSize, speed } from '../utils.js'

const BLANK = {
  name: '',
  price: 50,
  duration_minutes: 1440,
  data_mb: 1000,
  devices: 1,
  download_kbps: 4096,
  upload_kbps: 2048,
  hotspot_profile: 'default',
  active: true,
}

const PRESETS = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 1440 },
  { label: '1 week', minutes: 10080 },
  { label: '1 month', minutes: 43200 },
]

export default function Plans() {
  const { data, loading, reload } = useApi('/plans')
  const toast = useToast()
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!data && loading) return <Spinner label="Loading plans…" />
  const plans = data?.plans || []
  const currency = data?.currency || 'KES'

  const openCreate = () => {
    setForm(BLANK)
    setError('')
    setModal({ mode: 'create' })
  }

  const openEdit = (plan) => {
    setForm({
      name: plan.name,
      price: plan.price,
      duration_minutes: plan.duration_minutes,
      data_mb: plan.data_mb,
      devices: plan.devices,
      download_kbps: plan.download_kbps,
      upload_kbps: plan.upload_kbps,
      hotspot_profile: plan.hotspot_profile || 'default',
      active: Boolean(plan.active),
    })
    setError('')
    setModal({ mode: 'edit', plan })
  }

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = {
        ...form,
        price: Number(form.price),
        duration_minutes: Number(form.duration_minutes),
        data_mb: Number(form.data_mb),
        devices: Number(form.devices),
        download_kbps: Number(form.download_kbps),
        upload_kbps: Number(form.upload_kbps),
      }
      if (modal.mode === 'create') {
        await api('/plans', { method: 'POST', body })
        toast('Plan created.')
      } else {
        await api(`/plans/${modal.plan.id}`, { method: 'PATCH', body })
        toast('Plan updated.')
      }
      setModal(null)
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async (plan) => {
    try {
      await api(`/plans/${plan.id}`, { method: 'PATCH', body: { active: !plan.active } })
      toast(plan.active ? 'Plan hidden from the portal.' : 'Plan is live again.')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (plan) => {
    if (!window.confirm(`Delete or retire ${plan.name}?`)) return
    try {
      const result = await api(`/plans/${plan.id}`, { method: 'DELETE' })
      toast(result.deleted ? 'Plan deleted.' : 'Plan retired; existing vouchers still work.')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Plans"
        sub="What guests can buy. Plans map to hotspot profiles, time limits and speeds."
        actions={<button className="btn primary" onClick={openCreate}><Icon name="plus" size={16} /> New plan</button>}
      />

      {plans.length === 0 ? (
        <EmptyState
          icon="plans"
          title="No plans yet"
          text="Create a plan such as 1 Hour, 1 Day or 1 Week to start selling vouchers."
          action={<button className="btn primary" onClick={openCreate}>Create a plan</button>}
        />
      ) : (
        <div className="plan-grid">
          {plans.map((plan) => (
            <div className={`plan-tile ${plan.active ? '' : 'inactive'}`} key={plan.id}>
              <div className="plan-tile-head">
                <div>
                  <div className="plan-name">{plan.name}</div>
                  <div className="plan-price">{money(plan.price, plan.currency || currency)}</div>
                </div>
                <StatusPill status={plan.active ? 'active' : 'disabled'} label={plan.active ? 'Live' : 'Paused'} />
              </div>

              <div className="plan-specs">
                <div><Icon name="clock" size={14} /><span>{duration(plan.duration_minutes)}</span></div>
                <div><Icon name="signal" size={14} /><span>{dataSize(plan.data_mb)}</span></div>
                <div><Icon name="users" size={14} /><span>{plan.devices} device{plan.devices > 1 ? 's' : ''}</span></div>
                <div><Icon name="zap" size={14} /><span>{speed(plan.download_kbps)} down</span></div>
              </div>

              <div className="plan-foot">
                <div>
                  <span>Sold</span>
                  <strong>{plan.sold}</strong>
                </div>
                <div>
                  <span>Revenue</span>
                  <strong>{money(plan.revenue, plan.currency || currency)}</strong>
                </div>
                <div>
                  <span>In stock</span>
                  <strong>{plan.vouchers_unused}</strong>
                </div>
              </div>

              <div className="plan-actions">
                <button className="btn small" onClick={() => openEdit(plan)}>Edit</button>
                <button className="btn small ghost" onClick={() => toggleActive(plan)}>{plan.active ? 'Pause' : 'Activate'}</button>
                <button className="icon-btn danger-icon" onClick={() => remove(plan)} title="Delete plan">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal
          wide
          title={modal.mode === 'create' ? 'New plan' : 'Edit plan'}
          subtitle="Prices use the currency set in Settings."
          onClose={() => setModal(null)}
        >
          <form className="form-grid" onSubmit={save}>
            <Field label="Plan name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="1 Day" autoFocus />
            </Field>
            <Field label={`Price (${currency})`}>
              <input type="number" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </Field>
            <Field label="Duration (minutes)" full>
              <input type="number" min="1" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} />
              <div className="preset-row">
                {PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset.label}
                    className="chip-btn"
                    onClick={() => setForm({ ...form, duration_minutes: preset.minutes })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Data cap (MB, 0 = unlimited)">
              <input type="number" min="0" value={form.data_mb} onChange={(e) => setForm({ ...form, data_mb: e.target.value })} />
            </Field>
            <Field label="Devices">
              <input type="number" min="1" value={form.devices} onChange={(e) => setForm({ ...form, devices: e.target.value })} />
            </Field>
            <Field label="Download (kbps)">
              <input type="number" min="0" value={form.download_kbps} onChange={(e) => setForm({ ...form, download_kbps: e.target.value })} />
            </Field>
            <Field label="Upload (kbps)">
              <input type="number" min="0" value={form.upload_kbps} onChange={(e) => setForm({ ...form, upload_kbps: e.target.value })} />
            </Field>
            <Field label="Hotspot profile">
              <input value={form.hotspot_profile} onChange={(e) => setForm({ ...form, hotspot_profile: e.target.value })} />
            </Field>
            <label className="checkbox full">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              <span>Show this plan on the guest portal</span>
            </label>
            {error && <div className="form-error full">{error}</div>}
            <div className="form-actions full">
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

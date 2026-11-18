import { useEffect, useState } from 'react'
import { api, useApi } from '../api.js'
import {
  PageHeader,
  Field,
  StatusPill,
  Spinner,
  Toggle,
  CopyButton,
  useToast,
} from '../components.jsx'
import Icon from '../icons.jsx'

const CURRENCIES = ['KES', 'USD', 'NGN', 'GHS', 'ZAR', 'TZS', 'UGX']

export default function Settings() {
  const toast = useToast()
  const { data, loading, setData } = useApi('/settings')
  const [form, setForm] = useState({
    company_name: '',
    currency: 'KES',
    demo_payments: false,
    mpesa_env: 'sandbox',
    mpesa_shortcode: '',
    consumer_key: '',
    consumer_secret: '',
    passkey: '',
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!data) return
    setForm((current) => ({
      ...current,
      company_name: data.company_name || '',
      currency: data.currency || 'KES',
      demo_payments: Boolean(data.demo_payments),
      mpesa_env: data.mpesa?.env || 'sandbox',
      mpesa_shortcode: data.mpesa?.shortcode || '',
    }))
  }, [data])

  if (!data && loading) return <Spinner label="Loading settings…" />

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    try {
      const body = {
        company_name: form.company_name,
        currency: form.currency,
        demo_payments: form.demo_payments,
        mpesa_env: form.mpesa_env,
        mpesa_shortcode: form.mpesa_shortcode,
      }
      if (form.consumer_key) body.mpesa_consumer_key = form.consumer_key
      if (form.consumer_secret) body.mpesa_consumer_secret = form.consumer_secret
      if (form.passkey) body.mpesa_passkey = form.passkey
      const result = await api('/settings', { method: 'PATCH', body })
      setData(result)
      setForm((current) => ({ ...current, consumer_key: '', consumer_secret: '', passkey: '' }))
      toast('Settings saved.')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const clearMpesa = async () => {
    if (!window.confirm('Remove the saved M-Pesa credentials? STK push will stop working until you add them again.')) return
    try {
      const result = await api('/settings', { method: 'PATCH', body: { mpesa_clear: true } })
      setData(result)
      toast('M-Pesa credentials cleared.')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const loadDemo = async () => {
    try {
      await api('/demo/load', { method: 'POST' })
      toast('Demo workspace loaded.')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const mpesa = data?.mpesa || {}

  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Settings"
        sub="Business identity, M-Pesa and demo controls."
        actions={
          <button className="btn primary" type="submit" form="settings-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        }
      />

      <form id="settings-form" onSubmit={save} className="settings-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Business profile</div>
              <div className="card-sub">Shown on the console and receipts.</div>
            </div>
          </div>
          <div className="form-grid">
            <Field label="Business name" full>
              <input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
            </Field>
            <Field label="Currency">
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="divider" />
          <Toggle
            checked={form.demo_payments}
            onChange={(value) => setForm({ ...form, demo_payments: value })}
            label="Demo payments"
            description="Allows free test purchases from the guest portal. Turn this off before selling to real customers."
          />
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">M-Pesa Daraja</div>
              <div className="card-sub">STK push for portal purchases.</div>
            </div>
            <StatusPill status={mpesa.configured ? 'active' : 'disabled'} label={mpesa.configured ? 'Configured' : 'Not configured'} />
          </div>
          <div className="form-grid">
            <Field label="Environment">
              <select value={form.mpesa_env} onChange={(e) => setForm({ ...form, mpesa_env: e.target.value })}>
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </Field>
            <Field label="Shortcode (Paybill / Till)">
              <input value={form.mpesa_shortcode} onChange={(e) => setForm({ ...form, mpesa_shortcode: e.target.value })} placeholder="174379" />
            </Field>
            <Field label="Consumer key" full>
              <input
                value={form.consumer_key}
                onChange={(e) => setForm({ ...form, consumer_key: e.target.value })}
                placeholder={mpesa.has_consumer_key ? 'Saved — leave blank to keep' : 'From the Daraja portal'}
                autoComplete="off"
              />
            </Field>
            <Field label="Consumer secret" full>
              <input
                type="password"
                value={form.consumer_secret}
                onChange={(e) => setForm({ ...form, consumer_secret: e.target.value })}
                placeholder={mpesa.has_consumer_secret ? 'Saved — leave blank to keep' : ''}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Lipa na M-Pesa passkey" full>
              <input
                type="password"
                value={form.passkey}
                onChange={(e) => setForm({ ...form, passkey: e.target.value })}
                placeholder={mpesa.has_passkey ? 'Saved — leave blank to keep' : ''}
                autoComplete="new-password"
              />
            </Field>
          </div>
          {mpesa.callback_url ? (
            <div className="callback-box">
              <div>
                <span>Callback URL</span>
                <code>{mpesa.callback_url}</code>
              </div>
              <CopyButton value={mpesa.callback_url} className="btn small ghost" />
            </div>
          ) : (
            <div className="form-note">
              Add all credentials above to generate the callback URL. Make sure PUBLIC_URL in your .env is the public address of this server.
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn small danger" onClick={clearMpesa} disabled={!mpesa.has_consumer_key && !mpesa.has_consumer_secret}>
              Clear credentials
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Demo workspace</div>
              <div className="card-sub">Sample sites and sales for demonstrating the product.</div>
            </div>
          </div>
          <p className="body-text">
            Demo data can only be loaded into an empty workspace. It creates two simulated sites, four plans and three weeks of sales history,
            routed through virtual routers that generate live client traffic.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={loadDemo}>Load demo data</button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div className="card-title">About this deployment</div>
          </div>
          <div className="about-list">
            <div><span>Product</span><strong>CoryPulse 0.1.0</strong></div>
            <div><span>Build</span><strong>CoryTech</strong></div>
            <div><span>Database</span><strong>data/corypulse.db (SQLite)</strong></div>
            <div><span>Backup</span><strong>Copy the data folder nightly</strong></div>
          </div>
          <div className="form-note">
            Router passwords are encrypted at rest with a key in data/secret.key. Back up that file with the database, or set CREDENTIALS_KEY in your environment.
          </div>
        </section>
      </form>
    </>
  )
}

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useToast } from '../components.jsx'
import Icon from '../icons.jsx'

export default function Setup() {
  const { completeSetup } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [form, setForm] = useState({
    company: '',
    username: 'admin',
    password: '',
    confirm: '',
    currency: 'KES',
    demo: true,
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value
    setForm((f) => ({ ...f, [key]: value }))
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    if (form.username.trim().length < 3) return setError('Username must be at least 3 characters.')
    if (form.password.length < 8) return setError('Password must be at least 8 characters.')
    if (form.password !== form.confirm) return setError('Passwords do not match.')
    setBusy(true)
    try {
      await api('/setup', {
        method: 'POST',
        body: {
          username: form.username.trim(),
          password: form.password,
          company: form.company.trim(),
          currency: form.currency,
          demo: form.demo,
        },
      })
      await completeSetup()
      toast('Workspace created. Welcome to CoryPulse.')
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-orb" />
      <div className="auth-wrap">
        <div className="auth-brand">
          <div className="brand-mark">
            <Icon name="pulse" size={22} strokeWidth={2} />
          </div>
          <div>
            <div className="brand-name">CoryPulse</div>
            <div className="brand-tag">Wi-Fi business platform</div>
          </div>
        </div>

        <div className="auth-card">
          <div className="eyebrow">First run</div>
          <h1 className="auth-title">Set up your workspace</h1>
          <p className="auth-sub">Create the owner account for this installation. You can connect MikroTik routers and M-Pesa afterwards.</p>

          <form onSubmit={submit} className="auth-form">
            <label className="field">
              <span>Business name</span>
              <input value={form.company} onChange={set('company')} placeholder="e.g. Riverside Wi-Fi" autoFocus />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>Username</span>
                <input value={form.username} onChange={set('username')} autoComplete="username" />
              </label>
              <label className="field">
                <span>Currency</span>
                <select value={form.currency} onChange={set('currency')}>
                  {['KES', 'USD', 'NGN', 'GHS', 'ZAR', 'TZS', 'UGX'].map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
              </label>
              <label className="field">
                <span>Confirm password</span>
                <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
              </label>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={form.demo} onChange={set('demo')} />
              <span>Load demo workspace with sample sites, plans and sales</span>
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="btn primary block" disabled={busy}>
              {busy ? 'Creating workspace…' : 'Create workspace'}
              {!busy && <Icon name="chevron" size={16} />}
            </button>
          </form>
        </div>
        <p className="auth-foot">Self-hosted. Your data stays on this server.</p>
      </div>
    </div>
  )
}

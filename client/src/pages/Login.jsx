import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import Icon from '../icons.jsx'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await login(form.username.trim(), form.password)
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
      <div className="auth-wrap narrow">
        <div className="auth-brand">
          <div className="brand-mark">
            <Icon name="pulse" size={22} strokeWidth={2} />
          </div>
          <div>
            <div className="brand-name">CoryPulse</div>
            <div className="brand-tag">Operator console</div>
          </div>
        </div>

        <div className="auth-card">
          <div className="eyebrow">Welcome back</div>
          <h1 className="auth-title">Sign in</h1>
          <p className="auth-sub">Manage your sites, vouchers and sales.</p>
          <form onSubmit={submit} className="auth-form">
            <label className="field">
              <span>Username</span>
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                autoComplete="username"
                autoFocus
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="current-password"
              />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="btn primary block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              {!busy && <Icon name="chevron" size={16} />}
            </button>
          </form>
        </div>
        <p className="auth-foot">CoryPulse · Wi-Fi business management</p>
      </div>
    </div>
  )
}

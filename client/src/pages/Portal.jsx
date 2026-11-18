import { useEffect, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { api, useApi } from '../api.js'
import { useToast } from '../components.jsx'
import Icon from '../icons.jsx'
import { money, duration, dataSize, remaining, dateTime, copyText } from '../utils.js'

export default function Portal() {
  const { siteId } = useParams()
  const location = useLocation()
  const toast = useToast()
  const { data: info, loading } = useApi(`/portal/${siteId}/info`)
  const started = useRef(false)

  const [step, setStep] = useState('plans')
  const [plan, setPlan] = useState(null)
  const [details, setDetails] = useState({ name: '', phone: '' })
  const [order, setOrder] = useState(null)
  const [pushError, setPushError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loginCode, setLoginCode] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [connected, setConnected] = useState(null)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const params = new URLSearchParams(location.search)
    const autoCode = params.get('voucher')
    if (autoCode) {
      setLoginCode(autoCode.toUpperCase())
      setLoginBusy(true)
      api(`/portal/${siteId}/login`, { method: 'POST', body: { code: autoCode } })
        .then((result) => {
          setConnected(result)
          toast('Voucher accepted. You are online.')
          window.history.replaceState({}, '', `/portal/${siteId}`)
        })
        .catch((err) => setLoginError(err.message))
        .finally(() => setLoginBusy(false))
      return
    }
    const ref = params.get('order')
    if (ref) {
      api(`/portal/orders/${ref}`)
        .then((data) => {
          setOrder(data)
          setStep(data.status === 'paid' ? 'done' : 'pay')
        })
        .catch((err) => setError(err.message))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (step !== 'pay' || !order?.ref || !['pending', 'pending_demo'].includes(order.status)) return undefined
    const timer = setInterval(async () => {
      try {
        const fresh = await api(`/portal/orders/${order.ref}`)
        setOrder(fresh)
        if (fresh.status === 'paid') setStep('done')
        if (fresh.status === 'failed') setError('The payment was not completed. You can try again.')
      } catch {
        // keep polling
      }
    }, 3500)
    return () => clearInterval(timer)
  }, [step, order?.ref, order?.status])

  if (!info) {
    return (
      <div className="portal-page">
        <div className="portal-loading">
          <span className="spinner" />
          <span>{loading ? 'Loading hotspot…' : 'This hotspot is not available.'}</span>
        </div>
      </div>
    )
  }

  const { site, plans, demo_payments: demo } = info
  const accent = site.color || '#22d3a7'

  const choosePlan = (chosen) => {
    setPlan(chosen)
    setError('')
    setStep('details')
  }

  const createOrder = async (event) => {
    event.preventDefault()
    if (!plan) return
    setError('')
    setBusy(true)
    try {
      const result = await api(`/portal/${siteId}/orders`, {
        method: 'POST',
        body: { plan_id: plan.id, name: details.name.trim(), phone: details.phone.trim() },
      })
      setOrder({ ...result, plan: plan.name })
      setPushError(result.push_error || '')
      setStep('pay')
      window.history.replaceState({}, '', `/portal/${siteId}?order=${result.ref}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const payDemo = async () => {
    if (!order) return
    setBusy(true)
    setError('')
    try {
      const result = await api(`/portal/orders/${order.ref}/simulate-pay`, { method: 'POST' })
      setOrder({ ...order, status: 'paid', voucher: result.voucher })
      setStep('done')
      toast('Demo payment complete.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const retryPush = async () => {
    if (!order) return
    setBusy(true)
    setPushError('')
    try {
      await api(`/portal/orders/${order.ref}/pay`, { method: 'POST' })
      toast('Check your phone for the M-Pesa prompt.')
    } catch (err) {
      setPushError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setStep('plans')
    setPlan(null)
    setOrder(null)
    setPushError('')
    setError('')
    setConnected(null)
    setDetails({ name: '', phone: '' })
    window.history.replaceState({}, '', `/portal/${siteId}`)
  }

  const submitLogin = async (event) => {
    event.preventDefault()
    setLoginError('')
    setLoginBusy(true)
    try {
      const result = await api(`/portal/${siteId}/login`, { method: 'POST', body: { code: loginCode } })
      setConnected(result)
      toast('Voucher activated. You are online.')
    } catch (err) {
      setLoginError(err.message)
    } finally {
      setLoginBusy(false)
    }
  }

  const activatePurchased = async () => {
    if (!order?.voucher?.code) return
    setLoginBusy(true)
    try {
      const result = await api(`/portal/${siteId}/login`, { method: 'POST', body: { code: order.voucher.code } })
      setConnected(result)
      toast('Voucher activated. You are online.')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setLoginBusy(false)
    }
  }

  const copy = async (text) => {
    const ok = await copyText(text)
    toast(ok ? 'Copied.' : 'Copy failed.', ok ? 'success' : 'error')
  }

  return (
    <div className="portal-page" style={{ '--accent': accent }}>
      <div className="portal-glow" />
      <div className="portal-shell">
        <header className="portal-header">
          <div className="portal-brand">
            <span className="brand-mark small">
              <Icon name="pulse" size={18} strokeWidth={2} />
            </span>
            <span>Powered by CoryPulse</span>
          </div>
          <a className="link small-link" href="/login">Operator login</a>
        </header>

        {demo && (
          <div className="demo-banner">
            <Icon name="alert" size={16} />
            Demo mode is on. Plan purchases are simulated and no money is taken.
          </div>
        )}

        <div className="portal-grid">
          <section className="portal-side">
            <div className="eyebrow">Guest Wi-Fi</div>
            <h1 className="portal-title">Get online at {site.name}</h1>
            <p className="portal-sub">{site.address || 'Fast, secure Wi-Fi for guests.'}</p>

            <div className="ssid-card">
              <div className="ssid-icon"><Icon name="wifi" size={20} /></div>
              <div>
                <span>Network name</span>
                <strong>{site.ssid || 'Ask staff for the Wi-Fi name'}</strong>
              </div>
              <div className="signal-bars" aria-hidden="true"><i /><i /><i /><i /></div>
            </div>

            <div className="pulse-art" aria-hidden="true">
              <span /><span /><span /><span /><span />
            </div>

            <div className="login-box">
              <div className="card-title">Already have a voucher?</div>
              <p className="card-sub">Enter the code from your receipt or SMS.</p>
              <form onSubmit={submitLogin}>
                <input
                  value={loginCode}
                  onChange={(e) => setLoginCode(e.target.value.toUpperCase())}
                  placeholder="CP-XXXX-XXXX"
                  autoComplete="off"
                />
                <button className="btn primary" disabled={loginBusy || !loginCode.trim()}>
                  {loginBusy ? 'Activating…' : 'Activate'}
                </button>
              </form>
              {loginError && <div className="form-error">{loginError}</div>}
            </div>
          </section>

          <section className="portal-flow">
            {connected ? (
              <div className="connect-panel">
                <div className="success-ring"><Icon name="check" size={26} /></div>
                <h2>You're connected</h2>
                <p className="card-sub">Use these details on the Wi-Fi login page if your phone asks again.</p>
                <div className="voucher-code">{connected.code}</div>
                <div className="cred-list">
                  <div><span>Network</span><strong>{connected.ssid || site.ssid}</strong></div>
                  <div><span>Username</span><strong>{connected.hotspot_username || connected.code}</strong></div>
                  <div><span>Password</span><strong>{connected.hotspot_password || connected.code}</strong></div>
                  <div><span>Valid until</span><strong>{dateTime(connected.expires_at)}</strong></div>
                  <div><span>Time left</span><strong>{remaining(connected.expires_at)}</strong></div>
                </div>
                {connected.provisionError && (
                  <div className="warn-banner">
                    Voucher activated, but the router could not be updated. Show this code to the attendant.
                  </div>
                )}
                <div className="portal-actions">
                  <button className="btn" onClick={() => copy(connected.code)}><Icon name="copy" size={15} /> Copy code</button>
                  <button className="btn primary" onClick={reset}>Done</button>
                </div>
              </div>
            ) : step === 'plans' && (
              <>
                <div className="flow-head">
                  <div>
                    <div className="card-title">Choose a plan</div>
                    <div className="card-sub">Pick the time and data that suits you.</div>
                  </div>
                  <span className="step-badge">1 / 3</span>
                </div>
                <div className="buy-plans">
                  {plans.map((option) => (
                    <button key={option.id} className="buy-plan" onClick={() => choosePlan(option)}>
                      <div className="buy-plan-top">
                        <span className="buy-name">{option.name}</span>
                        <span className="buy-price">{money(option.price, option.currency)}</span>
                      </div>
                      <div className="buy-meta">
                        <span><Icon name="clock" size={13} /> {duration(option.duration_minutes)}</span>
                        <span><Icon name="signal" size={13} /> {dataSize(option.data_mb)}</span>
                        <span><Icon name="users" size={13} /> {option.devices} device{option.devices > 1 ? 's' : ''}</span>
                      </div>
                      <span className="buy-cta">Select <Icon name="chevron" size={13} /></span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {!connected && step === 'details' && plan && (
              <>
                <div className="flow-head">
                  <div>
                    <div className="card-title">Your details</div>
                    <div className="card-sub">Used only for your receipt.</div>
                  </div>
                  <span className="step-badge">2 / 3</span>
                </div>
                <div className="selected-plan">
                  <div>
                    <span>{plan.name}</span>
                    <strong>{money(plan.price, plan.currency)}</strong>
                  </div>
                  <button className="link" onClick={() => setStep('plans')}>Change</button>
                </div>
                <form className="portal-form" onSubmit={createOrder}>
                  <label className="field">
                    <span>Full name</span>
                    <input value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} placeholder="e.g. Jane Wanjiru" autoFocus />
                  </label>
                  <label className="field">
                    <span>M-Pesa number</span>
                    <input value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} placeholder="0712 345 678" inputMode="tel" />
                  </label>
                  {error && <div className="form-error">{error}</div>}
                  <button className="btn primary block" disabled={busy}>
                    {busy ? 'Creating order…' : `Continue · ${money(plan.price, plan.currency)}`}
                  </button>
                  <p className="fine-print">
                    {info.mpesa_configured ? 'You will receive an M-Pesa prompt on this number.' : demo ? 'Demo mode: no real payment will be requested.' : 'You will receive a payment reference to show the attendant.'}
                  </p>
                </form>
              </>
            )}

            {!connected && step === 'pay' && order && (
              <>
                <div className="flow-head">
                  <div>
                    <div className="card-title">Complete payment</div>
                    <div className="card-sub">Order {order.ref}</div>
                  </div>
                  <span className="step-badge">3 / 3</span>
                </div>

                <div className="order-summary">
                  <div><span>Plan</span><strong>{order.plan || plan?.name}</strong></div>
                  <div><span>Amount</span><strong>{money(order.amount, order.currency)}</strong></div>
                  <div><span>Status</span><strong>{order.status === 'paid' ? 'Paid' : order.status === 'failed' ? 'Failed' : 'Awaiting payment'}</strong></div>
                </div>

                {order.status === 'failed' && (
                  <div className="form-error">This payment did not go through. Start again to retry.</div>
                )}

                {pushError && (
                  <div className="form-error">
                    {pushError}
                    <button type="button" className="link" onClick={retryPush} disabled={busy}>Retry prompt</button>
                  </div>
                )}

                {order.method === 'demo' && (
                  <>
                    <div className="pay-state">
                      <span className="pulse-ring" />
                      <div>
                        <strong>Demo payment</strong>
                        <p>No money moves. Finish the demo to receive your voucher.</p>
                      </div>
                    </div>
                    <button className="btn primary block" onClick={payDemo} disabled={busy}>
                      {busy ? 'Completing…' : `Complete demo payment · ${money(order.amount, order.currency)}`}
                    </button>
                  </>
                )}

                {order.method === 'mpesa' && (
                  <div className="pay-state">
                    <span className="pulse-ring" />
                    <div>
                      <strong>Check your phone</strong>
                      <p>Enter your M-Pesa PIN to pay {money(order.amount, order.currency)}. This page updates automatically.</p>
                    </div>
                  </div>
                )}

                {!['demo', 'mpesa'].includes(order.method) && (
                  <div className="pay-state manual">
                    <Icon name="clock" size={20} />
                    <div>
                      <strong>Pay at the counter</strong>
                      <p>Show reference <b>{order.ref}</b> to the attendant. Your voucher appears here once the payment is confirmed.</p>
                    </div>
                  </div>
                )}

                <div className="portal-actions">
                  <button className="btn" onClick={reset}>Cancel</button>
                </div>
              </>
            )}

            {!connected && step === 'done' && order && (
              <>
                <div className="success-head">
                  <div className="success-ring"><Icon name="check" size={24} /></div>
                  <div>
                    <div className="card-title">Payment received</div>
                    <div className="card-sub">Your voucher code is ready.</div>
                  </div>
                </div>
                <div className="voucher-code">{order.voucher?.code}</div>
                <div className="connect-steps">
                  <div><span>1</span><p>Join <b>{site.ssid}</b> from your Wi-Fi settings.</p></div>
                  <div><span>2</span><p>When the login page opens, enter the code above as both username and password.</p></div>
                  <div><span>3</span><p>Or activate it here to see your remaining time.</p></div>
                </div>
                <div className="portal-actions">
                  <button className="btn" onClick={() => copy(order.voucher?.code || '')}>
                    <Icon name="copy" size={15} /> Copy code
                  </button>
                  <button className="btn primary" onClick={activatePurchased} disabled={loginBusy}>
                    {loginBusy ? 'Activating…' : 'Activate now'}
                  </button>
                </div>
                <button className="link center-link" onClick={reset}>Buy another plan</button>
              </>
            )}
          </section>
        </div>

        <footer className="portal-foot">
          <span>Secure guest access</span>
          <span>·</span>
          <span>Need help? Ask the attendant at {site.name}</span>
        </footer>
      </div>
    </div>
  )
}

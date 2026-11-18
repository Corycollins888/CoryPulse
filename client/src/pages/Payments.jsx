import { useState } from 'react'
import { api, useApi, useDebouncedReload } from '../api.js'
import { PageHeader, StatusPill, EmptyState, Spinner, useToast } from '../components.jsx'
import Icon from '../icons.jsx'
import { money, dateTime, statusLabel } from '../utils.js'

const METHOD_TONE = { mpesa: 'green', cash: 'amber', demo: 'violet', bank: 'blue', manual: 'grey' }

export default function Payments() {
  const toast = useToast()
  const [status, setStatus] = useState('all')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState(null)
  const { data, loading, reload } = useApi(`/payments?status=${status === 'all' ? '' : status}&q=${encodeURIComponent(q)}`, [status, q])
  useDebouncedReload(reload)

  if (!data && loading) return <Spinner label="Loading payments…" />

  const items = data?.items || []
  const currency = data?.currency || 'KES'
  const chips = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'paid', label: 'Paid' },
    { key: 'refunded', label: 'Refunded' },
    { key: 'failed', label: 'Failed' },
  ]

  const markPaid = async (payment) => {
    if (!window.confirm(`Mark ${payment.ref} (${money(payment.amount, payment.currency)}) as paid in cash?`)) return
    setBusyId(payment.id)
    try {
      const result = await api(`/payments/${payment.id}/mark-paid`, { method: 'POST', body: { method: 'cash' } })
      toast(`Payment confirmed. Voucher ${result.voucher?.code || ''} issued.`)
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const refund = async (payment) => {
    if (!window.confirm(`Refund ${payment.ref}? Any unused voucher will be disabled.`)) return
    setBusyId(payment.id)
    try {
      await api(`/payments/${payment.id}/refund`, { method: 'POST' })
      toast('Refund recorded.')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const retryPush = async (payment) => {
    setBusyId(payment.id)
    try {
      const result = await api(`/payments/${payment.id}/retry-push`, { method: 'POST' })
      toast(result.message)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Payments"
        sub="Every voucher sale, pending order and refund in one ledger."
        actions={<a className="btn" href="/api/reports/export.csv"><Icon name="reports" size={16} /> Export CSV</a>}
      />

      <div className="filter-bar">
        <div className="chips">
          {chips.map((chip) => (
            <button key={chip.key} className={`chip ${status === chip.key ? 'active' : ''}`} onClick={() => setStatus(chip.key)}>
              {chip.label}
            </button>
          ))}
        </div>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault()
            setQ(qInput)
          }}
        >
          <Icon name="search" size={15} />
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Ref, name or phone" />
        </form>
      </div>

      {items.length === 0 ? (
        <EmptyState icon="payments" title="No payments here" text="Voucher orders from the guest portal and manual sales appear in this ledger." />
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Plan / site</th>
                  <th>Method</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Voucher</th>
                  <th>When</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((payment) => (
                  <tr key={payment.id}>
                    <td><span className="code">{payment.ref}</span></td>
                    <td>
                      <div>{payment.customer_name || 'Walk-in'}</div>
                      {payment.phone && <div className="tiny muted-cell">{payment.phone}</div>}
                    </td>
                    <td>
                      <div>{payment.plan_name || '—'}</div>
                      <div className="tiny muted-cell">{payment.site_name || '—'}</div>
                    </td>
                    <td><span className={`pill ${METHOD_TONE[payment.method] || 'grey'}`}>{statusLabel(payment.method)}</span></td>
                    <td className="num">{money(payment.amount, payment.currency || currency)}</td>
                    <td><StatusPill status={payment.status} /></td>
                    <td>{payment.voucher_code ? <span className="code">{payment.voucher_code}</span> : <span className="muted-cell">—</span>}</td>
                    <td className="muted-cell">{dateTime(payment.paid_at || payment.created_at)}</td>
                    <td>
                      <div className="row-actions">
                        {payment.status === 'pending' && (
                          <button className="btn small" disabled={busyId === payment.id} onClick={() => markPaid(payment)}>
                            Mark paid
                          </button>
                        )}
                        {payment.status === 'pending' && payment.method === 'mpesa' && (
                          <button className="btn small ghost" disabled={busyId === payment.id} onClick={() => retryPush(payment)}>
                            Retry push
                          </button>
                        )}
                        {payment.status === 'paid' && (
                          <button className="btn small ghost" disabled={busyId === payment.id} onClick={() => refund(payment)}>
                            Refund
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

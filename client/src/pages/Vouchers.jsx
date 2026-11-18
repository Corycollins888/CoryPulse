import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api, useApi, useDebouncedReload } from '../api.js'
import {
  PageHeader,
  Modal,
  Field,
  StatusPill,
  EmptyState,
  Spinner,
  CopyButton,
  useToast,
} from '../components.jsx'
import Icon from '../icons.jsx'
import PrintSheet from '../PrintSheet.jsx'
import { money, dateTime, copyText } from '../utils.js'

export default function Vouchers() {
  const location = useLocation()
  const toast = useToast()
  const [status, setStatus] = useState('all')
  const [siteId, setSiteId] = useState('')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [genOpen, setGenOpen] = useState(false)
  const [result, setResult] = useState(null)
  const [genForm, setGenForm] = useState({ plan_id: '', site_id: '', count: 20, prefix: 'CP' })
  const [busy, setBusy] = useState(false)
  const [actionId, setActionId] = useState(null)
  const [error, setError] = useState('')
  const [sheet, setSheet] = useState(null)
  const [sheetBusy, setSheetBusy] = useState(false)
  const limit = 50

  const { data, loading, reload } = useApi(
    `/vouchers?status=${status === 'all' ? '' : status}&site_id=${siteId}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    [status, siteId, q, offset]
  )
  const { data: siteData } = useApi('/sites')
  const { data: planData } = useApi('/plans')
  useDebouncedReload(reload)

  const sites = siteData?.sites || []
  const plans = planData?.plans || []
  const currency = data?.currency || 'KES'
  const counts = data?.counts || { unused: 0, active: 0, expired: 0, disabled: 0 }
  const totalAll = counts.unused + counts.active + counts.expired + counts.disabled

  useEffect(() => {
    if (location.state?.generate) {
      openGenerate()
      window.history.replaceState({}, '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openGenerate = () => {
    setGenForm({
      plan_id: plans.find((p) => p.active)?.id || plans[0]?.id || '',
      site_id: sites[0]?.id || '',
      count: 20,
      prefix: 'CP',
    })
    setResult(null)
    setError('')
    setGenOpen(true)
  }

  const generate = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await api('/vouchers/generate', {
        method: 'POST',
        body: {
          plan_id: Number(genForm.plan_id),
          site_id: Number(genForm.site_id),
          count: Number(genForm.count),
          prefix: genForm.prefix,
        },
      })
      setResult(res)
      reload()
      toast(`${res.count} vouchers generated.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const activate = async (voucher) => {
    setActionId(voucher.id)
    try {
      const res = await api(`/vouchers/${voucher.id}/activate`, { method: 'POST' })
      toast(`${res.code} activated${res.provisionError ? ' (router sync failed)' : ''}.`)
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setActionId(null)
    }
  }

  const disable = async (voucher) => {
    if (!window.confirm(`Disable ${voucher.code}? The guest will be removed from the router.`)) return
    setActionId(voucher.id)
    try {
      await api(`/vouchers/${voucher.id}/disable`, { method: 'POST' })
      toast(`${voucher.code} disabled.`)
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setActionId(null)
    }
  }

  const openSheet = async (targetSite = siteId) => {
    setSheetBusy(true)
    try {
      const res = await api(`/vouchers/sheet?site_id=${targetSite || ''}&limit=24`)
      if (!res.items.length) {
        toast('No unused vouchers for this selection. Generate stock first.', 'error')
        return
      }
      setSheet(res)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setSheetBusy(false)
    }
  }

  const chips = [
    { key: 'all', label: 'All', count: totalAll },
    { key: 'unused', label: 'In stock', count: counts.unused },
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'expired', label: 'Expired', count: counts.expired },
    { key: 'disabled', label: 'Disabled', count: counts.disabled },
  ]

  const items = data?.items || []
  const exportHref = `/api/vouchers/export.csv?status=${status === 'all' ? '' : status}&site_id=${siteId}`

  if (!data && loading) return <Spinner label="Loading vouchers…" />

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Vouchers"
        sub="Sell printed stock, activate codes, and control guest access."
        actions={
          <>
            <a className="btn" href={exportHref}>Export CSV</a>
            <button className="btn" onClick={() => openSheet()} disabled={sheetBusy} title="Print unused vouchers as cards with QR codes">
              <Icon name="printer" size={16} /> {sheetBusy ? 'Preparing…' : 'Print cards'}
            </button>
            <button className="btn primary" onClick={openGenerate}>
              <Icon name="plus" size={16} /> Generate vouchers
            </button>
          </>
        }
      />

      <div className="filter-bar">
        <div className="chips">
          {chips.map((chip) => (
            <button
              key={chip.key}
              className={`chip ${status === chip.key ? 'active' : ''}`}
              onClick={() => {
                setStatus(chip.key)
                setOffset(0)
              }}
            >
              {chip.label}
              <span>{chip.count}</span>
            </button>
          ))}
        </div>
        <div className="filter-controls">
          <select
            value={siteId}
            onChange={(e) => {
              setSiteId(e.target.value)
              setOffset(0)
            }}
          >
            <option value="">All sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>{site.name}</option>
            ))}
          </select>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault()
              setQ(qInput)
              setOffset(0)
            }}
          >
            <Icon name="search" size={15} />
            <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search code" />
          </form>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="vouchers"
          title={q || status !== 'all' ? 'No vouchers match this view' : 'No vouchers yet'}
          text={q || status !== 'all' ? 'Try a different filter or search term.' : 'Generate a batch to start selling access.'}
          action={!q && status === 'all' ? <button className="btn primary" onClick={openGenerate}>Generate vouchers</button> : null}
        />
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Plan</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th>Price</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((voucher) => (
                  <tr key={voucher.id}>
                    <td>
                      <div className="code-cell">
                        <span className="code">{voucher.code}</span>
                        <CopyButton value={voucher.code} label="" className="icon-btn" />
                      </div>
                    </td>
                    <td>{voucher.plan_name}</td>
                    <td className="muted-cell">{voucher.site_name || '—'}</td>
                    <td><StatusPill status={voucher.status} /></td>
                    <td className="num">{money(voucher.price_paid, currency)}</td>
                    <td className="muted-cell">{dateTime(voucher.created_at)}</td>
                    <td className="muted-cell">{voucher.expires_at ? dateTime(voucher.expires_at) : '—'}</td>
                    <td>
                      <div className="row-actions">
                        {voucher.status === 'unused' && (
                          <button className="btn small" disabled={actionId === voucher.id} onClick={() => activate(voucher)}>
                            Activate
                          </button>
                        )}
                        {['unused', 'active'].includes(voucher.status) && (
                          <button className="btn small ghost" disabled={actionId === voucher.id} onClick={() => disable(voucher)}>
                            Disable
                          </button>
                        )}
                        {voucher.customer_name && <span className="muted-cell tiny">{voucher.customer_name}</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-foot">
            <span>
              Showing {offset + 1}–{Math.min(offset + limit, data.total)} of {data.total}
            </span>
            <div className="actions">
              <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
              <button className="btn small" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>Next</button>
            </div>
          </div>
        </div>
      )}

      {genOpen && (
        <Modal
          wide
          title={result ? 'Vouchers ready' : 'Generate vouchers'}
          subtitle={result ? 'Share or print these codes. Each code is also the hotspot username and password.' : 'Codes are created as stock and activate when a guest uses one.'}
          onClose={() => setGenOpen(false)}
        >
          {result ? (
            <div>
              <div className="generated-summary">
                <div>
                  <span>Generated</span>
                  <strong>{result.count}</strong>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    const ok = await copyText(result.codes.join('\n'))
                    toast(ok ? 'All codes copied.' : 'Copy failed; select the codes manually.', ok ? 'success' : 'error')
                  }}
                >
                  <Icon name="copy" size={15} /> Copy all
                </button>
              </div>
              <div className="code-grid">
                {result.codes.map((code) => (
                  <span className="code" key={code}>{code}</span>
                ))}
              </div>
              <div className="form-actions">
                <button className="btn" onClick={() => setResult(null)}>Generate more</button>
                <button
                  className="btn"
                  onClick={() => {
                    const target = genForm.site_id
                    setGenOpen(false)
                    setResult(null)
                    openSheet(target)
                  }}
                >
                  <Icon name="printer" size={15} /> Print cards
                </button>
                <button className="btn primary" onClick={() => setGenOpen(false)}>Done</button>
              </div>
            </div>
          ) : (
            <form className="form-grid" onSubmit={generate}>
              <Field label="Plan">
                <select value={genForm.plan_id} onChange={(e) => setGenForm({ ...genForm, plan_id: e.target.value })}>
                  <option value="">Choose a plan</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} · {money(plan.price, plan.currency || currency)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Site">
                <select value={genForm.site_id} onChange={(e) => setGenForm({ ...genForm, site_id: e.target.value })}>
                  <option value="">Choose a site</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>{site.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="How many (1–200)">
                <input type="number" min="1" max="200" value={genForm.count} onChange={(e) => setGenForm({ ...genForm, count: e.target.value })} />
              </Field>
              <Field label="Code prefix">
                <input value={genForm.prefix} maxLength={4} onChange={(e) => setGenForm({ ...genForm, prefix: e.target.value.toUpperCase() })} />
              </Field>
              <div className="form-note full">
                Vouchers are created for the first router at the selected site. If no router is attached yet, they stay in stock until one is added.
              </div>
              {error && <div className="form-error full">{error}</div>}
              <div className="form-actions full">
                <button type="button" className="btn" onClick={() => setGenOpen(false)}>Cancel</button>
                <button className="btn primary" disabled={busy || !genForm.plan_id || !genForm.site_id}>
                  {busy ? 'Generating…' : `Generate ${genForm.count || 0}`}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {sheet && <PrintSheet sheet={sheet} onClose={() => setSheet(null)} />}
    </>
  )
}

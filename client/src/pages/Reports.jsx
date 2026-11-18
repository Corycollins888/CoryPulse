import { useState } from 'react'
import { useApi } from '../api.js'
import { PageHeader, Bars, EmptyState, Spinner } from '../components.jsx'
import Icon from '../icons.jsx'
import { money, num, statusLabel } from '../utils.js'

const RANGES = [7, 14, 30, 90]

export default function Reports() {
  const [days, setDays] = useState(14)
  const { data, loading } = useApi(`/reports/overview?days=${days}`, [days])

  if (!data && loading) return <Spinner label="Crunching numbers…" />
  if (!data) return <EmptyState icon="reports" title="No report data" text="Reports appear once payments are recorded." />

  const { totals, series, by_site: bySite, top_plans: topPlans, by_method: byMethod, currency } = data
  const maxSite = Math.max(...bySite.map((site) => site.revenue), 1)

  return (
    <>
      <PageHeader
        eyebrow="Insight"
        title="Reports"
        sub={`Paid sales over the last ${days} days · ${statusLabel('paid')} payments only`}
        actions={
          <>
            <div className="segmented">
              {RANGES.map((range) => (
                <button key={range} className={days === range ? 'active' : ''} onClick={() => setDays(range)}>
                  {range}d
                </button>
              ))}
            </div>
            <a className="btn" href="/api/reports/export.csv">
              <Icon name="reports" size={15} /> Export CSV
            </a>
          </>
        }
      />

      <div className="mini-grid">
        <div className="mini">
          <span>Revenue</span>
          <strong>{money(totals.revenue, currency)}</strong>
        </div>
        <div className="mini">
          <span>Sales</span>
          <strong>{num(totals.sales)}</strong>
        </div>
        <div className="mini">
          <span>Average sale</span>
          <strong>{money(totals.average_sale, currency)}</strong>
        </div>
        <div className="mini">
          <span>Active vouchers</span>
          <strong>{num(totals.active_vouchers)}</strong>
        </div>
        <div className="mini">
          <span>Stock remaining</span>
          <strong>{num(totals.unused_vouchers)}</strong>
        </div>
        <div className="mini">
          <span>Customers</span>
          <strong>{num(totals.customers)}</strong>
        </div>
      </div>

      <section className="card spaced">
        <div className="card-head">
          <div>
            <div className="card-title">Revenue trend</div>
            <div className="card-sub">Daily paid revenue</div>
          </div>
        </div>
        <Bars data={series} valueKey="revenue" labelKey="day" height={240} format={(value) => money(value, currency)} />
      </section>

      <div className="split spaced">
        <section className="card">
          <div className="card-head">
            <div className="card-title">Revenue by site</div>
          </div>
          {bySite.length === 0 ? (
            <EmptyState icon="sites" title="No sites yet" />
          ) : (
            <div className="rank-list">
              {bySite.map((site) => (
                <div className="rank-row" key={site.id || site.name}>
                  <div className="rank-label">
                    <span className="rank-dot" style={{ background: site.color || '#22d3a7' }} />
                    {site.name}
                  </div>
                  <div className="rank-bar">
                    <i style={{ width: `${Math.max(2, (site.revenue / maxSite) * 100)}%`, background: site.color || '#22d3a7' }} />
                  </div>
                  <div className="rank-value">
                    <strong>{money(site.revenue, currency)}</strong>
                    <span>{site.sales} sales</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <div className="card-title">Payment methods</div>
          </div>
          {byMethod.length === 0 ? (
            <EmptyState icon="payments" title="No payments in range" />
          ) : (
            <div className="method-list">
              {byMethod.map((method) => (
                <div className="method-row" key={method.method}>
                  <span className={`pill ${method.method === 'mpesa' ? 'green' : method.method === 'cash' ? 'amber' : 'violet'}`}>
                    {statusLabel(method.method)}
                  </span>
                  <span className="method-count">{method.sales} sales</span>
                  <strong>{money(method.revenue, currency)}</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card spaced">
        <div className="card-head">
          <div className="card-title">Top plans</div>
        </div>
        {topPlans.length === 0 ? (
          <EmptyState icon="plans" title="No sales in range" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Sales</th>
                  <th>Revenue</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {topPlans.map((plan) => (
                  <tr key={plan.name}>
                    <td>{plan.name}</td>
                    <td className="num">{plan.sales}</td>
                    <td className="num">{money(plan.revenue, currency)}</td>
                    <td>{totals.revenue ? `${Math.round((plan.revenue / totals.revenue) * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

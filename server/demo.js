import crypto from 'node:crypto'
import { db, logEvent, nowIso, setSetting } from './db.js'
import { createVoucher } from './vouchers.js'

const CUSTOMERS = [
  ['Amina Otieno', '254712345678'],
  ['Brian Kimani', '254723456789'],
  ['Faith Wanjiku', '254734567890'],
  ['Kevin Mwangi', '254745678901'],
  ['Grace Achieng', '254756789012'],
  ['Samir Patel', '254767890123'],
  ['Lucy Njeri', '254778901234'],
  ['Daniel Omondi', '254789012345'],
]

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick(list) {
  return list[rand(0, list.length - 1)]
}

function ref() {
  return 'PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase()
}

export async function seedDemo() {
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM sites').get()
  if (existing.n > 0) return { seeded: false }

  const now = Date.now()
  const siteIds = []
  const planIds = []
  const customerIds = []

  const run = db.transaction(async () => {
    const insertSite = db.prepare(
      'INSERT INTO sites (name, ssid, address, timezone, color, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    siteIds.push(
      (await insertSite.run('Riverside Cafe', 'Riverside-Guest', 'Kilimani, Nairobi', 'Africa/Nairobi', '#22d3a7', 'Main branch, 2 APs', nowIso())).lastInsertRowid
    )
    siteIds.push(
      (await insertSite.run('Tatu Studios', 'Tatu-Connect', 'Ruiru, Kiambu', 'Africa/Nairobi', '#38bdf8', 'Serviced apartments', nowIso())).lastInsertRowid
    )

    const insertRouter = db.prepare(
      `INSERT INTO routers (site_id, name, mode, hotspot_server, hotspot_profile, status, created_at)
       VALUES (?, ?, 'simulated', 'hotspot1', 'default', 'unknown', ?)`
    )
    await insertRouter.run(siteIds[0], 'Riverside Core', nowIso())
    await insertRouter.run(siteIds[1], 'Tatu Gateway', nowIso())

    const insertPlan = db.prepare(
      `INSERT INTO plans (name, price, currency, duration_minutes, data_mb, devices, download_kbps, upload_kbps, hotspot_profile, active, created_at)
       VALUES (?, ?, 'KES', ?, ?, ?, ?, ?, 'default', 1, ?)`
    )
    planIds.push((await insertPlan.run('1 Hour', 30, 60, 500, 1, 2048, 1024, nowIso())).lastInsertRowid)
    planIds.push((await insertPlan.run('1 Day', 80, 1440, 3000, 2, 4096, 2048, nowIso())).lastInsertRowid)
    planIds.push((await insertPlan.run('1 Week', 400, 10080, 20000, 3, 6144, 3072, nowIso())).lastInsertRowid)
    planIds.push((await insertPlan.run('1 Month', 1200, 43200, 60000, 4, 8192, 4096, nowIso())).lastInsertRowid)

    const insertCustomer = db.prepare(
      'INSERT INTO customers (name, phone, email, site_id, notes, created_at) VALUES (?, ?, NULL, ?, NULL, ?)'
    )
    for (const [name, phone] of CUSTOMERS) {
      customerIds.push((await insertCustomer.run(name, phone, pick(siteIds), nowIso())).lastInsertRowid)
    }

    const plans = await db.prepare('SELECT * FROM plans ORDER BY price').all()
    const insertPayment = db.prepare(
      `INSERT INTO payments (ref, site_id, plan_id, customer_id, amount, currency, method, status, phone, customer_name, created_at, paid_at)
       VALUES (?, ?, ?, ?, ?, 'KES', ?, ?, ?, ?, ?, ?)`
    )
    const updatePaymentVoucher = db.prepare('UPDATE payments SET voucher_id = ? WHERE id = ?')
    const weight = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3]

    for (let i = 0; i < 84; i += 1) {
      const plan = plans[pick(weight)]
      const siteId = pick(siteIds)
      const customerId = Math.random() < 0.75 ? pick(customerIds) : null
      const customer = CUSTOMERS.find((c, idx) => customerIds[idx] === customerId)
      const daysAgo = Math.floor(Math.pow(Math.random(), 1.6) * 21)
      const created = new Date(now - daysAgo * 86_400_000 - rand(0, 20) * 3_600_000 - rand(0, 59) * 60_000)
      const roll = Math.random()
      const status = roll < 0.05 ? 'pending' : roll < 0.08 ? 'refunded' : 'paid'
      const method = Math.random() < 0.65 ? 'mpesa' : 'cash'
      const refCode = ref()
      const paidAt = status === 'pending' ? null : new Date(created.getTime() + rand(1, 25) * 60_000)

      const paymentId = (
        await insertPayment.run(
          refCode,
          siteId,
          plan.id,
          customerId,
          plan.price,
          method,
          status,
          customer ? customer[1] : null,
          customer ? customer[0] : 'Walk-in guest',
          created.toISOString(),
          paidAt ? paidAt.toISOString() : null
        )
      ).lastInsertRowid

      if (status === 'paid') {
        const expiresAt = new Date(paidAt.getTime() + plan.duration_minutes * 60_000)
        let voucherStatus = 'unused'
        let activatedAt = null
        if (expiresAt.getTime() < now) {
          voucherStatus = 'expired'
          activatedAt = paidAt.toISOString()
        } else if (Math.random() < 0.55) {
          voucherStatus = 'active'
          activatedAt = paidAt.toISOString()
        }
        const voucher = await createVoucher(plan, {
          siteId,
          customerId,
          paymentId,
          status: voucherStatus,
          pricePaid: plan.price,
          createdAt: paidAt.toISOString(),
          activatedAt,
          expiresAt: voucherStatus === 'unused' ? null : expiresAt.toISOString(),
        })
        await updatePaymentVoucher.run(voucher.id, paymentId)
        if (voucherStatus === 'active' || voucherStatus === 'expired') {
          await db.prepare('UPDATE vouchers SET provisioned = 1 WHERE id = ?').run(voucher.id)
        }
      }
    }

    const stockRouter = db.prepare('SELECT id FROM routers WHERE site_id = ? ORDER BY id LIMIT 1')
    for (let i = 0; i < 26; i += 1) {
      const plan = plans[rand(0, plans.length - 1)]
      const siteId = pick(siteIds)
      const router = await stockRouter.get(siteId)
      await createVoucher(plan, {
        siteId,
        routerId: router?.id ?? null,
        pricePaid: plan.price,
        notes: 'Printed stock',
      })
    }

    const recentSales = await db
      .prepare(
        `SELECT p.paid_at, p.amount, p.currency, pl.name AS plan_name, s.name AS site_name, p.customer_name
         FROM payments p JOIN plans pl ON pl.id = p.plan_id LEFT JOIN sites s ON s.id = p.site_id
         WHERE p.status = 'paid' ORDER BY p.paid_at DESC LIMIT 6`
      )
      .all()
    for (const sale of recentSales) {
      await db.prepare(
        'INSERT INTO events (ts, site_id, router_id, severity, kind, message) VALUES (?, NULL, NULL, ?, ?, ?)'
      ).run(
        sale.paid_at,
        'info',
        'sale',
        `${sale.customer_name || 'Guest'} bought ${sale.plan_name} for ${sale.currency} ${sale.amount} at ${sale.site_name}`
      )
    }
    logEvent({
      siteId: siteIds[0],
      severity: 'info',
      kind: 'demo_loaded',
      message: 'Demo workspace loaded with sample sites and sales',
    })
  })

  await run()
  setSetting('currency', 'KES')
  if (!(await db.prepare("SELECT 1 FROM settings WHERE key = 'company_name'").get())) {
    setSetting('company_name', 'CoryPulse Demo')
  }
  setSetting('demo_payments', '1')
  return { seeded: true }
}

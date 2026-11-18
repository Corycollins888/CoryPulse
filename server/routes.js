import express from 'express'
import crypto from 'node:crypto'
import { publicUrl } from './config.js'
import { db, getSetting, setSetting, logEvent, nowIso } from './db.js'
import {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  requireAuth,
  authenticate,
  loginAllowed,
  recordFailedLogin,
  clearLoginAttempts,
} from './auth.js'
import { rateAllowed } from './security.js'
import { toCsv, safeInt, dayRange, localDate } from './utils.js'
import { encryptSecret as encryptPassword } from './crypto.js'
import { testRouter, resetRouterState } from './mikrotik.js'
import { pollRouterNow, coverageStats } from './poller.js'
import { getIngestStats } from './ingest.js'
import {
  activateVoucher,
  disableVoucher,
  generateBatch,
  getVoucherById,
} from './vouchers.js'
import {
  markPaymentPaid,
  refundPayment,
  initiateStkPush,
  queryStkStatus,
  getMpesaConfig,
  normalizePhone,
  settingsForClient,
  ensureCallbackSecret,
} from './payments.js'
import { seedDemo } from './demo.js'
import { addClient } from './sse.js'

export const api = express.Router()

// Express 4 does not inspect returned promises, so route handlers are wrapped
// here once instead of repeating try/catch in every endpoint.
for (const method of ['get', 'post', 'patch', 'delete']) {
  const original = api[method].bind(api)
  api[method] = (route, ...handlers) =>
    original(
      route,
      ...handlers.map(
        (handler) => (req, res, next) =>
          Promise.resolve(handler(req, res, next)).catch(next)
      )
    )
}

function fail(res, error, status = 400) {
  return res.status(status).json({ error })
}

function text(value, max = 200) {
  if (value == null) return ''
  return String(value).trim().slice(0, max)
}

// One explainable number for the whole fleet. Every factor is a percentage so
// an operator can see exactly which telemetry path dragged the score down.
function pulseScore({ coverage, routers, ingest }) {
  const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)))
  const total = Math.max(0, Number(coverage.total) || 0)
  const fresh = Math.max(0, Number(coverage.fresh) || 0)
  const routerTotal = Number(routers?.total) || 0
  const routerOnline = Number(routers?.online) || 0
  const messages = ingest.radius.messages + ingest.syslog.messages
  const errors = ingest.radius.errors + ingest.syslog.errors + ingest.radius.rejected
  const buffered =
    ingest.buffered.radius_sessions +
    ingest.buffered.active_sessions +
    (ingest.buffered.logs || 0) +
    ingest.buffered.session_events

  const coveragePct = total ? clamp((fresh / total) * 100) : 100
  const livenessPct = routerTotal ? clamp((routerOnline / routerTotal) * 100) : 100
  const integrityPct = messages ? clamp(100 - (errors / messages) * 100) : 100
  const bufferPct = buffered === 0 ? 100 : buffered < 1_000 ? 92 : buffered < 10_000 ? 74 : buffered < 100_000 ? 42 : 12

  const factors = [
    { key: 'coverage', label: 'Telemetry coverage', value: coveragePct, weight: 35, detail: `${fresh.toLocaleString()} of ${total.toLocaleString()} routers reporting` },
    { key: 'liveness', label: 'Router liveness', value: livenessPct, weight: 30, detail: `${routerOnline.toLocaleString()} of ${routerTotal.toLocaleString()} reachable` },
    { key: 'integrity', label: 'Ingest integrity', value: integrityPct, weight: 20, detail: messages ? `${errors.toLocaleString()} rejects in ${messages.toLocaleString()} packets` : 'No packets yet' },
    { key: 'buffer', label: 'Write buffer', value: bufferPct, weight: 15, detail: buffered ? `${buffered.toLocaleString()} rows queued` : 'Drained' },
  ]
  const score = clamp(factors.reduce((sum, factor) => sum + (factor.value * factor.weight) / 100, 0))
  const grade = score >= 92 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'E'
  const weakest = [...factors].sort((a, b) => a.value - b.value)[0]
  let headline = 'Fleet heartbeat steady'
  if (weakest.value < 90) {
    if (weakest.key === 'coverage') headline = `${(total - fresh).toLocaleString()} routers are silent`
    else if (weakest.key === 'liveness') headline = `${(routerTotal - routerOnline).toLocaleString()} routers unreachable`
    else if (weakest.key === 'integrity') headline = 'Ingest is rejecting packets'
    else headline = 'Write buffer is backing up'
  }
  return { score, grade, headline, factors }
}

function username(value) {
  return text(value, 32).toLowerCase()
}

const PAYMENT_REF = /^PAY-[A-Z0-9]{8}$/
const VOUCHER_CODE = /^[A-Z0-9-]{4,40}$/

function paymentRef() {
  return 'PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase()
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function publicRouter(row) {
  if (!row) return null
  const { secret_enc, radius_secret_enc, ...rest } = row
  return {
    ...rest,
    has_password: Boolean(secret_enc),
    has_radius_secret: Boolean(radius_secret_enc),
  }
}

async function siteList() {
  const sites = await db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM routers r WHERE r.site_id = s.id) AS routers_total,
        (SELECT COUNT(*) FROM routers r WHERE r.site_id = s.id AND r.status = 'online') AS routers_online,
        (SELECT COUNT(*) FROM active_sessions a WHERE a.site_id = s.id) AS active_users,
        (SELECT COUNT(*) FROM vouchers v WHERE v.site_id = s.id AND v.status = 'unused') AS vouchers_unused,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.site_id = s.id AND p.status = 'paid'
          AND p.paid_at::date = current_date) AS revenue_today,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.site_id = s.id AND p.status = 'paid'
          AND p.paid_at::date >= current_date - 6) AS revenue_week
       FROM sites s ORDER BY lower(s.name)`
    )
    .all()
  const routers = await db
    .prepare('SELECT id, site_id, name, mode, status, last_seen, last_error FROM routers ORDER BY id')
    .all()
  for (const site of sites) {
    site.routers = routers.filter((r) => r.site_id === site.id)
  }
  return sites
}

/* ------------------------------------------------------------------ setup */

api.get('/setup/status', async (req, res) => {
  const setup = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n > 0
  res.json({ setup, demo_payments: getSetting('demo_payments', '0') === '1' })
})

api.post('/setup', async (req, res) => {
  if (!rateAllowed(`setup:${req.ip}`, 5, 60 * 60_000)) return fail(res, 'Too many attempts', 429)
  if ((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n > 0) {
    return fail(res, 'This installation is already set up', 409)
  }
  const name = username(req.body?.username)
  const password = String(req.body?.password || '')
  if (name.length < 3) return fail(res, 'Username must be at least 3 characters')
  if (password.length < 10) return fail(res, 'Password must be at least 10 characters')
  if (password.toLowerCase() === name) return fail(res, 'Password must not match the username')

  await db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
    name,
    await hashPassword(password),
    nowIso()
  )
  setSetting('company_name', text(req.body?.company, 80) || 'CoryPulse')
  setSetting('currency', text(req.body?.currency, 8).toUpperCase() || 'KES')
  setSetting('demo_payments', req.body?.demo === false ? '0' : '1')
  ensureCallbackSecret()
  if (req.body?.demo !== false) await seedDemo()

  const user = await db.prepare('SELECT id, username FROM users WHERE username = ?').get(name)
  const token = await createSession(user.id)
  setSessionCookie(res, token, publicUrl.startsWith('https://') || req.secure)
  res.json({ user })
})

/* ------------------------------------------------------------------- auth */

api.post('/auth/login', async (req, res) => {
  const ip = req.ip || 'local'
  const name = username(req.body?.username)
  const password = String(req.body?.password || '').slice(0, 256)
  if (!loginAllowed(ip, name)) {
    return fail(res, 'Too many attempts. Try again in a few minutes.', 429)
  }
  if (!name || !password) {
    recordFailedLogin(ip, name)
    return fail(res, 'Incorrect username or password', 401)
  }
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(name)
  if (!user) {
    await burnPasswordCheck(password).catch(() => {})
    recordFailedLogin(ip, name)
    return fail(res, 'Incorrect username or password', 401)
  }
  let valid = false
  try {
    valid = await verifyPassword(password, user.password_hash)
  } catch (err) {
    if (err.busy) return fail(res, 'Sign-in is busy right now. Try again shortly.', 429)
    throw err
  }
  if (!valid) {
    recordFailedLogin(ip, name)
    return fail(res, 'Incorrect username or password', 401)
  }
  clearLoginAttempts(ip, name)
  const token = await createSession(user.id)
  setSessionCookie(res, token, publicUrl.startsWith('https://') || req.secure)
  res.json({ user: { id: user.id, username: user.username } })
})

api.post('/auth/logout', async (req, res) => {
  await destroySession(getSessionToken(req))
  clearSessionCookie(res)
  res.json({ ok: true })
})

api.get('/auth/me', async (req, res) => {
  const user = await authenticate(req)
  if (!user) return fail(res, 'Not signed in', 401)
  res.json({ user })
})

api.get('/health/live', (req, res) => {
  res.json({ ok: true, app: 'CoryPulse', time: nowIso() })
})

api.get('/health', async (req, res) => {
  const started = Date.now()
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 2500)),
    ])
    res.json({ ok: true, app: 'CoryPulse', time: nowIso(), db_ms: Date.now() - started })
  } catch {
    res.status(503).json({ ok: false, app: 'CoryPulse', time: nowIso(), error: 'database unavailable' })
  }
})

/* ---------------------------------------------------------- public portal */

async function portalInfo(siteId) {
  const site = await db.prepare('SELECT id, name, ssid, address, color FROM sites WHERE id = ?').get(siteId)
  if (!site) return null
  const config = getMpesaConfig()
  const plans = await db
    .prepare('SELECT id, name, price, currency, duration_minutes, data_mb, devices, download_kbps, upload_kbps FROM plans WHERE active = 1 ORDER BY price')
    .all()
  return {
    site,
    plans,
    currency: getSetting('currency', 'KES'),
    demo_payments: getSetting('demo_payments', '0') === '1',
    mpesa_configured: config.configured,
  }
}

api.get('/portal/:siteId/info', async (req, res) => {
  const info = await portalInfo(safeInt(req.params.siteId))
  if (!info) return fail(res, 'Site not found', 404)
  res.json(info)
})

api.post('/portal/:siteId/orders', async (req, res, next) => {
  try {
    if (!rateAllowed(`order:${req.ip}`, 60)) return fail(res, 'Too many requests, please wait a moment', 429)
    const siteId = safeInt(req.params.siteId)
    const site = await db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId)
    if (!site) return fail(res, 'Site not found', 404)
    const plan = await db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(safeInt(req.body?.plan_id))
    if (!plan) return fail(res, 'Choose an available plan')
    const name = text(req.body?.name, 80)
    const phone = normalizePhone(req.body?.phone)
    if (name.length < 2) return fail(res, 'Enter your name')
    if (!/^254\d{9}$/.test(phone)) return fail(res, 'Enter a valid Safaricom number e.g. 0712 345 678')
    if (!rateAllowed(`order-phone:${phone}`, 6, 10 * 60_000)) {
      return fail(res, 'Several orders were just placed for this number. Please wait a few minutes.', 429)
    }

    let customer = await db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone)
    if (!customer) {
      const result = await db
        .prepare('INSERT INTO customers (name, phone, site_id, created_at) VALUES (?, ?, ?, ?)')
        .run(name, phone, siteId, nowIso())
      customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid)
    } else if (!customer.name) {
      await db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(name, customer.id)
    }

    const config = getMpesaConfig()
    const demo = getSetting('demo_payments', '0') === '1'
    const method = config.configured ? 'mpesa' : demo ? 'demo' : 'manual'
    const ref = paymentRef()
    const inserted = await db
      .prepare(
        `INSERT INTO payments (ref, site_id, plan_id, customer_id, amount, currency, method, status, phone, customer_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(ref, siteId, plan.id, customer.id, plan.price, plan.currency || 'KES', method, phone, name, nowIso())
    const paymentId = inserted.lastInsertRowid

    const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
    const base = {
      ref,
      status: method === 'demo' ? 'pending_demo' : 'pending',
      method,
      amount: payment.amount,
      currency: payment.currency,
      plan: plan.name,
      site: site.name,
      demo,
    }

    if (method === 'mpesa') {
      try {
        const push = await initiateStkPush(payment, phone)
        return res.json({ ...base, requires_stk: true, message: push.customerMessage || 'Check your phone to enter your M-Pesa PIN' })
      } catch (err) {
        console.error(`[portal] STK push failed for ${ref}:`, err.message)
        return res.json({ ...base, push_error: 'M-Pesa could not be reached. Please try again.', can_retry: true })
      }
    }
    if (method === 'demo') {
      return res.json({ ...base, message: 'Demo mode is on. Complete the demo payment to receive your voucher.' })
    }
    return res.json({ ...base, message: 'Payment pending. Show this reference to the attendant.' })
  } catch (err) {
    next(err)
  }
})

api.post('/portal/orders/:ref/pay', async (req, res, next) => {
  try {
    if (!rateAllowed(`pay:${req.ip}`, 20)) return fail(res, 'Too many attempts, please wait', 429)
    const ref = text(req.params.ref, 32).toUpperCase()
    if (!PAYMENT_REF.test(ref)) return fail(res, 'Order not found', 404)
    const payment = await db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref)
    if (!payment) return fail(res, 'Order not found', 404)
    if (payment.status !== 'pending') return fail(res, 'This order is no longer awaiting payment')
    if (!getMpesaConfig().configured) return fail(res, 'M-Pesa is not available right now')
    const push = await initiateStkPush(payment, payment.phone)
    res.json({ ok: true, message: push.customerMessage || 'Check your phone to complete the payment', requires_stk: true })
  } catch (err) {
    next(err)
  }
})

api.post('/portal/orders/:ref/simulate-pay', async (req, res) => {
  if (!rateAllowed(`simulate:${req.ip}`, 20)) return fail(res, 'Too many attempts', 429)
  if (getSetting('demo_payments', '0') !== '1') return fail(res, 'Demo payments are disabled', 403)
  const ref = text(req.params.ref, 32).toUpperCase()
  if (!PAYMENT_REF.test(ref)) return fail(res, 'Order not found', 404)
  const payment = await db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref)
  if (!payment) return fail(res, 'Order not found', 404)
  if (payment.method !== 'demo') return fail(res, 'This order does not use demo payment')
  const result = await markPaymentPaid(payment.id, { method: 'demo' })
  if (!result.ok) return fail(res, result.error)
  res.json({ ok: true, voucher: result.voucher })
})

api.get('/portal/orders/:ref', async (req, res, next) => {
  try {
    const ref = text(req.params.ref, 32).toUpperCase()
    if (!PAYMENT_REF.test(ref)) return fail(res, 'Order not found', 404)
    let payment = await db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref)
    if (!payment) return fail(res, 'Order not found', 404)
    if (payment.status === 'pending' && payment.provider_ref) {
      const age = Date.now() - new Date(payment.created_at).getTime()
      if (age > 10_000) {
        try {
          const status = await queryStkStatus(payment)
          if (status && String(status.ResultCode) === '0') {
            await markPaymentPaid(payment.id, { method: 'mpesa' })
            payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id)
          }
        } catch {
          // keep pending; callback may still arrive
        }
      }
    }
    const plan = await db.prepare('SELECT name, duration_minutes, data_mb FROM plans WHERE id = ?').get(payment.plan_id)
    const site = await db.prepare('SELECT id, name, ssid FROM sites WHERE id = ?').get(payment.site_id)
    const voucher = payment.voucher_id ? await getVoucherById(payment.voucher_id) : null
    res.json({
      ref: payment.ref,
      status: payment.status,
      method: payment.method,
      amount: payment.amount,
      currency: payment.currency,
      created_at: payment.created_at,
      paid_at: payment.paid_at,
      plan: plan?.name || '',
      data_mb: plan?.data_mb || 0,
      duration_minutes: plan?.duration_minutes || 0,
      site,
      voucher: voucher
        ? { code: voucher.code, status: voucher.status, expires_at: voucher.expires_at, plan_name: voucher.plan_name }
        : null,
      demo: getSetting('demo_payments', '0') === '1',
    })
  } catch (err) {
    next(err)
  }
})

api.post('/portal/:siteId/login', async (req, res, next) => {
  try {
    // NAT puts many guests behind one address, so the per-IP budget is roomy;
    // the per-code budget is what actually stops code guessing.
    if (!rateAllowed(`login:${req.ip}`, 120)) return fail(res, 'Too many attempts, please wait a moment', 429)
    const siteId = safeInt(req.params.siteId)
    const code = text(req.body?.code, 32).toUpperCase().replace(/\s+/g, '')
    if (!code) return fail(res, 'Enter your voucher code')
    if (!VOUCHER_CODE.test(code)) return fail(res, 'Voucher not found. Check the code and try again.', 404)
    if (!rateAllowed(`code:${code}`, 6, 10 * 60_000)) {
      return fail(res, 'Too many attempts for this voucher. Please wait a few minutes.', 429)
    }
    const voucher = await db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code)
    if (!voucher) return fail(res, 'Voucher not found. Check the code and try again.', 404)
    if (voucher.site_id && voucher.site_id !== siteId) return fail(res, 'This voucher belongs to another location', 403)
    const result = await activateVoucher(voucher, 'portal')
    if (!result.ok) return fail(res, result.error)
    const site = await db.prepare('SELECT name, ssid FROM sites WHERE id = ?').get(siteId)
    res.json({
      ...result,
      site_name: site?.name || '',
      ssid: site?.ssid || result.site_ssid || '',
      hotspot_username: code,
      hotspot_password: code,
    })
  } catch (err) {
    next(err)
  }
})

/* ------------------------------------------------------- M-Pesa callback */

api.post('/payments/mpesa/callback/:secret', async (req, res) => {
  if (!rateAllowed(`mpesa-cb:${req.ip}`, 240)) return res.status(429).json({ ResultCode: 1, ResultDesc: 'Busy' })
  const expected = getSetting('mpesa_callback_secret', '')
  const provided = String(req.params.secret || '')
  const valid =
    expected.length > 0 &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  if (!valid) return res.status(404).json({ ResultCode: 1, ResultDesc: 'Not found' })

  const callback = req.body?.Body?.stkCallback
  if (!callback) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' })

  const payment = await db.prepare('SELECT * FROM payments WHERE provider_ref = ?').get(callback.CheckoutRequestID)
  if (!payment) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' })

  if (Number(callback.ResultCode) === 0) {
    const items = callback.CallbackMetadata?.Item || []
    const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value
    await markPaymentPaid(payment.id, { method: 'mpesa', providerRef: receipt ? String(receipt) : undefined })
  } else {
    await db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(payment.id)
    logEvent({
      siteId: payment.site_id,
      severity: 'warning',
      kind: 'payment_failed',
      message: `M-Pesa payment ${payment.ref} failed: ${callback.ResultDesc || 'unknown reason'}`,
    })
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
})

/* -------------------------------------------------------- console (auth) */

api.use(requireAuth)

api.get('/stream', async (req, res) => {
  addClient(res, req)
})

api.get('/dashboard', async (req, res) => {
  const today = await db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS sales FROM payments WHERE status = 'paid' AND paid_at::date = current_date"
    )
    .get()
  const week = await db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS revenue FROM payments WHERE status = 'paid' AND paid_at::date >= current_date - 6"
    )
    .get()
  const activeUsers = (await db.prepare('SELECT COUNT(*) AS n FROM active_sessions').get()).n
  const unused = (await db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE status = 'unused'").get()).n
  const routers = await db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN status = \'online\' THEN 1 ELSE 0 END) AS online FROM routers').get()

  const days = dayRange(14)
  const rows = await db
    .prepare(
      `SELECT paid_at::date AS day, SUM(amount) AS revenue, COUNT(*) AS sales
       FROM payments WHERE status = 'paid' AND paid_at >= current_date - 13
       GROUP BY 1 ORDER BY 1`
    )
    .all()
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const series = days.map((day) => ({
    day,
    revenue: byDay.get(day)?.revenue || 0,
    sales: byDay.get(day)?.sales || 0,
  }))

  const recentPayments = await db
    .prepare(
      `SELECT p.id, p.ref, p.amount, p.currency, p.method, p.status, p.created_at, p.paid_at, p.customer_name,
              pl.name AS plan_name, s.name AS site_name, v.code AS voucher_code
       FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id
       LEFT JOIN sites s ON s.id = p.site_id LEFT JOIN vouchers v ON v.id = p.voucher_id
       ORDER BY p.created_at DESC LIMIT 7`
    )
    .all()
  const recentEvents = await db.prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT 8').all()
  const pulseClients = await db
    .prepare(
      `SELECT a.username, a.address, a.uptime_s, a.rx_bytes, a.tx_bytes, a.site_id
       FROM active_sessions a
       ORDER BY a.updated_at DESC LIMIT 80`
    )
    .all()
  const throughput = await db
    .prepare(
      `SELECT COALESCE(SUM(rx_bps), 0) AS rx_bps, COALESCE(SUM(tx_bps), 0) AS tx_bps
       FROM (
         SELECT DISTINCT ON (router_id) router_id, rx_bps, tx_bps
         FROM router_metrics
         WHERE ts > now() - interval '10 minutes'
         ORDER BY router_id, ts DESC
       ) latest`
    )
    .get()

  res.json({
    kpis: {
      revenue_today: today.revenue,
      sales_today: today.sales,
      revenue_week: week.revenue,
      active_users: activeUsers,
      unused_vouchers: unused,
      routers_total: routers.total,
      routers_online: routers.online || 0,
    },
    series,
    sites: await siteList(),
    pulse: { clients: pulseClients, throughput },
    recent_payments: recentPayments,
    recent_events: recentEvents,
    currency: getSetting('currency', 'KES'),
    company_name: getSetting('company_name', 'CoryPulse'),
  })
})

/* ------------------------------------------------------------------ sites */

api.get('/sites', async (req, res) => {
  res.json({ sites: await siteList() })
})

api.post('/sites', async (req, res) => {
  const name = text(req.body?.name, 80)
  if (name.length < 2) return fail(res, 'Site name is required')
  const result = await db
    .prepare(
      'INSERT INTO sites (name, ssid, address, timezone, color, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      name,
      text(req.body?.ssid, 40) || null,
      text(req.body?.address, 160) || null,
      text(req.body?.timezone, 60) || 'Africa/Nairobi',
      text(req.body?.color, 20) || '#22d3a7',
      text(req.body?.notes, 500) || null,
      nowIso()
    )
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').get(result.lastInsertRowid)
  res.json({ site })
})

api.patch('/sites/:id', async (req, res) => {
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').get(safeInt(req.params.id))
  if (!site) return fail(res, 'Site not found', 404)
  const fields = []
  const params = []
  for (const key of ['name', 'ssid', 'address', 'timezone', 'color', 'notes']) {
    if (key in req.body) {
      fields.push(`${key} = ?`)
      params.push(text(req.body[key], key === 'notes' ? 500 : 160) || null)
    }
  }
  if (!fields.length) return fail(res, 'Nothing to update')
  params.push(site.id)
  await db.prepare(`UPDATE sites SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  res.json({ site: await db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id) })
})

api.delete('/sites/:id', async (req, res) => {
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').get(safeInt(req.params.id))
  if (!site) return fail(res, 'Site not found', 404)
  const paid = (await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE site_id = ? AND status = 'paid'").get(site.id)).n
  if (paid > 0) return fail(res, 'This site has payment history. Keep it for reporting instead of deleting.', 409)
  const routers = await db.prepare('SELECT * FROM routers WHERE site_id = ?').all(site.id)
  for (const router of routers) resetRouterState(router)
  await db.prepare('DELETE FROM sites WHERE id = ?').run(site.id)
  res.json({ ok: true })
})

api.get('/sites/:id', async (req, res) => {
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').get(safeInt(req.params.id))
  if (!site) return fail(res, 'Site not found', 404)
  const routers = (
    await db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM active_sessions a WHERE a.router_id = r.id) AS active_users,
                (SELECT cpu FROM router_metrics m WHERE m.router_id = r.id ORDER BY m.ts DESC LIMIT 1) AS cpu,
                (SELECT uptime_s FROM router_metrics m WHERE m.router_id = r.id ORDER BY m.ts DESC LIMIT 1) AS uptime_s
         FROM routers r WHERE r.site_id = ? ORDER BY r.id`
      )
      .all(site.id)
  ).map(publicRouter)
  const stats = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM active_sessions a JOIN routers r ON r.id = a.router_id WHERE r.site_id = ?) AS active_users,
        (SELECT COUNT(*) FROM vouchers v WHERE v.site_id = ? AND v.status = 'unused') AS unused_vouchers,
        (SELECT COUNT(*) FROM vouchers v WHERE v.site_id = ? AND v.status = 'active') AS active_vouchers,
        (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = ? AND p.status = 'paid'
          AND p.paid_at::date = current_date) AS revenue_today,
        (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = ? AND p.status = 'paid'
          AND p.paid_at::date >= current_date - 29) AS revenue_month`
    )
    .get(site.id, site.id, site.id, site.id, site.id)
  const payments = await db
    .prepare(
      `SELECT p.id, p.ref, p.amount, p.currency, p.method, p.status, p.created_at, p.paid_at, p.customer_name,
              pl.name AS plan_name, v.code AS voucher_code
       FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id LEFT JOIN vouchers v ON v.id = p.voucher_id
       WHERE p.site_id = ? ORDER BY p.created_at DESC LIMIT 8`
    )
    .all(site.id)
  const events = await db.prepare('SELECT * FROM events WHERE site_id = ? ORDER BY ts DESC, id DESC LIMIT 8').all(site.id)
  res.json({ site, routers, stats, currency: getSetting('currency') || 'KES', payments, events })
})

/* ---------------------------------------------------------------- routers */

api.post('/sites/:siteId/routers', async (req, res) => {
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').get(safeInt(req.params.siteId))
  if (!site) return fail(res, 'Site not found', 404)
  const name = text(req.body?.name, 60)
  const mode = req.body?.mode === 'routeros' ? 'routeros' : 'simulated'
  if (name.length < 2) return fail(res, 'Router name is required')
  const password = String(req.body?.password || '')
  if (mode === 'routeros' && (!text(req.body?.host) || !text(req.body?.username) || !password)) {
    return fail(res, 'Host, API username, and password are required for a real router')
  }
  const result = await db
    .prepare(
      `INSERT INTO routers (site_id, name, mode, host, nas_ip, port, username, secret_enc, radius_secret_enc, use_tls, hotspot_server, hotspot_profile, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)`
    )
    .run(
      site.id,
      name,
      mode,
      text(req.body?.host, 120) || null,
      text(req.body?.nas_ip, 45) || null,
      safeInt(req.body?.port, 8728),
      text(req.body?.username, 60) || null,
      password ? encryptPassword(password) : null,
      req.body?.radius_secret ? encryptPassword(String(req.body.radius_secret)) : null,
      req.body?.use_tls ? 1 : 0,
      text(req.body?.hotspot_server, 40) || 'hotspot1',
      text(req.body?.hotspot_profile, 40) || 'default',
      nowIso()
    )
  const router = publicRouter(await db.prepare('SELECT * FROM routers WHERE id = ?').get(result.lastInsertRowid))
  res.json({ router })
})

api.patch('/routers/:id', async (req, res) => {
  const router = await db.prepare('SELECT * FROM routers WHERE id = ?').get(safeInt(req.params.id))
  if (!router) return fail(res, 'Router not found', 404)
  const fields = []
  const params = []
  const body = req.body || {}
  if ('name' in body) {
    fields.push('name = ?')
    params.push(text(body.name, 60))
  }
  if ('mode' in body) {
    fields.push('mode = ?')
    params.push(body.mode === 'routeros' ? 'routeros' : 'simulated')
  }
  for (const key of ['host', 'nas_ip', 'username', 'hotspot_server', 'hotspot_profile']) {
    if (key in body) {
      fields.push(`${key} = ?`)
      params.push(text(body[key], 120) || null)
    }
  }
  if ('port' in body) {
    fields.push('port = ?')
    params.push(safeInt(body.port, 8728))
  }
  if ('poll_interval_s' in body) {
    fields.push('poll_interval_s = ?')
    params.push(Math.max(15, safeInt(body.poll_interval_s, 60)))
  }
  if ('use_tls' in body) {
    fields.push('use_tls = ?')
    params.push(body.use_tls ? 1 : 0)
  }
  if (body.password) {
    fields.push('secret_enc = ?')
    params.push(encryptPassword(String(body.password)))
  }
  if (body.radius_secret) {
    fields.push('radius_secret_enc = ?')
    params.push(encryptPassword(String(body.radius_secret)))
  }
  if (!fields.length) return fail(res, 'Nothing to update')
  params.push(router.id)
  await db.prepare(`UPDATE routers SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  resetRouterState(router)
  res.json({ router: publicRouter(await db.prepare('SELECT * FROM routers WHERE id = ?').get(router.id)) })
})

api.delete('/routers/:id', async (req, res) => {
  const router = await db.prepare('SELECT * FROM routers WHERE id = ?').get(safeInt(req.params.id))
  if (!router) return fail(res, 'Router not found', 404)
  resetRouterState(router)
  await db.prepare('DELETE FROM routers WHERE id = ?').run(router.id)
  res.json({ ok: true })
})

api.post('/routers/:id/test', async (req, res, next) => {
  try {
    const router = await db.prepare('SELECT * FROM routers WHERE id = ?').get(safeInt(req.params.id))
    if (!router) return fail(res, 'Router not found', 404)
    try {
      const info = await testRouter(router)
      await db.prepare("UPDATE routers SET status = 'online', last_seen = ?, last_error = NULL WHERE id = ?").run(nowIso(), router.id)
      res.json({ ok: true, ...info })
    } catch (err) {
      await db.prepare("UPDATE routers SET status = 'offline', last_error = ? WHERE id = ?").run(err.message, router.id)
      logEvent({
        siteId: router.site_id,
        routerId: router.id,
        severity: 'warning',
        kind: 'router_test_failed',
        message: `${router.name} connection test failed: ${err.message}`,
      })
      return fail(res, err.message, 502)
    }
  } catch (err) {
    next(err)
  }
})

api.post('/routers/:id/sync', async (req, res, next) => {
  try {
    const router = await db.prepare('SELECT * FROM routers WHERE id = ?').get(safeInt(req.params.id))
    if (!router) return fail(res, 'Router not found', 404)
    try {
      const metrics = await pollRouterNow(router)
      res.json({ ok: true, metrics })
    } catch (err) {
      return fail(res, err.message, 502)
    }
  } catch (err) {
    next(err)
  }
})

/* ------------------------------------------------------------------ plans */

const PLAN_FIELDS = [
  'name',
  'price',
  'currency',
  'duration_minutes',
  'data_mb',
  'devices',
  'download_kbps',
  'upload_kbps',
  'hotspot_profile',
  'active',
]

function planValues(body) {
  return {
    name: text(body.name, 60),
    price: Number(body.price),
    currency: text(body.currency, 8).toUpperCase() || getSetting('currency', 'KES'),
    duration_minutes: safeInt(body.duration_minutes),
    data_mb: safeInt(body.data_mb),
    devices: Math.max(1, safeInt(body.devices, 1)),
    download_kbps: safeInt(body.download_kbps),
    upload_kbps: safeInt(body.upload_kbps),
    hotspot_profile: text(body.hotspot_profile, 40) || 'default',
    active: body.active === false || body.active === 0 ? 0 : 1,
  }
}

function validatePlan(values) {
  if (values.name.length < 2) return 'Plan name is required'
  if (!(values.price >= 0)) return 'Price must be zero or more'
  if (!(values.duration_minutes >= 1)) return 'Duration must be at least one minute'
  if (values.data_mb < 0 || values.download_kbps < 0 || values.upload_kbps < 0) return 'Limits cannot be negative'
  return null
}

api.get('/plans', async (req, res) => {
  const plans = await db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM vouchers v WHERE v.plan_id = p.id) AS vouchers_total,
        (SELECT COUNT(*) FROM vouchers v WHERE v.plan_id = p.id AND v.status = 'unused') AS vouchers_unused,
        (SELECT COUNT(*) FROM payments pm WHERE pm.plan_id = p.id AND pm.status = 'paid') AS sold,
        (SELECT COALESCE(SUM(pm.amount), 0) FROM payments pm WHERE pm.plan_id = p.id AND pm.status = 'paid') AS revenue
       FROM plans p ORDER BY p.price`
    )
    .all()
  res.json({ plans, currency: getSetting('currency', 'KES') })
})

api.post('/plans', async (req, res) => {
  const values = planValues(req.body || {})
  const error = validatePlan(values)
  if (error) return fail(res, error)
  const keys = Object.keys(values)
  const result = await db
    .prepare(
      `INSERT INTO plans (${keys.join(', ')}, created_at) VALUES (${keys.map(() => '?').join(', ')}, ?)`
    )
    .run(...keys.map((k) => values[k]), nowIso())
  res.json({ plan: await db.prepare('SELECT * FROM plans WHERE id = ?').get(result.lastInsertRowid) })
})

api.patch('/plans/:id', async (req, res) => {
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(safeInt(req.params.id))
  if (!plan) return fail(res, 'Plan not found', 404)
  const merged = planValues({ ...plan, ...req.body })
  const error = validatePlan(merged)
  if (error) return fail(res, error)
  await db.prepare(
    `UPDATE plans SET ${Object.keys(merged).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
  ).run(...Object.values(merged), plan.id)
  res.json({ plan: await db.prepare('SELECT * FROM plans WHERE id = ?').get(plan.id) })
})

api.delete('/plans/:id', async (req, res) => {
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(safeInt(req.params.id))
  if (!plan) return fail(res, 'Plan not found', 404)
  const used = (await db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE plan_id = ?').get(plan.id)).n
  if (used > 0) {
    await db.prepare('UPDATE plans SET active = 0 WHERE id = ?').run(plan.id)
    return res.json({ ok: true, deactivated: true })
  }
  await db.prepare('DELETE FROM plans WHERE id = ?').run(plan.id)
  res.json({ ok: true, deleted: true })
})

/* --------------------------------------------------------------- vouchers */

api.get('/vouchers', async (req, res) => {
  const where = []
  const params = []
  const status = text(req.query.status, 20)
  if (['unused', 'active', 'expired', 'disabled'].includes(status)) {
    where.push('v.status = ?')
    params.push(status)
  }
  if (req.query.site_id) {
    where.push('v.site_id = ?')
    params.push(safeInt(req.query.site_id))
  }
  if (req.query.plan_id) {
    where.push('v.plan_id = ?')
    params.push(safeInt(req.query.plan_id))
  }
  if (req.query.q) {
    where.push('v.code ILIKE ?')
    params.push(`%${text(req.query.q, 32).toUpperCase()}%`)
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const limit = Math.min(500, Math.max(1, safeInt(req.query.limit, 100)))
  const offset = Math.max(0, safeInt(req.query.offset, 0))
  const items = await db
    .prepare(
      `SELECT v.*, p.name AS plan_name, s.name AS site_name, c.name AS customer_name, c.phone AS customer_phone
       FROM vouchers v JOIN plans p ON p.id = v.plan_id
       LEFT JOIN sites s ON s.id = v.site_id LEFT JOIN customers c ON c.id = v.customer_id
       ${clause} ORDER BY v.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM vouchers v ${clause}`).get(...params)).n
  const counts = { unused: 0, active: 0, expired: 0, disabled: 0 }
  for (const row of await db.prepare('SELECT status, COUNT(*) AS n FROM vouchers GROUP BY status').all()) {
    counts[row.status] = row.n
  }
  res.json({ items, total, limit, offset, counts, currency: getSetting('currency', 'KES') })
})

api.post('/vouchers/generate', async (req, res) => {
  const planId = safeInt(req.body?.plan_id)
  const siteId = safeInt(req.body?.site_id)
  const count = Math.min(200, Math.max(1, safeInt(req.body?.count, 10)))
  let prefix = text(req.body?.prefix, 4).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!prefix) prefix = 'CP'
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) return fail(res, 'Plan not found')
  if (!await db.prepare('SELECT 1 FROM sites WHERE id = ?').get(siteId)) return fail(res, 'Site not found')
  const created = await generateBatch({ planId, siteId, count, prefix })
  res.json({ count: created.length, codes: created.map((v) => v.code) })
})

api.get('/vouchers/sheet', async (req, res) => {
  const siteId = safeInt(req.query.site_id)
  const limit = Math.min(40, Math.max(1, safeInt(req.query.limit, 24)))
  const site = siteId ? await db.prepare('SELECT id, name, ssid, color FROM sites WHERE id = ?').get(siteId) : null
  if (siteId && !site) return fail(res, 'Site not found', 404)
  const where = ["v.status = 'unused'"]
  const params = []
  if (siteId) {
    where.push('v.site_id = ?')
    params.push(siteId)
  }
  const items = await db
    .prepare(
      `SELECT v.id, v.code, v.created_at, p.name AS plan_name, p.duration_minutes, p.data_mb,
              p.price, p.currency, s.id AS site_id, s.name AS site_name, s.ssid, s.color
       FROM vouchers v JOIN plans p ON p.id = v.plan_id
       LEFT JOIN sites s ON s.id = v.site_id
       WHERE ${where.join(' AND ')} ORDER BY v.id DESC LIMIT ?`
    )
    .all(...params, limit)
  res.json({ items, site, currency: getSetting('currency', 'KES') })
})

api.get('/vouchers/export.csv', async (req, res) => {  const status = text(req.query.status, 20)
  const siteId = safeInt(req.query.site_id)
  const where = []
  const params = []
  if (['unused', 'active', 'expired', 'disabled'].includes(status)) {
    where.push('v.status = ?')
    params.push(status)
  }
  if (siteId) {
    where.push('v.site_id = ?')
    params.push(siteId)
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = await db
    .prepare(
      `SELECT v.code, p.name AS plan, s.name AS site, v.status, v.price_paid, v.created_at, v.activated_at, v.expires_at
       FROM vouchers v JOIN plans p ON p.id = v.plan_id LEFT JOIN sites s ON s.id = v.site_id
       ${clause} ORDER BY v.id DESC`
    )
    .all(...params)
  const csv = toCsv(
    ['Code', 'Plan', 'Site', 'Status', 'Price paid', 'Created', 'Activated', 'Expires'],
    rows.map((r) => [r.code, r.plan, r.site, r.status, r.price_paid, r.created_at, r.activated_at, r.expires_at])
  )
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="corypulse-vouchers-${localDate(nowIso())}.csv"`)
  res.send(csv)
})

api.post('/vouchers/:id/activate', async (req, res, next) => {
  try {
    const result = await activateVoucher(safeInt(req.params.id), 'admin')
    if (!result.ok) return fail(res, result.error)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

api.post('/vouchers/:id/disable', async (req, res, next) => {
  try {
    const result = await disableVoucher(safeInt(req.params.id))
    if (!result.ok) return fail(res, result.error)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/* -------------------------------------------------------------- customers */

api.get('/customers', async (req, res) => {
  const q = text(req.query.q, 80)
  const rows = await db
    .prepare(
      `SELECT c.*, s.name AS site_name,
        (SELECT COUNT(*) FROM payments p WHERE p.customer_id = c.id AND p.status = 'paid') AS purchases,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.customer_id = c.id AND p.status = 'paid') AS spend,
        (SELECT MAX(p.paid_at) FROM payments p WHERE p.customer_id = c.id AND p.status = 'paid') AS last_purchase
       FROM customers c LEFT JOIN sites s ON s.id = c.site_id
       ${q ? 'WHERE c.name LIKE ? OR c.phone LIKE ?' : ''}
       ORDER BY last_purchase DESC NULLS LAST, c.id DESC LIMIT 300`
    )
    .all(...(q ? [`%${q}%`, `%${q}%`] : []))
  res.json({ customers: rows, currency: getSetting('currency', 'KES') })
})

api.post('/customers', async (req, res) => {
  const name = text(req.body?.name, 80)
  if (name.length < 2) return fail(res, 'Customer name is required')
  const email = text(req.body?.email, 120)
  if (email && !isEmail(email)) return fail(res, 'Enter a valid email address')
  const result = await db
    .prepare('INSERT INTO customers (name, phone, email, site_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      name,
      normalizePhone(req.body?.phone) || null,
      email || null,
      req.body?.site_id ? safeInt(req.body.site_id) : null,
      text(req.body?.notes, 500) || null,
      nowIso()
    )
  res.json({ customer: await db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid) })
})

api.patch('/customers/:id', async (req, res) => {
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(safeInt(req.params.id))
  if (!customer) return fail(res, 'Customer not found', 404)
  const fields = []
  const params = []
  for (const key of ['name', 'email', 'notes']) {
    if (key in (req.body || {})) {
      fields.push(`${key} = ?`)
      params.push(text(req.body[key], key === 'notes' ? 500 : 120) || null)
    }
  }
  if ('phone' in (req.body || {})) {
    fields.push('phone = ?')
    params.push(normalizePhone(req.body.phone) || null)
  }
  if ('site_id' in (req.body || {})) {
    fields.push('site_id = ?')
    params.push(req.body.site_id ? safeInt(req.body.site_id) : null)
  }
  if (!fields.length) return fail(res, 'Nothing to update')
  params.push(customer.id)
  await db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  res.json({ customer: await db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id) })
})

api.delete('/customers/:id', async (req, res) => {
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(safeInt(req.params.id))
  if (!customer) return fail(res, 'Customer not found', 404)
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id)
  res.json({ ok: true })
})

/* --------------------------------------------------------------- payments */

api.get('/payments', async (req, res) => {
  const where = []
  const params = []
  const status = text(req.query.status, 20)
  if (['pending', 'paid', 'failed', 'refunded'].includes(status)) {
    where.push('p.status = ?')
    params.push(status)
  }
  if (req.query.site_id) {
    where.push('p.site_id = ?')
    params.push(safeInt(req.query.site_id))
  }
  if (req.query.q) {
    where.push('(p.ref LIKE ? OR p.customer_name LIKE ? OR p.phone LIKE ?)')
    const term = `%${text(req.query.q, 60)}%`
    params.push(term, term, term)
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const items = await db
    .prepare(
      `SELECT p.*, s.name AS site_name, pl.name AS plan_name, v.code AS voucher_code, v.status AS voucher_status
       FROM payments p LEFT JOIN sites s ON s.id = p.site_id LEFT JOIN plans pl ON pl.id = p.plan_id
       LEFT JOIN vouchers v ON v.id = p.voucher_id
       ${clause} ORDER BY p.created_at DESC LIMIT 300`
    )
    .all(...params)
  res.json({ items, currency: getSetting('currency', 'KES') })
})

api.post('/payments/:id/mark-paid', async (req, res) => {
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(safeInt(req.params.id))
  if (!payment) return fail(res, 'Payment not found', 404)
  const method = ['cash', 'mpesa', 'bank', 'manual'].includes(req.body?.method) ? req.body.method : 'cash'
  const result = await markPaymentPaid(payment.id, { method })
  if (!result.ok) return fail(res, result.error)
  res.json(result)
})

api.post('/payments/:id/refund', async (req, res, next) => {
  try {
    const result = await refundPayment(safeInt(req.params.id))
    if (!result.ok) return fail(res, result.error)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

api.post('/payments/:id/retry-push', async (req, res, next) => {
  try {
    if (!rateAllowed(`retry:${req.ip}`, 10)) return fail(res, 'Too many attempts', 429)
    const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(safeInt(req.params.id))
    if (!payment) return fail(res, 'Payment not found', 404)
    if (payment.status !== 'pending') return fail(res, 'This payment is not pending')
    const push = await initiateStkPush(payment, payment.phone)
    res.json({ ok: true, message: push.customerMessage || 'STK push sent' })
  } catch (err) {
    next(err)
  }
})

/* --------------------------------------------------------------- settings */

api.get('/settings', async (req, res) => {
  res.json(settingsForClient())
})

api.patch('/settings', async (req, res) => {
  const body = req.body || {}
  if ('company_name' in body) setSetting('company_name', text(body.company_name, 80) || 'CoryPulse')
  if ('currency' in body) setSetting('currency', text(body.currency, 8).toUpperCase() || 'KES')
  if ('demo_payments' in body) setSetting('demo_payments', body.demo_payments ? '1' : '0')
  if ('mpesa_env' in body) {
    if (!['sandbox', 'production'].includes(body.mpesa_env)) return fail(res, 'Invalid M-Pesa environment')
    setSetting('mpesa_env', body.mpesa_env)
  }
  if ('mpesa_shortcode' in body) setSetting('mpesa_shortcode', text(body.mpesa_shortcode, 12))
  for (const key of ['mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_passkey']) {
    if (key in body && String(body[key] || '').length > 0) setSetting(key, String(body[key]).trim())
  }
  if (body.mpesa_clear === true) {
    for (const key of ['mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_passkey', 'mpesa_shortcode']) {
      setSetting(key, '')
    }
  }
  res.json(settingsForClient())
})

/* ---------------------------------------------------------------- reports */

api.get('/reports/overview', async (req, res) => {
  const days = Math.min(90, Math.max(7, safeInt(req.query.days, 14)))
  const rows = await db
    .prepare(
      `SELECT p.amount, p.method, p.paid_at, pl.name AS plan_name, s.id AS site_id, s.name AS site_name, s.color
       FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id LEFT JOIN sites s ON s.id = p.site_id
       WHERE p.status = 'paid' AND p.paid_at >= now() - make_interval(days => ?)`
    )
    .all(days)

  const dayKeys = dayRange(days)
  const dayMap = new Map(dayKeys.map((day) => [day, { day, revenue: 0, sales: 0 }]))
  const siteMap = new Map()
  const planMap = new Map()
  const methodMap = new Map()
  let revenue = 0

  for (const site of await db.prepare('SELECT id, name, color FROM sites').all()) {
    siteMap.set(site.id, { id: site.id, name: site.name, color: site.color, revenue: 0, sales: 0 })
  }
  for (const row of rows) {
    revenue += row.amount
    const day = localDate(row.paid_at)
    if (dayMap.has(day)) {
      dayMap.get(day).revenue += row.amount
      dayMap.get(day).sales += 1
    }
    if (row.site_id && siteMap.has(row.site_id)) {
      siteMap.get(row.site_id).revenue += row.amount
      siteMap.get(row.site_id).sales += 1
    }
    if (row.plan_name) {
      const entry = planMap.get(row.plan_name) || { name: row.plan_name, revenue: 0, sales: 0 }
      entry.revenue += row.amount
      entry.sales += 1
      planMap.set(row.plan_name, entry)
    }
    const method = row.method || 'manual'
    const mEntry = methodMap.get(method) || { method, revenue: 0, sales: 0 }
    mEntry.revenue += row.amount
    mEntry.sales += 1
    methodMap.set(method, mEntry)
  }

  res.json({
    days,
    currency: getSetting('currency', 'KES'),
    totals: {
      revenue,
      sales: rows.length,
      average_sale: rows.length ? revenue / rows.length : 0,
      active_vouchers: (await db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE status = 'active'").get()).n,
      unused_vouchers: (await db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE status = 'unused'").get()).n,
      customers: (await db.prepare('SELECT COUNT(*) AS n FROM customers').get()).n,
    },
    series: [...dayMap.values()],
    by_site: [...siteMap.values()].sort((a, b) => b.revenue - a.revenue),
    top_plans: [...planMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6),
    by_method: [...methodMap.values()].sort((a, b) => b.revenue - a.revenue),
  })
})

api.get('/reports/export.csv', async (req, res) => {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : localDate(nowIso())
  const fallbackFrom = new Date(Date.now() - 29 * 86_400_000)
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : localDate(fallbackFrom.toISOString())
  const rows = await db
    .prepare(
      `SELECT p.ref, p.paid_at, s.name AS site, pl.name AS plan, p.customer_name, p.phone,
              p.method, p.amount, p.currency, v.code AS voucher, p.status
       FROM payments p LEFT JOIN sites s ON s.id = p.site_id LEFT JOIN plans pl ON pl.id = p.plan_id
       LEFT JOIN vouchers v ON v.id = p.voucher_id
       WHERE p.paid_at::date BETWEEN ? AND ? ORDER BY p.paid_at DESC`
    )
    .all(from, to)
  const csv = toCsv(
    ['Reference', 'Paid at', 'Site', 'Plan', 'Customer', 'Phone', 'Method', 'Amount', 'Currency', 'Voucher', 'Status'],
    rows.map((r) => [r.ref, r.paid_at, r.site, r.plan, r.customer_name, r.phone, r.method, r.amount, r.currency, r.voucher, r.status])
  )
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="corypulse-payments-${from}-to-${to}.csv"`)
  res.send(csv)
})

api.get('/events', async (req, res) => {
  const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 50)))
  const routerId = safeInt(req.query.router_id, 0)
  const events = routerId
    ? await db.prepare('SELECT * FROM events WHERE router_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(routerId, limit)
    : await db.prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?').all(limit)
  res.json({ events })
})

api.get('/network/overview', async (req, res) => {
  const [coverage, active, sessions, routers] = await Promise.all([
    coverageStats(),
    db.prepare('SELECT COUNT(*) AS n FROM active_sessions').get(),
    db.prepare("SELECT COUNT(*) AS n FROM radius_sessions WHERE status = 'active'").get(),
    db.prepare("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'online') AS online FROM routers").get(),
  ])
  const ingest = getIngestStats()
  res.json({
    coverage,
    active_sessions: active.n,
    radius_active_sessions: sessions.n,
    routers,
    pulse: pulseScore({ coverage, routers, ingest }),
    ingest,
    server_time: nowIso(),
  })
})

api.get('/network/fleet', async (req, res) => {
  const [sites, routers] = await Promise.all([
    db.prepare('SELECT id, name, color FROM sites ORDER BY name').all(),
    db
      .prepare(
        `SELECT r.id, r.name, r.site_id, r.status, r.last_seen, r.poll_interval_s, r.consecutive_failures,
                COALESCE(a.users, 0) AS users,
                COALESCE(m.rx_bps, 0) AS rx_bps, COALESCE(m.tx_bps, 0) AS tx_bps
         FROM routers r
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS users FROM active_sessions x WHERE x.router_id = r.id
         ) a ON true
         LEFT JOIN LATERAL (
           SELECT rx_bps, tx_bps FROM router_metrics rm
           WHERE rm.router_id = r.id ORDER BY ts DESC LIMIT 1
         ) m ON true
         ORDER BY r.site_id, r.name`
      )
      .all(),
  ])
  res.json({ sites, routers, generated_at: nowIso() })
})

api.get('/routers/:id/logs', async (req, res) => {
  const router = await db.prepare('SELECT id, name FROM routers WHERE id = ?').get(safeInt(req.params.id))
  if (!router) return fail(res, 'Router not found', 404)
  const limit = Math.min(500, Math.max(1, safeInt(req.query.limit, 100)))
  const logs = await db
    .prepare('SELECT * FROM router_logs WHERE router_id = ? ORDER BY ts DESC LIMIT ?')
    .all(router.id, limit)
  res.json({ router, logs })
})

api.get('/sessions/recent', async (req, res) => {
  const limit = Math.min(500, Math.max(1, safeInt(req.query.limit, 100)))
  const sessions = await db
    .prepare(
      `SELECT rs.*, r.name AS router_name, s.name AS site_name
       FROM radius_sessions rs
       LEFT JOIN routers r ON r.id = rs.router_id
       LEFT JOIN sites s ON s.id = rs.site_id
       ORDER BY rs.last_seen_at DESC LIMIT ?`
    )
    .all(limit)
  res.json({ sessions })
})

api.post('/demo/load', async (req, res) => {
  const result = await seedDemo()
  if (!result.seeded) return fail(res, 'Demo data can only be loaded into an empty workspace', 409)
  res.json(result)
})

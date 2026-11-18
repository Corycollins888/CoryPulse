import crypto from 'node:crypto'
import { publicUrl } from './config.js'
import { db, getSetting, logEvent, nowIso, setSetting } from './db.js'
import { broadcast } from './sse.js'
import { createVoucher, disableVoucher, getVoucherById } from './vouchers.js'

const SECRET_KEYS = [
  'mpesa_consumer_key',
  'mpesa_consumer_secret',
  'mpesa_passkey',
]

export function getMpesaConfig() {
  const env = getSetting('mpesa_env', process.env.MPESA_ENV || 'sandbox') || 'sandbox'
  const config = {
    env,
    consumerKey: getSetting('mpesa_consumer_key', process.env.MPESA_CONSUMER_KEY || ''),
    consumerSecret: getSetting('mpesa_consumer_secret', process.env.MPESA_CONSUMER_SECRET || ''),
    passkey: getSetting('mpesa_passkey', process.env.MPESA_PASSKEY || ''),
    shortcode: getSetting('mpesa_shortcode', process.env.MPESA_SHORTCODE || ''),
    callbackSecret: getSetting('mpesa_callback_secret', process.env.MPESA_CALLBACK_SECRET || ''),
    baseUrl: env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
  }
  config.configured = Boolean(config.consumerKey && config.consumerSecret && config.passkey && config.shortcode)
  config.callbackUrl = `${publicUrl}/api/payments/mpesa/callback/${encodeURIComponent(config.callbackSecret || 'unset')}`
  return config
}

export function publicMpesaState() {
  const config = getMpesaConfig()
  return {
    configured: config.configured,
    env: config.env,
    shortcode: config.shortcode,
    callback_url: config.configured && config.callbackSecret ? config.callbackUrl : '',
    has_consumer_key: Boolean(config.consumerKey),
    has_consumer_secret: Boolean(config.consumerSecret),
    has_passkey: Boolean(config.passkey),
  }
}

export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('254')) return digits
  if (digits.startsWith('0')) return '254' + digits.slice(1)
  if (digits.length === 9 && /^[71]/.test(digits)) return '254' + digits
  return digits
}

let tokenCache = { token: null, expiresAt: 0, key: '' }

async function accessToken(config) {
  const cacheKey = config.consumerKey + config.env
  if (tokenCache.token && tokenCache.key === cacheKey && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token
  }
  const res = await fetch(`${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64'),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`M-Pesa authorization failed (${res.status}): ${text.slice(0, 200)}`)
  const data = JSON.parse(text)
  tokenCache = { token: data.access_token, expiresAt: Date.now() + 3000_000, key: cacheKey }
  return data.access_token
}

function darajaTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export async function initiateStkPush(payment, phone) {
  const config = getMpesaConfig()
  if (!config.configured) throw new Error('M-Pesa is not configured')
  const normalized = normalizePhone(phone)
  if (!/^254\d{9}$/.test(normalized)) throw new Error('Enter a valid Safaricom phone number')
  const token = await accessToken(config)
  const timestamp = darajaTimestamp()
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64')

  const res = await fetch(`${config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.max(1, Math.round(payment.amount)),
      PartyA: normalized,
      PartyB: config.shortcode,
      PhoneNumber: normalized,
      CallBackURL: config.callbackUrl,
      AccountReference: payment.ref.slice(0, 12),
      TransactionDesc: 'CoryPulse Wi-Fi voucher',
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`M-Pesa request failed (${res.status}): ${text.slice(0, 200)}`)
  const data = JSON.parse(text)
  if (!data.CheckoutRequestID) throw new Error(data.errorMessage || 'M-Pesa did not return a checkout request')
  await db.prepare("UPDATE payments SET method = 'mpesa', provider_ref = ?, phone = ? WHERE id = ?").run(
    data.CheckoutRequestID,
    normalized,
    payment.id
  )
  return { checkoutRequestId: data.CheckoutRequestID, customerMessage: data.CustomerMessage }
}

export async function queryStkStatus(payment) {
  const config = getMpesaConfig()
  if (!config.configured || !payment.provider_ref) return null
  const token = await accessToken(config)
  const timestamp = darajaTimestamp()
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64')
  const res = await fetch(`${config.baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: payment.provider_ref,
    }),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.slice(0, 200) }
  }
}

export async function markPaymentPaid(paymentId, { method, providerRef } = {}) {
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
  if (!payment) return { ok: false, error: 'Payment not found' }
  if (payment.status === 'paid') {
    return { ok: true, alreadyPaid: true, voucher: payment.voucher_id ? await getVoucherById(payment.voucher_id) : null }
  }
  if (payment.status === 'refunded') return { ok: false, error: 'This payment was refunded' }

  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(payment.plan_id)
  if (!plan) return { ok: false, error: 'The plan for this payment no longer exists' }

  let voucher
  await db.transaction(async () => {
    await db
      .prepare(
        "UPDATE payments SET status = 'paid', paid_at = ?, method = COALESCE(?, method), provider_ref = COALESCE(?, provider_ref) WHERE id = ?"
      )
      .run(nowIso(), method || null, providerRef || null, payment.id)
    voucher = await createVoucher(plan, {
      siteId: payment.site_id,
      customerId: payment.customer_id,
      paymentId: payment.id,
      pricePaid: payment.amount,
    })
    await db.prepare('UPDATE payments SET voucher_id = ? WHERE id = ?').run(voucher.id, payment.id)
  })()

  const site = await db.prepare('SELECT name FROM sites WHERE id = ?').get(payment.site_id)
  logEvent({
    siteId: payment.site_id,
    severity: 'info',
    kind: 'sale',
    message: `${payerLabel(payment)} bought ${plan.name} for ${payment.currency} ${payment.amount} at ${site?.name || 'site'}`,
  })
  broadcast('sale', {
    paymentId: payment.id,
    ref: payment.ref,
    amount: payment.amount,
    currency: payment.currency,
    plan: plan.name,
    site: site?.name || '',
    voucherId: voucher.id,
    voucherCode: voucher.code,
  })
  return { ok: true, voucher, paymentId: payment.id }
}

function payerLabel(payment) {
  return payment.customer_name || payment.phone || payment.ref
}

export async function refundPayment(paymentId, { disableVoucher = true } = {}) {
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
  if (!payment) return { ok: false, error: 'Payment not found' }
  if (payment.status !== 'paid') return { ok: false, error: 'Only paid payments can be refunded' }

  await db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id)
  if (disableVoucher && payment.voucher_id) {
    const voucher = await getVoucherById(payment.voucher_id)
    if (voucher && voucher.status !== 'disabled') {
      await disableVoucher(voucher.id)
    }
  }
  logEvent({
    siteId: payment.site_id,
    severity: 'warning',
    kind: 'refund',
    message: `Refund issued for ${payment.ref} (${payment.currency} ${payment.amount})`,
  })
  broadcast('refund', { paymentId: payment.id, ref: payment.ref })
  return { ok: true }
}

export function settingsForClient() {
  const config = getMpesaConfig()
  return {
    company_name: getSetting('company_name', 'CoryPulse'),
    currency: getSetting('currency', 'KES'),
    demo_payments: getSetting('demo_payments', '0') === '1',
    mpesa: publicMpesaState(),
    callback_secret_set: Boolean(config.callbackSecret),
    masked: Object.fromEntries(SECRET_KEYS.map((key) => [key, Boolean(getSetting(key, ''))])),
  }
}

export function ensureCallbackSecret() {
  const existing = getSetting('mpesa_callback_secret', '')
  if (existing) return existing
  const secret = crypto.randomBytes(24).toString('hex')
  setSetting('mpesa_callback_secret', secret)
  return secret
}

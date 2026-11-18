import { db, logEvent, nowIso, addMinutes } from './db.js'
import { provisionVoucher, revokeVoucher } from './mikrotik.js'
import { uniqueVoucherCode } from './utils.js'
import { broadcast } from './sse.js'

export async function getVoucherById(id) {
  return db
    .prepare(
      `SELECT v.*, p.name AS plan_name, p.duration_minutes, p.data_mb, p.devices,
              p.download_kbps, p.upload_kbps, p.hotspot_profile AS plan_profile,
              s.name AS site_name, s.ssid AS site_ssid
       FROM vouchers v
       JOIN plans p ON p.id = v.plan_id
       LEFT JOIN sites s ON s.id = v.site_id
       WHERE v.id = ?`
    )
    .get(id)
}

export async function createVoucher(plan, options = {}) {
  const code = options.code || (await uniqueVoucherCode(options.prefix || 'CP'))
  const result = await db
    .prepare(
      `INSERT INTO vouchers
        (code, plan_id, site_id, router_id, customer_id, payment_id, status, price_paid, created_at, activated_at, expires_at, provisioned, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      plan.id,
      options.siteId ?? null,
      options.routerId ?? null,
      options.customerId ?? null,
      options.paymentId ?? null,
      options.status || 'unused',
      options.pricePaid ?? plan.price ?? 0,
      options.createdAt || nowIso(),
      options.activatedAt || null,
      options.expiresAt || null,
      options.provisioned ? 1 : 0,
      options.notes || null
    )
  return db.prepare('SELECT * FROM vouchers WHERE id = ?').get(result.lastInsertRowid)
}

async function routerForVoucher(voucher) {
  if (voucher.router_id) {
    const router = await db.prepare('SELECT * FROM routers WHERE id = ?').get(voucher.router_id)
    if (router) return router
  }
  if (voucher.site_id) {
    return db.prepare('SELECT * FROM routers WHERE site_id = ? ORDER BY id LIMIT 1').get(voucher.site_id)
  }
  return null
}

export async function activateVoucher(voucherOrId, via = 'portal') {
  const voucher =
    typeof voucherOrId === 'object' && voucherOrId !== null
      ? await getVoucherById(voucherOrId.id)
      : await getVoucherById(voucherOrId)

  if (!voucher) return { ok: false, error: 'Voucher not found' }
  if (voucher.status === 'disabled') return { ok: false, error: 'This voucher has been disabled' }
  if (voucher.status === 'expired') return { ok: false, error: 'This voucher has expired' }
  if (voucher.status === 'active' && voucher.expires_at && voucher.expires_at > nowIso()) {
    return {
      ok: true,
      alreadyActive: true,
      code: voucher.code,
      expires_at: voucher.expires_at,
      activated_at: voucher.activated_at,
      plan_name: voucher.plan_name,
      plan_id: voucher.plan_id,
      site_ssid: voucher.site_ssid,
      provisioned: Boolean(voucher.provisioned),
    }
  }

  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(voucher.plan_id)
  if (!plan) return { ok: false, error: 'The plan for this voucher no longer exists' }

  const router = await routerForVoucher(voucher)
  const activatedAt = nowIso()
  const expiresAt = addMinutes(plan.duration_minutes)

  await db
    .prepare(
      `UPDATE vouchers
       SET status = 'active', activated_at = ?, expires_at = ?, router_id = ?, provisioned = 0
       WHERE id = ?`
    )
    .run(activatedAt, expiresAt, router?.id ?? voucher.router_id ?? null, voucher.id)

  let provisioned = false
  let provisionError = null
  if (router) {
    try {
      await provisionVoucher(router, plan, { ...voucher, code: voucher.code })
      provisioned = true
      await db.prepare('UPDATE vouchers SET provisioned = 1 WHERE id = ?').run(voucher.id)
    } catch (err) {
      provisionError = err.message
      logEvent({
        siteId: voucher.site_id,
        routerId: router.id,
        severity: 'warning',
        kind: 'provision_failed',
        message: `Voucher ${voucher.code} activated but not added to ${router.name}: ${err.message}`,
      })
    }
  } else {
    provisionError = 'No router is assigned to this site'
  }

  logEvent({
    siteId: voucher.site_id,
    routerId: router?.id ?? null,
    severity: 'info',
    kind: 'voucher_activated',
    message: `${voucher.code} activated via ${via} (${plan.name})`,
  })
  broadcast('voucher', { id: voucher.id, code: voucher.code, status: 'active', expiresAt })

  return {
    ok: true,
    code: voucher.code,
    expires_at: expiresAt,
    activated_at: activatedAt,
    plan_name: plan.name,
    plan_id: plan.id,
    site_ssid: voucher.site_ssid,
    provisioned,
    provisionError,
  }
}

export async function disableVoucher(voucherId) {
  const voucher = await getVoucherById(voucherId)
  if (!voucher) return { ok: false, error: 'Voucher not found' }
  await db.prepare("UPDATE vouchers SET status = 'disabled' WHERE id = ?").run(voucher.id)
  const router = await routerForVoucher(voucher)
  if (router) {
    try {
      await revokeVoucher(router, voucher.code)
    } catch {
      // logging happens inside revokeVoucher
    }
  }
  logEvent({
    siteId: voucher.site_id,
    routerId: router?.id ?? null,
    severity: 'warning',
    kind: 'voucher_disabled',
    message: `${voucher.code} was disabled`,
  })
  broadcast('voucher', { id: voucher.id, code: voucher.code, status: 'disabled' })
  return { ok: true }
}

export async function expireVoucher(voucher) {
  await db.prepare("UPDATE vouchers SET status = 'expired' WHERE id = ?").run(voucher.id)
  const router = await routerForVoucher(voucher)
  if (router) {
    try {
      await revokeVoucher(router, voucher.code)
    } catch {
      // best effort
    }
  }
  logEvent({
    siteId: voucher.site_id,
    routerId: router?.id ?? null,
    severity: 'info',
    kind: 'voucher_expired',
    message: `${voucher.code} expired (${voucher.plan_name || 'plan'})`,
  })
  broadcast('voucher', { id: voucher.id, code: voucher.code, status: 'expired' })
}

export async function generateBatch({ planId, siteId, count, prefix }) {
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) throw new Error('Plan not found')
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId)
  if (!site) throw new Error('Site not found')
  const router = await db
    .prepare('SELECT * FROM routers WHERE site_id = ? ORDER BY id LIMIT 1')
    .get(siteId)
  const created = []
  await db.transaction(async () => {
    for (let i = 0; i < count; i += 1) {
      created.push(
        await createVoucher(plan, {
          siteId,
          routerId: router?.id ?? null,
          pricePaid: plan.price,
          prefix: prefix || 'CP',
        })
      )
    }
  })()
  logEvent({
    siteId,
    severity: 'info',
    kind: 'vouchers_generated',
    message: `${created.length} vouchers generated for ${plan.name} at ${site.name}`,
  })
  broadcast('vouchers_generated', { count: created.length, siteId, planId })
  return created
}

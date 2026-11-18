import { db, logEvent } from './db.js'
import { decryptSecret } from './crypto.js'
import { RouterOsClient } from './routeros.js'
import { SimulatedRouter } from './simulator.js'
import { formatUptime, parseUptime } from './utils.js'

const simulated = new Map()
const live = new Map()
const IDLE_CLOSE_MS = 120_000

setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of live) {
    if (now - entry.lastUsed > IDLE_CLOSE_MS) {
      entry.client.close()
      live.delete(id)
    }
  }
}, 60_000).unref()

function simulatedClient(router) {
  let client = simulated.get(router.id)
  if (!client) {
    client = new SimulatedRouter(router)
    simulated.set(router.id, client)
  }
  return client
}

export function forgetSimulated(routerId) {
  simulated.delete(routerId)
  const entry = live.get(routerId)
  if (entry) {
    entry.client.close()
    live.delete(routerId)
  }
}

export async function getClient(router) {
  if (router.mode === 'simulated') return simulatedClient(router)

  const existing = live.get(router.id)
  if (existing && !existing.client.closed) {
    existing.lastUsed = Date.now()
    return existing.client
  }
  if (!router.host || !router.username || !router.secret_enc) {
    throw new Error('Router host, username, and password are required')
  }
  const password = decryptSecret(router.secret_enc)
  const client = await RouterOsClient.connect({
    host: router.host,
    port: router.port || 8728,
    username: router.username,
    password,
    useTls: Boolean(router.use_tls),
  })
  live.set(router.id, { client, lastUsed: Date.now() })
  return client
}

export async function testRouter(router) {
  const client = await getClient(router)
  const identity = await client.exec('/system/identity/print')
  const resource = await client.exec('/system/resource/print')
  const info = resource[0] || {}
  return {
    ok: true,
    identity: identity[0]?.name || router.name,
    version: info.version || 'unknown',
    board: info['board-name'] || 'unknown',
    cpu: Number(info['cpu-load'] || 0),
    uptime: info.uptime || '',
    simulated: router.mode === 'simulated',
  }
}

export async function pollRouter(router, { includeSessions = true } = {}) {
  const client = await getClient(router)
  const requests = [client.exec('/system/resource/print'), client.exec('/interface/print')]
  if (includeSessions) requests.push(client.exec('/ip/hotspot/active/print'))
  const [resource, interfaces, active = []] = await Promise.all(requests)
  const info = resource[0] || {}
  let rxBytes = 0
  let txBytes = 0
  const plain = interfaces.filter((iface) => iface.type !== 'wlan' || !interfaces.some((i) => i.name === 'ether1'))
  const ether = interfaces.find((iface) => iface.name === 'ether1')
  const counted = ether ? [ether] : plain
  for (const iface of counted) {
    rxBytes += Number(iface['rx-byte'] || 0)
    txBytes += Number(iface['tx-byte'] || 0)
  }
  const sessions = active.map((row) => ({
    username: row.user || '',
    address: row.address || '',
    uptime_s: parseUptime(row.uptime),
    rx_bytes: Number(row['bytes-in'] || 0),
    tx_bytes: Number(row['bytes-out'] || 0),
  }))
  return {
    cpu: Number(info['cpu-load'] || 0),
    uptime_s: parseUptime(info.uptime),
    uptime_text: info.uptime || '',
    free_memory: Number(info['free-memory'] || 0),
    version: info.version || '',
    rx_bytes: rxBytes,
    tx_bytes: txBytes,
    sessions,
  }
}

function sanitizeComment(text) {
  return String(text || '').replace(/[\r\n]/g, ' ').slice(0, 120)
}

export async function provisionVoucher(router, plan, voucher) {
  if (router.mode === 'simulated') {
    const client = simulatedClient(router)
    await client.exec('/ip/hotspot/user/add', {
      name: voucher.code,
      password: voucher.code,
      profile: plan.hotspot_profile || router.hotspot_profile || 'default',
      'limit-uptime': formatUptime(plan.duration_minutes),
      'limit-bytes-total': plan.data_mb ? String(plan.data_mb * 1024 * 1024) : '',
      'rate-limit': plan.download_kbps ? `${plan.download_kbps}k/${plan.upload_kbps || plan.download_kbps}k` : '',
      comment: sanitizeComment(`CoryPulse ${plan.name}`),
    })
    return { ok: true, simulated: true }
  }

  const client = await getClient(router)
  await client.exec('/ip/hotspot/user/add', {
    name: voucher.code,
    password: voucher.code,
    profile: plan.hotspot_profile || router.hotspot_profile || 'default',
    'limit-uptime': formatUptime(plan.duration_minutes),
    'limit-bytes-total': plan.data_mb ? String(plan.data_mb * 1024 * 1024) : '',
    'rate-limit': plan.download_kbps ? `${plan.download_kbps}k/${plan.upload_kbps || plan.download_kbps}k` : '',
    comment: sanitizeComment(`CoryPulse ${plan.name}`),
  })
  return { ok: true, simulated: false }
}

export async function revokeVoucher(router, code) {
  if (router.mode === 'simulated') {
    const client = simulatedClient(router)
    await client.exec('/ip/hotspot/active/remove', { numbers: code })
    await client.exec('/ip/hotspot/user/remove', { numbers: code })
    return { ok: true }
  }
  const client = await getClient(router)
  try {
    await client.exec('/ip/hotspot/active/remove', { numbers: code })
  } catch {
    // the guest may not be online
  }
  try {
    await client.exec('/ip/hotspot/user/remove', { numbers: code })
  } catch (err) {
    logEvent({
      routerId: router.id,
      siteId: router.site_id,
      severity: 'warning',
      kind: 'voucher_revoke',
      message: `Could not remove ${code} from ${router.name}: ${err.message}`,
    })
    throw err
  }
  return { ok: true }
}

export function resetRouterState(router) {
  if (router.mode === 'simulated') simulated.delete(router.id)
  const entry = live.get(router.id)
  if (entry) {
    entry.client.close()
    live.delete(router.id)
  }
}

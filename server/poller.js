import { db, logEvent, nowIso } from './db.js'
import { pollRouter, resetRouterState } from './mikrotik.js'
import { expireVoucher } from './vouchers.js'
import { broadcast } from './sse.js'
import {
  instanceId,
  pollConcurrency,
  pollIntervalSeconds,
  metricRetentionDays,
  logRetentionDays,
  eventRetentionDays,
} from './config.js'

let polling = false
let timers = []
const POLL_TICK_MS = 5000
const SESSION_CHUNK = 500

function intervalFor(router) {
  if (router.mode === 'simulated') return 15
  return Math.max(15, Number(router.poll_interval_s || pollIntervalSeconds))
}

async function claimDueRouters(limit) {
  return db
    .prepare(
      `UPDATE routers SET poll_owner = ?, poll_lease_until = now() + interval '5 minutes'
       WHERE id IN (
         SELECT id FROM routers
         WHERE (next_poll_at IS NULL OR next_poll_at <= now())
           AND (poll_lease_until IS NULL OR poll_lease_until < now())
         ORDER BY next_poll_at ASC NULLS FIRST
         LIMIT ?
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    )
    .all(instanceId, limit)
}

async function replaceSessions(router, sessions, ts) {
  const unique = new Map()
  for (const session of sessions) {
    if (session.username) unique.set(session.username, session)
  }
  const rows = [...unique.values()]
  for (let offset = 0; offset < rows.length; offset += SESSION_CHUNK) {
    const chunk = rows.slice(offset, offset + SESSION_CHUNK)
    const values = []
    const params = []
    chunk.forEach((session, index) => {
      const base = index * 8
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
      )
      params.push(
        router.id,
        router.site_id,
        session.username,
        session.address || null,
        session.uptime_s || 0,
        session.rx_bytes || 0,
        session.tx_bytes || 0,
        ts
      )
    })
    await db.query(
      `INSERT INTO active_sessions
         (router_id, site_id, username, address, uptime_s, rx_bytes, tx_bytes, updated_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (router_id, username) DO UPDATE SET
         site_id = EXCLUDED.site_id,
         address = EXCLUDED.address,
         uptime_s = EXCLUDED.uptime_s,
         rx_bytes = EXCLUDED.rx_bytes,
         tx_bytes = EXCLUDED.tx_bytes,
         updated_at = EXCLUDED.updated_at`,
      params
    )
  }
  await db
    .prepare('DELETE FROM active_sessions WHERE router_id = ? AND updated_at < ?')
    .run(router.id, ts)
}

export async function pollRouterNow(router) {
  const nowMs = Date.now()
  const includeSessions = router.mode === 'simulated' || !router.radius_secret_enc
  const result = await pollRouter(router, { includeSessions })

  const previous = await db
    .prepare('SELECT rx_bytes, tx_bytes, ts FROM router_metrics WHERE router_id = ? ORDER BY ts DESC LIMIT 1')
    .get(router.id)
  const seconds = previous ? Math.max(1, (nowMs - new Date(previous.ts).getTime()) / 1000) : null
  const rxBps =
    previous && seconds
      ? Math.round((Math.max(0, result.rx_bytes - Number(previous.rx_bytes)) * 8) / seconds)
      : 0
  const txBps =
    previous && seconds
      ? Math.round((Math.max(0, result.tx_bytes - Number(previous.tx_bytes)) * 8) / seconds)
      : 0

  let activeUsers = 0
  if (includeSessions) {
    activeUsers = result.sessions.length
  } else {
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM active_sessions WHERE router_id = ?')
      .get(router.id)
    activeUsers = count.n
  }

  const ts = new Date(nowMs).toISOString()
  const nextPollAt = new Date(nowMs + intervalFor(router) * 1000).toISOString()

  await db
    .prepare(
      `UPDATE routers SET status = 'online', last_seen = ?, last_error = NULL, last_poll_at = ?,
         next_poll_at = ?, consecutive_failures = 0, poll_owner = NULL, poll_lease_until = NULL
       WHERE id = ?`
    )
    .run(ts, ts, nextPollAt, router.id)

  await db
    .prepare(
      `INSERT INTO router_metrics
         (router_id, site_id, ts, cpu, uptime_s, rx_bytes, tx_bytes, rx_bps, tx_bps, active_users)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      router.id,
      router.site_id,
      ts,
      result.cpu,
      result.uptime_s,
      result.rx_bytes,
      result.tx_bytes,
      rxBps,
      txBps,
      activeUsers
    )

  if (includeSessions) {
    await replaceSessions(router, result.sessions, ts)
  }

  if (router.status !== 'online') {
    logEvent({
      siteId: router.site_id,
      routerId: router.id,
      severity: 'info',
      kind: 'router_online',
      message: `${router.name} is online`,
      source: 'poller',
    })
  }

  const payload = {
    routerId: router.id,
    siteId: router.site_id,
    name: router.name,
    status: 'online',
    cpu: result.cpu,
    uptime_s: result.uptime_s,
    uptime_text: result.uptime_text,
    free_memory: result.free_memory,
    rx_bps: rxBps,
    tx_bps: txBps,
    users: activeUsers,
    ts,
  }
  broadcast('router', payload)
  return payload
}

async function handleFailure(router, err) {
  const failures = Number(router.consecutive_failures || 0) + 1
  const base = intervalFor(router)
  const backoff = Math.min(900, base * Math.min(8, 2 ** (failures - 1)))
  const nextPollAt = new Date(Date.now() + backoff * 1000).toISOString()

  await db
    .prepare(
      `UPDATE routers SET status = 'offline', last_error = ?, consecutive_failures = ?,
         last_poll_at = ?, next_poll_at = ?, poll_owner = NULL, poll_lease_until = NULL
       WHERE id = ?`
    )
    .run(err.message, failures, nowIso(), nextPollAt, router.id)

  if (router.status !== 'offline') {
    // Never clear sessions on an API failure: RADIUS accounting may still be
    // updating them. Stale rows are reaped by pruneHistory instead.
    logEvent({
      siteId: router.site_id,
      routerId: router.id,
      severity: 'critical',
      kind: 'router_offline',
      message: `${router.name} is unreachable: ${err.message}`,
      source: 'poller',
    })
    resetRouterState(router)
    broadcast('router', {
      routerId: router.id,
      siteId: router.site_id,
      name: router.name,
      status: 'offline',
      error: err.message,
      users: 0,
      ts: nowIso(),
    })
  }
}

async function pollOne(router) {
  try {
    await pollRouterNow(router)
  } catch (err) {
    await handleFailure(router, err).catch((failureErr) => {
      console.error(`[poller] could not record failure for ${router.name}:`, failureErr.message)
    })
  }
}

export async function pollAll() {
  if (polling) return
  polling = true
  try {
    for (let batch = 0; batch < 100; batch += 1) {
      const routers = await claimDueRouters(pollConcurrency)
      if (!routers.length) break
      await Promise.all(routers.map((router) => pollOne(router)))
      if (routers.length < pollConcurrency) break
    }
  } catch (err) {
    console.error('[poller] sweep failed:', err.message)
  } finally {
    polling = false
  }
}

export async function coverageStats() {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (
                WHERE last_seen IS NOT NULL
                  AND last_seen > now() - make_interval(secs => GREATEST(COALESCE(poll_interval_s, 60) * 3, 180))
              ) AS fresh
       FROM routers`
    )
    .get()
  return { total: row.total, fresh: row.fresh, stale: row.total - row.fresh }
}

async function checkCoverage() {
  const rows = await db
    .prepare(
      `UPDATE routers SET coverage_alert_at = now()
       WHERE id IN (
         SELECT id FROM routers
         WHERE (last_seen IS NULL
                OR last_seen < now() - make_interval(secs => GREATEST(COALESCE(poll_interval_s, 60) * 3, 180)))
           AND (coverage_alert_at IS NULL OR coverage_alert_at < now() - interval '1 hour')
         LIMIT 200
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, name, site_id, last_seen`
    )
    .all()
  for (const router of rows) {
    const minutes = router.last_seen
      ? Math.max(1, Math.round((Date.now() - new Date(router.last_seen).getTime()) / 60_000))
      : null
    logEvent({
      siteId: router.site_id,
      routerId: router.id,
      severity: 'warning',
      kind: 'router_coverage_gap',
      message:
        minutes === null
          ? `${router.name} has never reported`
          : `${router.name} has not reported for ${minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`}`,
      source: 'coverage',
    })
  }
}

async function expireDueVouchers() {
  const due = await db
    .prepare("SELECT * FROM vouchers WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()")
    .all()
  if (!due.length) return
  for (const voucher of due) {
    await expireVoucher(voucher).catch((err) => {
      console.error(`[poller] could not expire ${voucher.code}:`, err.message)
    })
  }
  broadcast('vouchers_expired', { count: due.length })
}

async function pruneHistory() {
  const jobs = [
    ['router_metrics', metricRetentionDays],
    ['router_logs', logRetentionDays],
    ['events', eventRetentionDays],
    ['session_events', eventRetentionDays],
    ['ingest_stats', 30],
  ]
  for (const [table, days] of jobs) {
    await db
      .prepare(`DELETE FROM ${table} WHERE ts < now() - make_interval(days => ?)`)
      .run(days)
      .catch((err) => console.error(`[poller] retention ${table} failed:`, err.message))
  }
  await db
    .prepare('DELETE FROM sessions WHERE expires_at < now()')
    .run()
    .catch(() => {})
}

async function pruneActiveSessions() {
  await db
    .prepare("DELETE FROM active_sessions WHERE updated_at < now() - interval '30 minutes'")
    .run()
    .catch(() => {})
}

export function startPoller() {
  if (timers.length) return
  setTimeout(() => pollAll().catch(() => {}), 1000)
  timers = [
    setInterval(() => pollAll().catch(() => {}), POLL_TICK_MS),
    setInterval(() => expireDueVouchers().catch(() => {}), 30_000),
    setInterval(() => checkCoverage().catch(() => {}), 60_000),
    setInterval(() => pruneActiveSessions().catch(() => {}), 5 * 60_000),
    setInterval(() => pruneHistory().catch(() => {}), 6 * 60 * 60_000),
  ]
  for (const timer of timers) timer.unref?.()
}

export function stopPoller() {
  for (const timer of timers) clearInterval(timer)
  timers = []
}

import crypto from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'
import { pool, logEvent } from './db.js'
import { decryptSecret } from './crypto.js'
import {
  ingestEnabled,
  instanceId,
  radiusPort,
  radiusSecret,
  syslogPort,
  syslogTcpPort,
} from './config.js'

const ACCT_STATUS = { 1: 'start', 2: 'stop', 3: 'interim-update', 7: 'accounting-on', 8: 'accounting-off' }
const ATTR = {
  USER_NAME: 1,
  NAS_IP: 4,
  FRAMED_IP: 8,
  CALLED_STATION: 30,
  CALLING_STATION: 31,
  NAS_IDENTIFIER: 32,
  ACCT_STATUS: 40,
  ACCT_DELAY: 41,
  ACCT_INPUT_OCTETS: 42,
  ACCT_OUTPUT_OCTETS: 43,
  ACCT_SESSION_ID: 44,
  ACCT_SESSION_TIME: 46,
  ACCT_TERMINATE_CAUSE: 49,
  ACCT_INPUT_GIGAWORDS: 52,
  ACCT_OUTPUT_GIGAWORDS: 53,
}

const stats = {
  radius: { messages: 0, errors: 0, starts: 0, stops: 0, interim: 0, rejected: 0 },
  syslog: { messages: 0, errors: 0, unmatched: 0, udp: 0, tcp: 0 },
  since: Date.now(),
}

const sockets = []
let statsTimer = null
let flushTimer = null
let running = false

/* ----------------------------------------------------------- router mapping */

const routerCache = new Map()
let routersLoadedAt = 0
let routerLoad = null

async function loadRouters(force = false) {
  if (!force && Date.now() - routersLoadedAt < 30_000) return
  if (routerLoad) return routerLoad
  routerLoad = (async () => {
    try {
      const { rows } = await pool.query(
        'SELECT id, site_id, name, host, nas_ip, radius_secret_enc FROM routers'
      )
      routerCache.clear()
      for (const row of rows) {
        let secret = radiusSecret
        if (row.radius_secret_enc) {
          try {
            secret = decryptSecret(row.radius_secret_enc) || radiusSecret
          } catch (err) {
            console.error(`[ingest] cannot decrypt RADIUS secret for router ${row.id}: ${err.message}`)
          }
        }
        const entry = { ...row, secret }
        if (row.nas_ip) routerCache.set(`ip:${row.nas_ip}`, entry)
        if (row.host) routerCache.set(`ip:${row.host}`, entry)
        if (row.name) routerCache.set(`name:${String(row.name).toLowerCase()}`, entry)
      }
      routersLoadedAt = Date.now()
    } catch (err) {
      console.error('[ingest] router map refresh failed:', err.message)
    } finally {
      routerLoad = null
    }
  })()
  return routerLoad
}

async function findRouter(nasIp, identifier) {
  if (nasIp && routerCache.has(`ip:${nasIp}`)) return routerCache.get(`ip:${nasIp}`)
  if (identifier) {
    const key = `name:${String(identifier).toLowerCase()}`
    if (routerCache.has(key)) return routerCache.get(key)
  }
  await loadRouters(true)
  if (nasIp && routerCache.has(`ip:${nasIp}`)) return routerCache.get(`ip:${nasIp}`)
  if (identifier) return routerCache.get(`name:${String(identifier).toLowerCase()}`) || null
  return null
}

const seenMarks = new Map()

function markRouterSeen(router) {
  const last = seenMarks.get(router.id) || 0
  if (Date.now() - last < 60_000) return
  seenMarks.set(router.id, Date.now())
  pending.seen.set(router.id, router.site_id)
  scheduleFlush()
}

/* ------------------------------------------------------------ write buffers */

const pending = {
  radius: new Map(),
  active: new Map(),
  activeDeletes: new Map(),
  seen: new Map(),
  logs: [],
  sessionEvents: [],
}

// If PostgreSQL goes away, accounting keeps arriving. Without a ceiling the
// buffers would grow until the process is killed; instead the oldest rows are
// shed so the newest live state still lands when the database returns.
const MAX_PENDING_ROWS = 150_000
const MAX_PENDING_LINES = 40_000
let droppedRows = 0
let lastDropLog = 0

function trimPending() {
  let excess = pending.radius.size + pending.active.size + pending.activeDeletes.size - MAX_PENDING_ROWS
  if (excess > 0) {
    for (const map of [pending.radius, pending.active, pending.activeDeletes]) {
      for (const key of map.keys()) {
        if (excess <= 0) break
        map.delete(key)
        excess -= 1
        droppedRows += 1
      }
      if (excess <= 0) break
    }
  }
  if (pending.logs.length > MAX_PENDING_LINES) {
    droppedRows += pending.logs.length - MAX_PENDING_LINES
    pending.logs.length = MAX_PENDING_LINES
  }
  if (pending.sessionEvents.length > MAX_PENDING_LINES) {
    droppedRows += pending.sessionEvents.length - MAX_PENDING_LINES
    pending.sessionEvents.length = MAX_PENDING_LINES
  }
  if (droppedRows && Date.now() - lastDropLog > 30_000) {
    lastDropLog = Date.now()
    console.error(`[ingest] write buffer over capacity, shed ${droppedRows} rows so far`)
  }
}

let flushDelay = 400

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPending().catch((err) => console.error('[ingest] flush failed:', err.message))
  }, flushDelay)
  flushTimer.unref()
}

let flushing = false

function requeue(radiusRows, activeRows, deletes, seenIds, logs, sessionEvents) {
  for (const row of radiusRows) {
    const key = `${row.routerId}:${row.acctSessionId}`
    if (!pending.radius.has(key)) pending.radius.set(key, row)
  }
  for (const row of activeRows) {
    const key = `${row.routerId}:${row.username}`
    if (!pending.active.has(key)) pending.active.set(key, row)
  }
  for (const row of deletes) {
    const key = `${row.routerId}:${row.username}`
    if (!pending.activeDeletes.has(key)) pending.activeDeletes.set(key, row)
  }
  for (const id of seenIds) if (!pending.seen.has(id)) pending.seen.set(id, null)
  pending.logs.unshift(...logs)
  pending.sessionEvents.unshift(...sessionEvents)
  trimPending()
}

async function flushPending() {
  if (flushing) return
  flushing = true
  const radiusRows = [...pending.radius.values()]
  const activeRows = [...pending.active.values()]
  const deletes = [...pending.activeDeletes.values()]
  const seenIds = [...pending.seen.keys()]
  const logs = pending.logs.splice(0, 4000)
  const sessionEvents = pending.sessionEvents.splice(0, 4000)
  pending.radius.clear()
  pending.active.clear()
  pending.activeDeletes.clear()
  pending.seen.clear()

  try {
    await writeRadius(radiusRows)
    await writeActive(activeRows)
    await writeDeletes(deletes)
    await writeRouterSeen(seenIds)
    await writeLogs(logs)
    await writeSessionEvents(sessionEvents)
    flushDelay = 400
  } catch (err) {
    requeue(radiusRows, activeRows, deletes, seenIds, logs, sessionEvents)
    flushDelay = Math.min(flushDelay * 2, 10_000)
    throw err
  } finally {
    flushing = false
    if (
      pending.radius.size ||
      pending.active.size ||
      pending.activeDeletes.size ||
      pending.seen.size ||
      pending.logs.length ||
      pending.sessionEvents.length
    ) {
      scheduleFlush()
    }
  }
}

async function writeRouterSeen(ids) {
  for (const batch of chunks(ids)) {
    const values = batch.map((_, i) => `($${i + 1}::bigint)`).join(', ')
    await pool.query(
      `UPDATE routers r SET status = 'online', last_seen = now(), consecutive_failures = 0,
         last_error = NULL, coverage_alert_at = NULL
       FROM (VALUES ${values}) AS v(id) WHERE r.id = v.id`,
      batch
    )
  }
}

// PostgreSQL rejects statements above 65,535 bind parameters, so rows are
// written in chunks small enough for the widest insert (15 params/row).
const WRITE_CHUNK = 2000

function chunks(rows, size = WRITE_CHUNK) {
  const result = []
  for (let start = 0; start < rows.length; start += size) result.push(rows.slice(start, start + size))
  return result
}

async function writeRadius(radiusRows) {
  for (const batch of chunks(radiusRows)) {
    const values = []
    const params = []
    batch.forEach((row, i) => {
      const b = i * 15
      values.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13}, $${b + 14}, $${b + 15})`
      )
      params.push(
        row.acctSessionId,
        row.routerId,
        row.siteId,
        row.username,
        row.address,
        row.callingStationId,
        row.nasIp,
        row.startedAt,
        row.lastSeenAt,
        row.stoppedAt,
        row.sessionSeconds,
        row.rxBytes,
        row.txBytes,
        row.terminateCause,
        row.status
      )
    })
    await pool.query(
      `INSERT INTO radius_sessions
         (acct_session_id, router_id, site_id, username, address, calling_station_id, nas_ip,
          started_at, last_seen_at, stopped_at, session_seconds, rx_bytes, tx_bytes, terminate_cause, status)
       VALUES ${values.join(', ')}
       ON CONFLICT (router_id, acct_session_id) DO UPDATE SET
         site_id = EXCLUDED.site_id,
         username = EXCLUDED.username,
         address = EXCLUDED.address,
         calling_station_id = EXCLUDED.calling_station_id,
         nas_ip = EXCLUDED.nas_ip,
         last_seen_at = EXCLUDED.last_seen_at,
         stopped_at = COALESCE(EXCLUDED.stopped_at, radius_sessions.stopped_at),
         session_seconds = GREATEST(radius_sessions.session_seconds, EXCLUDED.session_seconds),
         rx_bytes = GREATEST(radius_sessions.rx_bytes, EXCLUDED.rx_bytes),
         tx_bytes = GREATEST(radius_sessions.tx_bytes, EXCLUDED.tx_bytes),
         terminate_cause = COALESCE(EXCLUDED.terminate_cause, radius_sessions.terminate_cause),
         status = CASE WHEN radius_sessions.status = 'stopped' THEN 'stopped' ELSE EXCLUDED.status END`,
      params
    )
  }
}

async function writeActive(activeRows) {
  for (const batch of chunks(activeRows)) {
    const values = []
    const params = []
    batch.forEach((row, i) => {
      const b = i * 8
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`)
      params.push(row.routerId, row.siteId, row.username, row.address, row.uptimeS, row.rxBytes, row.txBytes, row.updatedAt)
    })
    await pool.query(
      `INSERT INTO active_sessions (router_id, site_id, username, address, uptime_s, rx_bytes, tx_bytes, updated_at)
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
}

async function writeDeletes(deletes) {
  for (const batch of chunks(deletes)) {
    const values = batch.map((row, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
    const params = batch.flatMap((row) => [row.routerId, row.username])
    await pool.query(`DELETE FROM active_sessions WHERE (router_id, username) IN (${values})`, params)
  }
}

async function writeLogs(logs) {
  for (const batch of chunks(logs)) {
    const values = []
    const params = []
    batch.forEach((row, i) => {
      const b = i * 8
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`)
      params.push(row.ts, row.routerId, row.siteId, row.facility, row.topic, row.severity, row.message, JSON.stringify(row.raw))
    })
    await pool.query(
      `INSERT INTO router_logs (ts, router_id, site_id, facility, topic, severity, message, raw)
       VALUES ${values.join(', ')}`,
      params
    )
  }
}

async function writeSessionEvents(sessionEvents) {
  for (const batch of chunks(sessionEvents)) {
    const values = []
    const params = []
    batch.forEach((row, i) => {
      const b = i * 10
      values.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`
      )
      params.push(
        row.ts,
        row.routerId,
        row.siteId,
        row.username,
        row.kind,
        row.sessionSeconds,
        row.rxBytes,
        row.txBytes,
        JSON.stringify(row.payload),
        row.payload.sessionId
      )
    })
    await pool.query(
      `INSERT INTO session_events (ts, router_id, site_id, username, kind, session_seconds, rx_bytes, tx_bytes, payload, acct_session_id)
       VALUES ${values.join(', ')}`,
      params
    )
  }
}

/* ------------------------------------------------------------ RADIUS ingest */

function parseAttributes(packet) {
  const attrs = new Map()
  let offset = 20
  while (offset + 2 <= packet.length) {
    const type = packet[offset]
    const length = packet[offset + 1]
    if (length < 2 || offset + length > packet.length) break
    attrs.set(type, packet.subarray(offset + 2, offset + length))
    offset += length
  }
  return attrs
}

function text(attrs, type) {
  const value = attrs.get(type)
  return value ? value.toString('utf8') : ''
}

function integer(attrs, type) {
  const value = attrs.get(type)
  return value && value.length === 4 ? value.readUInt32BE(0) : 0
}

function ipAttr(attrs, type) {
  const value = attrs.get(type)
  return value && value.length === 4 ? [...value].join('.') : ''
}

function requestAuthValid(packet, secret) {
  const expected = crypto
    .createHash('md5')
    .update(packet.subarray(0, 4))
    .update(Buffer.alloc(16))
    .update(packet.subarray(20))
    .update(secret)
    .digest()
  return expected.length === 16 && crypto.timingSafeEqual(expected, packet.subarray(4, 20))
}

function accountingResponse(packet, secret) {
  const response = Buffer.alloc(20)
  response[0] = 5
  response[1] = packet[1]
  response.writeUInt16BE(20, 2)
  const hash = crypto
    .createHash('md5')
    .update(response.subarray(0, 4))
    .update(packet.subarray(4, 20))
    .update(secret)
    .digest()
  hash.copy(response, 4)
  return response
}

function octets(attrs, lowType, gigawordType) {
  return integer(attrs, lowType) + integer(attrs, gigawordType) * 4_294_967_296
}

export async function handleRadiusPacket(packet, rinfo, socket) {
  stats.radius.messages += 1
  if (packet.length < 20 || packet.length > 4096) {
    stats.radius.errors += 1
    return
  }
  const code = packet[0]
  if (code !== 4) {
    stats.radius.errors += 1
    return
  }
  const attrs = parseAttributes(packet)
  const nasIp = ipAttr(attrs, ATTR.NAS_IP) || rinfo.address
  const identifier = text(attrs, ATTR.NAS_IDENTIFIER)
  const router = await findRouter(nasIp, identifier)
  if (!router) {
    stats.radius.rejected += 1
    return
  }
  const secret = router.secret
  if (!secret) {
    stats.radius.rejected += 1
    return
  }
  if (!requestAuthValid(packet, Buffer.from(secret, 'utf8'))) {
    stats.radius.rejected += 1
    return
  }
  if (socket) socket.send(accountingResponse(packet, Buffer.from(secret, 'utf8')), rinfo.port, rinfo.address)

  const status = ACCT_STATUS[integer(attrs, ATTR.ACCT_STATUS)] || 'unknown'

  // Accounting-On/Off signal NAS state and usually carry no Acct-Session-Id,
  // so they must be handled before the session-id requirement below.
  if (status === 'accounting-on' || status === 'accounting-off') {
    const online = status === 'accounting-on'
    seenMarks.set(router.id, Date.now())
    await pool
      .query(
        `UPDATE routers SET status = $2, last_seen = now(), consecutive_failures = 0,
         last_error = NULL, coverage_alert_at = NULL WHERE id = $1`,
        [router.id, online ? 'online' : 'offline']
      )
      .catch(() => {})
    if (!online) {
      pending.active.forEach((row, k) => {
        if (row.routerId === router.id) pending.active.delete(k)
      })
      await pool.query('DELETE FROM active_sessions WHERE router_id = $1', [router.id]).catch(() => {})
    }
    logEvent({
      siteId: router.site_id,
      routerId: router.id,
      severity: online ? 'info' : 'warning',
      kind: online ? 'router_online' : 'router_offline',
      message: `${router.name}: accounting ${online ? 'on' : 'off'} (NAS ${nasIp})`,
      source: 'radius',
    })
    return
  }

  const sessionId = text(attrs, ATTR.ACCT_SESSION_ID)
  if (!sessionId) {
    stats.radius.errors += 1
    return
  }
  const now = new Date()
  const sessionSeconds = integer(attrs, ATTR.ACCT_SESSION_TIME)
  const username = text(attrs, ATTR.USER_NAME) || text(attrs, ATTR.CALLING_STATION) || sessionId
  const address = ipAttr(attrs, ATTR.FRAMED_IP) || text(attrs, ATTR.CALLING_STATION)
  const callingStationId = text(attrs, ATTR.CALLING_STATION)
  const rxBytes = octets(attrs, ATTR.ACCT_INPUT_OCTETS, ATTR.ACCT_INPUT_GIGAWORDS)
  const txBytes = octets(attrs, ATTR.ACCT_OUTPUT_OCTETS, ATTR.ACCT_OUTPUT_GIGAWORDS)
  const terminateCause = status === 'stop' ? String(integer(attrs, ATTR.ACCT_TERMINATE_CAUSE)) : null
  const startedAt = new Date(now.getTime() - sessionSeconds * 1000).toISOString()
  const key = `${router.id}:${sessionId}`

  markRouterSeen(router)

  if (status === 'start') stats.radius.starts += 1
  else if (status === 'stop') stats.radius.stops += 1
  else if (status === 'interim-update') stats.radius.interim += 1

  const stopped = status === 'stop'
  pending.radius.set(key, {
    acctSessionId: sessionId,
    routerId: router.id,
    siteId: router.site_id,
    username,
    address,
    callingStationId,
    nasIp,
    startedAt,
    lastSeenAt: now.toISOString(),
    stoppedAt: stopped ? now.toISOString() : null,
    sessionSeconds,
    rxBytes,
    txBytes,
    terminateCause,
    status: stopped ? 'stopped' : 'active',
  })
  if (stopped) {
    pending.active.delete(key)
    pending.activeDeletes.set(key, { routerId: router.id, username })
  } else {
    pending.activeDeletes.delete(key)
    pending.active.set(key, {
      routerId: router.id,
      siteId: router.site_id,
      username,
      address,
      uptimeS: sessionSeconds,
      rxBytes,
      txBytes,
      updatedAt: now.toISOString(),
    })
  }
  if (status === 'start' || stopped) {
    pending.sessionEvents.push({
      ts: now.toISOString(),
      routerId: router.id,
      siteId: router.site_id,
      username,
      kind: stopped ? 'radius_stop' : 'radius_start',
      sessionSeconds,
      rxBytes,
      txBytes,
      payload: {
        sessionId,
        address,
        callingStationId,
        nasIp,
        terminateCause,
        status,
      },
    })
  }
  trimPending()
  scheduleFlush()
  if (stopped) {
    logEvent({
      siteId: router.site_id,
      routerId: router.id,
      severity: 'info',
      kind: 'session_stop',
      message: `${username} disconnected from ${router.name} after ${Math.round(sessionSeconds / 60)} min`,
      source: 'radius',
    })
  }
  if (pending.radius.size + pending.active.size + pending.logs.length > 6000) await flushPending()
}

/* ------------------------------------------------------------- syslog ingest */

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
const SYSLOG_SEVERITY = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']
const recentAlerts = new Map()

function parseSyslog(line) {
  const match = /^<(\d{1,3})>/.exec(line)
  if (!match) return null
  const priority = Number(match[1])
  let rest = line.slice(match[0].length).trim()
  let ts = new Date()
  let hostname = ''

  const slash = /^([A-Z][a-z]{2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+/.exec(rest)
  const rfc = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+/.exec(rest)
  if (slash) {
    ts = new Date(
      Number(slash[3]),
      MONTHS[slash[1]] ?? 0,
      Number(slash[2]),
      Number(slash[4]),
      Number(slash[5]),
      Number(slash[6])
    )
    rest = rest.slice(slash[0].length)
  } else if (rfc) {
    const now = new Date()
    ts = new Date(
      now.getFullYear(),
      MONTHS[rfc[1]] ?? 0,
      Number(rfc[2]),
      Number(rfc[3]),
      Number(rfc[4]),
      Number(rfc[5])
    )
    if (ts.getTime() - now.getTime() > 86_400_000) ts.setFullYear(now.getFullYear() - 1)
    rest = rest.slice(rfc[0].length)
  }
  const firstSpace = rest.indexOf(' ')
  if (firstSpace > 0) {
    hostname = rest.slice(0, firstSpace)
    rest = rest.slice(firstSpace + 1).trim()
  }
  return {
    priority,
    facility: `local${Math.floor(priority / 8)}`,
    severity: SYSLOG_SEVERITY[priority % 8] || 'info',
    ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
    hostname,
    message: rest.slice(0, 4000),
  }
}

function syslogTopic(message) {
  const head = message.split(' ')[0]
  if (!head || head.length > 80) return { topic: '', text: message }
  if (/^[a-z0-9_,-]+$/i.test(head) && (head.includes(',') || /^[a-z]+$/i.test(head))) {
    return { topic: head.split(',')[0], text: message.slice(head.length).trim() }
  }
  return { topic: '', text: message }
}

export async function handleSyslog(rawLine, sourceIp, transport = 'udp') {
  stats.syslog.messages += 1
  if (transport === 'udp') stats.syslog.udp += 1
  else stats.syslog.tcp += 1
  const line = rawLine.trim()
  if (!line) return
  const parsed = parseSyslog(line)
  if (!parsed) {
    stats.syslog.unmatched += 1
    return
  }
  const router = await findRouter(sourceIp, parsed.hostname)
  if (!router) {
    stats.syslog.unmatched += 1
    return
  }
  markRouterSeen(router)
  const { topic, text: body } = syslogTopic(parsed.message)
  pending.logs.push({
    ts: parsed.ts.toISOString(),
    routerId: router.id,
    siteId: router.site_id,
    facility: parsed.facility,
    topic,
    severity: parsed.severity,
    message: parsed.message,
    raw: {
      host: parsed.hostname,
      source: sourceIp,
      transport,
      priority: parsed.priority,
    },
  })
  if (parsed.severity === 'err' || parsed.severity === 'crit' || parsed.severity === 'alert' || parsed.severity === 'emerg') {
    const alertKey = `${router.id}:${topic}`
    const last = recentAlerts.get(alertKey) || 0
    if (Date.now() - last > 60_000) {
      recentAlerts.set(alertKey, Date.now())
      logEvent({
        siteId: router.site_id,
        routerId: router.id,
        severity: parsed.severity === 'emerg' || parsed.severity === 'alert' ? 'critical' : 'warning',
        kind: topic || 'syslog',
        message: `${router.name}: ${body || parsed.message}`.slice(0, 300),
        source: 'syslog',
      })
    }
  }
  scheduleFlush()
  if (pending.logs.length > 4000) await flushPending()
}

/* ------------------------------------------------------------------ servers */

// Bursts (e.g. every router restarting accounting at once) must not overflow
// the kernel socket queue. Node/OS may clamp this to the system maximum.
const UDP_BUFFER_BYTES = 8 * 1024 * 1024

function createUdpSocket() {
  return dgram.createSocket({ type: 'udp4', recvBufferSize: UDP_BUFFER_BYTES })
}

function startRadiusServer() {
  const socket = createUdpSocket()
  socket.on('message', (msg, rinfo) => {
    handleRadiusPacket(msg, rinfo, socket).catch((err) => {
      stats.radius.errors += 1
      console.error('[ingest] radius packet failed:', err.message)
    })
  })
  socket.on('error', (err) => {
    stats.radius.errors += 1
    console.error(`[ingest] radius socket error: ${err.message}`)
  })
  socket.bind(radiusPort, '0.0.0.0', () => {
    console.log(`[ingest] RADIUS accounting listening on udp/${radiusPort} (rx buffer ${socket.getRecvBufferSize()} bytes)`)
  })
  sockets.push(socket)
}

function startSyslogUdp() {
  if (!syslogPort) return
  const socket = createUdpSocket()
  socket.on('message', (msg, rinfo) => {
    const lines = msg.toString('utf8').split(/\r?\n/)
    for (const line of lines) {
      handleSyslog(line, rinfo.address, 'udp').catch((err) => {
        stats.syslog.errors += 1
        console.error('[ingest] syslog line failed:', err.message)
      })
    }
  })
  socket.on('error', (err) => {
    stats.syslog.errors += 1
    console.error(`[ingest] syslog udp error: ${err.message}`)
  })
  socket.bind(syslogPort, '0.0.0.0', () => {
    console.log(`[ingest] syslog listening on udp/${syslogPort} (rx buffer ${socket.getRecvBufferSize()} bytes)`)
  })
  sockets.push(socket)
}

function startSyslogTcp() {
  if (!syslogTcpPort) return
  const server = net.createServer((connection) => {
    const remote = connection.remoteAddress?.replace(/^::ffff:/, '') || ''
    let buffer = ''
    connection.setEncoding('utf8')
    connection.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 65_536) buffer = buffer.slice(-32_768)
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        const framed = /^(\d+)\s(.*)$/.exec(line)
        handleSyslog(framed ? framed[2] : line, remote, 'tcp').catch((err) => {
          stats.syslog.errors += 1
          console.error('[ingest] syslog line failed:', err.message)
        })
        newline = buffer.indexOf('\n')
      }
    })
    connection.on('error', () => {})
  })
  server.on('error', (err) => {
    stats.syslog.errors += 1
    console.error(`[ingest] syslog tcp error: ${err.message}`)
  })
  server.listen(syslogTcpPort, '0.0.0.0', () => {
    console.log(`[ingest] syslog listening on tcp/${syslogTcpPort}`)
  })
  sockets.push(server)
}

export function getIngestStats() {
  return {
    ...stats,
    uptime_s: Math.round((Date.now() - stats.since) / 1000),
    instance: instanceId,
    buffered: {
      radius_sessions: pending.radius.size,
      active_sessions: pending.active.size,
      routers: pending.seen.size,
      logs: pending.logs.length,
      session_events: pending.sessionEvents.length,
      dropped_rows: droppedRows,
    },
  }
}

export function startIngest() {
  if (!ingestEnabled || running) return
  running = true
  stats.since = Date.now()
  loadRouters(true)
  startRadiusServer()
  startSyslogUdp()
  startSyslogTcp()
  statsTimer = setInterval(async () => {
    try {
      await pool.query(
        'INSERT INTO ingest_stats (service, instance_id, messages, errors, detail) VALUES ($1, $2, $3, $4, $5)',
        [
          'radius+syslog',
          instanceId,
          stats.radius.messages + stats.syslog.messages,
          stats.radius.errors + stats.syslog.errors,
          JSON.stringify({ radius: stats.radius, syslog: stats.syslog }),
        ]
      )
      await pool.query("DELETE FROM ingest_stats WHERE ts < now() - interval '7 days'")
    } catch (err) {
      console.error('[ingest] stats write failed:', err.message)
    }
  }, 60_000)
  statsTimer.unref()
}

export async function stopIngest() {
  running = false
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  for (const socket of sockets.splice(0)) {
    try {
      socket.close()
    } catch {
      // already closed
    }
  }
  // Drain everything buffered so a clean shutdown loses no telemetry.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(pending.radius.size || pending.active.size || pending.activeDeletes.size || pending.seen.size || pending.logs.length || pending.sessionEvents.length)) break
    await flushPending().catch((err) => console.error('[ingest] shutdown flush failed:', err.message))
  }
}

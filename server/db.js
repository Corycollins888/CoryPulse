import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { appTimezone, databaseUrl, instanceId, pgPoolMax, root } from './config.js'

// Keep TIMESTAMPTZ values as ISO strings so existing string comparisons,
// API responses, and the React UI all keep their current shape.
pg.types.setTypeParser(20, (value) => Number(value))
pg.types.setTypeParser(1700, (value) => Number(value))
pg.types.setTypeParser(1184, (value) => new Date(value).toISOString())
pg.types.setTypeParser(1114, (value) => new Date(`${value.replace(' ', 'T')}Z`).toISOString())
pg.types.setTypeParser(1082, (value) => value)

export const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: pgPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // A single runaway query must never pin a pool slot forever: cap statement
  // and application wait time, and roll back forgotten transactions.
  query_timeout: 35_000,
  options: `-c timezone=${appTimezone} -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000`,
  application_name: `corypulse-${instanceId}`,
})

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message)
})

const als = new AsyncLocalStorage()

export function nowIso() {
  return new Date().toISOString()
}

export function addMinutes(minutes) {
  return new Date(Date.now() + Number(minutes || 0) * 60_000).toISOString()
}

const ID_TABLES = new Set([
  'users',
  'sites',
  'routers',
  'plans',
  'customers',
  'payments',
  'vouchers',
  'router_metrics',
  'events',
  'router_logs',
  'session_events',
  'radius_sessions',
  'ingest_stats',
])

function toPg(sql) {
  let index = 0
  return String(sql).replace(/\?/g, () => `$${++index}`)
}

function normalizeParams(params) {
  return params.map((value) => (value === undefined ? null : value))
}

function tableOf(sql) {
  const match = /^\s*INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i.exec(sql)
  return match ? match[1].toLowerCase() : null
}

class Statement {
  constructor(sql) {
    this.text = toPg(sql)
    this.table = tableOf(sql)
  }

  executor() {
    return als.getStore()?.client || pool
  }

  async get(...params) {
    const result = await this.executor().query(this.text, normalizeParams(params))
    return result.rows[0] ?? null
  }

  async all(...params) {
    const result = await this.executor().query(this.text, normalizeParams(params))
    return result.rows
  }

  async run(...params) {
    let text = this.text
    if (
      this.table &&
      ID_TABLES.has(this.table) &&
      !/\bRETURNING\b/i.test(text)
    ) {
      text += ' RETURNING id'
    }
    const result = await this.executor().query(text, normalizeParams(params))
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows?.[0]?.id ?? null,
      rows: result.rows || [],
    }
  }
}

export function transaction(fn) {
  return async (...args) => {
    const state = als.getStore()
    if (state?.client) return fn(...args)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await als.run({ client }, () => fn(...args))
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // connection already gone
      }
      throw err
    } finally {
      client.release()
    }
  }
}

export const db = {
  prepare: (sql) => new Statement(sql),
  query: (sql, params = []) => pool.query(toPg(sql), normalizeParams(params)),
  async exec(sql) {
    return pool.query(sql)
  },
  transaction,
  close: closeDb,
}

export async function closeDb() {
  await flushEvents().catch(() => {})
  await pool.end()
}

/* ---------------------------------------------------------------- settings */

const settingsCache = new Map()

export async function refreshSettings() {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings')
    for (const row of rows) settingsCache.set(row.key, row.value)
    return settingsCache
  } catch (err) {
    console.error('[db] settings refresh failed:', err.message)
    return settingsCache
  }
}

export function getSetting(key, fallback = null) {
  return settingsCache.has(key) ? settingsCache.get(key) : fallback
}

export function getSettings(keys) {
  const out = {}
  for (const key of keys) out[key] = getSetting(key, '')
  return out
}

export function setSetting(key, value) {
  const text = value == null ? null : String(value)
  settingsCache.set(key, text)
  pool
    .query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [key, text]
    )
    .catch((err) => console.error(`[db] setting ${key} write failed:`, err.message))
}

/* ------------------------------------------------------------------ events */

const eventBuffer = []
let flushTimer = null
let flushing = false

export function logEvent({ siteId = null, routerId = null, severity = 'info', kind, message, source = 'system' }) {
  if (eventBuffer.length >= 50_000) {
    console.error('[db] event buffer full, dropping the oldest event')
    eventBuffer.shift()
  }
  eventBuffer.push({ ts: new Date().toISOString(), siteId, routerId, severity, kind, message, source })
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushEvents().catch((err) => console.error('[db] event flush failed:', err.message))
    }, 250)
    flushTimer.unref()
  }
}

export async function flushEvents() {
  if (flushing || !eventBuffer.length) return
  flushing = true
  const batch = eventBuffer.splice(0, 2000)
  try {
    const values = []
    const params = []
    batch.forEach((event, i) => {
      const base = i * 7
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`)
      params.push(
        event.ts,
        event.siteId,
        event.routerId,
        event.severity,
        event.kind,
        event.message,
        event.source
      )
    })
    await pool.query(
      `INSERT INTO events (ts, site_id, router_id, severity, kind, message, source)
       VALUES ${values.join(', ')}`,
      params
    )
  } catch (err) {
    // Put the batch back so a transient database restart does not lose events.
    eventBuffer.unshift(...batch)
    throw err
  } finally {
    flushing = false
  }
  if (eventBuffer.length >= 2000) {
    setImmediate(() => flushEvents().catch((err) => console.error('[db] event flush failed:', err.message)))
  }
}

/* -------------------------------------------------------------- bootstrap */

async function waitForDatabase(attempts = 30, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      if (attempt === attempts) throw err
      console.warn(`[db] waiting for PostgreSQL (${attempt}/${attempts}): ${err.message}`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

async function enableTimescale() {
  const { rows } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
  if (!rows.length) return false
  const tables = ['router_metrics', 'events', 'router_logs', 'session_events']
  for (const table of tables) {
    try {
      await pool.query(
        `SELECT create_hypertable('${table}', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`
      )
    } catch (err) {
      console.warn(`[db] timescale hypertable ${table} skipped: ${err.message}`)
    }
  }
  return true
}

export async function initDb() {
  await waitForDatabase()
  await pool.query(`SET TIME ZONE '${appTimezone}'`)
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8')
  await pool.query(schema)
  await refreshSettings()
  const timescale = await enableTimescale()
  console.log(`[db] PostgreSQL ready${timescale ? ' (TimescaleDB)' : ''}`)
  setInterval(() => refreshSettings().catch(() => {}), 30_000).unref()
  setInterval(() => {
    if (eventBuffer.length) flushEvents().catch(() => {})
  }, 1000).unref()
}

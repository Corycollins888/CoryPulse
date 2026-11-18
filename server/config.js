import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const dataDir = path.join(root, 'data')
export const distDir = path.join(root, 'dist')

function loadEnvFile() {
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile()

fs.mkdirSync(dataDir, { recursive: true })

function loadSecretKey() {
  if (process.env.CREDENTIALS_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.CREDENTIALS_KEY)) {
    return process.env.CREDENTIALS_KEY.toLowerCase()
  }
  const keyPath = path.join(dataDir, 'secret.key')
  if (fs.existsSync(keyPath)) {
    const stored = fs.readFileSync(keyPath, 'utf8').trim()
    if (/^[0-9a-fA-F]{64}$/.test(stored)) return stored.toLowerCase()
  }
  const generated = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(keyPath, generated + '\n', { mode: 0o600 })
  return generated
}

export const secretKey = loadSecretKey()
export const port = Number(process.env.PORT || 8787)
export const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')

// Only the reverse proxy should be able to spoof X-Forwarded-For. The default
// trusts loopback and private-network peers, which is the Docker/Caddy layout.
function parseTrustProxy(value) {
  if (value == null || value === '') return 'loopback, uniquelocal'
  if (value === 'false') return false
  if (value === 'true') return true
  return value
}

export const trustProxy = parseTrustProxy(process.env.TRUST_PROXY)
export const sessionDays = Math.max(1, Math.min(30, Number(process.env.SESSION_DAYS || 7)))
export const maxSseClients = Math.max(1, Number(process.env.MAX_SSE_CLIENTS || 200))
export const apiBodyLimit = process.env.API_BODY_LIMIT || '100kb'
export const apiRatePerMinute = Math.max(60, Number(process.env.API_RATE_PER_MINUTE || 3000))

export const databaseUrl =
  process.env.DATABASE_URL || 'postgres://corypulse:corypulse@127.0.0.1:5432/corypulse'
export const pgPoolMax = Math.max(2, Number(process.env.PG_POOL_MAX || 20))
export const appTimezone = /^[A-Za-z0-9_+\-/]+$/.test(process.env.APP_TIMEZONE || '')
  ? process.env.APP_TIMEZONE
  : 'Africa/Nairobi'

export const role = ['api', 'ingest', 'all'].includes(process.env.ROLE) ? process.env.ROLE : 'all'
export const instanceId =
  process.env.INSTANCE_ID || `${role}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`

export const pollConcurrency = Math.max(1, Number(process.env.POLL_CONCURRENCY || 48))
export const pollIntervalSeconds = Math.max(15, Number(process.env.POLL_INTERVAL_S || 60))
export const sessionInventorySeconds = Math.max(60, Number(process.env.SESSION_INVENTORY_S || 300))

export const ingestEnabled = (process.env.INGEST_ENABLED || '1') !== '0'
export const radiusPort = Math.max(1, Number(process.env.RADIUS_PORT || 1813))
export const radiusSecret = process.env.RADIUS_SECRET || ''
export const syslogPort = Math.max(0, Number(process.env.SYSLOG_PORT || 514))
export const syslogTcpPort = Math.max(0, Number(process.env.SYSLOG_TCP_PORT || 1514))
export const metricRetentionDays = Math.max(7, Number(process.env.METRIC_RETENTION_DAYS || 90))
export const logRetentionDays = Math.max(7, Number(process.env.LOG_RETENTION_DAYS || 90))
export const eventRetentionDays = Math.max(30, Number(process.env.EVENT_RETENTION_DAYS || 365))

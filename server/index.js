import express from 'express'
import cookieParser from 'cookie-parser'
import fs from 'node:fs'
import path from 'node:path'
import {
  port,
  publicUrl,
  distDir,
  role,
  trustProxy,
  apiBodyLimit,
  apiRatePerMinute,
} from './config.js'
import { initDb, closeDb } from './db.js'
import { api } from './routes.js'
import { startPoller, stopPoller } from './poller.js'
import { startIngest, stopIngest } from './ingest.js'
import { pruneExpiredSessions } from './auth.js'
import { securityHeaders, sameOriginGuard, createLimiter } from './security.js'

await initDb()

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', trustProxy)

app.use(securityHeaders)
app.use(
  '/api',
  createLimiter({
    windowMs: 60_000,
    max: apiRatePerMinute,
    skip: (req) => req.path.startsWith('/health'),
  })
)
app.use(express.json({ limit: apiBodyLimit }))
app.use(cookieParser())
app.use('/api', sameOriginGuard)
app.use('/api', api)
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' })
  next()
})

const indexHtml = path.join(distDir, 'index.html')
if (fs.existsSync(indexHtml)) {
  app.use(
    express.static(distDir, {
      index: false,
      maxAge: '1h',
      dotfiles: 'deny',
      etag: true,
    })
  )
  app.get('*', (req, res) => res.sendFile(indexHtml))
} else {
  app.get('/', (req, res) => {
    res
      .type('text/plain')
      .send(
        'CoryPulse API is running.\n\nFor development run: npm run dev\nFor production run: npm run build && npm start'
      )
  })
}

app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err)
  if (res.headersSent) return next(err)
  const message =
    status === 413
      ? 'Request body is too large'
      : status === 400
        ? 'Malformed request'
        : status >= 500
          ? 'Internal server error'
          : err.message || 'Request failed'
  if (req.path.startsWith('/api')) return res.status(status).json({ error: message })
  res.status(status).send(message)
})

function listen() {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`CoryPulse API listening on ${publicUrl} (port ${port}, role ${role})`)
    startPoller()
    setInterval(() => pruneExpiredSessions().catch(() => {}), 6 * 60 * 60_000).unref()
  })
  // Slowloris and connection-hold protection. requestTimeout only covers
  // receiving the request, so long-lived SSE streams are unaffected.
  server.headersTimeout = 20_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 65_000
  server.maxHeadersCount = 100
  server.on('error', (err) => {
    console.error('[http] server error:', err.message)
    shutdown(1)
  })
  return server
}

const servers = []
if (role !== 'ingest') servers.push(listen())
if (role !== 'api') startIngest()
if (role === 'ingest') console.log('CoryPulse running in ingest-only mode (no HTTP API)')

let shuttingDown = false
async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  const force = setTimeout(() => {
    console.error('[shutdown] timed out, forcing exit')
    process.exit(code || 1)
  }, 15_000)
  force.unref()
  stopPoller()
  await stopIngest().catch((err) => console.error('[shutdown] ingest flush:', err.message))
  for (const server of servers) server.close()
  await closeDb().catch(() => {})
  clearTimeout(force)
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// An uncaught exception leaves the process in an unknown state; exiting lets
// the container supervisor restart cleanly instead of running corrupted.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err)
  shutdown(1)
})

let rejectionCount = 0
let rejectionWindow = Date.now()
process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err)
  const now = Date.now()
  if (now - rejectionWindow > 60_000) {
    rejectionWindow = now
    rejectionCount = 0
  }
  rejectionCount += 1
  if (rejectionCount > 25) {
    console.error('[fatal] unhandled rejections are repeating, restarting')
    shutdown(1)
  }
})

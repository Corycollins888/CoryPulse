import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { db, nowIso } from './db.js'
import { sessionDays } from './config.js'

const scrypt = promisify(crypto.scrypt)
const SESSION_COOKIE = 'cp_session'
const KEY_LENGTH = 64
const MAX_CONCURRENT = 4
const MAX_QUEUE = 64

// scrypt is deliberately expensive, which also makes it a denial-of-service
// lever: an unbounded flood of login attempts would exhaust the libuv thread
// pool and stall every other request. Derivation is capped and queued.
let running = 0
const queue = []

function derive(password, salt) {
  const secret = String(password).slice(0, 256)
  return new Promise((resolve, reject) => {
    if (running >= MAX_CONCURRENT && queue.length >= MAX_QUEUE) {
      return reject(Object.assign(new Error('Sign-in is busy, try again shortly'), { busy: true }))
    }
    const run = () => {
      running += 1
      scrypt(secret, salt, KEY_LENGTH)
        .then(resolve, reject)
        .finally(() => {
          running -= 1
          const next = queue.shift()
          if (next) next()
        })
    }
    if (running < MAX_CONCURRENT) run()
    else queue.push(run)
  })
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const derived = await derive(password, salt)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

const DUMMY_HASH = `scrypt$${crypto.randomBytes(16).toString('hex')}$${crypto.randomBytes(KEY_LENGTH).toString('hex')}`

export async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$')
    if (scheme !== 'scrypt') return false
    const derived = await derive(password, Buffer.from(saltHex, 'hex'))
    const expected = Buffer.from(hashHex, 'hex')
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
  } catch (err) {
    if (err.busy) throw err
    return false
  }
}

// Unknown usernames still pay the full scrypt cost so response timing does not
// reveal which accounts exist.
export async function burnPasswordCheck(password) {
  await verifyPassword(password, DUMMY_HASH).catch((err) => {
    if (err.busy) throw err
  })
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + sessionDays * 86_400_000).toISOString()
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, nowIso(), expires)
  return token
}

export async function destroySession(token) {
  if (!token) return
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

export async function pruneExpiredSessions() {
  await db
    .prepare('DELETE FROM sessions WHERE expires_at < now()')
    .run()
    .catch((err) => console.error('[auth] session prune failed:', err.message))
}

export async function authenticate(req) {
  const token = req.cookies?.[SESSION_COOKIE]
  if (!token) return null
  const row = await db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(hashToken(token))
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash)
    return null
  }
  return { id: row.id, username: row.username }
}

export function setSessionCookie(res, token, secure) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: sessionDays * 86_400_000,
    path: '/',
  })
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function getSessionToken(req) {
  return req.cookies?.[SESSION_COOKIE] || null
}

export async function requireAuth(req, res, next) {
  try {
    const user = await authenticate(req)
    if (!user) return res.status(401).json({ error: 'Not signed in' })
    req.user = user
    next()
  } catch (err) {
    next(err)
  }
}

/* ------------------------------------------------------- brute-force gates */

const WINDOW_MS = 10 * 60_000
const MAX_TRACKED = 20_000
const IP_LIMIT = 8
const USER_LIMIT = 12

const ipAttempts = new Map()
const userAttempts = new Map()

function prune(map, now) {
  for (const [key, entry] of map) if (entry.resetAt <= now) map.delete(key)
  if (map.size > MAX_TRACKED) {
    for (const key of map.keys()) {
      map.delete(key)
      if (map.size <= MAX_TRACKED * 0.8) break
    }
  }
}

setInterval(() => {
  const now = Date.now()
  prune(ipAttempts, now)
  prune(userAttempts, now)
}, 60_000).unref()

function blocked(map, key, limit, now) {
  const entry = map.get(key)
  if (!entry) return false
  if (entry.resetAt <= now) {
    map.delete(key)
    return false
  }
  return entry.count >= limit
}

export function loginAllowed(ip, name = '') {
  const now = Date.now()
  if (blocked(ipAttempts, ip, IP_LIMIT, now)) return false
  if (name && blocked(userAttempts, `u:${name}`, USER_LIMIT, now)) return false
  return true
}

export function recordFailedLogin(ip, name = '') {
  const now = Date.now()
  const bump = (map, key) => {
    const entry = map.get(key)
    if (!entry || entry.resetAt <= now) map.set(key, { count: 1, resetAt: now + WINDOW_MS })
    else entry.count += 1
  }
  bump(ipAttempts, ip)
  if (name) bump(userAttempts, `u:${name}`)
}

export function clearLoginAttempts(ip, name = '') {
  ipAttempts.delete(ip)
  if (name) userAttempts.delete(`u:${name}`)
}

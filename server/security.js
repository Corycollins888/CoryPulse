import { publicUrl } from './config.js'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

const HTTPS = publicUrl.startsWith('https://')

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store')
    if (!req.path.startsWith('/api/stream')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    }
  } else {
    res.setHeader('Content-Security-Policy', CSP)
  }
  if (HTTPS || req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}

// Cookies are SameSite=Lax, which already blocks cross-site form posts in
// modern browsers. This guard is the belt to that suspenders: a JSON write
// from another origin is refused even if a browser ever loosens that rule.
export function sameOriginGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  const origin = req.get('origin')
  if (!origin) return next()
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return res.status(403).json({ error: 'Request blocked' })
  }
  const allowed = new Set([req.get('host'), new URL(publicUrl).host])
  if (!allowed.has(originHost)) return res.status(403).json({ error: 'Cross-site request blocked' })
  next()
}

const MAX_KEYS = 50_000
const sweepers = new Set()

function sweep(map, now) {
  for (const [key, entry] of map) {
    if (entry.resetAt <= now) map.delete(key)
  }
  if (map.size > MAX_KEYS) {
    for (const key of map.keys()) {
      map.delete(key)
      if (map.size <= MAX_KEYS * 0.8) break
    }
  }
}

setInterval(() => {
  const now = Date.now()
  for (const map of sweepers) sweep(map, now)
}, 60_000).unref()

export function rateAllowed(key, max = 60, windowMs = 60_000) {
  const map = bucketsFor(max + ':' + windowMs)
  const now = Date.now()
  const entry = map.get(key)
  if (!entry || entry.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  entry.count += 1
  return entry.count <= max
}

const bucketSets = new Map()
function bucketsFor(id) {
  let map = bucketSets.get(id)
  if (!map) {
    map = new Map()
    bucketSets.set(id, map)
    sweepers.add(map)
  }
  return map
}

export function createLimiter({ windowMs = 60_000, max = 300, skip } = {}) {
  const hits = new Map()
  sweepers.add(hits)
  return function limiter(req, res, next) {
    if (skip && skip(req)) return next()
    const key = req.ip || 'unknown'
    const now = Date.now()
    let entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(key, entry)
    }
    entry.count += 1
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      return res.status(429).json({ error: 'Too many requests. Please slow down.' })
    }
    next()
  }
}

// Blast RADIUS accounting traffic at a running ingest node and measure acks.
// Example (1,000,000 sessions): ROUTERS=3500 SESSIONS_PER_ROUTER=286 npm run loadtest
import crypto from 'node:crypto'
import dgram from 'node:dgram'

const host = process.env.INGEST_HOST || '127.0.0.1'
const port = Number(process.env.RADIUS_PORT || 1813)
const secret = process.env.RADIUS_SECRET || 'devsecret'
const routers = Math.max(1, Number(process.env.ROUTERS || 3500))
const perRouter = Math.max(1, Number(process.env.SESSIONS_PER_ROUTER || 20))
const total = Math.max(1, Number(process.env.SESSIONS || routers * perRouter))
const maxInflight = Math.max(50, Number(process.env.MAX_INFLIGHT || 4000))
const sendStops = process.env.SEND_STOPS === '1'
const interimPercent = Math.min(100, Math.max(0, Number(process.env.INTERIM_PERCENT || 5)))

const ATTR = {
  USER_NAME: 1,
  NAS_IP: 4,
  FRAMED_IP: 8,
  CALLING_STATION: 31,
  ACCT_STATUS: 40,
  ACCT_INPUT_OCTETS: 42,
  ACCT_OUTPUT_OCTETS: 43,
  ACCT_SESSION_ID: 44,
  ACCT_SESSION_TIME: 46,
}

function attr(type, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return Buffer.concat([Buffer.from([type, data.length + 2]), data])
}

function attrInt(type, value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value >>> 0, 0)
  return attr(type, buf)
}

function attrIp(type, ip) {
  return attr(type, Buffer.from(ip.split('.').map(Number)))
}

function nasIpFor(index) {
  return `10.${20 + Math.floor(index / 254)}.${(index % 254) + 1}.1`
}

function buildPacket(status, routerIndex, sessionIndex, seconds, rx, tx) {
  const attrs = Buffer.concat([
    attr(ATTR.USER_NAME, `guest-${routerIndex}-${sessionIndex}`),
    attr(ATTR.ACCT_SESSION_ID, `lt-${routerIndex}-${sessionIndex}`),
    attrInt(ATTR.ACCT_STATUS, status),
    attrInt(ATTR.ACCT_SESSION_TIME, seconds),
    attrInt(ATTR.ACCT_INPUT_OCTETS, rx),
    attrInt(ATTR.ACCT_OUTPUT_OCTETS, tx),
    attrIp(ATTR.NAS_IP, nasIpFor(routerIndex)),
    attrIp(ATTR.FRAMED_IP, `10.200.${routerIndex % 250}.${(sessionIndex % 250) + 1}`),
    attr(ATTR.CALLING_STATION, 'AA-BB-CC-DD-EE-FF'),
  ])
  const head = Buffer.alloc(4)
  head[0] = 4
  head[1] = Math.floor(Math.random() * 256)
  head.writeUInt16BE(20 + attrs.length, 2)
  const hash = crypto
    .createHash('md5')
    .update(head)
    .update(Buffer.alloc(16))
    .update(attrs)
    .update(secret)
    .digest()
  return Buffer.concat([head, hash, attrs])
}

const jobs = [
  { status: 1, label: 'sessions', count: total, seconds: 0, rx: 0, tx: 0 },
]
if (interimPercent > 0) {
  jobs.push({
    status: 3,
    label: 'interim updates',
    count: Math.max(1, Math.floor((total * interimPercent) / 100)),
    seconds: 300,
    rx: 1_000_000,
    tx: 500_000,
  })
}
if (sendStops) {
  jobs.push({ status: 2, label: 'stops', count: total, seconds: 600, rx: 2_000_000, tx: 1_000_000 })
}

let job = null
let started = 0
let acks = 0
let errors = 0
let inflight = 0
let lastResponseAt = Date.now()
let done = false
const startedAt = Date.now()

const socket = dgram.createSocket('udp4')
socket.on('message', (msg) => {
  lastResponseAt = Date.now()
  inflight = Math.max(0, inflight - 1)
  if (msg[0] === 5) acks += 1
  else errors += 1
  pump()
})
socket.on('error', (err) => {
  errors += 1
  console.error('[load] socket error:', err.message)
})
socket.bind(0, '127.0.0.1')

function sendOne(status, index, seconds, rx, tx) {
  const packet = buildPacket(status, index % routers, Math.floor(index / routers), seconds, rx, tx)
  inflight += 1
  socket.send(packet, port, host, (err) => {
    if (err) {
      errors += 1
      inflight = Math.max(0, inflight - 1)
      pump()
    }
  })
}

function nextJob() {
  job = jobs.shift() || null
  if (!job) return finish()
  console.log(`[load] sending ${job.count.toLocaleString()} ${job.label}`)
  pump()
}

function pump() {
  if (done) return
  if (!job) return nextJob()
  while (inflight < maxInflight && job.sent < job.count) {
    const index = job.sent
    job.sent += 1
    started += 1
    sendOne(job.status, index, job.seconds, job.rx, job.tx)
  }
  if (job.sent >= job.count && inflight === 0) nextJob()
}

for (const item of jobs) item.sent = 0

function finish() {
  if (done) return
  done = true
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const pps = Math.round(started / Math.max(0.001, Number(elapsed)))
  console.log(
    `[load] done: ${started.toLocaleString()} packets in ${elapsed}s (${pps.toLocaleString()}/s), ${acks.toLocaleString()} acks, ${errors.toLocaleString()} errors`
  )
  setTimeout(() => {
    socket.close()
    process.exit(0)
  }, 1500)
}

const progress = setInterval(() => {
  const seconds = Math.max(1, (Date.now() - startedAt) / 1000)
  console.log(
    `[load] ${job?.label || 'finishing'} · ${started.toLocaleString()} sent · ${acks.toLocaleString()} acks · ${Math.round(started / seconds).toLocaleString()}/s · inflight ${inflight}`
  )
  if (acks + errors < started && started > 0) {
    const loss = 100 - ((acks + errors) / started) * 100
    if (loss > 5) console.log(`[load] ${loss.toFixed(1)}% of packets not answered yet`)
  }
}, 3000)
progress.unref()

// UDP has no acknowledgements of its own: abandon packets the server ignored
// so the flow-control window cannot stall on silent RADIUS rejects.
setInterval(() => {
  if (!done && inflight > 0 && Date.now() - lastResponseAt > 3000) {
    errors += inflight
    inflight = 0
    lastResponseAt = Date.now()
    pump()
  }
}, 1000).unref()

socket.once('listening', () => nextJob())

// Sends signed RADIUS accounting packets and a syslog line at a running
// CoryPulse instance so ingest can be verified without a real MikroTik.
import crypto from 'node:crypto'
import dgram from 'node:dgram'

const host = process.env.INGEST_HOST || '127.0.0.1'
const radiusPort = Number(process.env.RADIUS_PORT || 1813)
const syslogPort = Number(process.env.SYSLOG_PORT || 514)
const secret = process.env.RADIUS_SECRET || 'devsecret'
const sessionId = process.env.ACCT_SESSION_ID || `smoke-${Date.now()}`
const username = process.env.GUEST_NAME || 'smoke-guest'

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
  ACCT_TERMINATE_CAUSE: 49,
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

function packet(id, attrs) {
  const head = Buffer.alloc(4)
  head[0] = 4
  head[1] = id
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

function attributes(status, seconds, rx, tx) {
  const list = [
    attr(ATTR.USER_NAME, username),
    attr(ATTR.ACCT_SESSION_ID, sessionId),
    attrInt(ATTR.ACCT_STATUS, status),
    attrInt(ATTR.ACCT_SESSION_TIME, seconds),
    attrInt(ATTR.ACCT_INPUT_OCTETS, rx),
    attrInt(ATTR.ACCT_OUTPUT_OCTETS, tx),
    attrIp(ATTR.NAS_IP, '127.0.0.1'),
    attrIp(ATTR.FRAMED_IP, '10.5.0.42'),
    attr(ATTR.CALLING_STATION, 'AA-BB-CC-DD-EE-FF'),
  ]
  if (status === 2) list.push(attrInt(ATTR.ACCT_TERMINATE_CAUSE, 1))
  return Buffer.concat(list)
}

async function send(status, seconds, rx, tx) {
  const socket = dgram.createSocket('udp4')
  const id = Math.floor(Math.random() * 255)
  const payload = packet(id, attributes(status, seconds, rx, tx))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no RADIUS response')), 3000)
    socket.once('message', (msg) => {
      clearTimeout(timer)
      console.log(`[radius] status ${status}: response code ${msg[0]} (${msg.length} bytes)`)
      resolve()
    })
    socket.send(payload, radiusPort, host, (err) => {
      if (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
  })
  socket.close()
}

await send(1, 0, 0, 0)
await send(3, 120, 1_048_576, 524_288)
await send(2, 300, 2_097_152, 1_048_576)

const syslog = dgram.createSocket('udp4')
const line = `<30>Nov 17 00:00:00 ${host} hotspot,info,debug ${username} logged in from 10.5.0.42`
await new Promise((resolve, reject) => {
  syslog.send(line, syslogPort, host, (err) => (err ? reject(err) : resolve()))
})
syslog.close()
console.log(`[syslog] sent: ${line}`)
console.log(`session ${sessionId} username ${username}`)

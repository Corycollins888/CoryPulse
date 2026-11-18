import crypto from 'node:crypto'
import { db } from './db.js'

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function randomCode(prefix = 'CP', groups = 2, groupSize = 4) {
  const chunks = []
  for (let g = 0; g < groups; g += 1) {
    let chunk = ''
    for (let i = 0; i < groupSize; i += 1) {
      chunk += ALPHABET[crypto.randomInt(0, ALPHABET.length)]
    }
    chunks.push(chunk)
  }
  return [prefix, ...chunks].join('-')
}

export async function uniqueVoucherCode(prefix = 'CP') {
  for (let i = 0; i < 20; i += 1) {
    const code = randomCode(prefix)
    const exists = await db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code)
    if (!exists) return code
  }
  return `${randomCode(prefix)}-${Date.now().toString(36).toUpperCase()}`
}

export function paymentRef() {
  return 'PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase()
}

export function parseUptime(text) {
  if (!text) return 0
  const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }
  let total = 0
  const re = /(\d+)([wdhms])/g
  let match
  while ((match = re.exec(String(text))) !== null) {
    total += Number(match[1]) * units[match[2]]
  }
  return total
}

export function formatUptime(minutes) {
  const total = Math.max(1, Math.round(minutes))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  let out = ''
  if (days) out += `${days}d`
  if (hours) out += `${hours}h`
  if (mins && !days) out += `${mins}m`
  return out || '1m'
}

export function csvEscape(value) {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) lines.push(row.map(csvEscape).join(','))
  return lines.join('\r\n') + '\r\n'
}

export function localDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function dayRange(days) {
  const out = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    out.push(localDate(d.toISOString()))
  }
  return out
}

export function safeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

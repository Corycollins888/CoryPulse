export function money(value, currency = 'KES') {
  const amount = Number(value || 0)
  try {
    return new Intl.NumberFormat('en-KE', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString()}`
  }
}

export function num(value) {
  return Number(value || 0).toLocaleString()
}

export function duration(minutes) {
  const total = Number(minutes || 0)
  if (!total) return '—'
  if (total < 60) return `${total} min`
  if (total < 1440) {
    const h = Math.floor(total / 60)
    const m = total % 60
    return m ? `${h}h ${m}m` : `${h} hour${h > 1 ? 's' : ''}`
  }
  if (total < 10080) {
    const d = Math.round(total / 1440)
    return `${d} day${d > 1 ? 's' : ''}`
  }
  if (total < 43200) {
    const d = Math.round(total / 1440)
    return d % 7 === 0 ? `${d / 7} week${d / 7 > 1 ? 's' : ''}` : `${d} days`
  }
  const m = Math.round(total / 43200)
  return `${m} month${m > 1 ? 's' : ''}`
}

export function dataSize(mb) {
  const value = Number(mb || 0)
  if (!value) return 'Unlimited'
  if (value < 1024) return `${value} MB`
  return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB`
}

export function speed(kbps) {
  const value = Number(kbps || 0)
  if (!value) return 'Uncapped'
  if (value < 1024) return `${value} kbps`
  return `${(value / 1024).toFixed(1).replace('.0', '')} Mbps`
}

export function bpsText(bps) {
  const value = Number(bps || 0)
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`
  if (value >= 1000) return `${(value / 1000).toFixed(0)} kbps`
  return `${value} bps`
}

export function timeAgo(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function dateTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function dateShort(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

export function dateLong(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

export function statusTone(status) {
  switch (status) {
    case 'online':
    case 'paid':
    case 'active':
      return 'green'
    case 'pending':
    case 'unused':
      return 'amber'
    case 'offline':
    case 'failed':
    case 'disabled':
      return 'red'
    case 'refunded':
      return 'violet'
    case 'expired':
    case 'unknown':
      return 'grey'
    default:
      return 'grey'
  }
}

const STATUS_LABELS = {
  online: 'Online',
  offline: 'Offline',
  unknown: 'Not checked',
  paid: 'Paid',
  pending: 'Pending',
  failed: 'Failed',
  refunded: 'Refunded',
  unused: 'In stock',
  active: 'Active',
  expired: 'Expired',
  disabled: 'Disabled',
  mpesa: 'M-Pesa',
  cash: 'Cash',
  demo: 'Demo',
  manual: 'Manual',
  bank: 'Bank',
  simulated: 'Simulated',
  routeros: 'RouterOS',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function pct(part, total) {
  if (!total) return 0
  return Math.round((part / total) * 100)
}

export function remaining(iso) {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes} min left`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m left`
  return `${Math.floor(hours / 24)} days left`
}

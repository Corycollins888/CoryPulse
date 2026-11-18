import { maxSseClients } from './config.js'

const MAX_BACKLOG = 1 << 20

let clients = new Set()

export function addClient(res, req) {
  if (clients.size >= maxSseClients) {
    return res.status(503).json({ error: 'Live stream is at capacity, retry shortly' })
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`)
  clients.add(res)

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return cleanup()
    // A stalled client must not let the process buffer frames without bound.
    if (res.writableLength > MAX_BACKLOG) {
      cleanup()
      res.destroy()
      return
    }
    try {
      res.write(`: ping ${Date.now()}\n\n`)
    } catch {
      cleanup()
      res.destroy()
    }
  }, 25_000)

  const cleanup = () => {
    clearInterval(heartbeat)
    clients.delete(res)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    if (res.writableEnded || res.writableLength > MAX_BACKLOG) {
      clients.delete(res)
      if (!res.writableEnded) res.destroy()
      continue
    }
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}

export function clientCount() {
  return clients.size
}

// Development-only PostgreSQL substitute: speaks the pg wire protocol on 5432.
// Production deployments should use a real PostgreSQL/TimescaleDB server.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

const dataDir = path.join(process.cwd(), 'data', 'pglite')
fs.mkdirSync(dataDir, { recursive: true })

const db = await PGlite.create(dataDir)
const server = new PGLiteSocketServer({
  db,
  port: Number(process.env.PGLITE_PORT || 5432),
  host: '127.0.0.1',
  maxConnections: 32,
})
await server.start()
console.log(`[dev-db] PGlite listening on ${server.getServerConn()} (data: ${dataDir})`)

async function shutdown() {
  await server.stop()
  await db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

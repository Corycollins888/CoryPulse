// Seeds a large, non-polling router fleet for ingest and capacity testing.
// Usage: ROUTERS=3500 SITES=25 node scripts/seed-scale.js
import pg from 'pg'
import { databaseUrl } from '../server/config.js'

const routers = Math.max(1, Number(process.env.ROUTERS || 3500))
const siteCount = Math.max(1, Number(process.env.SITES || 25))
const client = new pg.Client({ connectionString: databaseUrl })
await client.connect()

const existingSites = await client.query("SELECT id FROM sites WHERE name LIKE 'NBO Zone %' ORDER BY id")
const siteIds = existingSites.rows.map((row) => row.id)
for (let i = siteIds.length; i < siteCount; i += 1) {
  const name = `NBO Zone ${String(i + 1).padStart(2, '0')}`
  const { rows } = await client.query(
    "INSERT INTO sites (name, ssid, address, timezone, color, notes, created_at) VALUES ($1, $2, 'Nairobi', 'Africa/Nairobi', '#38bdf8', 'Scale test zone', now()) RETURNING id",
    [name, `CoryPulse-${String(i + 1).padStart(2, '0')}`]
  )
  siteIds.push(rows[0].id)
}

const existing = await client.query("SELECT COUNT(*)::int AS n FROM routers WHERE name LIKE 'NBO-%'")
const have = existing.rows[0].n
let inserted = 0
const BATCH = 250
for (let start = have; start < routers; start += BATCH) {
  const values = []
  const params = []
  const end = Math.min(routers, start + BATCH)
  for (let i = start; i < end; i += 1) {
    const base = values.length * 3
    values.push(`($${base + 1}::bigint, $${base + 2}, 'routeros', $${base + 3}, $${base + 3}, 8728, 'unknown', 3600, now() + interval '365 days', now())`)
    const nasIp = `10.${20 + Math.floor(i / 254)}.${(i % 254) + 1}.1`
    params.push(siteIds[i % siteIds.length], `NBO-${String(i + 1).padStart(4, '0')}`, nasIp)
  }
  await client.query(
    `INSERT INTO routers (site_id, name, mode, host, nas_ip, port, status, poll_interval_s, next_poll_at, created_at)
     VALUES ${values.join(', ')}`,
    params
  )
  inserted += end - start
}

const total = await client.query("SELECT COUNT(*)::int AS n FROM routers WHERE name LIKE 'NBO-%'")
console.log(`[seed] ${siteIds.length} sites, ${inserted} new routers, ${total.rows[0].n} scale routers ready`)
await client.end()

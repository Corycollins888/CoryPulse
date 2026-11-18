# CoryPulse

Wi-Fi business management platform by **CoryTech**. One self-hosted web app for
running a MikroTik hotspot business at city scale: sites and routers, plans and
vouchers, a guest captive portal with M-Pesa payments, customers, reports, and
live monitoring fed by RADIUS accounting, syslog, and the RouterOS API.

This build is complete and source-included, intended for handover to a buyer
starting or operating a Wi-Fi business.

---

## 1. What's inside

| Area | What the operator gets |
| --- | --- |
| Dashboard | Live "pulse radar" of every site, connected devices, throughput, revenue, stock, and fleet telemetry coverage |
| Sites & routers | Thousands of locations, per-router NAS IP and RADIUS secret, health, coverage alerts, quick actions |
| Plans | Price, duration, data cap, device limit, speed limits, hotspot profile |
| Vouchers | Batch generation, search/filter, activate/disable, CSV export, printable card sheet |
| Captive portal | Branded guest page per site, voucher login, package purchase, M-Pesa STK push (or demo payment) |
| Payments | Full ledger, manual marking, refunds, M-Pesa callback handling |
| Customers | Guest directory linked to payments and vouchers |
| Reports | Revenue by day, site, plan, and payment method; voucher stock |
| Settings | Company name, currency, demo payments, M-Pesa Daraja credentials |
| Scale telemetry | Sharded poller with leases and backoff, RADIUS accounting ingest, syslog ingest, TimescaleDB retention |

### Signature features

- **Three independent telemetry paths** – RADIUS accounting for every session,
  remote syslog for every router event, and API polling for health and
  provisioning. Losing one path does not stop the other two.
- **Leased, sharded poller** – API nodes claim due routers with
  `FOR UPDATE SKIP LOCKED`, so any number of app replicas can share 3,500+
  routers without double-polling. Failures back off exponentially and routers
  that stop reporting raise coverage-gap events instead of disappearing.
- **Batched ingest** – RADIUS and syslog packets are parsed in memory and written
  in multi-row batches, which keeps 1M concurrently connected guests practical.
- **Live pulse radar** – animated, deterministic map of sites and clients;
  updates without a page refresh.
- **Pulse wall** – a full-screen operations wall with one ECG heartbeat per
  router, grouped by site and coloured by telemetry health, beside an
  explainable **Pulse Score** (coverage, liveness, ingest integrity, write
  buffer) and a live incident tape. Open it from the sidebar or `/wall`;
  `Esc` returns to the console.
- **Printable voucher cards** – 24-per-sheet, colour-accented cards with QR
  codes that open the guest portal and activate that exact voucher.
- **Real MikroTik provisioning** – activating a voucher creates a hotspot user
  with the plan's uptime, data cap, speed limit, and profile; disabling or
  expiring removes it and kills the session.
- **Honest demo mode** – simulated routers generate traffic, clients, and
  payments so the console can be demonstrated with no hardware.

---

## 2. Requirements

- **Node.js 24 or newer** and npm.
- **PostgreSQL 14+**. TimescaleDB is optional but recommended: telemetry tables
  become hypertables automatically when the extension is present.
- A modern browser.
- For real routers: MikroTik RouterOS hotspots with API access plus RADIUS
  accounting and remote syslog pointed at this server.
- For M-Pesa: a public HTTPS URL (Safaricom cannot call `localhost`) and a
  Daraja app.

Docker users do not need Node or PostgreSQL on the host.

---

## 3. Quick start

### Local development (no PostgreSQL install)

```bash
cp .env.example .env          # review values, especially RADIUS_SECRET
npm install
npm run dev:db                # terminal 1: embedded PostgreSQL on :5432
npm run dev                   # terminal 2: API :8787 + Vite UI
```

`dev:db` runs PGlite (PostgreSQL compiled to WASM) and speaks the normal pg wire
protocol. It is for development only and stores data in `data/pglite`.

Open http://localhost:8787, complete the setup wizard, and leave demo mode on to
explore every screen. Demo mode can be turned off in **Settings**.

### Production on one server with Docker

```bash
cp .env.example .env
# Set at least:
#   DOMAIN=wifi.example.com
#   POSTGRES_PASSWORD=<strong password>
#   CREDENTIALS_KEY=<64 hex chars>
#   RADIUS_SECRET=<strong shared secret>
#   PUBLIC_URL=https://wifi.example.com
docker compose up -d --build
```

Compose starts TimescaleDB/PostgreSQL, one API container, one ingest container,
and Caddy for automatic HTTPS. Only Caddy (80/443), the API (localhost 8787 for
debugging), RADIUS (1813/udp), syslog (514/udp, 1514/tcp), and PostgreSQL
(localhost 5432) are exposed.

### Production without Docker

```bash
npm ci
npm run build
NODE_ENV=production node server/index.js
```

The server applies `server/schema.sql` on boot. Run it behind nginx/Caddy and
supervise it with systemd or your process manager.

---

## 4. Architecture

```
MikroTik hotspots ──┬── RADIUS accounting (UDP 1813) ──┐
                    ├── remote syslog (UDP 514 / TCP 1514) ├── ingest role ── PostgreSQL
                    └── RouterOS API (8728/8729) ── poller ──┘        │
                                                                      │
Guests / operators ─── HTTPS ─── Caddy ─── api role (Express + SSE) ──┘
```

- **`ROLE=api`** runs the HTTP API, the sharded poller, voucher expiry, coverage
  checks, and retention jobs.
- **`ROLE=ingest`** runs only the RADIUS and syslog listeners. It never binds
  HTTP.
- **`ROLE=all`** (default) runs both in one process for small deployments.

Every node shares the same PostgreSQL and `CREDENTIALS_KEY`. Router polling is
coordinated through database leases (`poll_owner`, `poll_lease_until`), so scale
the API role horizontally without configuration:

```bash
docker compose up -d --scale api=3
```

If ingest outgrows one UDP socket, run several ingest containers on separate
hosts and spread routers across their IPs in RouterOS.

### Data model highlights

- `radius_sessions` – one row per RADIUS accounting session, updated on interim
  and stop; `session_events` keeps immutable start/stop audit rows.
- `active_sessions` – current guests per router for the live console.
- `router_logs` – raw syslog lines, indexed by router and time.
- `router_metrics` – poller samples with traffic counters and computed bps.
- `events` – operator-facing activity stream (sales, coverage gaps, failures).
- `ingest_stats` – per-instance ingest counters written every minute.

When TimescaleDB is installed, `router_metrics`, `router_logs`, `events`, and
`session_events` become hypertables partitioned by `ts`.

---

## 5. Connecting a real MikroTik router

### On the router

Use a dedicated API user, then allow the CoryPulse host.

```routeros
/user add name=corypulse group=full password=<api-password>
/ip service set api disabled=no
/ip service set api-ssl disabled=no
```

Enable RADIUS accounting and remote syslog (replace addresses and secret):

```routeros
/radius add service=hotspot address=<corypulse-host> secret=<radius-secret> timeout=3s
/ip hotspot profile set [find name=default] radius-accounting=yes

/system logging action add name=corypulse target=remote remote=<corypulse-host> remote-port=514
/system logging add topics=hotspot info action=corypulse
/system logging add topics=hotspot error action=corypulse
/system logging add topics=system error action=corypulse
```

CoryPulse only creates and removes hotspot users. It never changes router-wide
settings.

### In CoryPulse

1. Open **Sites & routers → Add router** and choose **MikroTik RouterOS**.
2. Enter host/IP, API port, API user, and API password.
3. Enter the router's **NAS IP** (the source address it uses for RADIUS/syslog)
   and the same **RADIUS secret** if it differs from the server default.
4. Save and press **Test**.

Once accounting packets arrive, the router appears under **Routers reporting**
on the dashboard and its sessions populate the live views. API polling continues
in parallel for health and voucher provisioning.

> If the router sits behind NAT, enter the public source IP it presents to the
> server. Every NAS IP must be unique.

### Guest flow with a real hotspot

1. Guest connects to the SSID and the captive portal opens.
2. Guest buys a plan (M-Pesa STK push) or enters a printed voucher code.
3. CoryPulse activates the voucher and creates the hotspot user over the API.
4. The guest logs in with the voucher code as username and password.
5. RADIUS accounting streams the session; syslog captures router events.

---

## 6. Payments

### Demo payments

`demo_payments=1` lets the portal complete a purchase without M-Pesa. Turn it
off in **Settings** before going live.

### M-Pesa Daraja

1. Create a Daraja app and obtain the consumer key, consumer secret, passkey,
   and shortcode.
2. Enter them in **Settings** (or `.env`), choose sandbox or production.
3. Set `PUBLIC_URL` to the real HTTPS address. The callback URL shown in
   Settings must be reachable from Safaricom.
4. Send a test purchase through the guest portal and confirm the callback marks
   the payment paid and issues the voucher.

---

## 7. Vouchers and printable cards

- Generate a batch for a plan and site; codes are unique and human-readable.
- Printed stock can be redeemed later; activation sets the expiry and provisions
  the hotspot user.
- The card sheet prints 24 cards per A4 page with QR codes. Scanning a QR opens
  the portal with the code pre-filled.
- Expired vouchers are expired by a background job every 30 seconds and removed
  from the router.

---

## 8. Capacity and load testing

The design target is **3,500 routers and 1,000,000 concurrent guest sessions**
per shared PostgreSQL cluster. Capacity depends on hardware, UDP bandwidth, and
how often routers send interim updates; test with your own router settings.

Seed a synthetic fleet (routers are parked so the poller ignores them, leaving
only ingest work):

```bash
ROUTERS=3500 SITES=25 npm run seed:scale
```

Blast signed RADIUS accounting traffic:

```bash
ROUTERS=3500 SESSIONS_PER_ROUTER=286 RADIUS_SECRET=<secret> npm run loadtest
```

Useful knobs: `SESSIONS` (absolute total), `MAX_INFLIGHT`, `INTERIM_PERCENT`,
`SEND_STOPS=1`, `INGEST_HOST`, `RADIUS_PORT`.

Practical notes:

- One generator host will bottleneck before the server does at ~1M sessions.
  Run the load script on several machines and point `INGEST_HOST` at the ingest
  node.
- Watch `GET /api/network/overview` for coverage, ingest counters, and the write
  buffer. A permanently growing buffer means PostgreSQL cannot keep up.
- Ingest sockets request an 8 MB kernel receive buffer so a burst (for example
  every router rebooting at once) is queued instead of dropped. If the OS
  clamps it, raise `net.core.rmem_max` on Linux. Ingest writes are chunked well
  below PostgreSQL's 65,535 bind-parameter limit.
- Scale reads and polling with `--scale api=N`; scale UDP ingest by adding
  ingest hosts and splitting NAS IPs across them.
- Keep PostgreSQL and ingest on the same fast network; batch sizes assume low
  write latency.

---

## 9. Data, backups, and security

- **Backups:** `pg_dump -Fc corypulse > corypulse.dump` on a schedule. Back up
  `CREDENTIALS_KEY` separately; router secrets are encrypted with AES-256-GCM
  and cannot be recovered without it.
- **Retention:** router metrics and raw logs default to 90 days, events and
  session events to 365 days. Change with `METRIC_RETENTION_DAYS`,
  `LOG_RETENTION_DAYS`, and `EVENT_RETENTION_DAYS`. TimescaleDB users can add
  native retention policies instead. Guests whose router stops sending
  accounting are removed from the live session view after 30 minutes so a dead
  router cannot leave phantom users behind.
- **Secrets:** router API passwords, RADIUS secrets, and M-Pesa credentials are
  never returned by the API. RADIUS requests are authenticated with the shared
  secret before any row is written; unauthenticated packets are dropped.
- **Exposure:** publish only Caddy on 443. Keep PostgreSQL, the API port, and
  ingest UDP ports on a private network or firewall allow-list of router IPs.
- **TLS:** Caddy obtains certificates automatically for `DOMAIN`. Set
  `PUBLIC_URL` to the same HTTPS URL so session cookies are marked secure.
- **Handover:** delete the demo workspace or reset the database before handing
  the system to a buyer, and replace the default admin account.

### Built-in hardening

| Control | Behaviour |
|---|---|
| Security headers | CSP, HSTS (when HTTPS), `nosniff`, frame denial, strict referrer, permissions policy on every response |
| Request size | API JSON capped at 100 kB (`API_BODY_LIMIT`) |
| Rate limits | 3,000 req/min per IP overall (`API_RATE_PER_MINUTE`), plus tighter per-endpoint and per-phone/per-voucher budgets |
| Login protection | 8 failures per IP and 12 per username in 10 minutes; password hashing is async and queue-limited so a login flood cannot stall the event loop |
| CSRF | `SameSite=Lax` session cookie plus an Origin check on every mutating API call |
| Sessions | SHA-256 hashed tokens, `HttpOnly`, 7-day expiry (`SESSION_DAYS`), expired rows pruned every 6 hours |
| Proxy trust | `X-Forwarded-For` accepted only from loopback/private peers (`TRUST_PROXY`) so rate limits see real client IPs |
| Slowloris | 20 s header timeout, 30 s request timeout, 100-header cap |
| Database | 30 s statement timeout, 35 s query timeout, 60 s idle-transaction timeout — one bad query cannot pin the pool |
| Live stream | Capped at 200 connections (`MAX_SSE_CLIENTS`); slow consumers are dropped instead of buffered without limit |
| Ingest | Write buffers capped at 150k rows; if the database is down the oldest rows are shed and logged rather than exhausting memory |
| Outbound calls | M-Pesa requests abort after 10–15 s instead of hanging |
| Crash handling | Uncaught exceptions trigger a graceful shutdown and container restart; repeated unhandled rejections do the same; UI render errors show a recover button instead of a blank page |

For internet-facing deployments, put the site behind a WAF/CDN (Cloudflare or
similar) as well; app-level limits are the second line of defence, not the first.

---

## 10. Project layout

```
CoryPulse/
├── client/                 React console + captive portal
├── server/
│   ├── index.js            Startup, roles, HTTP server
│   ├── db.js               PostgreSQL pool, compatibility helpers, settings, event buffer
│   ├── schema.sql          Idempotent schema + Timescale hypertables
│   ├── routes.js           Console, portal, payments, reports, telemetry APIs
│   ├── poller.js           Leased sharded poller, coverage, retention
│   ├── ingest.js           RADIUS accounting + syslog listeners and batch writers
│   ├── mikrotik.js         RouterOS API client wrapper and voucher provisioning
│   ├── routeros.js         Minimal RouterOS API protocol client
│   ├── simulator.js        Simulated routers for demos and load tests
│   ├── vouchers.js         Voucher lifecycle
│   ├── payments.js         M-Pesa Daraja + payment state
│   ├── auth.js             Sessions, password hashing, login throttling
│   ├── security.js         Headers, rate limiting, origin checks
│   └── crypto.js           AES-256-GCM secret storage
├── scripts/
│   ├── dev-db.js           Embedded PGlite server for development
│   ├── radius-smoke.js     Signed RADIUS/syslog smoke test
│   ├── seed-scale.js       Synthetic 3,500-router fleet
│   └── loadtest.js         RADIUS load generator
├── deploy/Caddyfile
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## 11. Troubleshooting

| Symptom | Check |
| --- | --- |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL is not running; start it or `npm run dev:db` |
| Setup page keeps reloading | API is up but schema failed; read the server log |
| Router online, zero sessions | RADIUS accounting not enabled, wrong NAS IP, or secret mismatch |
| `ingest.radius.rejected` climbing | Secret mismatch or unknown NAS IP; `ingest.radius.errors` points to malformed packets |
| RADIUS packets get no response | UDP 1813 blocked between router and ingest node |
| Syslog lines missing | Wrong remote port, or the source IP does not match the router's NAS IP |
| Router shows offline but guests work | API polling failed; check API user, port, firewall |
| M-Pesa callback never arrives | `PUBLIC_URL` must be public HTTPS and the callback secret must match |
| Timezone looks wrong | Set `APP_TIMEZONE`; reports group by local calendar date |

Logs go to stdout (Docker captures them). Set `ROLE=ingest` on a node to see
only ingest output.

---

## License and handover

Source and documentation are delivered to the buyer for their Wi-Fi business.
CoryPulse is branded by **CoryTech**. Before handover, replace demo data,
credentials, and `CREDENTIALS_KEY`, then back up the database and key together.

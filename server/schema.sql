-- CoryPulse PostgreSQL schema. Safe to run on every boot.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sites (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  ssid TEXT,
  address TEXT,
  timezone TEXT DEFAULT 'Africa/Nairobi',
  color TEXT DEFAULT '#22d3a7',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS routers (
  id BIGSERIAL PRIMARY KEY,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'simulated',
  host TEXT,
  nas_ip TEXT,
  port INTEGER DEFAULT 8728,
  username TEXT,
  secret_enc TEXT,
  radius_secret_enc TEXT,
  use_tls INTEGER DEFAULT 0,
  hotspot_server TEXT DEFAULT 'hotspot1',
  hotspot_profile TEXT DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'unknown',
  last_seen TIMESTAMPTZ,
  last_error TEXT,
  last_poll_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ,
  coverage_alert_at TIMESTAMPTZ,
  poll_interval_s INTEGER DEFAULT 60,
  consecutive_failures INTEGER DEFAULT 0,
  poll_owner TEXT,
  poll_lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE routers ADD COLUMN IF NOT EXISTS nas_ip TEXT;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS radius_secret_enc TEXT;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS last_poll_at TIMESTAMPTZ;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS coverage_alert_at TIMESTAMPTZ;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS poll_interval_s INTEGER DEFAULT 60;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS poll_owner TEXT;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS poll_lease_until TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_routers_nas_ip
  ON routers(nas_ip) WHERE nas_ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routers_due
  ON routers(next_poll_at) WHERE mode <> 'simulated';

CREATE TABLE IF NOT EXISTS plans (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT DEFAULT 'KES',
  duration_minutes INTEGER NOT NULL,
  data_mb BIGINT DEFAULT 0,
  devices INTEGER DEFAULT 1,
  download_kbps INTEGER DEFAULT 0,
  upload_kbps INTEGER DEFAULT 0,
  hotspot_profile TEXT,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  site_id BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  site_id BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  plan_id BIGINT REFERENCES plans(id) ON DELETE SET NULL,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  voucher_id BIGINT,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'KES',
  method TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  phone TEXT,
  customer_name TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vouchers (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  plan_id BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  site_id BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  router_id BIGINT REFERENCES routers(id) ON DELETE SET NULL,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  payment_id BIGINT,
  status TEXT NOT NULL DEFAULT 'unused',
  price_paid REAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  provisioned INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS active_sessions (
  router_id BIGINT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  site_id BIGINT,
  username TEXT NOT NULL,
  address TEXT,
  uptime_s BIGINT DEFAULT 0,
  rx_bytes BIGINT DEFAULT 0,
  tx_bytes BIGINT DEFAULT 0,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (router_id, username)
);

ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS site_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_active_sessions_site ON active_sessions(site_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_updated ON active_sessions(updated_at);

CREATE TABLE IF NOT EXISTS router_metrics (
  id BIGSERIAL,
  router_id BIGINT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  site_id BIGINT,
  ts TIMESTAMPTZ NOT NULL,
  cpu REAL DEFAULT 0,
  uptime_s BIGINT DEFAULT 0,
  rx_bytes BIGINT DEFAULT 0,
  tx_bytes BIGINT DEFAULT 0,
  rx_bps DOUBLE PRECISION DEFAULT 0,
  tx_bps DOUBLE PRECISION DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  PRIMARY KEY (id, ts)
);

ALTER TABLE router_metrics ADD COLUMN IF NOT EXISTS rx_bytes BIGINT DEFAULT 0;
ALTER TABLE router_metrics ADD COLUMN IF NOT EXISTS tx_bytes BIGINT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_metrics_router_ts ON router_metrics(router_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_ts_brin ON router_metrics USING BRIN (ts);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL,
  ts TIMESTAMPTZ NOT NULL,
  site_id BIGINT,
  router_id BIGINT,
  severity TEXT NOT NULL DEFAULT 'info',
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT DEFAULT 'system',
  PRIMARY KEY (id, ts)
);

ALTER TABLE events ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_router_ts ON events(router_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts DESC);

-- Raw MikroTik syslog. High volume, queried by router/time.
CREATE TABLE IF NOT EXISTS router_logs (
  id BIGSERIAL,
  ts TIMESTAMPTZ NOT NULL,
  router_id BIGINT,
  site_id BIGINT,
  facility TEXT,
  topic TEXT,
  severity TEXT,
  message TEXT,
  raw JSONB,
  PRIMARY KEY (id, ts)
);

CREATE INDEX IF NOT EXISTS idx_router_logs_ts_brin ON router_logs USING BRIN (ts);
CREATE INDEX IF NOT EXISTS idx_router_logs_router_ts ON router_logs(router_id, ts DESC);

-- One row per RADIUS accounting session, updated on interim and stop.
CREATE TABLE IF NOT EXISTS radius_sessions (
  id BIGSERIAL PRIMARY KEY,
  acct_session_id TEXT NOT NULL,
  router_id BIGINT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  site_id BIGINT,
  username TEXT,
  address TEXT,
  calling_station_id TEXT,
  nas_ip TEXT,
  started_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  session_seconds BIGINT DEFAULT 0,
  rx_bytes BIGINT DEFAULT 0,
  tx_bytes BIGINT DEFAULT 0,
  terminate_cause TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (router_id, acct_session_id)
);

CREATE INDEX IF NOT EXISTS idx_radius_active ON radius_sessions(status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_radius_site_active ON radius_sessions(site_id, status);
CREATE INDEX IF NOT EXISTS idx_radius_stopped_brin ON radius_sessions USING BRIN (stopped_at);

-- Immutable session lifecycle events for audit.
CREATE TABLE IF NOT EXISTS session_events (
  id BIGSERIAL,
  ts TIMESTAMPTZ NOT NULL,
  router_id BIGINT,
  site_id BIGINT,
  username TEXT,
  kind TEXT NOT NULL,
  session_seconds BIGINT,
  rx_bytes BIGINT,
  tx_bytes BIGINT,
  payload JSONB,
  acct_session_id TEXT,
  PRIMARY KEY (id, ts)
);

ALTER TABLE session_events ADD COLUMN IF NOT EXISTS acct_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_session_events_ts_brin ON session_events USING BRIN (ts);
CREATE INDEX IF NOT EXISTS idx_session_events_acct ON session_events(acct_session_id);

CREATE TABLE IF NOT EXISTS ingest_stats (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  service TEXT NOT NULL,
  instance_id TEXT,
  messages BIGINT DEFAULT 0,
  errors BIGINT DEFAULT 0,
  detail JSONB
);

CREATE INDEX IF NOT EXISTS idx_ingest_stats_ts ON ingest_stats(ts DESC);CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_site ON vouchers(site_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

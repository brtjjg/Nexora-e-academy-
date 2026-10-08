-- ============================================================
-- NEXORA SECURITY — Migration 004
-- Adds security_events, blocked_ips, security_thresholds
-- ============================================================

BEGIN;

-- 1. Every suspicious activity is recorded here
CREATE TABLE IF NOT EXISTS security_events (
  id              bigserial PRIMARY KEY,
  event_type      text NOT NULL,          -- 'login_failed', 'rate_limited', 'bad_user_agent', 'sql_injection_attempt', etc.
  severity        text NOT NULL DEFAULT 'low'
                  CHECK (severity IN ('low','medium','high','critical')),
  ip_address      text,
  user_agent      text,
  method          text,
  path            text,
  user_id         uuid REFERENCES users(id),
  details         jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sec_ip        ON security_events(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_type      ON security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_severity  ON security_events(severity, created_at DESC);

-- 2. Blocked IPs (auto or manual)
CREATE TABLE IF NOT EXISTS blocked_ips (
  ip_address      text PRIMARY KEY,
  reason          text,
  severity        text NOT NULL DEFAULT 'medium'
                  CHECK (severity IN ('low','medium','high','critical')),
  blocked_by      text NOT NULL DEFAULT 'auto'   -- 'auto' or 'admin:<user_id>'
                  CHECK (blocked_by = 'auto' OR blocked_by LIKE 'admin:%'),
  blocked_at      timestamptz NOT NULL DEFAULT NOW(),
  expires_at      timestamptz,                    -- NULL = permanent
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_blocked_expires ON blocked_ips(expires_at);

-- 3. Thresholds — admin-tunable
CREATE TABLE IF NOT EXISTS security_thresholds (
  key             text PRIMARY KEY,
  value           integer NOT NULL,
  description     text,
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

-- Seed the defaults
INSERT INTO security_thresholds (key, value, description) VALUES
  ('failed_logins_per_10min',     10, 'Block IP after this many failed logins in 10 min'),
  ('requests_per_min',            120, 'Rate limit per IP per minute'),
  ('suspicious_paths_per_10min',  5,  'Block IP after this many 404s on suspicious paths in 10 min'),
  ('block_duration_hours',        24, 'How long auto-blocks last (hours)')
ON CONFLICT (key) DO NOTHING;

COMMIT;

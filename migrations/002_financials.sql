-- ============================================================
-- NEXORA FINANCIALS — Migration 002
-- Default split: 70% contributor / 30% Nexora
-- Hold period: 7 days
-- ============================================================

BEGIN;

-- 1. Extend users.role to include finance roles
DO $$
DECLARE
  conname_var text;
BEGIN
  SELECT conname INTO conname_var
  FROM pg_constraint
  WHERE conrelid = 'users'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%role%';

  IF conname_var IS NOT NULL THEN
    EXECUTE 'ALTER TABLE users DROP CONSTRAINT ' || quote_ident(conname_var);
  END IF;

  ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('student','contributor','admin','finance_admin','finance_manager','super_admin'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Course revenue config (per-course overrides)
CREATE TABLE IF NOT EXISTS course_revenue_config (
  course_id                  uuid PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  contributor_share_percent  numeric(5,2) NOT NULL DEFAULT 70.00
                             CHECK (contributor_share_percent >= 0 AND contributor_share_percent <= 100),
  nexora_share_percent       numeric(5,2) NOT NULL DEFAULT 30.00
                             CHECK (nexora_share_percent >= 0 AND nexora_share_percent <= 100),
  override_reason            text,
  updated_by                 uuid REFERENCES users(id),
  updated_at                 timestamptz NOT NULL DEFAULT NOW(),
  CHECK (contributor_share_percent + nexora_share_percent = 100)
);

-- 3. Ledger (immutable, append-only)
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  bigserial PRIMARY KEY,
  entry_ref           text NOT NULL UNIQUE,
  contributor_id      uuid REFERENCES users(id),
  course_id           uuid REFERENCES courses(id),
  transaction_id      uuid REFERENCES transactions(id),
  entry_type          text NOT NULL CHECK (entry_type IN (
                        'sale_contributor_credit',
                        'sale_nexora_credit',
                        'refund_debit',
                        'payout_debit',
                        'adjustment_credit',
                        'adjustment_debit'
                      )),
  amount              numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency            text NOT NULL DEFAULT 'USD',
  is_pending          boolean NOT NULL DEFAULT TRUE,
  available_at        timestamptz,
  description         text,
  metadata            jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_contributor ON ledger_entries(contributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_course      ON ledger_entries(course_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_pending     ON ledger_entries(is_pending, available_at)
  WHERE is_pending = TRUE;

CREATE SEQUENCE IF NOT EXISTS ledger_ref_seq START 1;

CREATE OR REPLACE FUNCTION gen_ledger_ref()
RETURNS text AS $$
  SELECT 'NXA-LED-' || LPAD(nextval('ledger_ref_seq')::text, 8, '0');
$$ LANGUAGE sql;

-- 4. Contributor balances (materialized)
CREATE TABLE IF NOT EXISTS contributor_balances (
  contributor_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_balance   numeric(12,2) NOT NULL DEFAULT 0.00,
  pending_balance     numeric(12,2) NOT NULL DEFAULT 0.00,
  total_earned        numeric(12,2) NOT NULL DEFAULT 0.00,
  total_paid          numeric(12,2) NOT NULL DEFAULT 0.00,
  currency            text NOT NULL DEFAULT 'USD',
  last_ledger_id      bigint,
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

-- 5. Payout destinations
CREATE TABLE IF NOT EXISTS payout_destinations (
  id                  bigserial PRIMARY KEY,
  contributor_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method              text NOT NULL CHECK (method IN ('manual','bank_transfer','paypal','mpesa','pesapal','wise')),
  label               text,
  details             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','verified','rejected')),
  verified_by         uuid REFERENCES users(id),
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_dest_contributor ON payout_destinations(contributor_id, status);

-- 6. Payout requests
CREATE TABLE IF NOT EXISTS payout_requests (
  id                  bigserial PRIMARY KEY,
  payout_ref          text NOT NULL UNIQUE,
  contributor_id      uuid NOT NULL REFERENCES users(id),
  destination_id      bigint REFERENCES payout_destinations(id),
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  currency            text NOT NULL DEFAULT 'USD',
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                        'pending','under_review','approved','processing',
                        'paid','rejected','failed','cancelled'
                      )),
  requested_by        uuid REFERENCES users(id),
  requested_at        timestamptz NOT NULL DEFAULT NOW(),
  reviewed_by         uuid REFERENCES users(id),
  reviewed_at         timestamptz,
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  rejection_reason    text,
  failure_reason      text,
  payment_reference   text,
  marked_paid_by      uuid REFERENCES users(id),
  marked_paid_at      timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_status      ON payout_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_contributor ON payout_requests(contributor_id, requested_at DESC);

CREATE SEQUENCE IF NOT EXISTS payout_ref_seq START 1;

CREATE OR REPLACE FUNCTION gen_payout_ref()
RETURNS text AS $$
  SELECT 'NXA-PAY-' || LPAD(nextval('payout_ref_seq')::text, 8, '0');
$$ LANGUAGE sql;

-- 7. Payout transactions
CREATE TABLE IF NOT EXISTS payout_transactions (
  id                  bigserial PRIMARY KEY,
  payout_request_id   bigint NOT NULL REFERENCES payout_requests(id) ON DELETE CASCADE,
  provider            text NOT NULL DEFAULT 'manual',
  provider_ref        text,
  amount              numeric(12,2) NOT NULL,
  currency            text NOT NULL DEFAULT 'USD',
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','processing','success','failed','reversed')),
  raw_response        jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_tx_request ON payout_transactions(payout_request_id);

-- 8. Finance audit logs
CREATE TABLE IF NOT EXISTS finance_audit_logs (
  id                  bigserial PRIMARY KEY,
  actor_id            uuid REFERENCES users(id),
  actor_role          text,
  action              text NOT NULL,
  entity_type         text,
  entity_id           text,
  amount              numeric(12,2),
  currency            text,
  notes               text,
  metadata            jsonb DEFAULT '{}'::jsonb,
  ip_address          text,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor  ON finance_audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON finance_audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON finance_audit_logs(action, created_at DESC);

-- 9. Helper functions
CREATE OR REPLACE FUNCTION get_course_split(p_course_id uuid)
RETURNS TABLE (contributor_percent numeric, nexora_percent numeric) AS $$
  SELECT
    COALESCE(crc.contributor_share_percent, 70.00),
    COALESCE(crc.nexora_share_percent, 30.00)
  FROM (SELECT 1) dummy
  LEFT JOIN course_revenue_config crc ON crc.course_id = p_course_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION recompute_contributor_balance(p_contributor_id uuid)
RETURNS void AS $$
DECLARE
  v_available numeric(12,2);
  v_pending   numeric(12,2);
  v_earned    numeric(12,2);
  v_paid      numeric(12,2);
  v_last_id   bigint;
BEGIN
  SELECT
    COALESCE(SUM(CASE
      WHEN entry_type IN ('sale_contributor_credit','adjustment_credit') AND is_pending = FALSE THEN amount
      WHEN entry_type IN ('refund_debit','payout_debit','adjustment_debit') AND is_pending = FALSE THEN -amount
      ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN entry_type = 'sale_contributor_credit' AND is_pending = TRUE THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN entry_type IN ('sale_contributor_credit','adjustment_credit') THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN entry_type = 'payout_debit' THEN amount ELSE 0 END), 0),
    MAX(id)
  INTO v_available, v_pending, v_earned, v_paid, v_last_id
  FROM ledger_entries
  WHERE contributor_id = p_contributor_id;

  INSERT INTO contributor_balances
    (contributor_id, available_balance, pending_balance, total_earned, total_paid, last_ledger_id, updated_at)
  VALUES
    (p_contributor_id, v_available, v_pending, v_earned, v_paid, v_last_id, NOW())
  ON CONFLICT (contributor_id) DO UPDATE SET
    available_balance = EXCLUDED.available_balance,
    pending_balance   = EXCLUDED.pending_balance,
    total_earned      = EXCLUDED.total_earned,
    total_paid        = EXCLUDED.total_paid,
    last_ledger_id    = EXCLUDED.last_ledger_id,
    updated_at        = NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_ledger_after_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.contributor_id IS NOT NULL THEN
    PERFORM recompute_contributor_balance(NEW.contributor_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_after_insert ON ledger_entries;
CREATE TRIGGER ledger_after_insert
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_after_insert();

CREATE OR REPLACE FUNCTION release_matured_ledger_entries()
RETURNS integer AS $$
DECLARE
  v_count integer;
BEGIN
  WITH upd AS (
    UPDATE ledger_entries
    SET is_pending = FALSE
    WHERE is_pending = TRUE
      AND available_at IS NOT NULL
      AND available_at <= NOW()
    RETURNING contributor_id
  )
  SELECT COUNT(*) INTO v_count FROM upd;

  PERFORM recompute_contributor_balance(contributor_id)
  FROM (SELECT DISTINCT contributor_id FROM ledger_entries WHERE contributor_id IS NOT NULL) x;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMIT;

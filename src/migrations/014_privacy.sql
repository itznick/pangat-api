-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014: privacy (DPDP Act): consent record and data-principal requests.
-- Additive and idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
-- What the person agreed to, and when. The notice version lets us prove which text they saw.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS consent_version varchar(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_version varchar(20);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_at timestamptz;

-- Finding a person's orders by phone (access / erasure requests) must not scan the whole table
CREATE INDEX IF NOT EXISTS idx_orders_phone_digits ON orders ((right(regexp_replace(customer_phone, '\D', '', 'g'), 10))) WHERE customer_phone IS NOT NULL;
-- Retention sweep: PII on old, finished orders
CREATE INDEX IF NOT EXISTS idx_orders_pii_created ON orders (created_at) WHERE customer_phone IS NOT NULL OR customer_name IS NOT NULL OR delivery_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS privacy_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        varchar(20) NOT NULL UNIQUE,            -- what the person is told, e.g. PR-7K2M9QX4
  kind             varchar(24) NOT NULL,                   -- ACCESS | CORRECTION | ERASURE | WITHDRAW_CONSENT | GRIEVANCE | NOMINATE
  name             varchar(120) NOT NULL,
  contact          varchar(180) NOT NULL,                  -- email or phone the person gave
  restaurant_ref   varchar(120),                           -- which restaurant they dealt with, if they know
  message          text,
  status           varchar(16) NOT NULL DEFAULT 'OPEN',    -- OPEN | IN_PROGRESS | RESOLVED | REJECTED
  due_at           timestamptz NOT NULL,
  resolved_at      timestamptz,
  resolution_note  text,
  handled_by       varchar(120),
  consent_version  varchar(20),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests (status, due_at);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_created ON privacy_requests (created_at DESC);

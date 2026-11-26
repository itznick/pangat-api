-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 020: payment integrity and UPI confirmation (Pilot Readiness).
--
--  * orders.request_hash: hash of what the guest asked for. A retry with the same idempotency key and the same request returns the
--    original order; the same key with a DIFFERENT request is a conflict (409). Nullable: existing orders have none and keep
--    behaving as before.
--  * order_refunds: one row per refund operation. UNIQUE (order_id, idempotency_key) makes "one refund per key" a database fact, not
--    a lookup race. request_hash detects the same key reused for a different refund.
--  * uq_tax_documents_bill_per_order: at most ONE bill document per order. It is created only if no order already has two (a
--    production database that somehow does keeps working; the application also serialises bill issuance with a row lock).
--  * orders CHECK (refund_amount <= total_amount): added NOT VALID, so it protects every new write and never fails on old data.
--  * restaurants.upi_vpa_confirmed_at / _by: the owner's explicit confirmation that the UPI ID belongs to the business. EXISTING
--    OUTLETS START UNCONFIRMED, so diner UPI stays off until the owner confirms. Changing the UPI ID clears the confirmation.
--
-- Additive and idempotent. Nothing is deleted or rewritten.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash char(64);

CREATE TABLE IF NOT EXISTS order_refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           varchar(20) NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  restaurant_id      uuid        NOT NULL,
  idempotency_key    varchar(100) NOT NULL,
  request_hash       char(64)    NOT NULL,
  method             varchar(20) NOT NULL,
  amount             numeric(10,2) NOT NULL CHECK (amount > 0),
  reason             text        NOT NULL,
  credit_note_number varchar(32),
  provider_reference varchar(120),
  requested_by       uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_order_refunds_key UNIQUE (order_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_order_refunds_order ON order_refunds (order_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tax_documents WHERE kind = 'BILL' GROUP BY order_id HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'Some orders already have more than one BILL document: uq_tax_documents_bill_per_order NOT created (review them first)';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_documents_bill_per_order ON tax_documents (order_id) WHERE kind = 'BILL';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_refund_within_total') THEN
    ALTER TABLE orders ADD CONSTRAINT chk_orders_refund_within_total CHECK (refund_amount <= total_amount) NOT VALID;
  END IF;
END
$$;

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_vpa_confirmed_at timestamptz;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_vpa_confirmed_by uuid;

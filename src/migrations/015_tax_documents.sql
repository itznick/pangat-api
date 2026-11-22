-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 015: statutory bill numbers and credit notes (CGST Rule 46), FSSAI licence on bills.
--  * every paid order gets a consecutive, unique serial number (max 16 characters), per outlet and financial year (1 April - 31 March)
--  * every refund gets a credit-note number from its own series
--  * the register (tax_documents) is append-only, like the audit logs
-- Additive and idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS fssai_license varchar(14);
-- Short code that keeps one outlet's numbers distinct from every other outlet's (several outlets can share one GSTIN)
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS invoice_prefix varchar(4);
CREATE UNIQUE INDEX IF NOT EXISTS uq_restaurants_invoice_prefix ON restaurants (invoice_prefix) WHERE invoice_prefix IS NOT NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_number varchar(16);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_issued_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_bill_number ON orders (restaurant_id, bill_number) WHERE bill_number IS NOT NULL;

-- One counter per outlet, document kind and financial year. Incrementing it inside the issuing transaction keeps numbers gap-free.
CREATE TABLE IF NOT EXISTS document_sequences (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  kind          varchar(12) NOT NULL,        -- BILL | CREDIT_NOTE
  fiscal_year   varchar(4)  NOT NULL,        -- e.g. 2627 for April 2026 - March 2027
  last_value    integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, kind, fiscal_year)
);

CREATE TABLE IF NOT EXISTS tax_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id      varchar(20) NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,   -- order ids are short text ids, not uuids
  kind          varchar(12) NOT NULL,
  number        varchar(16) NOT NULL,
  fiscal_year   varchar(4)  NOT NULL,
  amount        numeric(12,2) NOT NULL,
  reason        text,
  issued_by     varchar(120),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, number)
);
CREATE INDEX IF NOT EXISTS idx_tax_documents_order ON tax_documents (order_id);
CREATE INDEX IF NOT EXISTS idx_tax_documents_restaurant ON tax_documents (restaurant_id, issued_at DESC);

CREATE OR REPLACE FUNCTION tax_documents_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax_documents is append-only: % is not permitted', TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tax_documents_immutable ON tax_documents;
CREATE TRIGGER trg_tax_documents_immutable BEFORE UPDATE OR DELETE ON tax_documents
  FOR EACH ROW EXECUTE FUNCTION tax_documents_immutable();
DROP TRIGGER IF EXISTS trg_tax_documents_no_truncate ON tax_documents;
CREATE TRIGGER trg_tax_documents_no_truncate BEFORE TRUNCATE ON tax_documents
  FOR EACH STATEMENT EXECUTE FUNCTION tax_documents_immutable();

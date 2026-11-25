-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 019: billing profile and a consecutive invoice series for Pangat's own subscription invoices.
--
--  * organizations gets four OPTIONAL columns describing who a tax invoice is addressed to and the place of supply
--    (legal name, address, GST state code, GSTIN). Nothing is backfilled; every column is nullable.
--  * subscription_invoice_sequences holds one counter per financial year (e.g. '2627'). New invoices are numbered
--    PGT/2627/000001 ... consecutively, inside the transaction that inserts the invoice (CGST Rule 46: consecutive, unique per
--    financial year, at most 16 characters). Invoices already issued keep their numbers.
--
-- Additive and idempotent. This does NOT turn on paid subscription billing: nothing in the application creates a gateway
-- subscription or checkout, and manual grants still create no invoice.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_legal_name  varchar(200);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address     text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_state_code  varchar(2);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_gstin       varchar(15);

CREATE TABLE IF NOT EXISTS subscription_invoice_sequences (
  fiscal_year varchar(4) PRIMARY KEY,
  last_value  bigint     NOT NULL DEFAULT 0
);

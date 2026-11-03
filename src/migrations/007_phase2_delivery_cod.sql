-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: Phase 2 — Cash on Delivery (COD) Payment Method & Orders Defaults
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'orders_payment_method_enum') THEN
    ALTER TYPE "orders_payment_method_enum" ADD VALUE IF NOT EXISTS 'COD';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method_enum') THEN
    ALTER TYPE "payment_method_enum" ADD VALUE IF NOT EXISTS 'COD';
  END IF;
END $$;

-- Guarantee refund_amount column default is 0.00 and non-null
ALTER TABLE "orders" 
  ALTER COLUMN "refund_amount" SET DEFAULT 0.00;

UPDATE "orders" 
SET "refund_amount" = 0.00 
WHERE "refund_amount" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007 Rollback: Cash on Delivery (COD) Payment Method
-- ─────────────────────────────────────────────────────────────────────────────

-- Update any COD orders to PAY_AT_COUNTER prior to any schema revert
UPDATE "orders" 
SET "payment_method" = 'PAY_AT_COUNTER' 
WHERE "payment_method" = 'COD';

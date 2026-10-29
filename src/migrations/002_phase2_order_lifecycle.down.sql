-- ─────────────────────────────────────────────────────────────────────────────
-- pangat-api Database Rollback: 002_phase2_order_lifecycle.down.sql
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP INDEX IF EXISTS "idx_audit_logs_restaurant_entity";
DROP TABLE IF EXISTS "audit_logs";

ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "cancellation_reason",
  DROP COLUMN IF EXISTS "cancelled_at",
  DROP COLUMN IF EXISTS "cancelled_by_staff_id",
  DROP COLUMN IF EXISTS "refund_amount",
  DROP COLUMN IF EXISTS "refund_reason",
  DROP COLUMN IF EXISTS "refunded_at",
  DROP COLUMN IF EXISTS "refunded_by_staff_id",
  DROP COLUMN IF EXISTS "version";

-- Note: In PostgreSQL, dropping values from an ENUM requires recreating the enum type
-- if values are in active use. In rollback, existing CANCELLED/REFUND rows must be 
-- migrated or archived before removing enum values.

COMMIT;

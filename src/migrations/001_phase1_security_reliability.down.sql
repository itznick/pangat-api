-- ─────────────────────────────────────────────────────────────────────────────
-- pangat-api Database Rollback: 001_phase1_security_reliability.down.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback script for Phase 1 migration
-- Reverts timezone types and removes added columns and indexes
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Drop indexes
DROP INDEX IF EXISTS "idx_orders_status_created";
DROP INDEX IF EXISTS "idx_staff_reset_token";

-- 2. Revert orders table
ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "preparing_at",
  DROP COLUMN IF EXISTS "ready_at",
  DROP COLUMN IF EXISTS "completed_at";

ALTER TABLE "orders"
  ALTER COLUMN "settled_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING ("settled_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING ("updated_at" AT TIME ZONE 'UTC');

-- 3. Revert staff table
ALTER TABLE "staff"
  DROP COLUMN IF EXISTS "reset_token_hash",
  DROP COLUMN IF EXISTS "reset_token_expires_at";

ALTER TABLE "staff"
  ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING ("updated_at" AT TIME ZONE 'UTC');

COMMIT;

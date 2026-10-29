-- ─────────────────────────────────────────────────────────────────────────────
-- pangat-api Database Migration: 001_phase1_security_reliability.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Target Database: PostgreSQL (Neon Serverless)
-- Idempotent, safe, and non-destructive forward migration
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Upgrade staff table
ALTER TABLE "staff" 
  ADD COLUMN IF NOT EXISTS "reset_token_hash" VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS "reset_token_expires_at" TIMESTAMPTZ NULL;

ALTER TABLE "staff" 
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ USING ("updated_at" AT TIME ZONE 'UTC');

-- 2. Upgrade orders table
ALTER TABLE "orders" 
  ADD COLUMN IF NOT EXISTS "tracking_token" VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS "preparing_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "ready_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ NULL;

ALTER TABLE "orders" 
  ALTER COLUMN "settled_at" TYPE TIMESTAMPTZ USING ("settled_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ USING ("updated_at" AT TIME ZONE 'UTC');

-- 3. Dedicated indexes
CREATE INDEX IF NOT EXISTS "idx_staff_reset_token" 
  ON "staff" ("reset_token_expires_at") 
  WHERE "reset_token_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_orders_status_created" 
  ON "orders" ("restaurant_id", "order_status", "created_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_orders_tracking_token"
  ON "orders" ("tracking_token")
  WHERE "tracking_token" IS NOT NULL;

COMMIT;

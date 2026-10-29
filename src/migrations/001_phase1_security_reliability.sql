-- ─────────────────────────────────────────────────────────────────────────────
-- pangat-api Database Migration: Phase 1 Security & Reliability
-- ─────────────────────────────────────────────────────────────────────────────
-- Safe, idempotent, non-destructive migration script
-- Adds timezone-aware timestamps, KDS transition logs, and reset token hashes
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Upgrade staff table with reset token hash and timestamptz columns
ALTER TABLE "staff" 
  ADD COLUMN IF NOT EXISTS "reset_token_hash" VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS "reset_token_expires_at" TIMESTAMPTZ NULL;

ALTER TABLE "staff" 
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ USING "updated_at" AT TIME ZONE 'UTC';

-- 2. Upgrade orders table with stage transition timestamps & timezone safety
ALTER TABLE "orders" 
  ADD COLUMN IF NOT EXISTS "preparing_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "ready_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ NULL;

ALTER TABLE "orders" 
  ALTER COLUMN "settled_at" TYPE TIMESTAMPTZ USING "settled_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ USING "updated_at" AT TIME ZONE 'UTC';

-- 3. Add index on reset_token_expires_at to prevent slow lookups
CREATE INDEX IF NOT EXISTS "idx_staff_reset_token" ON "staff" ("reset_token_expires_at") WHERE "reset_token_expires_at" IS NOT NULL;

-- 4. Add index on order status & dates for historical lookups
CREATE INDEX IF NOT EXISTS "idx_orders_status_created" ON "orders" ("restaurant_id", "order_status", "created_at" DESC);

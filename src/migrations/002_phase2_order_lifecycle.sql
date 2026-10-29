-- ─────────────────────────────────────────────────────────────────────────────
-- pangat-api Database Migration: 002_phase2_order_lifecycle.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Target Database: PostgreSQL (Neon Serverless)
-- Phase 2 Feature 1: Order Lifecycle, Audit Ledger & Refund Workflows
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Extend order_status enum
ALTER TYPE "order_status_enum" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- 2. Extend payment_status enum with refund statuses
ALTER TYPE "payment_status_enum" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';
ALTER TYPE "payment_status_enum" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';
ALTER TYPE "payment_status_enum" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- 3. Upgrade orders table with cancellation, refund, and concurrency versioning
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "cancellation_reason" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "cancelled_by_staff_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "refund_amount" DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS "refund_reason" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "refunded_by_staff_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "version" INT NOT NULL DEFAULT 1;

-- 4. Create operational audit_logs table
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "restaurant_id" UUID NOT NULL REFERENCES "restaurants"("id") ON DELETE CASCADE,
  "entity_type" VARCHAR(50) NOT NULL,
  "entity_id" VARCHAR(100) NOT NULL,
  "action" VARCHAR(50) NOT NULL,
  "staff_id" UUID NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  "staff_name" VARCHAR(100) NULL,
  "staff_role" VARCHAR(50) NULL,
  "reason" TEXT NULL,
  "metadata" JSONB NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Dedicated indexing for audit queries
CREATE INDEX IF NOT EXISTS "idx_audit_logs_restaurant_entity"
  ON "audit_logs" ("restaurant_id", "entity_type", "entity_id", "created_at" DESC);

COMMIT;

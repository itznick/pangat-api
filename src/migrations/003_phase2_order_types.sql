-- Migration: 003_phase2_order_types.sql
-- Description: Add order_type, delivery fields, customer fields, and DISPATCHED order status

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_type_enum') THEN
    CREATE TYPE "order_type_enum" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');
  END IF;
END $$;

-- Add DISPATCHED to order_status enum if not present
DO $$
BEGIN
  ALTER TYPE "order_status_enum" ADD VALUE IF NOT EXISTS 'DISPATCHED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Order entity schema adjustments
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "order_type" "order_type_enum" NOT NULL DEFAULT 'DINE_IN',
  ADD COLUMN IF NOT EXISTS "customer_name" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "delivery_address" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_instructions" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_fee" NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS "dispatched_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "dispatched_by_staff_id" UUID;

-- Make table_number nullable for TAKEAWAY and DELIVERY
ALTER TABLE "orders" ALTER COLUMN "table_number" DROP NOT NULL;

-- Index order_type for dashboard filtering and metrics
CREATE INDEX IF NOT EXISTS "idx_orders_order_type" ON "orders" ("order_type");

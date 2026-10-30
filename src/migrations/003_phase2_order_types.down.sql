-- Rollback Migration: 003_phase2_order_types.down.sql

DROP INDEX IF EXISTS "idx_orders_order_type";

ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "dispatched_by_staff_id",
  DROP COLUMN IF EXISTS "delivered_at",
  DROP COLUMN IF EXISTS "dispatched_at",
  DROP COLUMN IF EXISTS "delivery_fee",
  DROP COLUMN IF EXISTS "delivery_instructions",
  DROP COLUMN IF EXISTS "delivery_address",
  DROP COLUMN IF EXISTS "customer_name",
  DROP COLUMN IF EXISTS "order_type";

-- Note: Postgres enums cannot easily remove a value without recreation, so DISPATCHED remains harmless in enum.
DROP TYPE IF EXISTS "order_type_enum";

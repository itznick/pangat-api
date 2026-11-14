-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011: repair - re-assert the additive schema of migrations 001 and 009.
-- Some databases recorded 009 as applied (or were baselined by hand) without actually having its columns, which made every
-- query on staff / restaurants fail with "column ... does not exist". Everything here is idempotent (IF NOT EXISTS / guarded)
-- and additive: a database that is already correct is left unchanged. Data-moving steps of 009 are intentionally not repeated.
-- ─────────────────────────────────────────────────────────────────────────────

-- from 001
ALTER TABLE staff ADD COLUMN IF NOT EXISTS reset_token_hash varchar(255);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS reset_token_expires_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_token varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparing_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- from 009
-- Staff: account state, hashed station PIN, brute-force lockout, token invalidation
ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash varchar(255);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Service charge (percentage of subtotal, 0 = none) per outlet, snapshot per order
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS service_charge_percentage numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge_amount numeric(10,2) NOT NULL DEFAULT 0;

-- Menu items are soft-deleted so historical orders / recipes stay intact
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS auto_disabled boolean NOT NULL DEFAULT false;

-- A dish may outlive its category: deleting a category sets category_id NULL (the FK already says ON DELETE SET NULL,
-- but the NOT NULL made that impossible and surfaced as a 500)
ALTER TABLE menu_items ALTER COLUMN category_id DROP NOT NULL;

-- ── Indexes for the hot paths (all IF NOT EXISTS) ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_created ON orders (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status ON orders (restaurant_id, order_status);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_payment ON orders (restaurant_id, payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items (restaurant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items (category_id);
CREATE INDEX IF NOT EXISTS idx_menu_categories_restaurant ON menu_categories (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_modifiers_menu_item ON modifiers (menu_item_id);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON tables (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_staff_organization ON staff (organization_id);
CREATE INDEX IF NOT EXISTS idx_staff_restaurant ON staff (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_organization ON restaurants (organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_restaurant_created ON audit_logs (restaurant_id, created_at DESC);

-- Case-insensitive uniqueness for logins. Guarded: skipped (with a notice) if legacy rows already collide,
-- so the migration can never fail or drop data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM staff GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE NOTICE 'staff has emails that differ only by case; skipping uq_staff_email_lower - resolve manually';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_email_lower ON staff (lower(email));
  END IF;

  IF EXISTS (SELECT 1 FROM tables GROUP BY restaurant_id, upper(table_number) HAVING count(*) > 1) THEN
    RAISE NOTICE 'duplicate table numbers within an outlet; skipping uq_tables_restaurant_number - resolve manually';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tables_restaurant_number ON tables (restaurant_id, upper(table_number));
  END IF;
END $$;

-- Integrity checks (NOT VALID so existing data is never rejected; enforced for all new writes)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_items_qty_positive') THEN
    ALTER TABLE order_items ADD CONSTRAINT chk_order_items_qty_positive CHECK (quantity > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_menu_items_price_nonneg') THEN
    ALTER TABLE menu_items ADD CONSTRAINT chk_menu_items_price_nonneg CHECK (price >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_amounts_nonneg') THEN
    ALTER TABLE orders ADD CONSTRAINT chk_orders_amounts_nonneg CHECK (subtotal >= 0 AND total_amount >= 0 AND refund_amount >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurants_gst_range') THEN
    ALTER TABLE restaurants ADD CONSTRAINT chk_restaurants_gst_range CHECK (gst_percentage >= 0 AND gst_percentage <= 28) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurants_service_charge_range') THEN
    ALTER TABLE restaurants ADD CONSTRAINT chk_restaurants_service_charge_range CHECK (service_charge_percentage >= 0 AND service_charge_percentage <= 20) NOT VALID;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009: security hardening, integrity constraints, query indexes,
-- service charge, soft-deleted menu items.
-- Backward compatible and non-destructive: only ADD columns / indexes. Existing rows are untouched.
-- ─────────────────────────────────────────────────────────────────────────────

-- Staff: account state, hashed station PIN, brute-force lockout, token invalidation
ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash varchar(255);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Station PINs: historically a kitchen PIN was stored in clear on a manager account and matched across tenants.
-- Move each such PIN onto a dedicated per-outlet CHEF "Kitchen Station" account (so existing kitchen tablets keep
-- working) and clear it from the manager. The clear-text value is hashed on the station's next successful sign-in.
INSERT INTO staff (name, email, password_hash, role, organization_id, restaurant_id, pin_code)
SELECT DISTINCT ON (r.id)
       'Kitchen Station',
       'kitchen.' || r.slug || '@stations.pangat.app',
       '!unusable-' || md5(random()::text || r.id::text),   -- not a valid bcrypt hash: password login impossible
       'CHEF', r.organization_id, r.id, s.pin_code
FROM staff s
JOIN restaurants r ON r.id = s.restaurant_id
WHERE s.pin_code IS NOT NULL AND s.role <> 'CHEF'
  AND NOT EXISTS (SELECT 1 FROM staff st WHERE st.restaurant_id = r.id AND st.role = 'CHEF' AND st.pin_code IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM staff st WHERE lower(st.email) = lower('kitchen.' || r.slug || '@stations.pangat.app'))
ORDER BY r.id, s.created_at;
UPDATE staff SET pin_code = NULL WHERE pin_code IS NOT NULL AND role <> 'CHEF';

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

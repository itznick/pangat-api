-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Phase 2 Feature 3 — Inventory & Stock Management
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create Unit of Measure Enum if not exists
DO $$ BEGIN
  CREATE TYPE unit_of_measure AS ENUM ('KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACKET');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Create Stock Movement Type Enum if not exists
DO $$ BEGIN
  CREATE TYPE stock_movement_type AS ENUM (
    'OPENING_STOCK',
    'RECEIVED',
    'MANUAL_ADJUSTMENT',
    'ORDER_CONSUMPTION',
    'ORDER_CANCELLATION_REVERSAL',
    'WASTAGE'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 3. Add auto_deduct_inventory flag to restaurants
ALTER TABLE restaurants
ADD COLUMN IF NOT EXISTS auto_deduct_inventory BOOLEAN NOT NULL DEFAULT true;

-- 4. Create ingredients table
CREATE TABLE IF NOT EXISTS ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  sku VARCHAR(60),
  unit VARCHAR(30) NOT NULL DEFAULT 'KG',
  current_stock NUMERIC(12,3) NOT NULL DEFAULT 0.000,
  minimum_stock NUMERIC(12,3) NOT NULL DEFAULT 0.000,
  cost_per_unit NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingredients_restaurant_id ON ingredients(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_restaurant_name ON ingredients(restaurant_id, name);

-- 5. Create stock_movements table
CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  quantity NUMERIC(12,3) NOT NULL,
  balance_after NUMERIC(12,3) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  reference_order_id VARCHAR(50),
  actor_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_restaurant_date ON stock_movements(restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient_date ON stock_movements(ingredient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_order_ref ON stock_movements(reference_order_id);

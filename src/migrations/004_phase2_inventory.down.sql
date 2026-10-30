-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback Migration 004: Phase 2 Feature 3 — Inventory & Stock Management
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS recipe_ingredients CASCADE;
DROP TABLE IF EXISTS recipes CASCADE;
DROP TABLE IF EXISTS stock_movements CASCADE;
DROP TABLE IF EXISTS ingredients CASCADE;

ALTER TABLE restaurants DROP COLUMN IF EXISTS auto_deduct_inventory;

DROP TYPE IF EXISTS stock_movement_type;
DROP TYPE IF EXISTS unit_of_measure;

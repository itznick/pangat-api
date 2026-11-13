-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: Per-outlet operating rules (pause switch, hours, order types, payments)
-- Stored as JSON so new rules never need another migration. NULL means "use defaults".
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS operations jsonb;

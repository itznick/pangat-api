-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback Migration 005: Phase 2 Feature 3 — Multi-Tenant SaaS Subscriptions
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS subscription_audit_logs CASCADE;
DROP TABLE IF EXISTS subscription_invoices CASCADE;
DROP TABLE IF EXISTS organization_subscriptions CASCADE;
DROP TABLE IF EXISTS subscription_plans CASCADE;

DROP TYPE IF EXISTS subscription_invoice_status;
DROP TYPE IF EXISTS billing_interval;
DROP TYPE IF EXISTS subscription_status;

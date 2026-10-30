-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: Rollback Documentation & Reversal Script
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ⚠️ HIGH RISK / DESTRUCTIVE OPERATION WARNING:
-- Reverting migration 006 drops integer paise financial columns (base_amount_paise,
-- tax_amount_paise, total_amount_paise, cgst_amount_paise, sgst_amount_paise,
-- igst_amount_paise, state_code, buyer_gstin, max_staff_per_outlet).
--
-- Running DROP COLUMN statements permanently purges sub-rupee precision records,
-- place-of-supply breakdown, and staff limit configurations.
--
-- MANDATORY RECOVERY & BACKUP PROCEDURE BEFORE ROLLBACK:
-- 1. Perform a full snapshot of the Postgres database using pg_dump:
--    pg_dump -h $PGHOST -U $PGUSER -d $PGDATABASE -F c -b -v -f "pangat_pre_rollback_006_$(date +%Y%m%d_%H%M%S).dump"
-- 2. Verify dump integrity:
--    pg_restore --list "pangat_pre_rollback_006_*.dump" | grep -E "subscription_plans|subscription_invoices"
-- 3. Ensure no active payment webhook transactions are executing in flight.
-- 4. Execute the rollback within an explicit SQL transaction.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Drop partial unique indexes safely
DROP INDEX IF EXISTS uq_sub_invoices_rzp_payment_id;
DROP INDEX IF EXISTS uq_sub_audit_idempotency_key;

-- 2. Optionally deactivate (do NOT delete) annual plans to preserve historical subscriptions
UPDATE subscription_plans
SET is_active = false
WHERE code IN ('STARTER_ANNUAL', 'GROWTH_ANNUAL', 'ENTERPRISE_ANNUAL');

-- 3. Drop enhanced columns on subscription_invoices (Only proceed after Step 1 backup verification!)
ALTER TABLE subscription_invoices
  DROP COLUMN IF EXISTS base_amount_paise,
  DROP COLUMN IF EXISTS tax_amount_paise,
  DROP COLUMN IF EXISTS total_amount_paise,
  DROP COLUMN IF EXISTS cgst_amount_paise,
  DROP COLUMN IF EXISTS sgst_amount_paise,
  DROP COLUMN IF EXISTS igst_amount_paise,
  DROP COLUMN IF EXISTS state_code,
  DROP COLUMN IF EXISTS buyer_gstin;

-- 4. Drop enhanced columns on subscription_plans
ALTER TABLE subscription_plans
  DROP COLUMN IF EXISTS base_price_paise,
  DROP COLUMN IF EXISTS max_staff_per_outlet,
  DROP COLUMN IF EXISTS sac_code;

COMMIT;

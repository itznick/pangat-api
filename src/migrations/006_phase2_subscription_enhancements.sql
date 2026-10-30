-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: Phase 2 Feature 4 — SaaS Subscription Enhancements & Monetary Precision
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add integer paise pricing, staff limits, and tax metadata to subscription_plans
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS base_price_paise BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_staff_per_outlet INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS sac_code VARCHAR(20) DEFAULT NULL;

-- 2. Add integer paise breakdown, place-of-supply state, and GSTIN to subscription_invoices
ALTER TABLE subscription_invoices
  ADD COLUMN IF NOT EXISTS base_amount_paise BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount_paise BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount_paise BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst_amount_paise BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount_paise BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount_paise BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state_code VARCHAR(10) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS buyer_gstin VARCHAR(20) DEFAULT NULL;

-- 3. Webhook idempotency and duplicate charge prevention unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_invoices_rzp_payment_id 
  ON subscription_invoices(razorpay_payment_id) 
  WHERE razorpay_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_audit_idempotency_key 
  ON subscription_audit_logs(idempotency_key) 
  WHERE idempotency_key IS NOT NULL;

-- 4. Non-destructive backfill for existing rows: convert Rupee values to Integer Paise
UPDATE subscription_plans
SET base_price_paise = ROUND(base_price * 100)
WHERE base_price_paise = 0 AND base_price IS NOT NULL;

UPDATE subscription_invoices
SET base_amount_paise = ROUND(base_amount * 100),
    tax_amount_paise = ROUND(tax_amount * 100),
    total_amount_paise = ROUND(total_amount * 100)
WHERE total_amount_paise = 0 AND total_amount IS NOT NULL;

-- 5. Seed Canonical Tier Plans (Monthly & Annual with 20% savings)
-- ON CONFLICT (code) DO NOTHING guarantees idempotency and preserves admin customizations.
INSERT INTO subscription_plans (
  id,
  code,
  name,
  description,
  billing_interval,
  base_price,
  base_price_paise,
  currency,
  tax_percentage,
  max_outlets,
  max_tables_per_outlet,
  max_staff_per_outlet,
  features,
  sac_code,
  is_active
) VALUES
  -- STARTER (Monthly): ₹1,499 / mo
  (
    '11111111-1111-1111-1111-111111111101',
    'STARTER',
    'Starter Plan',
    'Ideal for single-outlet cafes, cloud kitchens, and quick-service diners.',
    'MONTHLY',
    1499.00,
    149900,
    'INR',
    18.00,
    1,
    15,
    5,
    'QR_ORDERING,KDS',
    NULL,
    true
  ),
  -- STARTER_ANNUAL (Yearly): ₹14,390 / yr (~20% annual discount)
  (
    '11111111-1111-1111-1111-111111111104',
    'STARTER_ANNUAL',
    'Starter Plan (Annual)',
    'Single-outlet cafe plan billed annually with 20% savings.',
    'YEARLY',
    14390.00,
    1439000,
    'INR',
    18.00,
    1,
    15,
    5,
    'QR_ORDERING,KDS',
    NULL,
    true
  ),
  -- GROWTH (Monthly): ₹2,999 / mo
  (
    '11111111-1111-1111-1111-111111111102',
    'GROWTH',
    'Growth Plan',
    'For growing full-service restaurants with multiple tables and kitchen inventory.',
    'MONTHLY',
    2999.00,
    299900,
    'INR',
    18.00,
    3,
    40,
    15,
    'QR_ORDERING,KDS,INVENTORY,ANALYTICS',
    NULL,
    true
  ),
  -- GROWTH_ANNUAL (Yearly): ₹28,790 / yr (~20% annual discount)
  (
    '11111111-1111-1111-1111-111111111105',
    'GROWTH_ANNUAL',
    'Growth Plan (Annual)',
    'Growing multi-table restaurant plan billed annually with 20% savings.',
    'YEARLY',
    28790.00,
    2879000,
    'INR',
    18.00,
    3,
    40,
    15,
    'QR_ORDERING,KDS,INVENTORY,ANALYTICS',
    NULL,
    true
  ),
  -- ENTERPRISE (Monthly): ₹5,999 / mo
  (
    '11111111-1111-1111-1111-111111111103',
    'ENTERPRISE',
    'Enterprise Plan',
    'For restaurant chains, franchise groups, and high-volume dining networks.',
    'MONTHLY',
    5999.00,
    599900,
    'INR',
    18.00,
    -1,
    -1,
    -1,
    'QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS',
    NULL,
    true
  ),
  -- ENTERPRISE_ANNUAL (Yearly): ₹57,590 / yr (~20% annual discount)
  (
    '11111111-1111-1111-1111-111111111106',
    'ENTERPRISE_ANNUAL',
    'Enterprise Plan (Annual)',
    'Enterprise restaurant chain plan billed annually with 20% savings.',
    'YEARLY',
    57590.00,
    5759000,
    'INR',
    18.00,
    -1,
    -1,
    -1,
    'QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS',
    NULL,
    true
  )
ON CONFLICT (code) DO NOTHING;

-- 6. Ensure existing default plans have their staff limits updated if at default 5
UPDATE subscription_plans
SET max_staff_per_outlet = CASE 
      WHEN code = 'STARTER' THEN 5
      WHEN code = 'GROWTH' THEN 15
      WHEN code = 'ENTERPRISE' THEN -1
      ELSE max_staff_per_outlet
    END
WHERE code IN ('STARTER', 'GROWTH', 'ENTERPRISE') AND max_staff_per_outlet = 5;

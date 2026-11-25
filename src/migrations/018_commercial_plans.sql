-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 018: the approved commercial plan catalogue.
--
--   Pangat Mini       ₹699 / ₹6,990   1 outlet,  10 tables, 3 staff        QR ordering, kitchen display
--   Pangat Starter    ₹1,299 / ₹12,990 1 outlet, 25 tables, 8 staff        + reports
--   Pangat Growth     ₹2,499 / ₹24,990 3 outlets, 60 tables, 20 staff       + inventory, multi-outlet
--   Pangat Enterprise ₹4,999 / ₹49,990 5 outlets, 100 tables, 40 staff      same features as Growth, larger capacity
--   (prices exclude GST; annual = exactly 10 x monthly)
--   plus the non-public PANGAT_TRIAL plan (14 days, 1 outlet, 20 tables, 8 staff) and the non-public Founding 10 rows (20% off list).
--
-- SAFE FOR EXISTING SUBSCRIBERS. Additive and idempotent:
--   1. New rows are INSERTed only when their code is missing (ON CONFLICT DO NOTHING). No existing plan row is edited:
--      price, interval, limits, features and tax of every historical plan stay exactly as they are.
--   2. The historical public plans (STARTER, GROWTH, ENTERPRISE and their annual variants) are only HIDDEN from the public list
--      (is_public = false). They stay active, so every existing subscription keeps resolving to its plan. Nothing is deleted and no
--      organisation is moved. The previous visibility is recorded in plan_visibility_backfills so the .down.sql restores it exactly,
--      and the hide runs once: after an operator deliberately re-publishes a historical plan, re-running this file leaves it alone.
--   3. Nothing here assigns any plan to any organisation, so the Founding 10 offer is never applied automatically.
--
-- The values below are generated from src/subscriptions/default-plans.ts and a test fails if the two ever differ.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO subscription_plans
  (id, code, name, description, billing_interval, base_price, base_price_paise, currency, tax_percentage,
   max_outlets, max_tables_per_outlet, max_staff_per_outlet, features, sac_code, trial_days, is_public, razorpay_plan_id, is_active)
VALUES
  ('22222222-2222-2222-2222-222222222211', 'PANGAT_MINI_M', 'Pangat Mini', 'For food stalls, small cafés, kiosks and takeaway counters: QR menu and ordering, kitchen display, order history and today''s sales summary.', 'MONTHLY', 699.00, 69900, 'INR', 18.00, 1, 10, 3, 'QR_ORDERING,KDS', NULL, 14, true, NULL, true),
  ('22222222-2222-2222-2222-222222222212', 'PANGAT_MINI_A', 'Pangat Mini (Annual)', 'For food stalls, small cafés, kiosks and takeaway counters: QR menu and ordering, kitchen display, order history and today''s sales summary.', 'YEARLY', 6990.00, 699000, 'INR', 18.00, 1, 10, 3, 'QR_ORDERING,KDS', NULL, 14, true, NULL, true),
  ('22222222-2222-2222-2222-222222222213', 'PANGAT_STARTER_M', 'Pangat Starter', 'For cafés, bakeries, small restaurants and quick-service outlets: everything in Mini with more tables and staff, plus order and sales reports.', 'MONTHLY', 1299.00, 129900, 'INR', 18.00, 1, 25, 8, 'QR_ORDERING,KDS,ANALYTICS', NULL, 14, true, NULL, true),
  ('22222222-2222-2222-2222-222222222214', 'PANGAT_STARTER_A', 'Pangat Starter (Annual)', 'For cafés, bakeries, small restaurants and quick-service outlets: everything in Mini with more tables and staff, plus order and sales reports.', 'YEARLY', 12990.00, 1299000, 'INR', 18.00, 1, 25, 8, 'QR_ORDERING,KDS,ANALYTICS', NULL, 14, true, NULL, true),
  ('22222222-2222-2222-2222-222222222215', 'PANGAT_GROWTH_M', 'Pangat Growth', 'For established restaurants and small groups: everything in Starter plus inventory, recipes and stock tracking, and up to 3 outlets.', 'MONTHLY', 2499.00, 249900, 'INR', 18.00, 3, 60, 20, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, true, NULL, true),
  ('22222222-2222-2222-2222-222222222216', 'PANGAT_GROWTH_A', 'Pangat Growth (Annual)', 'For established restaurants and small groups: everything in Starter plus inventory, recipes and stock tracking, and up to 3 outlets.', 'YEARLY', 24990.00, 2499000, 'INR', 18.00, 3, 60, 20, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, true, NULL, true),
  ('22222222-2222-2222-2222-222222222217', 'PANGAT_ENTERPRISE_M', 'Pangat Enterprise', 'For chains, franchises and larger operations: everything in Growth for up to 5 outlets, with onboarding arranged with our team. Additional outlets by agreement.', 'MONTHLY', 4999.00, 499900, 'INR', 18.00, 5, 100, 40, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, true, NULL, true),
  ('22222222-2222-2222-2222-222222222218', 'PANGAT_ENTERPRISE_A', 'Pangat Enterprise (Annual)', 'For chains, franchises and larger operations: everything in Growth for up to 5 outlets, with onboarding arranged with our team. Additional outlets by agreement.', 'YEARLY', 49990.00, 4999000, 'INR', 18.00, 5, 100, 40, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, true, NULL, true),
  ('44444444-4444-4444-4444-444444444401', 'PANGAT_TRIAL', 'Pangat Trial', '14-day free trial. One outlet, up to 20 tables and 8 staff accounts. Not a purchasable plan.', 'MONTHLY', 0.00, 0, 'INR', 18.00, 1, 20, 8, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333311', 'FOUNDING_MINI_M', 'Founding 10 · Pangat Mini', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For food stalls, small cafés, kiosks and takeaway counters: QR menu and ordering, kitchen display, order history and today''s sales summary.', 'MONTHLY', 559.20, 55920, 'INR', 18.00, 1, 10, 3, 'QR_ORDERING,KDS', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333312', 'FOUNDING_MINI_A', 'Founding 10 · Pangat Mini (Annual)', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For food stalls, small cafés, kiosks and takeaway counters: QR menu and ordering, kitchen display, order history and today''s sales summary.', 'YEARLY', 5592.00, 559200, 'INR', 18.00, 1, 10, 3, 'QR_ORDERING,KDS', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333313', 'FOUNDING_STARTER_M', 'Founding 10 · Pangat Starter', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For cafés, bakeries, small restaurants and quick-service outlets: everything in Mini with more tables and staff, plus order and sales reports.', 'MONTHLY', 1039.20, 103920, 'INR', 18.00, 1, 25, 8, 'QR_ORDERING,KDS,ANALYTICS', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333314', 'FOUNDING_STARTER_A', 'Founding 10 · Pangat Starter (Annual)', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For cafés, bakeries, small restaurants and quick-service outlets: everything in Mini with more tables and staff, plus order and sales reports.', 'YEARLY', 10392.00, 1039200, 'INR', 18.00, 1, 25, 8, 'QR_ORDERING,KDS,ANALYTICS', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333315', 'FOUNDING_GROWTH_M', 'Founding 10 · Pangat Growth', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For established restaurants and small groups: everything in Starter plus inventory, recipes and stock tracking, and up to 3 outlets.', 'MONTHLY', 1999.20, 199920, 'INR', 18.00, 3, 60, 20, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333316', 'FOUNDING_GROWTH_A', 'Founding 10 · Pangat Growth (Annual)', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For established restaurants and small groups: everything in Starter plus inventory, recipes and stock tracking, and up to 3 outlets.', 'YEARLY', 19992.00, 1999200, 'INR', 18.00, 3, 60, 20, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333317', 'FOUNDING_ENTERPRISE_M', 'Founding 10 · Pangat Enterprise', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For chains, franchises and larger operations: everything in Growth for up to 5 outlets, with onboarding arranged with our team. Additional outlets by agreement.', 'MONTHLY', 3999.20, 399920, 'INR', 18.00, 5, 100, 40, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, false, NULL, true),
  ('33333333-3333-3333-3333-333333333318', 'FOUNDING_ENTERPRISE_A', 'Founding 10 · Pangat Enterprise (Annual)', 'Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. For chains, franchises and larger operations: everything in Growth for up to 5 outlets, with onboarding arranged with our team. Additional outlets by agreement.', 'YEARLY', 39992.00, 3999200, 'INR', 18.00, 5, 100, 40, 'QR_ORDERING,KDS,ANALYTICS,INVENTORY,MULTI_OUTLET', NULL, 14, false, NULL, true)
ON CONFLICT (code) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('public.plan_visibility_backfills') IS NOT NULL THEN
    RAISE NOTICE 'Migration 018 already hid the historical plans: leaving their visibility alone';
    RETURN;
  END IF;

  CREATE TABLE plan_visibility_backfills (
    plan_id           uuid        PRIMARY KEY,
    previous_is_public boolean    NOT NULL,
    migration         varchar(20) NOT NULL,
    applied_at        timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO plan_visibility_backfills (plan_id, previous_is_public, migration)
    SELECT id, is_public, '018' FROM subscription_plans WHERE code IN ('STARTER', 'STARTER_ANNUAL', 'GROWTH', 'GROWTH_ANNUAL', 'ENTERPRISE', 'ENTERPRISE_ANNUAL')
    ON CONFLICT DO NOTHING;

  UPDATE subscription_plans SET is_public = false, updated_at = now()
    WHERE code IN ('STARTER', 'STARTER_ANNUAL', 'GROWTH', 'GROWTH_ANNUAL', 'ENTERPRISE', 'ENTERPRISE_ANNUAL') AND is_public = true;
END
$$;

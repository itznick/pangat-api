-- ─────────────────────────────────────────────────────────────────────────────
-- READ-ONLY pre-rollout checks for migrations 018 (commercial plans) and 019 (billing profile, invoice series).
-- Run on a STAGING COPY first, then on production, with a read-only role:  psql "$DATABASE_URL" -f commercial_plans_precheck.sql
-- Nothing in this file changes data. Review every result BEFORE deploying the API (migrations auto-apply at boot).
-- ─────────────────────────────────────────────────────────────────────────────
\echo '== 1. Which plan rows exist today, who is on them, and in what state'
SELECT p.code, p.name, p.billing_interval, p.base_price, p.max_outlets, p.max_tables_per_outlet, p.max_staff_per_outlet,
       p.is_public, p.is_active, COALESCE(s.status::text, '-') AS status, COUNT(s.id) AS subscriptions
FROM subscription_plans p
LEFT JOIN (SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC) s ON s.plan_id = p.id
GROUP BY p.code, p.name, p.billing_interval, p.base_price, p.max_outlets, p.max_tables_per_outlet, p.max_staff_per_outlet, p.is_public, p.is_active, s.status
ORDER BY p.base_price, p.code, s.status;

\echo '== 2. Are there ANY paid subscriptions or invoices? (decides how careful the rollout must be)'
SELECT (SELECT COUNT(*) FROM organization_subscriptions WHERE source = 'GATEWAY') AS gateway_subscriptions,
       (SELECT COUNT(*) FROM organization_subscriptions WHERE source = 'MANUAL')  AS manual_grants,
       (SELECT COUNT(*) FROM organization_subscriptions WHERE razorpay_subscription_id IS NOT NULL) AS with_razorpay_id,
       (SELECT COUNT(*) FROM subscription_invoices) AS invoices,
       (SELECT COUNT(*) FROM subscription_invoices WHERE status = 'PAID') AS paid_invoices;

\echo '== 3. Active trials and when they end'
SELECT o.name, p.code AS plan, s.status, s.trial_ends_at, s.current_period_end
FROM (SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC) s
JOIN organizations o ON o.id = s.organization_id JOIN subscription_plans p ON p.id = s.plan_id
WHERE s.status = 'TRIAL' ORDER BY s.trial_ends_at;

\echo '== 4. Organisations above the limits of the NEW plans (informational: nobody is moved automatically)'
WITH usage AS (
  SELECT o.id, o.name,
         (SELECT COUNT(*) FROM restaurants r WHERE r.organization_id = o.id) AS outlets,
         COALESCE((SELECT MAX(c) FROM (SELECT COUNT(*) c FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE r.organization_id = o.id GROUP BY r.id) x), 0) AS tables_peak,
         COALESCE((SELECT MAX(c) FROM (SELECT COUNT(*) c FROM staff st JOIN restaurants r ON r.id = st.restaurant_id
                   WHERE r.organization_id = o.id AND st.is_active AND NOT st.is_platform_admin AND st.role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN')
                     AND LOWER(st.email) NOT LIKE '%@stations.pangat.app' GROUP BY r.id) x), 0) AS staff_peak
  FROM organizations o)
SELECT u.name, u.outlets, u.tables_peak, u.staff_peak,
       (u.outlets > 1 OR u.tables_peak > 10 OR u.staff_peak > 3)   AS over_mini,
       (u.outlets > 1 OR u.tables_peak > 25 OR u.staff_peak > 8)   AS over_starter,
       (u.outlets > 3 OR u.tables_peak > 60 OR u.staff_peak > 20)  AS over_growth,
       (u.outlets > 5 OR u.tables_peak > 100 OR u.staff_peak > 40) AS over_enterprise,
       (u.tables_peak > 20 OR u.staff_peak > 8 OR u.outlets > 1)   AS over_trial_caps
FROM usage u ORDER BY u.name;

\echo '== 5. Would migration 018 collide with anything? (expect 0 rows)'
SELECT code, name FROM subscription_plans WHERE code LIKE 'PANGAT\_%' ESCAPE '\' OR code LIKE 'FOUNDING\_%' ESCAPE '\';

\echo '== 6. Historical public plans that 018 will HIDE (is_public -> false). They stay active; subscribers are unaffected.'
SELECT code, is_public, is_active FROM subscription_plans WHERE code IN ('STARTER','STARTER_ANNUAL','GROWTH','GROWTH_ANNUAL','ENTERPRISE','ENTERPRISE_ANNUAL') ORDER BY code;

\echo '== 7. Has 018/019 been applied already? Which migrations are recorded?'
SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 6;
SELECT to_regclass('public.plan_visibility_backfills') AS visibility_backfill_table, to_regclass('public.subscription_invoice_sequences') AS invoice_sequence_table;

\echo '== 8. Existing subscription invoice numbers (kept as issued; new invoices use PGT/<fy>/<serial>)'
SELECT invoice_number, status, created_at FROM subscription_invoices ORDER BY created_at DESC LIMIT 10;

\echo '== 9. Platform settings that interact with the new catalogue (stored overrides win over the new defaults)'
SELECT key, CASE WHEN is_secret THEN '(secret)' ELSE value::text END AS value
FROM platform_settings WHERE key IN ('subscription.defaultTrialPlanCode','subscription.defaultTrialDays','subscription.gracePeriodDays','billing.invoicePrefix','billing.supplierStateCode','general.selfSignupEnabled');

\echo '== 10. Existing feature-entitlement audit (see entitlement_audit.sql for the full set)'
SELECT COUNT(*) AS plans_without_qr_or_kds FROM subscription_plans
WHERE NOT ('QR_ORDERING' = ANY (string_to_array(features::text, ','))) OR NOT ('KDS' = ANY (string_to_array(features::text, ',')));

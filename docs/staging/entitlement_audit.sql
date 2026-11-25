-- Existing-tenant entitlement audit. READ-ONLY: run it on the staging copy (and later on production) before and after deploying.
-- Every query should return ZERO rows unless noted; a non-empty result is a restaurant the new enforcement would restrict.

\echo '1. Plans in use that lack QR_ORDERING or KDS (their restaurants would lose guest ordering / the kitchen display)'
SELECT p.code, p.features, COUNT(*) AS organisations
FROM (SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC) s
JOIN subscription_plans p ON p.id = s.plan_id
WHERE s.status IN ('TRIAL','ACTIVE','GRACE_PERIOD','PAST_DUE')
  AND (NOT ('QR_ORDERING' = ANY (string_to_array(p.features, ','))) OR NOT ('KDS' = ANY (string_to_array(p.features, ',')))) AND p.features NOT LIKE '%*%'
GROUP BY 1,2;

\echo '2. Organisations with more than one outlet on a plan without MULTI_OUTLET (existing outlets keep working; adding more is refused)'
SELECT o.name, p.code, COUNT(r.id) AS outlets
FROM organizations o
JOIN (SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC) s ON s.organization_id = o.id
JOIN subscription_plans p ON p.id = s.plan_id
JOIN restaurants r ON r.organization_id = o.id
WHERE NOT ('MULTI_OUTLET' = ANY (string_to_array(p.features, ','))) AND p.features NOT LIKE '%*%'
GROUP BY 1,2 HAVING COUNT(r.id) > 1;

\echo '3. Outlets already over their plan table limit (nothing is deleted; they cannot add tables until within the limit)'
SELECT o.name AS organisation, r.slug, COUNT(t.id) AS tables, p.max_tables_per_outlet AS plan_limit
FROM restaurants r JOIN organizations o ON o.id = r.organization_id
JOIN (SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC) s ON s.organization_id = o.id
JOIN subscription_plans p ON p.id = s.plan_id
JOIN tables t ON t.restaurant_id = r.id
WHERE p.max_tables_per_outlet <> -1
GROUP BY 1,2,4 HAVING COUNT(t.id) > p.max_tables_per_outlet;

\echo '4. Outlets over their staff-seat limit (seat = active human account of the outlet; kitchen-station accounts and owners excluded)'
SELECT o.name AS organisation, r.slug, COUNT(st.id) AS seats, p.max_staff_per_outlet AS plan_limit
FROM restaurants r JOIN organizations o ON o.id = r.organization_id
JOIN (SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC) s ON s.organization_id = o.id
JOIN subscription_plans p ON p.id = s.plan_id
JOIN staff st ON st.restaurant_id = r.id AND st.is_active AND NOT st.is_platform_admin
 AND st.role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN') AND LOWER(st.email) NOT LIKE '%@stations.pangat.app'
WHERE p.max_staff_per_outlet <> -1
GROUP BY 1,2,4 HAVING COUNT(st.id) > p.max_staff_per_outlet;

\echo '5. Organisations with no subscription row (a trial is created on first use; listed so you know who they are)'
SELECT o.id, o.name FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM organization_subscriptions s WHERE s.organization_id = o.id);

\echo '6. Subscriptions whose stored status is behind the clock (the hourly sweep will persist them; access already follows the clock)'
SELECT o.name, s.status, s.current_period_end FROM (SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC) s
JOIN organizations o ON o.id = s.organization_id WHERE s.status IN ('TRIAL','ACTIVE') AND s.current_period_end < now();

\echo '7. Plans still carrying ADVANCED_REPORTS (hidden from customers; nothing is built behind it)'
SELECT code FROM subscription_plans WHERE 'ADVANCED_REPORTS' = ANY (string_to_array(features, ','));

\echo '8. Kitchen-station accounts that count as people by mistake (should be 0): station-domain accounts that are not CHEF'
SELECT email, role FROM staff WHERE LOWER(email) LIKE '%@stations.pangat.app' AND role <> 'CHEF';

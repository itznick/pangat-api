-- Reverses migration 018 without touching any subscriber.
--  * restores the visibility the historical plans had before 018 (recorded in plan_visibility_backfills);
--  * removes the new catalogue rows ONLY while nobody is subscribed to them. A row that has ever been assigned to an organisation
--    is kept (it is part of that customer's record), only hidden.
UPDATE subscription_plans p SET is_public = b.previous_is_public, updated_at = now()
  FROM plan_visibility_backfills b WHERE b.plan_id = p.id AND b.migration = '018';

DELETE FROM subscription_plans p
  WHERE (p.code LIKE 'PANGAT\_%' ESCAPE '\' OR p.code LIKE 'FOUNDING\_%' ESCAPE '\')
    AND NOT EXISTS (SELECT 1 FROM organization_subscriptions s WHERE s.plan_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM subscription_invoices i JOIN organization_subscriptions s ON s.id = i.subscription_id WHERE s.plan_id = p.id);

DROP TABLE IF EXISTS plan_visibility_backfills;

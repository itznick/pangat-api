-- Undo migration 017: remove exactly the feature keys it added, then drop its record.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT plan_id, feature FROM plan_feature_backfills WHERE migration = '017' LOOP
    UPDATE subscription_plans
       SET features = array_to_string(array_remove(string_to_array(COALESCE(features::text, ''), ','), r.feature), ',')
     WHERE id = r.plan_id;
  END LOOP;
END $$;
DELETE FROM plan_feature_backfills WHERE migration = '017';
DROP TABLE IF EXISTS plan_feature_backfills;

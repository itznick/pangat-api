-- Undo migration 017: remove exactly the feature keys it recorded adding, then drop its record. Safe to run when 017 was never applied.
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.plan_feature_backfills') IS NULL THEN
    RAISE NOTICE 'Migration 017 is not applied: nothing to undo';
    RETURN;
  END IF;
  FOR r IN EXECUTE 'SELECT plan_id, feature FROM plan_feature_backfills WHERE migration = ''017''' LOOP
    UPDATE subscription_plans
       SET features = array_to_string(array_remove(string_to_array(COALESCE(features::text, ''), ','), r.feature), ',')
     WHERE id = r.plan_id;
  END LOOP;
  DROP TABLE plan_feature_backfills;
END $$;

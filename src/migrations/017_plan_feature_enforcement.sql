-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 017: plan feature enforcement (Phase 1).
--
-- Until now only INVENTORY and ANALYTICS were checked against a plan; QR_ORDERING, KDS and MULTI_OUTLET were listed on plans but never
-- enforced, so EVERY restaurant effectively had them. They are enforced from this release, so any existing plan that lacks a key it
-- was effectively granting is given that key, to make sure no existing restaurant loses access because of the rollout:
--   * QR_ORDERING and KDS         -> added to every plan that does not list them (they were never enforced)
--   * MULTI_OUTLET                -> added to every plan whose outlet limit is not exactly 1 (those plans already sold several outlets)
-- Operators can remove a key from a plan afterwards on purpose (Super Admin > Subscriptions); this migration never does.
-- ADVANCED_REPORTS is NOT touched: nothing is built behind it (it is hidden from customers by the application).
--
-- Additive, idempotent and reversible: every change is recorded in plan_feature_backfills, which the .down.sql uses to undo exactly it.
-- ─────────────────────────────────────────────────────────────────────────────
-- A one-time backfill: if its record table already exists the migration has run before, and re-running must not grant anything again
-- (an operator may have removed a key on purpose since). The whole file is therefore a single guarded block.
DO $$
DECLARE f text;
BEGIN
  IF to_regclass('public.plan_feature_backfills') IS NOT NULL THEN
    RAISE NOTICE 'Migration 017 was already applied: nothing to do';
    RETURN;
  END IF;

  CREATE TABLE plan_feature_backfills (
    plan_id   uuid        NOT NULL,
    feature   varchar(50) NOT NULL,
    migration varchar(20) NOT NULL,
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plan_id, feature, migration)
  );

  -- Each statement updates ONLY the plans whose record row it inserts in this very run. Running the file again (or after an
  -- operator deliberately removed a key) inserts nothing, so nothing is granted a second time.
  FOREACH f IN ARRAY ARRAY['QR_ORDERING', 'KDS'] LOOP
    WITH added AS (
      INSERT INTO plan_feature_backfills (plan_id, feature, migration)
        SELECT id, f, '017' FROM subscription_plans
        WHERE NOT (f = ANY (string_to_array(COALESCE(features::text, ''), ','))) AND COALESCE(features::text, '') NOT LIKE '%*%'
        ON CONFLICT DO NOTHING
        RETURNING plan_id
    )
    UPDATE subscription_plans p
       SET features = CASE WHEN COALESCE(p.features::text, '') = '' THEN f ELSE p.features::text || ',' || f END
      FROM added a WHERE p.id = a.plan_id;
  END LOOP;

  WITH added AS (
    INSERT INTO plan_feature_backfills (plan_id, feature, migration)
      SELECT id, 'MULTI_OUTLET', '017' FROM subscription_plans
      WHERE max_outlets <> 1 AND NOT ('MULTI_OUTLET' = ANY (string_to_array(COALESCE(features::text, ''), ','))) AND COALESCE(features::text, '') NOT LIKE '%*%'
      ON CONFLICT DO NOTHING
      RETURNING plan_id
  )
  UPDATE subscription_plans p
     SET features = CASE WHEN COALESCE(p.features::text, '') = '' THEN 'MULTI_OUTLET' ELSE p.features::text || ',MULTI_OUTLET' END
    FROM added a WHERE p.id = a.plan_id;
END $$;

-- Reverses 021. Refuses to drop delivery history that exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform_event_deliveries LIMIT 1) THEN
    RAISE NOTICE 'platform_event_deliveries has rows: kept';
  ELSE
    DROP TABLE IF EXISTS platform_event_deliveries;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM restaurants WHERE onboarding <> '{}'::jsonb) THEN
    RAISE NOTICE 'restaurants.onboarding holds confirmations: kept';
  ELSE
    ALTER TABLE restaurants DROP COLUMN IF EXISTS onboarding;
  END IF;
END $$;

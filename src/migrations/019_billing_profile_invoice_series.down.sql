-- Never drops columns that may hold customer data. The counter table is removed only while it is empty (no invoice has used it).
DO $$
BEGIN
  IF to_regclass('public.subscription_invoice_sequences') IS NOT NULL
     AND (SELECT COUNT(*) FROM subscription_invoice_sequences) = 0 THEN
    DROP TABLE subscription_invoice_sequences;
  END IF;
END
$$;

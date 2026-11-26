-- Removes constraints and the (empty-by-design) refund table only when nothing was recorded in it. Never drops columns that may hold data.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_refund_within_total;
DROP INDEX IF EXISTS uq_tax_documents_bill_per_order;
DO $$
BEGIN
  IF to_regclass('public.order_refunds') IS NOT NULL AND (SELECT COUNT(*) FROM order_refunds) = 0 THEN
    DROP TABLE order_refunds;
  END IF;
END
$$;

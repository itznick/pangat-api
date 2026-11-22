-- Down: consent columns and request history are legal evidence, so they are kept. Only the helper indexes are removed.
DROP INDEX IF EXISTS idx_orders_phone_digits;
DROP INDEX IF EXISTS idx_orders_pii_created;

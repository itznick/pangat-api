ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS chk_restaurants_service_charge_range;
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS chk_restaurants_gst_range;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_amounts_nonneg;
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS chk_menu_items_price_nonneg;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS chk_order_items_qty_positive;
DROP INDEX IF EXISTS uq_tables_restaurant_number;
DROP INDEX IF EXISTS uq_staff_email_lower;
DROP INDEX IF EXISTS idx_audit_logs_restaurant_created;
DROP INDEX IF EXISTS idx_restaurants_organization;
DROP INDEX IF EXISTS idx_staff_restaurant;
DROP INDEX IF EXISTS idx_staff_organization;
DROP INDEX IF EXISTS idx_tables_restaurant;
DROP INDEX IF EXISTS idx_modifiers_menu_item;
DROP INDEX IF EXISTS idx_menu_categories_restaurant;
DROP INDEX IF EXISTS idx_menu_items_category;
DROP INDEX IF EXISTS idx_menu_items_restaurant;
DROP INDEX IF EXISTS idx_order_items_order;
DROP INDEX IF EXISTS idx_orders_restaurant_payment;
DROP INDEX IF EXISTS idx_orders_restaurant_status;
DROP INDEX IF EXISTS idx_orders_restaurant_created;
-- Columns are intentionally kept on rollback (dropping them would destroy data):
--   staff.is_active/pin_hash/password_changed_at/failed_login_count/locked_until/last_login_at,
--   restaurants.service_charge_percentage, orders.service_charge_amount, menu_items.deleted_at/auto_disabled
-- menu_items.category_id stays nullable on rollback (re-adding NOT NULL could fail on existing rows)

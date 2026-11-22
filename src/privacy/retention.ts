import { DataSource } from 'typeorm';
import { getSetting } from '../platform/settings.service.js';

/**
 * Scheduled sweep: contact details on old FINISHED orders, and old demo requests.
 * Amounts, items, tax and payment fields stay: they are the business's financial record. Personal details are not needed for that.
 */
export async function runPrivacyRetention(ds: DataSource): Promise<{ ordersAnonymised: number; leadsDeleted: number }> {
  const months = getSetting<number>('compliance.dinerDataRetentionMonths') ?? 12;
  const leadMonths = getSetting<number>('compliance.leadRetentionMonths') || 18;
  const ordersAnonymised =
    months > 0
      ? ((await ds.query(
          `UPDATE orders SET customer_name = NULL, customer_phone = NULL, delivery_address = NULL, delivery_instructions = NULL,
             feedback = CASE WHEN feedback IS NULL THEN NULL ELSE feedback - 'comment' END
           WHERE created_at < now() - ($1 || ' months')::interval AND order_status IN ('COMPLETED','CANCELLED')
             AND (customer_phone IS NOT NULL OR customer_name IS NOT NULL OR delivery_address IS NOT NULL)`,
          [String(months)],
        ))[1] as number)
      : 0;
  const leadsDeleted = (await ds.query(`DELETE FROM leads WHERE created_at < now() - ($1 || ' months')::interval`, [String(leadMonths)]))[1] as number;
  return { ordersAnonymised, leadsDeleted };
}

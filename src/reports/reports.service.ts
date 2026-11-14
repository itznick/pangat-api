import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';

export interface ReportRange {
  from?: string;
  to?: string;
}

const TZ = 'Asia/Kolkata';
const MAX_DAYS = 400;

/** Parse YYYY-MM-DD (the outlet's local calendar day). */
function parseDay(v: string | undefined, label: string): string | null {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new BadRequestException(`${label} must be a date in YYYY-MM-DD format`);
  }
  return v;
}

@Injectable()
export class ReportsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Sales & operations summary for one outlet over [from, to] inclusive (local days, IST).
   * Money rules: "sales" = orders that are PAID/partially refunded, net of refunds; cancelled orders are excluded
   * from every figure; pending orders appear only as "outstanding".
   */
  async summary(restaurantId: string, range: ReportRange) {
    const outlet = await this.dataSource.getRepository(Restaurant).findOne({ where: { id: restaurantId } });
    if (!outlet) throw new NotFoundException('Restaurant not found');

    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const to = parseDay(range.to, 'to') ?? today;
    const from = parseDay(range.from, 'from') ?? new Date(Date.parse(to) - 6 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw new BadRequestException('from must not be after to');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) {
      throw new BadRequestException(`Choose a range of at most ${MAX_DAYS} days`);
    }

    const base = `o.restaurant_id = $1
      AND (o.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date
      AND o.order_status <> 'CANCELLED'`;
    const p = [restaurantId, from, to];
    const q = <T = any>(sql: string) => this.dataSource.query(sql, p) as Promise<T[]>;

    const [totals] = await q(`
      SELECT
        COUNT(*)::int AS orders,
        COUNT(*) FILTER (WHERE o.payment_status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED'))::int AS paid_orders,
        COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')),0)::float AS gross_sales,
        COALESCE(SUM(o.refund_amount),0)::float AS refunds,
        COALESCE(SUM(o.subtotal) FILTER (WHERE o.payment_status IN ('PAID','PARTIALLY_REFUNDED')),0)::float AS subtotal,
        COALESCE(SUM(o.gst_amount) FILTER (WHERE o.payment_status IN ('PAID','PARTIALLY_REFUNDED')),0)::float AS gst_collected,
        COALESCE(SUM(o.service_charge_amount) FILTER (WHERE o.payment_status IN ('PAID','PARTIALLY_REFUNDED')),0)::float AS service_charge,
        COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PENDING'),0)::float AS outstanding,
        COUNT(*) FILTER (WHERE o.payment_status = 'PENDING')::int AS pending_orders,
        COALESCE(AVG(EXTRACT(EPOCH FROM (o.ready_at - o.created_at))/60) FILTER (WHERE o.ready_at IS NOT NULL),0)::float AS avg_ready_minutes
      FROM orders o WHERE ${base}`);

    const daily = await q(`
      SELECT to_char((o.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS orders,
             COALESCE(SUM(o.total_amount - o.refund_amount) FILTER (WHERE o.payment_status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')),0)::float AS sales
      FROM orders o WHERE ${base} GROUP BY 1 ORDER BY 1`);

    const byPayment = await q(`
      SELECT COALESCE(o.payment_method::text,'UNKNOWN') AS method, COUNT(*)::int AS orders,
             COALESCE(SUM(o.total_amount - o.refund_amount),0)::float AS sales
      FROM orders o WHERE ${base} AND o.payment_status IN ('PAID','PARTIALLY_REFUNDED') GROUP BY 1 ORDER BY 3 DESC`);

    const byType = await q(`
      SELECT o.order_type::text AS type, COUNT(*)::int AS orders,
             COALESCE(SUM(o.total_amount - o.refund_amount) FILTER (WHERE o.payment_status IN ('PAID','PARTIALLY_REFUNDED')),0)::float AS sales
      FROM orders o WHERE ${base} GROUP BY 1 ORDER BY 2 DESC`);

    const hourly = await q(`
      SELECT EXTRACT(HOUR FROM (o.created_at AT TIME ZONE '${TZ}'))::int AS hour, COUNT(*)::int AS orders
      FROM orders o WHERE ${base} GROUP BY 1 ORDER BY 1`);

    const topItems = await q(`
      SELECT oi.name, SUM(oi.quantity)::int AS quantity,
             SUM((oi.price + COALESCE((SELECT SUM((m->>'price')::numeric) FROM jsonb_array_elements(oi.selected_modifiers) m),0)) * oi.quantity)::float AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${base} GROUP BY oi.name ORDER BY quantity DESC, revenue DESC LIMIT 10`);

    // Cancelled orders are outside every sales figure; what was handed back for them is reported separately
    const [cancelled] = await q(`
      SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.refund_amount),0)::float AS refunded
      FROM orders o
      WHERE o.restaurant_id = $1 AND (o.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date
        AND o.order_status = 'CANCELLED'`);

    const net = totals.gross_sales - totals.refunds;
    return {
      restaurantSlug: outlet.slug,
      range: { from, to, timezone: TZ },
      totals: {
        orders: totals.orders,
        paidOrders: totals.paid_orders,
        pendingOrders: totals.pending_orders,
        grossSales: round2(totals.gross_sales),
        refunds: round2(totals.refunds),
        netSales: round2(net),
        subtotal: round2(totals.subtotal),
        gstCollected: round2(totals.gst_collected),
        serviceCharge: round2(totals.service_charge),
        outstanding: round2(totals.outstanding),
        averageOrderValue: totals.paid_orders ? round2(totals.gross_sales / totals.paid_orders) : 0,
        avgReadyMinutes: round1(totals.avg_ready_minutes),
      },
      cancelled: { orders: cancelled.orders, refunded: round2(cancelled.refunded) },
      daily: fillDays(from, to, daily),
      byPaymentMethod: byPayment,
      byOrderType: byType,
      hourly,
      topItems,
    };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

function fillDays(from: string, to: string, rows: Array<{ day: string; orders: number; sales: number }>) {
  const map = new Map(rows.map((r) => [r.day, r]));
  const out: Array<{ day: string; orders: number; sales: number }> = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(map.get(day) ?? { day, orders: 0, sales: 0 });
  }
  return out;
}

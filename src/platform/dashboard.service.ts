import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LATEST_SUB_SQL, effectiveStatusSql } from './subscriptions-admin.service.js';
import { MERCHANT_STAFF_SQL } from './restaurants-admin.service.js';
import { PlatformEventsService } from './events.service.js';
import { MetricsService } from './monitoring.service.js';

const PAID = `od.payment_status IN ('PAID','PARTIALLY_REFUNDED') AND od.order_status <> 'CANCELLED'`;
const DAY = 86_400_000;

const delta = (cur: number, prev: number | null) => (prev === null || prev === undefined ? null : prev === 0 ? (cur === 0 ? 0 : null) : Math.round(((cur - prev) / prev) * 1000) / 10);
const metric = (value: number, previous: number | null) => ({ value, previous, deltaPct: delta(value, previous) });

@Injectable()
export class DashboardService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: PlatformEventsService,
    private readonly metrics: MetricsService,
  ) {}

  async overview(q: { from?: string; to?: string; compare?: string }) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
    const spanMs = Math.max(DAY, to.getTime() - from.getTime());
    const compare = q.compare === 'year' || q.compare === 'none' ? q.compare : 'previous';
    let pFrom: Date | null = null;
    let pTo: Date | null = null;
    if (compare === 'previous') { pTo = from; pFrom = new Date(from.getTime() - spanMs); }
    if (compare === 'year') { pFrom = new Date(from); pFrom.setFullYear(pFrom.getFullYear() - 1); pTo = new Date(to); pTo.setFullYear(pTo.getFullYear() - 1); }

    const [cur, prev] = await Promise.all([this.window(from, to), pFrom && pTo ? this.window(pFrom, pTo) : Promise.resolve(null)]);
    const eff = effectiveStatusSql('s');
    const spanDays = spanMs / DAY;
    const trunc = spanDays <= 45 ? 'day' : spanDays <= 200 ? 'week' : 'month';

    const [snapshot, subs, plansDist, leads, top, series, prevSeries, health, errors24, hooks24, jobs, activity] = await Promise.all([
      this.ds.query(
        `SELECT (SELECT COUNT(*)::int FROM organizations) AS restaurants,
                (SELECT COUNT(*)::int FROM organizations WHERE status = 'ACTIVE') AS active,
                (SELECT COUNT(*)::int FROM organizations WHERE status = 'SUSPENDED') AS suspended,
                (SELECT COUNT(*)::int FROM organizations WHERE status = 'DEACTIVATED') AS deactivated,
                (SELECT COUNT(*)::int FROM organizations o WHERE o.status = 'ACTIVE' AND o.created_at < now() - interval '14 days'
                   AND NOT EXISTS (SELECT 1 FROM orders od JOIN restaurants r ON r.id = od.restaurant_id WHERE r.organization_id = o.id AND od.created_at > now() - interval '30 days')) AS dormant,
                (SELECT COUNT(*)::int FROM organizations WHERE verification_status = 'VERIFIED') AS verified,
                (SELECT COUNT(*)::int FROM restaurants) AS outlets, (SELECT COUNT(*)::int FROM restaurants WHERE is_active) AS active_outlets,
                (SELECT COUNT(*)::int FROM ${MERCHANT_STAFF_SQL} ms) AS users, (SELECT COUNT(*)::int FROM ${MERCHANT_STAFF_SQL} ms WHERE ms.is_active) AS active_users,
                (SELECT COUNT(*)::int FROM staff WHERE is_platform_admin = true OR role = 'PLATFORM_SUPER_ADMIN') AS admins,
                (SELECT COUNT(*)::int FROM orders) AS orders_total,
                (SELECT COUNT(*)::int FROM orders od WHERE od.order_status NOT IN ('COMPLETED','CANCELLED')) AS orders_open,
                (SELECT COUNT(*)::int FROM support_tickets WHERE status NOT IN ('RESOLVED','CLOSED')) AS open_tickets`,
      ),
      this.ds.query(`SELECT ${eff} AS status, COUNT(*)::int AS n FROM (${LATEST_SUB_SQL}) s GROUP BY 1`),
      this.ds.query(
        `SELECT pl.name AS plan, COUNT(*)::int AS n FROM (${LATEST_SUB_SQL}) s JOIN subscription_plans pl ON pl.id = s.plan_id WHERE ${eff} IN ('ACTIVE','TRIAL','GRACE_PERIOD') GROUP BY 1 ORDER BY 2 DESC`,
      ),
      this.ds.query('SELECT status, COUNT(*)::int AS n FROM leads GROUP BY 1'),
      this.ds.query(
        `SELECT o.id, o.name, COUNT(od.id)::int AS orders, COALESCE(SUM(od.total_amount - od.refund_amount) FILTER (WHERE ${PAID}),0)::float AS gmv
         FROM organizations o JOIN restaurants r ON r.organization_id = o.id JOIN orders od ON od.restaurant_id = r.id AND od.created_at >= $1 AND od.created_at < $2
         GROUP BY o.id, o.name ORDER BY gmv DESC, orders DESC LIMIT 5`,
        [from.toISOString(), to.toISOString()],
      ),
      this.series(from, to, trunc),
      pFrom && pTo ? this.series(pFrom, pTo, trunc) : Promise.resolve(null),
      this.ds
        .query('SELECT 1')
        .then(async () => {
          const t = Date.now();
          await this.ds.query('SELECT 1');
          return { ok: true, latencyMs: Date.now() - t };
        })
        .catch(() => ({ ok: false, latencyMs: null })),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM error_logs WHERE created_at > now() - interval '24 hours'`),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM webhook_events WHERE status IN ('REJECTED','FAILED') AND received_at > now() - interval '24 hours'`),
      this.ds.query(`SELECT job_name, status, started_at FROM (SELECT DISTINCT ON (job_name) * FROM job_runs ORDER BY job_name, started_at DESC) j`),
      this.activityFeed(),
    ]);

    const subCounts: Record<string, number> = {};
    for (const r of subs) subCounts[r.status] = r.n;

    // Conversion: restaurants whose trial began in the window that now hold a paid plan.
    const [conv] = await this.ds.query(
      `WITH trials AS (SELECT DISTINCT organization_id FROM organization_subscriptions WHERE source = 'TRIAL' AND created_at >= $1 AND created_at < $2)
       SELECT (SELECT COUNT(*)::int FROM trials) AS trials,
              (SELECT COUNT(*)::int FROM trials t WHERE EXISTS (SELECT 1 FROM subscription_invoices i WHERE i.organization_id = t.organization_id AND i.status = 'PAID')
                 OR EXISTS (SELECT 1 FROM organization_subscriptions s2 WHERE s2.organization_id = t.organization_id AND s2.status = 'ACTIVE' AND s2.source <> 'TRIAL')) AS converted`,
      [from.toISOString(), to.toISOString()],
    );
    // Churn: restaurants whose paid period ended and was not renewed within the window, against those that were paying.
    const [churn] = await this.ds.query(
      `SELECT (SELECT COUNT(*)::int FROM (${LATEST_SUB_SQL}) s WHERE ${eff} IN ('EXPIRED','CANCELLED','HALTED') AND s.source <> 'TRIAL' AND s.current_period_end >= $1 AND s.current_period_end < $2) AS lost,
              (SELECT COUNT(*)::int FROM (${LATEST_SUB_SQL}) s WHERE ${eff} IN ('ACTIVE','GRACE_PERIOD','PAST_DUE') AND s.source <> 'TRIAL') AS retained`,
      [from.toISOString(), to.toISOString()],
    );
    const conversionRate = conv.trials ? Math.round((conv.converted / conv.trials) * 1000) / 10 : null;
    const churnRate = churn.lost + churn.retained ? Math.round((churn.lost / (churn.lost + churn.retained)) * 1000) / 10 : null;

    const snap = snapshot[0];
    const req = this.metrics.snapshot();
    return {
      range: { from: from.toISOString(), to: to.toISOString(), compare, previousFrom: pFrom?.toISOString() ?? null, previousTo: pTo?.toISOString() ?? null, bucket: trunc },
      restaurants: {
        total: snap.restaurants, active: snap.active, suspended: snap.suspended, deactivated: snap.deactivated, dormant: snap.dormant, verified: snap.verified,
        inactive: snap.suspended + snap.deactivated,
        newInPeriod: metric(cur.newRestaurants, prev?.newRestaurants ?? null),
      },
      outlets: { total: snap.outlets, active: snap.active_outlets, newInPeriod: metric(cur.newOutlets, prev?.newOutlets ?? null) },
      users: { total: snap.users, active: snap.active_users, admins: snap.admins, signedInPeriod: metric(cur.activeUsers, prev?.activeUsers ?? null) },
      subscriptions: {
        active: subCounts.ACTIVE || 0, trial: subCounts.TRIAL || 0, expired: subCounts.EXPIRED || 0, cancelled: subCounts.CANCELLED || 0,
        grace: (subCounts.GRACE_PERIOD || 0) + (subCounts.PAST_DUE || 0), halted: subCounts.HALTED || 0,
        trialsStarted: metric(conv.trials, prev?.trialsStarted ?? null), conversionRate, churnRate, trialsConverted: conv.converted, churned: churn.lost,
        byPlan: plansDist,
      },
      revenue: {
        collected: metric(cur.collected, prev?.collected ?? null), payments: metric(cur.paidCount, prev?.paidCount ?? null),
        failedCount: metric(cur.failedCount, prev?.failedCount ?? null), failedAmount: cur.failedAmount,
        pending: cur.pending, refunded: cur.refunded,
      },
      orders: { total: snap.orders_total, open: snap.orders_open, inPeriod: metric(cur.orders, prev?.orders ?? null), gmv: metric(cur.gmv, prev?.gmv ?? null) },
      series: { current: series, previous: prevSeries },
      topRestaurants: top,
      leads: Object.fromEntries(leads.map((l: any) => [l.status, l.n])),
      support: { open: snap.open_tickets },
      health: {
        database: health,
        api: { requests: req.total, errorRatePct: req.errorRatePct, p95Ms: req.p95Ms },
        errors24h: errors24[0].n,
        webhookFailures24h: hooks24[0].n,
        jobs,
        uptimeSeconds: Math.floor(process.uptime()),
      },
      activity,
    };
  }

  private async window(from: Date, to: Date) {
    const p = [from.toISOString(), to.toISOString()];
    const [r] = await this.ds.query(
      `SELECT (SELECT COUNT(*)::int FROM organizations WHERE created_at >= $1 AND created_at < $2) AS new_restaurants,
              (SELECT COUNT(*)::int FROM restaurants WHERE created_at >= $1 AND created_at < $2) AS new_outlets,
              (SELECT COUNT(*)::int FROM ${MERCHANT_STAFF_SQL} ms WHERE ms.last_login_at >= $1 AND ms.last_login_at < $2) AS active_users,
              (SELECT COUNT(*)::int FROM orders od WHERE od.created_at >= $1 AND od.created_at < $2) AS orders,
              (SELECT COALESCE(SUM(od.total_amount - od.refund_amount) FILTER (WHERE ${PAID}),0)::float FROM orders od WHERE od.created_at >= $1 AND od.created_at < $2) AS gmv,
              (SELECT COALESCE(SUM(total_amount),0)::float FROM subscription_invoices WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2) AS collected,
              (SELECT COUNT(*)::int FROM subscription_invoices WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2) AS paid_count,
              (SELECT COUNT(*)::int FROM subscription_invoices WHERE status = 'FAILED' AND created_at >= $1 AND created_at < $2) AS failed_count,
              (SELECT COALESCE(SUM(total_amount),0)::float FROM subscription_invoices WHERE status = 'FAILED' AND created_at >= $1 AND created_at < $2) AS failed_amount,
              (SELECT COALESCE(SUM(refunded_amount_paise),0)::float / 100 FROM subscription_invoices WHERE refunded_at >= $1 AND refunded_at < $2) AS refunded,
              (SELECT COUNT(*)::int FROM (SELECT DISTINCT organization_id FROM organization_subscriptions WHERE source = 'TRIAL' AND created_at >= $1 AND created_at < $2) t) AS trials_started,
              (SELECT COUNT(*)::int FROM subscription_invoices WHERE status = 'DRAFT') AS pending`,
      p,
    );
    return {
      newRestaurants: r.new_restaurants, newOutlets: r.new_outlets, activeUsers: r.active_users, orders: r.orders, gmv: r.gmv, collected: r.collected,
      paidCount: r.paid_count, failedCount: r.failed_count, failedAmount: r.failed_amount, refunded: r.refunded, trialsStarted: r.trials_started, pending: r.pending,
    };
  }

  private series(from: Date, to: Date, trunc: 'day' | 'week' | 'month') {
    const step = trunc === 'day' ? '1 day' : trunc === 'week' ? '1 week' : '1 month';
    return this.ds.query(
      `SELECT to_char(b, 'YYYY-MM-DD') AS bucket,
              COALESCE(o.orders,0)::int AS orders, COALESCE(o.gmv,0)::float AS gmv, COALESCE(g.n,0)::int AS signups, COALESCE(v.amount,0)::float AS revenue,
              (SELECT COUNT(*)::int FROM organizations WHERE created_at < b + interval '${step}') AS restaurants_cumulative
       FROM generate_series(date_trunc('${trunc}', $1::timestamptz), $2::timestamptz, interval '${step}') b
       LEFT JOIN (SELECT date_trunc('${trunc}', od.created_at) AS d, COUNT(*) AS orders, SUM(od.total_amount - od.refund_amount) FILTER (WHERE ${PAID}) AS gmv
                  FROM orders od WHERE od.created_at >= $1 AND od.created_at < $2 GROUP BY 1) o ON o.d = b
       LEFT JOIN (SELECT date_trunc('${trunc}', created_at) AS d, COUNT(*) AS n FROM organizations WHERE created_at >= $1 AND created_at < $2 GROUP BY 1) g ON g.d = b
       LEFT JOIN (SELECT date_trunc('${trunc}', paid_at) AS d, SUM(total_amount) AS amount FROM subscription_invoices WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2 GROUP BY 1) v ON v.d = b
       ORDER BY b`,
      [from.toISOString(), to.toISOString()],
    );
  }

  /** Merge platform events and admin actions into one recent-activity feed. */
  private async activityFeed() {
    const rows = await this.ds.query(
      `(SELECT 'event' AS kind, e.type AS action, e.severity, e.title AS summary, o.name AS organization_name, e.organization_id, e.created_at
          FROM platform_events e LEFT JOIN organizations o ON o.id = e.organization_id ORDER BY e.created_at DESC LIMIT 12)
       UNION ALL
       (SELECT 'admin', a.action, 'INFO', a.summary, a.entity_label, a.organization_id, a.created_at FROM platform_audit_logs a ORDER BY a.created_at DESC LIMIT 12)
       ORDER BY created_at DESC LIMIT 14`,
    );
    return rows;
  }
}

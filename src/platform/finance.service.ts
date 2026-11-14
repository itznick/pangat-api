import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LATEST_SUB_SQL, effectiveStatusSql } from './subscriptions-admin.service.js';

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // spreadsheet formula injection guard
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  return [columns.map((c) => csvEscape(c.label)).join(','), ...rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(','))].join('\n');
}

@Injectable()
export class FinanceService {
  constructor(private readonly ds: DataSource) {}

  private range(q: { from?: string; to?: string }) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    return { from, to };
  }

  /** Filtered, paged payment ledger. Every row is a stored invoice created from verified gateway events. */
  async transactions(q: { q?: string; status?: string; method?: string; organizationId?: string; from?: string; to?: string; page?: number; limit?: number; sort?: string; order?: string }, forExport = false) {
    const limit = forExport ? 20000 : Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const params: unknown[] = [];
    const cond: string[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); cond.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (q.q) add('(i.invoice_number ILIKE ? OR i.razorpay_payment_id ILIKE ? OR o.name ILIKE ?)', `%${q.q}%`);
    if (q.status) add('i.status::text = ?', q.status);
    if (q.method) add('i.payment_method = ?', q.method);
    if (q.organizationId) add('i.organization_id = ?', q.organizationId);
    if (q.from) add('i.created_at >= ?', q.from);
    if (q.to) add('i.created_at <= ?', q.to);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const sortCol: Record<string, string> = { date: 'i.created_at', amount: 'i.total_amount', restaurant: 'o.name', status: 'i.status' };
    const order = `${sortCol[q.sort || 'date'] || 'i.created_at'} ${q.order === 'asc' ? 'ASC' : 'DESC'}, i.id`;
    const from = `FROM subscription_invoices i JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN organization_subscriptions s ON s.id = i.subscription_id LEFT JOIN subscription_plans p ON p.id = s.plan_id ${where}`;
    const [items, total, agg] = await Promise.all([
      this.ds.query(
        `SELECT i.id, i.invoice_number, i.status::text AS status, i.organization_id, o.name AS organization_name, p.name AS plan_name, i.gateway, i.payment_method,
                i.razorpay_payment_id, i.razorpay_invoice_id, i.base_amount::float AS base_amount, i.tax_amount::float AS tax_amount, i.total_amount::float AS total_amount,
                (i.refunded_amount_paise::float / 100) AS refunded_amount, i.failure_reason, i.billing_period_start, i.billing_period_end, i.paid_at, i.refunded_at, i.created_at
         ${from} ORDER BY ${order} LIMIT ${limit} OFFSET ${forExport ? 0 : (page - 1) * limit}`,
        params,
      ),
      this.ds.query(`SELECT COUNT(*)::int AS n ${from}`, params),
      this.ds.query(
        `SELECT COALESCE(SUM(i.total_amount) FILTER (WHERE i.status = 'PAID'),0)::float AS paid, COALESCE(SUM(i.total_amount) FILTER (WHERE i.status = 'FAILED'),0)::float AS failed,
                COALESCE(SUM(i.refunded_amount_paise),0)::float / 100 AS refunded FROM subscription_invoices i JOIN organizations o ON o.id = i.organization_id ${where}`,
        params,
      ),
    ]);
    return { items, total: total[0].n, page, limit, totals: agg[0] };
  }

  async overview(q: { from?: string; to?: string }) {
    const { from, to } = this.range(q);
    const span = (to.getTime() - from.getTime()) / 86_400_000;
    const trunc = span <= 45 ? 'day' : span <= 200 ? 'week' : 'month';
    const step = trunc === 'day' ? '1 day' : trunc === 'week' ? '1 week' : '1 month';
    const p = [from.toISOString(), to.toISOString()];
    const eff = effectiveStatusSql('s');
    const [kpi, series, byMethod, byPlan, pending, mrr] = await Promise.all([
      this.ds.query(
        `SELECT COALESCE(SUM(total_amount) FILTER (WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2),0)::float AS collected,
                COALESCE(SUM(base_amount) FILTER (WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2),0)::float AS collected_base,
                COALESCE(SUM(tax_amount) FILTER (WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2),0)::float AS collected_tax,
                COUNT(*) FILTER (WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2)::int AS paid_count,
                COUNT(*) FILTER (WHERE status = 'FAILED' AND created_at >= $1 AND created_at < $2)::int AS failed_count,
                COALESCE(SUM(total_amount) FILTER (WHERE status = 'FAILED' AND created_at >= $1 AND created_at < $2),0)::float AS failed_amount,
                COALESCE(SUM(refunded_amount_paise) FILTER (WHERE refunded_at >= $1 AND refunded_at < $2),0)::float / 100 AS refunded
         FROM subscription_invoices`,
        p,
      ),
      this.ds.query(
        `SELECT to_char(b, 'YYYY-MM-DD') AS bucket, COALESCE(x.amount,0)::float AS amount, COALESCE(x.n,0)::int AS payments, COALESCE(f.n,0)::int AS failed
         FROM generate_series(date_trunc('${trunc}', $1::timestamptz), $2::timestamptz, interval '${step}') b
         LEFT JOIN (SELECT date_trunc('${trunc}', paid_at) AS d, SUM(total_amount) AS amount, COUNT(*) AS n FROM subscription_invoices WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2 GROUP BY 1) x ON x.d = b
         LEFT JOIN (SELECT date_trunc('${trunc}', created_at) AS d, COUNT(*) AS n FROM subscription_invoices WHERE status = 'FAILED' AND created_at >= $1 AND created_at < $2 GROUP BY 1) f ON f.d = b
         ORDER BY b`,
        p,
      ),
      this.ds.query(
        `SELECT COALESCE(payment_method,'unknown') AS method, COUNT(*)::int AS n, SUM(total_amount)::float AS amount FROM subscription_invoices
         WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2 GROUP BY 1 ORDER BY 3 DESC`,
        p,
      ),
      this.ds.query(
        `SELECT pl.name AS plan, COUNT(*)::int AS n, SUM(i.total_amount)::float AS amount FROM subscription_invoices i JOIN organization_subscriptions s ON s.id = i.subscription_id
         JOIN subscription_plans pl ON pl.id = s.plan_id WHERE i.status = 'PAID' AND i.paid_at >= $1 AND i.paid_at < $2 GROUP BY 1 ORDER BY 3 DESC`,
        p,
      ),
      this.ds.query(
        `SELECT (SELECT COUNT(*)::int FROM subscription_invoices WHERE status = 'DRAFT') AS draft_invoices,
                (SELECT COUNT(*)::int FROM (${LATEST_SUB_SQL}) s WHERE ${eff} IN ('GRACE_PERIOD','PAST_DUE')) AS awaiting_payment`,
      ),
      this.ds.query(
        `SELECT COALESCE(SUM(CASE WHEN pl.billing_interval = 'YEARLY' THEN pl.base_price / 12 ELSE pl.base_price END),0)::float AS mrr, COUNT(*)::int AS subscribers
         FROM (${LATEST_SUB_SQL}) s JOIN subscription_plans pl ON pl.id = s.plan_id WHERE ${eff} = 'ACTIVE' AND s.source = 'GATEWAY'`,
      ),
    ]);
    return {
      range: { from: from.toISOString(), to: to.toISOString(), bucket: trunc },
      kpi: kpi[0], series, byMethod, byPlan, pending: pending[0], recurring: mrr[0],
    };
  }

  /**
   * Reconciliation: cross-checks our own records against each other and against webhook outcomes. Nothing here can be
   * "fixed" by marking a payment successful — only a signed gateway event creates a PAID invoice.
   */
  async reconciliation() {
    const eff = effectiveStatusSql('s');
    const [noRef, mismatch, activeNoPay, hooks, grace, manual, overRefund] = await Promise.all([
      this.ds.query(
        `SELECT i.id, i.invoice_number, o.name AS organization_name, i.total_amount::float AS amount, i.created_at FROM subscription_invoices i JOIN organizations o ON o.id = i.organization_id
         WHERE i.status = 'PAID' AND (i.razorpay_payment_id IS NULL OR i.razorpay_payment_id = '') ORDER BY i.created_at DESC LIMIT 20`,
      ),
      this.ds.query(
        `SELECT i.id, i.invoice_number, o.name AS organization_name, i.total_amount::float AS amount, (i.base_amount + i.tax_amount)::float AS expected FROM subscription_invoices i
         JOIN organizations o ON o.id = i.organization_id WHERE ABS((i.base_amount + i.tax_amount) - i.total_amount) > 0.01 ORDER BY i.created_at DESC LIMIT 20`,
      ),
      this.ds.query(
        `SELECT o.id AS organization_id, o.name AS organization_name, s.current_period_end FROM (${LATEST_SUB_SQL}) s JOIN organizations o ON o.id = s.organization_id
         WHERE s.status = 'ACTIVE' AND s.source = 'GATEWAY' AND NOT EXISTS (SELECT 1 FROM subscription_invoices i WHERE i.organization_id = s.organization_id AND i.status = 'PAID') LIMIT 20`,
      ),
      this.ds.query(
        `SELECT id, event_type, status, error, received_at FROM webhook_events WHERE status IN ('REJECTED','FAILED') AND received_at > now() - interval '7 days' ORDER BY received_at DESC LIMIT 20`,
      ),
      this.ds.query(
        `SELECT o.id AS organization_id, o.name AS organization_name, s.current_period_end, s.grace_period_ends_at FROM (${LATEST_SUB_SQL}) s JOIN organizations o ON o.id = s.organization_id
         WHERE ${eff} IN ('GRACE_PERIOD','PAST_DUE') ORDER BY s.current_period_end LIMIT 20`,
      ),
      this.ds.query(
        `SELECT o.id AS organization_id, o.name AS organization_name, s.current_period_end, s.assigned_by FROM (${LATEST_SUB_SQL}) s JOIN organizations o ON o.id = s.organization_id
         WHERE s.source = 'MANUAL' AND ${eff} = 'ACTIVE' ORDER BY s.current_period_end LIMIT 20`,
      ),
      this.ds.query(
        `SELECT i.id, i.invoice_number, (i.refunded_amount_paise::float / 100) AS refunded, i.total_amount::float AS amount FROM subscription_invoices i WHERE i.refunded_amount_paise > i.total_amount_paise LIMIT 20`,
      ),
    ]);
    const checks = [
      { key: 'paid_without_gateway_reference', title: 'Paid invoices without a gateway payment id', severity: 'CRITICAL', description: 'A paid invoice must carry the gateway payment id that confirmed it.', items: noRef },
      { key: 'amount_mismatch', title: 'Invoice totals that do not add up', severity: 'CRITICAL', description: 'Base amount + tax differs from the invoice total.', items: mismatch },
      { key: 'active_without_payment', title: 'Gateway subscriptions active with no paid invoice', severity: 'WARNING', description: 'Active on a gateway plan but no verified payment has been recorded.', items: activeNoPay },
      { key: 'webhook_failures', title: 'Webhook failures in the last 7 days', severity: 'WARNING', description: 'Rejected or failed gateway deliveries can mean missed payments.', items: hooks },
      { key: 'awaiting_payment', title: 'Subscriptions awaiting payment (grace period)', severity: 'INFO', description: 'Renewal not yet collected; access continues until the grace period ends.', items: grace },
      { key: 'refund_exceeds_payment', title: 'Refunds larger than the payment', severity: 'CRITICAL', description: 'Refunded amount exceeds the invoice total.', items: overRefund },
      { key: 'manual_grants', title: 'Active manual grants (no revenue recorded)', severity: 'INFO', description: 'Plans activated by a platform admin. These never count as collected revenue.', items: manual },
    ].map((c) => ({ ...c, count: c.items.length, status: c.items.length === 0 ? 'OK' : c.severity }));
    return { checkedAt: new Date().toISOString(), healthy: checks.every((c) => c.severity === 'INFO' || c.count === 0), checks };
  }
}

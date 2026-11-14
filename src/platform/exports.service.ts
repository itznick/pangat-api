import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { AuditActor, PlatformAuditService } from './audit.service.js';
import { FinanceService, toCsv } from './finance.service.js';
import { RestaurantsAdminService } from './restaurants-admin.service.js';
import { SubscriptionsAdminService } from './subscriptions-admin.service.js';
import { UsersAdminService } from './users-admin.service.js';

export const REPORT_KINDS = ['payments', 'subscriptions', 'restaurants', 'users', 'audit', 'revenue-by-month'] as const;
type Kind = (typeof REPORT_KINDS)[number];

@Injectable()
export class ExportsService {
  constructor(
    private readonly ds: DataSource,
    private readonly audit: PlatformAuditService,
    private readonly finance: FinanceService,
    private readonly restaurants: RestaurantsAdminService,
    private readonly subs: SubscriptionsAdminService,
    private readonly users: UsersAdminService,
  ) {}

  private async record(actor: AuditActor, scope: string, kind: string, orgId: string | null, content: string, counts: unknown, filters: unknown) {
    const checksum = createHash('sha256').update(content).digest('hex');
    await this.ds.query(
      `INSERT INTO data_exports (organization_id, scope, kind, requested_by, requested_by_name, row_counts, bytes, checksum, filters) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb)`,
      [orgId, scope, kind, actor.id ?? null, actor.name ?? null, JSON.stringify(counts), Buffer.byteLength(content), checksum, JSON.stringify(filters ?? {})],
    );
    await this.audit.record(actor, {
      action: 'DATA_EXPORTED', category: 'SYSTEM', entityType: scope === 'ORGANIZATION' ? 'organization' : 'report', entityId: orgId ?? kind, entityLabel: kind, organizationId: orgId,
      summary: `Exported ${kind}${orgId ? ' for a restaurant' : ''} (${Object.values(counts as Record<string, number>).reduce((a, b) => a + b, 0)} rows)`,
    });
    return checksum;
  }

  async report(kind: string, filters: Record<string, string | undefined>, actor: AuditActor) {
    if (!REPORT_KINDS.includes(kind as Kind)) throw new BadRequestException(`Unknown report '${kind}'`);
    const today = new Date().toISOString().slice(0, 10);
    let columns: { key: string; label: string }[] = [];
    let rows: Record<string, unknown>[] = [];
    if (kind === 'payments') {
      rows = (await this.finance.transactions(filters, true)).items;
      columns = ['invoice_number', 'status', 'organization_name', 'plan_name', 'gateway', 'payment_method', 'razorpay_payment_id', 'base_amount', 'tax_amount', 'total_amount', 'refunded_amount', 'failure_reason', 'paid_at', 'created_at'].map((k) => ({ key: k, label: k }));
    } else if (kind === 'subscriptions') {
      rows = (await this.subs.list({ ...filters, limit: 100000 } as any)).items as any;
      columns = ['organization_name', 'owner_email', 'plan_name', 'effective_status', 'source', 'current_period_start', 'current_period_end', 'days_left', 'cancel_at_period_end', 'last_paid_at'].map((k) => ({ key: k, label: k }));
    } else if (kind === 'restaurants') {
      rows = (await this.restaurants.list({ ...filters, limit: 100000 } as any)).items as any;
      columns = ['name', 'status', 'verification_status', 'owner_name', 'owner_email', 'outlets', 'users', 'orders', 'orders_30d', 'gmv', 'plan_name', 'subscription_status', 'current_period_end', 'created_at'].map((k) => ({ key: k, label: k }));
    } else if (kind === 'users') {
      rows = (await this.users.list({ ...filters, limit: 100000 } as any)).items as any;
      columns = ['name', 'email', 'role', 'organization_name', 'outlet_name', 'is_active', 'last_login_at', 'created_at'].map((k) => ({ key: k, label: k }));
    } else if (kind === 'audit') {
      rows = await this.audit.exportRows(filters as any);
      columns = ['created_at', 'actor_name', 'actor_email', 'action', 'category', 'entity_type', 'entity_label', 'summary', 'reason', 'ip'].map((k) => ({ key: k, label: k }));
    } else {
      rows = await this.ds.query(
        `SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month, COUNT(*)::int AS payments, SUM(base_amount)::float AS base_amount, SUM(tax_amount)::float AS tax_amount, SUM(total_amount)::float AS total_amount
         FROM subscription_invoices WHERE status = 'PAID' GROUP BY 1 ORDER BY 1`,
      );
      columns = ['month', 'payments', 'base_amount', 'tax_amount', 'total_amount'].map((k) => ({ key: k, label: k }));
    }
    const content = toCsv(columns, rows);
    await this.record(actor, 'PLATFORM_REPORT', kind, null, content, { rows: rows.length }, filters);
    return { filename: `pangat-${kind}-${today}.csv`, mime: 'text/csv', content, rows: rows.length };
  }

  /** Full machine-readable copy of one restaurant's data (no password hashes, tokens or PINs). */
  async organization(orgId: string, actor: AuditActor) {
    const org = (await this.ds.query('SELECT id, name, status, verification_status, created_at FROM organizations WHERE id = $1', [orgId]))[0];
    if (!org) throw new NotFoundException('Restaurant not found');
    const ids = (await this.ds.query('SELECT id FROM restaurants WHERE organization_id = $1', [orgId])).map((r: any) => r.id);
    const q = (sql: string, params: unknown[] = [ids]) => this.ds.query(sql, params);
    const [outlets, staff, tables, categories, menuItems, orders, orderItems, invoices, subscriptions, ingredients] = await Promise.all([
      q('SELECT id, name, slug, branch_area, phone, email, is_active, upi_vpa, gstin, gst_percentage, operations, created_at FROM restaurants WHERE id = ANY($1)'),
      q(`SELECT id, name, email, phone, role, is_active, last_login_at, restaurant_id, created_at FROM staff WHERE (organization_id = $2 OR restaurant_id = ANY($1)) AND is_platform_admin = false AND email NOT LIKE 'kitchen.%@stations.pangat.app'`, [ids, orgId]),
      q('SELECT * FROM tables WHERE restaurant_id = ANY($1)'),
      q('SELECT * FROM menu_categories WHERE restaurant_id = ANY($1)'),
      q('SELECT * FROM menu_items WHERE restaurant_id = ANY($1)'),
      q('SELECT * FROM orders WHERE restaurant_id = ANY($1) ORDER BY created_at DESC LIMIT 50000'),
      q('SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.restaurant_id = ANY($1) AND oi.order_id IN (SELECT id FROM orders WHERE restaurant_id = ANY($1) ORDER BY created_at DESC LIMIT 50000)'),
      q('SELECT id, invoice_number, status, base_amount, tax_amount, total_amount, razorpay_payment_id, paid_at, created_at FROM subscription_invoices WHERE organization_id = $1', [orgId]),
      q('SELECT * FROM organization_subscriptions WHERE organization_id = $1', [orgId]),
      q('SELECT * FROM ingredients WHERE restaurant_id = ANY($1)').catch(() => []),
    ]);
    // Order tracking tokens would let anyone open a guest's order page
    const safeOrders = orders.map((o: any) => { const { tracking_token, ...rest } = o; void tracking_token; return rest; });
    const bundle = { exportedAt: new Date().toISOString(), organization: org, outlets, staff, tables, menuCategories: categories, menuItems, orders: safeOrders, orderItems, ingredients, invoices, subscriptions, truncated: orders.length >= 50000 };
    const content = JSON.stringify(bundle, null, 2);
    if (Buffer.byteLength(content) > 40 * 1048576) throw new BadRequestException('This restaurant is too large to export in one file. Contact engineering for a database-level export.');
    const counts = { outlets: outlets.length, staff: staff.length, tables: tables.length, menuItems: menuItems.length, orders: orders.length, invoices: invoices.length };
    const checksum = await this.record(actor, 'ORGANIZATION', 'restaurant-data', orgId, content, counts, {});
    return { filename: `pangat-${org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`, mime: 'application/json', content, counts, checksum };
  }

  history(limit = 50) {
    return this.ds.query(
      `SELECT e.id, e.scope, e.kind, e.requested_by_name, e.status, e.row_counts, e.bytes, e.checksum, e.created_at, o.name AS organization_name
       FROM data_exports e LEFT JOIN organizations o ON o.id = e.organization_id ORDER BY e.created_at DESC LIMIT $1`,
      [Math.min(200, limit)],
    );
  }
}

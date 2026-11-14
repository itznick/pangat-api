import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventsGateway } from '../events/events.gateway.js';
import { AuditActor, PlatformAuditService } from './audit.service.js';
import { PlatformEventsService } from './events.service.js';
import { invalidateOrgLifecycle } from './org-status.js';
import { invalidateOrgAccess } from '../subscriptions/subscription-access.js';
import { invalidateFeatureCache } from './features.js';
import { LATEST_SUB_SQL, SubscriptionsAdminService, effectiveStatusSql } from './subscriptions-admin.service.js';

/** Real merchant staff: excludes platform admins and the per-outlet kitchen station logins. */
export const MERCHANT_STAFF_SQL = `(SELECT st.*, COALESCE(st.organization_id, r.organization_id) AS org_id FROM staff st LEFT JOIN restaurants r ON r.id = st.restaurant_id
  WHERE st.is_platform_admin = false AND st.role <> 'PLATFORM_SUPER_ADMIN' AND st.email NOT LIKE 'kitchen.%@stations.pangat.app')`;

const PAID = `od.payment_status IN ('PAID','PARTIALLY_REFUNDED') AND od.order_status <> 'CANCELLED'`;

@Injectable()
export class RestaurantsAdminService {
  constructor(
    private readonly ds: DataSource,
    private readonly audit: PlatformAuditService,
    private readonly events: PlatformEventsService,
    private readonly gateway: EventsGateway,
    private readonly subs: SubscriptionsAdminService,
  ) {}

  // ── list ──────────────────────────────────────────────────────────────────
  async list(q: {
    q?: string; status?: string; verification?: string; plan?: string; subscription?: string; onboarding?: string;
    from?: string; to?: string; sort?: string; order?: string; page?: number; limit?: number;
  }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const eff = effectiveStatusSql('s');
    const params: unknown[] = [];
    const cond: string[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); cond.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (q.q) {
      add(`(o.name ILIKE ? OR ow.email ILIKE ? OR ow.name ILIKE ? OR EXISTS (SELECT 1 FROM restaurants r WHERE r.organization_id = o.id AND (r.name ILIKE ? OR r.slug ILIKE ? OR r.phone ILIKE ?)))`, `%${q.q}%`);
    }
    if (q.status) add('o.status = ?', q.status);
    if (q.verification) add('o.verification_status = ?', q.verification);
    if (q.plan) add('p.code = ?', q.plan);
    if (q.subscription === 'NONE') cond.push('s.id IS NULL');
    else if (q.subscription) add(`${eff} = ?`, q.subscription);
    if (q.from) add('o.created_at >= ?', q.from);
    if (q.to) add('o.created_at <= ?', q.to);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const sortCol: Record<string, string> = {
      name: 'o.name', created: 'o.created_at', orders: 'orders', gmv: 'gmv', outlets: 'outlets', activity: 'last_order_at', users: 'users',
    };
    const order = `${sortCol[q.sort || 'created'] || 'o.created_at'} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, o.id`;

    const from = `FROM organizations o
      LEFT JOIN LATERAL (SELECT name, email, last_login_at FROM staff WHERE organization_id = o.id AND role = 'SUPER_OWNER' ORDER BY created_at LIMIT 1) ow ON true
      LEFT JOIN (${LATEST_SUB_SQL}) s ON s.organization_id = o.id
      LEFT JOIN subscription_plans p ON p.id = s.plan_id
      LEFT JOIN (SELECT r.organization_id AS org_id, COUNT(*)::int AS outlets, COUNT(*) FILTER (WHERE r.is_active)::int AS active_outlets,
                        BOOL_OR(COALESCE(r.upi_vpa,'') <> '') AS has_upi FROM restaurants r GROUP BY r.organization_id) ra ON ra.org_id = o.id
      LEFT JOIN (SELECT r.organization_id AS org_id, COUNT(od.id)::int AS orders, COUNT(od.id) FILTER (WHERE od.created_at >= now() - interval '30 days')::int AS orders_30d,
                        COALESCE(SUM(od.total_amount - od.refund_amount) FILTER (WHERE ${PAID}), 0)::float AS gmv, MAX(od.created_at) AS last_order_at
                 FROM restaurants r JOIN orders od ON od.restaurant_id = r.id GROUP BY r.organization_id) oa ON oa.org_id = o.id
      LEFT JOIN (SELECT org_id, COUNT(*)::int AS users FROM ${MERCHANT_STAFF_SQL} ms GROUP BY org_id) ua ON ua.org_id = o.id
      LEFT JOIN (SELECT r.organization_id AS org_id, COUNT(*)::int AS n FROM tables t JOIN restaurants r ON r.id = t.restaurant_id GROUP BY r.organization_id) ta ON ta.org_id = o.id
      LEFT JOIN (SELECT r.organization_id AS org_id, COUNT(*)::int AS n FROM menu_items m JOIN restaurants r ON r.id = m.restaurant_id WHERE m.deleted_at IS NULL GROUP BY r.organization_id) ma ON ma.org_id = o.id
      ${where}`;

    const [rows, total] = await Promise.all([
      this.ds.query(
        `SELECT o.id, o.name, o.status, o.verification_status, o.created_at, ow.name AS owner_name, ow.email AS owner_email, ow.last_login_at AS owner_last_login_at,
                COALESCE(ra.outlets,0) AS outlets, COALESCE(ra.active_outlets,0) AS active_outlets, COALESCE(ra.has_upi,false) AS has_upi,
                COALESCE(oa.orders,0) AS orders, COALESCE(oa.orders_30d,0) AS orders_30d, COALESCE(oa.gmv,0) AS gmv, oa.last_order_at,
                COALESCE(ua.users,0) AS users, COALESCE(ta.n,0) AS tables, COALESCE(ma.n,0) AS menu_items,
                p.code AS plan_code, p.name AS plan_name, ${eff} AS subscription_status, s.current_period_end, s.source AS subscription_source
         ${from} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params,
      ),
      this.ds.query(`SELECT COUNT(*)::int AS n ${from}`, params),
    ]);
    const items = rows.map((r: any) => ({ ...r, onboarding: this.onboardingFrom(r) }));
    const filtered = q.onboarding === 'COMPLETE' ? items.filter((i: any) => i.onboarding.percent === 100) : q.onboarding === 'INCOMPLETE' ? items.filter((i: any) => i.onboarding.percent < 100) : items;
    return { items: filtered, total: total[0].n, page, limit };
  }

  private onboardingFrom(r: any) {
    const steps = [
      { key: 'outlet', label: 'Outlet created', done: Number(r.outlets) > 0 },
      { key: 'payments', label: 'UPI payment address set', done: Boolean(r.has_upi) },
      { key: 'tables', label: 'Tables added', done: Number(r.tables) > 0 },
      { key: 'menu', label: 'Menu items added', done: Number(r.menu_items) > 0 },
      { key: 'team', label: 'Team member invited', done: Number(r.users) > 1 },
      { key: 'login', label: 'Owner has signed in', done: Boolean(r.owner_last_login_at) },
      { key: 'order', label: 'First order received', done: Number(r.orders) > 0 },
    ];
    const done = steps.filter((s) => s.done).length;
    return { steps, completed: done, total: steps.length, percent: Math.round((done / steps.length) * 100) };
  }

  // ── profile ───────────────────────────────────────────────────────────────
  async get(id: string) {
    const found = (await this.ds.query('SELECT id FROM organizations WHERE id = $1', [id]))[0];
    if (!found) throw new NotFoundException('Restaurant not found');

    const [org] = await this.ds.query(
      `SELECT o.*, ow.id AS owner_id, ow.name AS owner_name, ow.email AS owner_email, ow.phone AS owner_phone, ow.last_login_at AS owner_last_login_at, ow.is_active AS owner_active
       FROM organizations o LEFT JOIN LATERAL (SELECT * FROM staff WHERE organization_id = o.id AND role = 'SUPER_OWNER' ORDER BY created_at LIMIT 1) ow ON true WHERE o.id = $1`,
      [id],
    );
    const [outlets, users, subscription, stats, flags, tickets, notesCount, usage] = await Promise.all([
      this.ds.query(
        `SELECT r.id, r.name, r.slug, r.branch_area, r.phone, r.email, r.is_active, r.upi_vpa, r.gstin, r.gst_percentage::float AS gst_percentage, r.created_at,
                (SELECT COUNT(*)::int FROM tables t WHERE t.restaurant_id = r.id) AS tables,
                (SELECT COUNT(*)::int FROM menu_items m WHERE m.restaurant_id = r.id AND m.deleted_at IS NULL) AS menu_items,
                (SELECT COUNT(*)::int FROM orders od WHERE od.restaurant_id = r.id) AS orders,
                (SELECT COUNT(*)::int FROM orders od WHERE od.restaurant_id = r.id AND od.created_at >= now() - interval '30 days') AS orders_30d,
                (SELECT COUNT(*)::int FROM orders od WHERE od.restaurant_id = r.id AND od.order_status NOT IN ('COMPLETED','CANCELLED')) AS open_orders,
                (SELECT MAX(od.created_at) FROM orders od WHERE od.restaurant_id = r.id) AS last_order_at
         FROM restaurants r WHERE r.organization_id = $1 ORDER BY r.created_at`,
        [id],
      ),
      this.ds.query(
        `SELECT ms.id, ms.name, ms.email, ms.phone, ms.role, ms.is_active, ms.last_login_at, ms.failed_login_count, ms.locked_until, ms.created_at, ms.restaurant_id, r.name AS outlet_name
         FROM ${MERCHANT_STAFF_SQL} ms LEFT JOIN restaurants r ON r.id = ms.restaurant_id WHERE ms.org_id = $1 ORDER BY (ms.role = 'SUPER_OWNER') DESC, ms.created_at`,
        [id],
      ),
      this.currentSubscription(id),
      this.ds.query(
        `SELECT COUNT(od.id)::int AS orders, COUNT(od.id) FILTER (WHERE od.created_at >= now() - interval '30 days')::int AS orders_30d,
                COALESCE(SUM(od.total_amount - od.refund_amount) FILTER (WHERE ${PAID}),0)::float AS gmv,
                COALESCE(SUM(od.total_amount - od.refund_amount) FILTER (WHERE ${PAID} AND od.created_at >= now() - interval '30 days'),0)::float AS gmv_30d,
                MAX(od.created_at) AS last_order_at
         FROM restaurants r LEFT JOIN orders od ON od.restaurant_id = r.id WHERE r.organization_id = $1`,
        [id],
      ),
      this.ds.query('SELECT feature_key, mode, reason, set_by, created_at FROM org_feature_overrides WHERE organization_id = $1', [id]),
      this.ds.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED'))::int AS open, COUNT(*)::int AS total FROM support_tickets WHERE organization_id = $1`, [id]),
      this.ds.query('SELECT COUNT(*)::int AS n FROM organization_notes WHERE organization_id = $1', [id]),
      this.subs.usage(id),
    ]);
    const outletRows = outlets.map((o: any) => ({ ...o, isOnline: this.gateway.isOutletOnline(o.slug) }));
    const ob = this.onboardingFrom({
      outlets: outlets.length,
      has_upi: outlets.some((o: any) => o.upi_vpa),
      tables: outlets.reduce((a: number, o: any) => a + o.tables, 0),
      menu_items: outlets.reduce((a: number, o: any) => a + o.menu_items, 0),
      users: users.length,
      owner_last_login_at: org.owner_last_login_at,
      orders: stats[0].orders,
    });
    return {
      organization: org,
      owner: org.owner_id ? { id: org.owner_id, name: org.owner_name, email: org.owner_email, phone: org.owner_phone, lastLoginAt: org.owner_last_login_at, isActive: org.owner_active } : null,
      outlets: outletRows,
      users,
      subscription,
      stats: stats[0],
      onboarding: ob,
      featureOverrides: flags,
      support: tickets[0],
      notesCount: notesCount[0].n,
      usage,
    };
  }

  async currentSubscription(orgId: string) {
    const rows = await this.ds.query(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.base_price::float AS base_price, p.billing_interval, p.max_outlets, p.max_tables_per_outlet, p.max_staff_per_outlet,
              p.features, p.tax_percentage::float AS tax_percentage, ${effectiveStatusSql('s')} AS effective_status
       FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.organization_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [orgId],
    );
    const r = rows[0];
    if (!r) return null;
    return { ...r, features: typeof r.features === 'string' ? r.features.split(',').filter(Boolean) : r.features };
  }

  /** Usage over time: daily orders and revenue, order mix, sign-ins, plus both audit trails. */
  async activity(id: string, days = 30) {
    const span = Math.min(180, Math.max(7, Number(days) || 30));
    const [daily, mix, byStatus, logins, merchantAudit, platformAudit] = await Promise.all([
      this.ds.query(
        `SELECT to_char(d::date, 'YYYY-MM-DD') AS day, COALESCE(x.orders,0)::int AS orders, COALESCE(x.revenue,0)::float AS revenue
         FROM generate_series(now()::date - ($2::int - 1), now()::date, interval '1 day') d
         LEFT JOIN (SELECT od.created_at::date AS day, COUNT(*) AS orders, SUM(od.total_amount - od.refund_amount) FILTER (WHERE ${PAID}) AS revenue
                    FROM orders od JOIN restaurants r ON r.id = od.restaurant_id WHERE r.organization_id = $1 GROUP BY 1) x ON x.day = d::date ORDER BY d`,
        [id, span],
      ),
      this.ds.query(
        `SELECT od.order_type AS type, od.payment_method AS payment_method, COUNT(*)::int AS n FROM orders od JOIN restaurants r ON r.id = od.restaurant_id
         WHERE r.organization_id = $1 AND od.created_at >= now() - ($2::int || ' days')::interval GROUP BY 1,2`,
        [id, span],
      ),
      this.ds.query(
        `SELECT od.order_status AS status, COUNT(*)::int AS n FROM orders od JOIN restaurants r ON r.id = od.restaurant_id
         WHERE r.organization_id = $1 AND od.created_at >= now() - ($2::int || ' days')::interval GROUP BY 1`,
        [id, span],
      ),
      this.ds.query(
        `SELECT le.created_at, le.success, le.reason, le.ip, ms.name, ms.email, ms.role FROM login_events le JOIN ${MERCHANT_STAFF_SQL} ms ON ms.id = le.staff_id
         WHERE ms.org_id = $1 ORDER BY le.created_at DESC LIMIT 25`,
        [id],
      ),
      this.ds.query(
        `SELECT al.id, al.action, al.entity_type, al.staff_name, al.staff_role, al.reason, al.created_at FROM audit_logs al JOIN restaurants r ON r.id = al.restaurant_id
         WHERE r.organization_id = $1 ORDER BY al.created_at DESC LIMIT 25`,
        [id],
      ),
      this.audit.forOrganization(id, 25),
    ]);
    return { days: span, daily, mix, byStatus, logins, merchantAudit, platformAudit };
  }

  async billing(id: string) {
    const [invoices, totals] = await Promise.all([
      this.ds.query(
        `SELECT i.id, i.invoice_number, i.status, i.base_amount::float AS base_amount, i.tax_amount::float AS tax_amount, i.total_amount::float AS total_amount,
                i.refunded_amount_paise::float AS refunded_amount_paise, i.razorpay_payment_id, i.payment_method, i.failure_reason, i.billing_period_start, i.billing_period_end,
                i.paid_at, i.created_at, i.gateway
         FROM subscription_invoices i WHERE i.organization_id = $1 ORDER BY i.created_at DESC LIMIT 200`,
        [id],
      ),
      this.ds.query(
        `SELECT COALESCE(SUM(total_amount) FILTER (WHERE status = 'PAID'),0)::float AS paid, COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count, COALESCE(SUM(refunded_amount_paise),0)::float / 100 AS refunded
         FROM subscription_invoices WHERE organization_id = $1`,
        [id],
      ),
    ]);
    return { invoices, totals: totals[0], history: await this.subs.history(id) };
  }

  // ── actions ───────────────────────────────────────────────────────────────
  async setStatus(id: string, action: 'SUSPEND' | 'DEACTIVATE' | 'RESTORE', reason: string | undefined, actor: AuditActor) {
    const org = (await this.ds.query('SELECT id, name, status FROM organizations WHERE id = $1', [id]))[0];
    if (!org) throw new NotFoundException('Restaurant not found');
    const next = action === 'SUSPEND' ? 'SUSPENDED' : action === 'DEACTIVATE' ? 'DEACTIVATED' : 'ACTIVE';
    if (org.status === next) throw new BadRequestException(`The account is already ${next.toLowerCase()}`);
    if (next !== 'ACTIVE' && !reason?.trim()) throw new BadRequestException('A reason is required to suspend or deactivate an account');
    await this.ds.query(
      `UPDATE organizations SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4, updated_at = now() WHERE id = $1`,
      [id, next, next === 'ACTIVE' ? null : reason!.trim(), actor.name || actor.email || 'admin'],
    );
    invalidateOrgLifecycle(id);
    invalidateOrgAccess(id);
    await this.audit.record(actor, {
      action: `RESTAURANT_${action === 'RESTORE' ? 'RESTORED' : action === 'SUSPEND' ? 'SUSPENDED' : 'DEACTIVATED'}`,
      category: 'RESTAURANT', entityType: 'organization', entityId: id, entityLabel: org.name, organizationId: id,
      summary: `${action === 'RESTORE' ? 'Restored' : action === 'SUSPEND' ? 'Suspended' : 'Deactivated'} ${org.name}`,
      changes: { status: { from: org.status, to: next } }, reason: reason?.trim() || null,
    });
    if (next !== 'ACTIVE') await this.events.emit('ACCOUNT_STATUS', 'WARNING', `${org.name} ${next.toLowerCase()}`, reason, { organizationId: id, actorName: actor.name || undefined });
    return { status: next };
  }

  async setVerification(id: string, status: 'VERIFIED' | 'REJECTED' | 'UNVERIFIED', note: string | undefined, actor: AuditActor) {
    const org = (await this.ds.query('SELECT id, name, verification_status FROM organizations WHERE id = $1', [id]))[0];
    if (!org) throw new NotFoundException('Restaurant not found');
    if (status === 'REJECTED' && !note?.trim()) throw new BadRequestException('Add a note explaining why verification was rejected');
    await this.ds.query(
      `UPDATE organizations SET verification_status = $2::varchar, verification_note = $3, verified_at = CASE WHEN $2::varchar = 'UNVERIFIED' THEN NULL ELSE now() END,
         verified_by = CASE WHEN $2::varchar = 'UNVERIFIED' THEN NULL ELSE $4::varchar END, updated_at = now() WHERE id = $1`,
      [id, status, note?.trim() || null, actor.name || actor.email || 'admin'],
    );
    await this.audit.record(actor, {
      action: `VERIFICATION_${status}`, category: 'RESTAURANT', entityType: 'organization', entityId: id, entityLabel: org.name, organizationId: id,
      summary: `Marked ${org.name} as ${status.toLowerCase()}`, changes: { verification: { from: org.verification_status, to: status } }, reason: note?.trim() || null,
    });
    return { verificationStatus: status };
  }

  listNotes(id: string) {
    return this.ds.query('SELECT id, author_id, author_name, body, pinned, created_at FROM organization_notes WHERE organization_id = $1 ORDER BY pinned DESC, created_at DESC', [id]);
  }

  async addNote(id: string, body: string, pinned: boolean, actor: AuditActor) {
    const org = (await this.ds.query('SELECT id, name FROM organizations WHERE id = $1', [id]))[0];
    if (!org) throw new NotFoundException('Restaurant not found');
    const [row] = await this.ds.query(
      'INSERT INTO organization_notes (organization_id, author_id, author_name, body, pinned) VALUES ($1,$2,$3,$4,$5) RETURNING id, author_name, body, pinned, created_at',
      [id, actor.id ?? null, actor.name ?? actor.email ?? 'admin', body.trim(), pinned],
    );
    await this.audit.record(actor, {
      action: 'NOTE_ADDED', category: 'RESTAURANT', entityType: 'organization', entityId: id, entityLabel: org.name, organizationId: id,
      summary: `Added an internal note on ${org.name}`,
    });
    return row;
  }

  async setOutletActive(outletId: string, isActive: boolean, reason: string | undefined, actor: AuditActor) {
    const o = (await this.ds.query('SELECT id, name, is_active, organization_id FROM restaurants WHERE id = $1', [outletId]))[0];
    if (!o) throw new NotFoundException('Outlet not found');
    if (!isActive && !reason?.trim()) throw new BadRequestException('A reason is required to deactivate an outlet');
    await this.ds.query('UPDATE restaurants SET is_active = $2, updated_at = now() WHERE id = $1', [outletId, isActive]);
    await this.audit.record(actor, {
      action: isActive ? 'OUTLET_ACTIVATED' : 'OUTLET_DEACTIVATED', category: 'RESTAURANT', entityType: 'outlet', entityId: outletId, entityLabel: o.name, organizationId: o.organization_id,
      summary: `${isActive ? 'Activated' : 'Deactivated'} outlet ${o.name}`, changes: { isActive: { from: o.is_active, to: isActive } }, reason: reason?.trim() || null,
    });
    return { isActive };
  }

  // ── feature access per restaurant ─────────────────────────────────────────
  async setFeatureOverride(id: string, feature: string, mode: 'FORCE_ON' | 'FORCE_OFF' | 'DEFAULT', reason: string | undefined, actor: AuditActor) {
    const org = (await this.ds.query('SELECT id, name FROM organizations WHERE id = $1', [id]))[0];
    if (!org) throw new NotFoundException('Restaurant not found');
    const flag = (await this.ds.query('SELECT 1 FROM feature_flags WHERE feature_key = $1', [feature]))[0];
    if (!flag) throw new BadRequestException(`Unknown feature '${feature}'`);
    if (mode === 'DEFAULT') await this.ds.query('DELETE FROM org_feature_overrides WHERE organization_id = $1 AND feature_key = $2', [id, feature]);
    else {
      await this.ds.query(
        `INSERT INTO org_feature_overrides (organization_id, feature_key, mode, reason, set_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id, feature_key) DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, created_at = now()`,
        [id, feature, mode, reason ?? null, actor.name || actor.email || 'admin'],
      );
    }
    invalidateFeatureCache();
    await this.audit.record(actor, {
      action: 'FEATURE_OVERRIDE', category: 'SETTINGS', entityType: 'organization', entityId: id, entityLabel: org.name, organizationId: id,
      summary: `${feature} for ${org.name}: ${mode === 'DEFAULT' ? 'follow plan' : mode === 'FORCE_ON' ? 'forced on' : 'forced off'}`, reason: reason ?? null,
    });
    return { feature, mode };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrganizationSubscription } from '../subscriptions/entities/organization-subscription.entity.js';
import { SubscriptionPlan } from '../subscriptions/entities/subscription-plan.entity.js';
import { SubscriptionAuditLog } from '../subscriptions/entities/subscription-audit-log.entity.js';
import { SubscriptionStatus } from '../common/enums/index.js';
import { invalidateOrgAccess } from '../subscriptions/subscription-access.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { AuditActor, PlatformAuditService } from './audit.service.js';
import { getSetting } from './settings.service.js';

const DAY = 86_400_000;

/**
 * Status as the customer experiences it right now: a row can still say ACTIVE / TRIAL after its period ended
 * (it is only persisted lazily), so every list / count derives the real state with this expression.
 */
export function effectiveStatusSql(alias = 's'): string {
  const grace = Math.max(0, Math.floor(Number(getSetting<number>('subscription.gracePeriodDays') ?? 7)));
  return `(CASE
    WHEN ${alias}.status IN ('ACTIVE','TRIAL','PAST_DUE','GRACE_PERIOD') AND ${alias}.current_period_end < now()
      THEN (CASE WHEN now() < COALESCE(${alias}.grace_period_ends_at, ${alias}.current_period_end + interval '${grace} days') THEN 'GRACE_PERIOD' ELSE 'EXPIRED' END)
    ELSE ${alias}.status::text END)`;
}

/** Latest subscription row per organization. */
export const LATEST_SUB_SQL = `SELECT DISTINCT ON (organization_id) * FROM organization_subscriptions ORDER BY organization_id, created_at DESC`;

const monthly = (p: { basePrice: number; billingInterval: string }) => (p.billingInterval === 'YEARLY' ? Number(p.basePrice) / 12 : Number(p.basePrice));

@Injectable()
export class SubscriptionsAdminService {
  constructor(
    private readonly ds: DataSource,
    private readonly audit: PlatformAuditService,
    private readonly subs: SubscriptionsService,
  ) {}

  async list(q: { q?: string; status?: string; plan?: string; source?: string; sort?: string; order?: string; page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const eff = effectiveStatusSql('s');
    const params: unknown[] = [];
    const cond: string[] = [];
    if (q.q) { params.push(`%${q.q}%`); cond.push(`(o.name ILIKE $${params.length} OR ow.email ILIKE $${params.length})`); }
    if (q.status) { params.push(q.status); cond.push(`${eff} = $${params.length}`); }
    if (q.plan) { params.push(q.plan); cond.push(`p.code = $${params.length}`); }
    if (q.source) { params.push(q.source); cond.push(`s.source = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const sortCol: Record<string, string> = { name: 'o.name', end: 's.current_period_end', plan: 'p.name', status: 'effective_status', created: 's.created_at' };
    const order = `${sortCol[q.sort || 'end'] || 's.current_period_end'} ${q.order === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
    const base = `FROM (${LATEST_SUB_SQL}) s JOIN organizations o ON o.id = s.organization_id JOIN subscription_plans p ON p.id = s.plan_id
      LEFT JOIN LATERAL (SELECT email, name FROM staff WHERE organization_id = o.id AND role = 'SUPER_OWNER' ORDER BY created_at LIMIT 1) ow ON true ${where}`;
    const [rows, total, summary] = await Promise.all([
      this.ds.query(
        `SELECT s.id, s.organization_id, o.name AS organization_name, o.status AS account_status, ow.name AS owner_name, ow.email AS owner_email,
                p.code AS plan_code, p.name AS plan_name, p.base_price::float AS base_price, p.billing_interval,
                s.status AS stored_status, ${eff} AS effective_status, s.source, s.current_period_start, s.current_period_end, s.trial_ends_at,
                s.cancel_at_period_end, s.cancelled_at,
                CEIL(EXTRACT(EPOCH FROM (s.current_period_end - now())) / 86400)::int AS days_left,
                (SELECT MAX(paid_at) FROM subscription_invoices i WHERE i.organization_id = o.id AND i.status = 'PAID') AS last_paid_at
         ${base} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params,
      ),
      this.ds.query(`SELECT COUNT(*)::int AS n ${base}`, params),
      this.summary(),
    ]);
    return { items: rows, total: total[0].n, page, limit, summary };
  }

  /** Counts per effective status (one latest subscription per organization) plus orgs with none. */
  async summary() {
    const eff = effectiveStatusSql('s');
    const [by, none, expiring] = await Promise.all([
      this.ds.query(`SELECT ${eff} AS status, COUNT(*)::int AS n FROM (${LATEST_SUB_SQL}) s GROUP BY 1`),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM organization_subscriptions s WHERE s.organization_id = o.id)`),
      this.ds.query(
        `SELECT COUNT(*)::int AS n FROM (${LATEST_SUB_SQL}) s WHERE ${eff} IN ('ACTIVE','TRIAL') AND s.current_period_end < now() + interval '7 days'`,
      ),
    ]);
    const counts: Record<string, number> = {};
    for (const r of by) counts[r.status] = r.n;
    return { counts, withoutSubscription: none[0].n, expiringIn7Days: expiring[0].n };
  }

  async history(orgId: string) {
    const org = await this.ds.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
    if (!org[0]) throw new NotFoundException('Restaurant not found');
    const [subscriptions, events] = await Promise.all([
      this.ds.query(
        `SELECT s.*, p.code AS plan_code, p.name AS plan_name, ${effectiveStatusSql('s')} AS effective_status
         FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.organization_id = $1 ORDER BY s.created_at DESC`,
        [orgId],
      ),
      this.ds.query('SELECT id, action, actor, reason, metadata, created_at FROM subscription_audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100', [orgId]),
    ]);
    return { subscriptions, events };
  }

  private async load(orgId: string) {
    const org = (await this.ds.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]))[0];
    if (!org) throw new NotFoundException('Restaurant not found');
    const sub = await this.ds.getRepository(OrganizationSubscription).findOne({ where: { organizationId: orgId }, relations: { plan: true }, order: { createdAt: 'DESC' } });
    return { org, sub };
  }
  private async planBy(code: string): Promise<SubscriptionPlan> {
    const plan = await this.ds.getRepository(SubscriptionPlan).findOne({ where: { code } });
    if (!plan) throw new NotFoundException(`Plan '${code}' not found`);
    return plan;
  }
  private async log(orgId: string, action: string, actor: AuditActor, reason: string, metadata: unknown) {
    await this.ds.getRepository(SubscriptionAuditLog).save(
      this.ds.getRepository(SubscriptionAuditLog).create({ organizationId: orgId, action, actor: `ADMIN:${actor.email || actor.id || 'unknown'}`, reason, metadata: metadata as any }),
    );
  }
  private done(orgId: string) {
    invalidateOrgAccess(orgId);
  }

  /** Upgrade or downgrade immediately. A downgrade is refused if the restaurant is over the new plan's limits. */
  async changePlan(orgId: string, dto: { planCode: string; reason: string; keepPeriod?: boolean }, actor: AuditActor) {
    const { org, sub } = await this.load(orgId);
    if (!sub) throw new BadRequestException('This restaurant has no subscription yet. Start a trial or assign a plan first.');
    const plan = await this.planBy(dto.planCode);
    if (!plan.isActive) throw new BadRequestException('That plan is not active');
    if (plan.id === sub.planId) throw new BadRequestException('The restaurant is already on this plan');

    const usage = await this.usage(orgId);
    const over: string[] = [];
    if (plan.maxOutlets !== -1 && usage.outlets > plan.maxOutlets) over.push(`${usage.outlets} outlets (plan allows ${plan.maxOutlets})`);
    if (plan.maxTablesPerOutlet !== -1 && usage.maxTablesInAnOutlet > plan.maxTablesPerOutlet) over.push(`${usage.maxTablesInAnOutlet} tables in one outlet (plan allows ${plan.maxTablesPerOutlet})`);
    if (plan.maxStaffPerOutlet !== -1 && usage.maxStaffInAnOutlet > plan.maxStaffPerOutlet) over.push(`${usage.maxStaffInAnOutlet} staff in one outlet (plan allows ${plan.maxStaffPerOutlet})`);
    if (over.length) throw new BadRequestException(`Cannot move to ${plan.name}: the restaurant currently has ${over.join(', ')}. Reduce usage first.`);

    const direction = monthly(plan) > monthly(sub.plan) ? 'UPGRADE' : monthly(plan) < monthly(sub.plan) ? 'DOWNGRADE' : 'CHANGE';
    const from = sub.plan.code;
    sub.planId = plan.id;
    sub.plan = plan;
    sub.assignedBy = actor.email || null;
    if (sub.source !== 'GATEWAY') sub.source = 'MANUAL';
    await this.ds.getRepository(OrganizationSubscription).save(sub);
    this.done(orgId);
    await this.log(orgId, `PLAN_${direction}`, actor, dto.reason, { from, to: plan.code });
    await this.audit.record(actor, {
      action: `SUBSCRIPTION_${direction}`, category: 'SUBSCRIPTION', entityType: 'organization', entityId: orgId, entityLabel: org.name, organizationId: orgId,
      summary: `${direction === 'UPGRADE' ? 'Upgraded' : direction === 'DOWNGRADE' ? 'Downgraded' : 'Changed'} ${org.name} from ${from} to ${plan.code}`,
      changes: { plan: { from, to: plan.code } }, reason: dto.reason,
    });
    return { direction, plan: plan.code };
  }

  /** Add days to the current period (restores access if it had lapsed). */
  async extend(orgId: string, dto: { days: number; reason: string }, actor: AuditActor) {
    const { org, sub } = await this.load(orgId);
    if (!sub) throw new BadRequestException('This restaurant has no subscription to extend');
    const now = new Date();
    const endBefore = new Date(sub.currentPeriodEnd);
    const base = endBefore > now ? endBefore : now;
    const end = new Date(base.getTime() + dto.days * DAY);
    const wasStatus = sub.status;
    sub.currentPeriodEnd = end;
    if (sub.status === SubscriptionStatus.TRIAL) sub.trialEndsAt = end;
    else if (sub.status !== SubscriptionStatus.ACTIVE) sub.status = SubscriptionStatus.ACTIVE;
    if (endBefore < now) sub.currentPeriodStart = now;
    sub.gracePeriodEndsAt = null;
    sub.cancelAtPeriodEnd = false;
    sub.cancelledAt = null;
    await this.ds.getRepository(OrganizationSubscription).save(sub);
    this.done(orgId);
    await this.log(orgId, 'SUBSCRIPTION_EXTENDED', actor, dto.reason, { days: dto.days, from: endBefore, to: end });
    await this.audit.record(actor, {
      action: 'SUBSCRIPTION_EXTENDED', category: 'SUBSCRIPTION', entityType: 'organization', entityId: orgId, entityLabel: org.name, organizationId: orgId,
      summary: `Extended ${org.name} by ${dto.days} day(s) until ${end.toISOString().slice(0, 10)}`,
      changes: { periodEnd: { from: endBefore, to: end }, status: { from: wasStatus, to: sub.status } }, reason: dto.reason,
    });
    return { currentPeriodEnd: end, status: sub.status };
  }

  async cancel(orgId: string, dto: { immediate?: boolean; reason: string }, actor: AuditActor) {
    const { org, sub } = await this.load(orgId);
    if (!sub) throw new BadRequestException('This restaurant has no subscription');
    if ([SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED].includes(sub.status) && dto.immediate) throw new BadRequestException('This subscription has already ended');
    if (dto.immediate) {
      sub.status = SubscriptionStatus.CANCELLED;
      sub.currentPeriodEnd = new Date();
      sub.cancelledAt = new Date();
      sub.gracePeriodEndsAt = new Date();
    } else {
      sub.cancelAtPeriodEnd = true;
    }
    sub.cancelReason = dto.reason;
    await this.ds.getRepository(OrganizationSubscription).save(sub);
    this.done(orgId);
    const action = dto.immediate ? 'SUBSCRIPTION_CANCELLED_NOW' : 'SUBSCRIPTION_CANCEL_SCHEDULED';
    await this.log(orgId, action, actor, dto.reason, { immediate: !!dto.immediate });
    await this.audit.record(actor, {
      action, category: 'SUBSCRIPTION', entityType: 'organization', entityId: orgId, entityLabel: org.name, organizationId: orgId,
      summary: dto.immediate ? `Cancelled ${org.name}'s subscription immediately` : `Scheduled ${org.name}'s subscription to end at period end`, reason: dto.reason,
    });
    return { status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd };
  }

  /** Undo a scheduled cancellation, or bring an expired / cancelled restaurant back for N days. */
  async reactivate(orgId: string, dto: { planCode?: string; days: number; reason: string }, actor: AuditActor) {
    const { org, sub } = await this.load(orgId);
    if (!sub) throw new BadRequestException('This restaurant has no subscription');
    const plan = dto.planCode ? await this.planBy(dto.planCode) : sub.plan;
    const now = new Date();
    sub.planId = plan.id;
    sub.plan = plan;
    sub.status = SubscriptionStatus.ACTIVE;
    sub.source = 'MANUAL';
    sub.assignedBy = actor.email || null;
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = new Date(now.getTime() + dto.days * DAY);
    sub.trialEndsAt = null;
    sub.gracePeriodEndsAt = null;
    sub.cancelAtPeriodEnd = false;
    sub.cancelledAt = null;
    sub.cancelReason = null;
    await this.ds.getRepository(OrganizationSubscription).save(sub);
    this.done(orgId);
    await this.log(orgId, 'SUBSCRIPTION_REACTIVATED', actor, dto.reason, { plan: plan.code, days: dto.days });
    await this.audit.record(actor, {
      action: 'SUBSCRIPTION_REACTIVATED', category: 'SUBSCRIPTION', entityType: 'organization', entityId: orgId, entityLabel: org.name, organizationId: orgId,
      summary: `Reactivated ${org.name} on ${plan.code} for ${dto.days} day(s) (manual grant, no payment recorded)`, reason: dto.reason,
    });
    return { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd };
  }

  /** Begin a (new) trial with a custom length. */
  async startTrial(orgId: string, dto: { planCode: string; days: number; reason: string }, actor: AuditActor) {
    const { org } = await this.load(orgId);
    await this.planBy(dto.planCode);
    const sub = await this.subs.startTrial(orgId, dto.planCode, dto.days, 'TRIAL', actor.email || undefined);
    await this.audit.record(actor, {
      action: 'TRIAL_STARTED', category: 'SUBSCRIPTION', entityType: 'organization', entityId: orgId, entityLabel: org.name, organizationId: orgId,
      summary: `Started a ${dto.days}-day trial on ${dto.planCode} for ${org.name}`, reason: dto.reason,
    });
    return { status: sub.status, trialEndsAt: sub.trialEndsAt };
  }

  /** Manual grant for N months (existing behaviour) now with mandatory reason, source tag and platform audit. */
  async assign(orgId: string, dto: { planCode: string; months: number; note: string }, actor: AuditActor) {
    const { org } = await this.load(orgId);
    const sub: any = await this.subs.adminAssignPlan(orgId, { planCode: dto.planCode, months: dto.months, note: dto.note }, { id: actor.id ?? undefined, email: actor.email ?? undefined });
    await this.ds.query(`UPDATE organization_subscriptions SET source = 'MANUAL', assigned_by = $2 WHERE id = $1`, [sub.id, actor.email || null]);
    this.done(orgId);
    await this.audit.record(actor, {
      action: 'SUBSCRIPTION_ASSIGNED', category: 'SUBSCRIPTION', entityType: 'organization', entityId: orgId, entityLabel: org.name, organizationId: orgId,
      summary: `Granted ${org.name} ${dto.planCode} for ${dto.months} month(s) (manual grant, no payment recorded)`, reason: dto.note,
    });
    return sub;
  }

  async usage(orgId: string) {
    const [o, t, s] = await Promise.all([
      this.ds.query('SELECT COUNT(*)::int AS n FROM restaurants WHERE organization_id = $1', [orgId]),
      this.ds.query(
        `SELECT COALESCE(MAX(c),0)::int AS n FROM (SELECT COUNT(*) c FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE r.organization_id = $1 GROUP BY r.id) x`,
        [orgId],
      ),
      this.ds.query(
        `SELECT COALESCE(MAX(c),0)::int AS n FROM (SELECT COUNT(*) c FROM staff st JOIN restaurants r ON r.id = st.restaurant_id
          WHERE r.organization_id = $1 AND st.is_active = true GROUP BY r.id) x`,
        [orgId],
      ),
    ]);
    return { outlets: o[0].n, maxTablesInAnOutlet: t[0].n, maxStaffInAnOutlet: s[0].n };
  }

  /** Plans with how many restaurants are on each (current effective status). */
  async plansWithUsage() {
    const plans = await this.subs.findAllPlans(true);
    const rows = await this.ds.query(
      `SELECT p.id AS plan_id, ${effectiveStatusSql('s')} AS status, COUNT(*)::int AS n FROM (${LATEST_SUB_SQL}) s JOIN subscription_plans p ON p.id = s.plan_id GROUP BY 1,2`,
    );
    return plans.map((p: any) => {
      const mine = rows.filter((r: any) => r.plan_id === p.id);
      const by: Record<string, number> = {};
      for (const r of mine) by[r.status] = r.n;
      return { ...p, subscribers: { total: mine.reduce((a: number, r: any) => a + r.n, 0), byStatus: by } };
    });
  }
}

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
import { TRIAL_PLAN_CODE, planFamilyOf, planGroupOf } from '../subscriptions/default-plans.js';

const DAY = 86_400_000;

/**
 * Status as the customer experiences it right now: a row can still say ACTIVE / TRIAL after its period ended
 * (it is only persisted lazily), so every list / count derives the real state with this expression.
 */
export function effectiveStatusSql(alias = 's'): string {
  const grace = Math.max(0, Math.floor(Number(getSetting<number>('subscription.gracePeriodDays') ?? 7)));
  const live = `${alias}.status IN ('ACTIVE','TRIAL','PAST_DUE','GRACE_PERIOD')`;
  const graceEnd = `COALESCE(${alias}.grace_period_ends_at, ${alias}.current_period_end + interval '${grace} days')`;
  // SQL twin of subscription-access.ts `derivedStatus` (same rules, for list/count queries). A live test compares the two.
  return `(CASE
    WHEN ${live} AND ${alias}.status IN ('PAST_DUE','GRACE_PERIOD') AND ${alias}.grace_period_ends_at IS NOT NULL AND ${alias}.grace_period_ends_at <= now() THEN 'EXPIRED'
    WHEN ${live} AND ${alias}.current_period_end < now() AND COALESCE(${alias}.cancel_at_period_end, false) THEN 'EXPIRED'
    WHEN ${live} AND ${alias}.current_period_end < now() THEN (CASE WHEN now() < ${graceEnd} THEN 'GRACE_PERIOD' ELSE 'EXPIRED' END)
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
        // seats only: not the kitchen-station system account, the owner or platform administrators (see subscriptions/capacity.ts)
        `SELECT COALESCE(MAX(c),0)::int AS n FROM (SELECT COUNT(*) c FROM staff st JOIN restaurants r ON r.id = st.restaurant_id
          WHERE r.organization_id = $1 AND st.is_active = true AND st.is_platform_admin = false
            AND st.role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN') AND LOWER(st.email) NOT LIKE '%@stations.pangat.app' GROUP BY r.id) x`,
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
    const ever = await this.ds.query(`SELECT plan_id, COUNT(DISTINCT organization_id)::int AS n FROM organization_subscriptions GROUP BY 1`);
    return Promise.all(
      plans.map(async (p: any) => {
        const mine = rows.filter((r: any) => r.plan_id === p.id);
        const by: Record<string, number> = {};
        for (const r of mine) by[r.status] = r.n;
        const total = mine.reduce((a: number, r: any) => a + r.n, 0);
        // a plan nobody is on cannot have anybody over its limits: skip the query
        const overLimit = total > 0 ? (await this.subs.organisationsOverPlanLimits(p.id)).length : 0;
        return {
          ...p,
          group: planGroupOf(p.code),
          family: planFamilyOf(p.code),
          everSubscribed: ever.find((e: any) => e.plan_id === p.id)?.n ?? 0,
          overLimitCount: overLimit,
          subscribers: { total, byStatus: by },
        };
      }),
    );
  }

  /** The trial as configured right now (platform settings + the trial plan row), so the console can show what a new restaurant gets. */
  async trialConfiguration() {
    const code = String(getSetting('subscription.defaultTrialPlanCode') || TRIAL_PLAN_CODE);
    const plan = await this.ds.query(`SELECT code, name, trial_days, max_outlets, max_tables_per_outlet, max_staff_per_outlet, features, is_public, is_active FROM subscription_plans WHERE code = $1`, [code]);
    return {
      planCode: code,
      graceDays: Number(getSetting('subscription.gracePeriodDays') ?? 7),
      reminderDays: Number(getSetting('subscription.trialReminderDays') ?? 3),
      defaultTrialDays: Number(getSetting('subscription.defaultTrialDays') ?? 14),
      plan: plan[0] ?? null,
      planFound: Boolean(plan[0]),
    };
  }

  /**
   * Restaurants that are close to (>= 80%) or over a limit of the plan they are on. Over a limit is not an error: nothing is
   * ever deleted, they just cannot add more until they are within it. Shown so a founder can talk to them before they hit a wall.
   */
  async capacityWatch() {
    const rows = await this.ds.query(
      `WITH latest AS (${LATEST_SUB_SQL}),
            usage AS (
              SELECT l.organization_id, p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
                     p.max_outlets, p.max_tables_per_outlet, p.max_staff_per_outlet,
                     (SELECT COUNT(*) FROM restaurants r WHERE r.organization_id = l.organization_id)::int AS outlets,
                     COALESCE((SELECT MAX(c) FROM (SELECT COUNT(*) c FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE r.organization_id = l.organization_id GROUP BY r.id) x),0)::int AS tables_peak,
                     COALESCE((SELECT MAX(c) FROM (SELECT COUNT(*) c FROM staff st JOIN restaurants r ON r.id = st.restaurant_id
                               WHERE r.organization_id = l.organization_id AND st.is_active AND NOT st.is_platform_admin
                                 AND st.role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN') AND LOWER(st.email) NOT LIKE '%@stations.pangat.app' GROUP BY r.id) x),0)::int AS staff_peak
              FROM latest l JOIN subscription_plans p ON p.id = l.plan_id)
       SELECT u.*, o.name AS organization_name
       FROM usage u JOIN organizations o ON o.id = u.organization_id
       WHERE (u.max_outlets > 1 AND u.outlets >= 0.8 * u.max_outlets) OR (u.max_outlets > 0 AND u.outlets > u.max_outlets)
          OR (u.max_tables_per_outlet > 0 AND u.tables_peak >= 0.8 * u.max_tables_per_outlet)
          OR (u.max_staff_per_outlet > 0 AND u.staff_peak >= 0.8 * u.max_staff_per_outlet)
       ORDER BY o.name LIMIT 200`,
    );
    return rows.map((r: any) => {
      const kinds = [
        ['Outlets', r.outlets, r.max_outlets],
        ['Tables (busiest outlet)', r.tables_peak, r.max_tables_per_outlet],
        ['Staff (busiest outlet)', r.staff_peak, r.max_staff_per_outlet],
      ] as const;
      // A single-outlet plan with its one outlet is normal, not a warning: outlets flag only when the plan allows several (>= 80%) or when over the limit
      const flags = kinds
        .filter(([label, used, limit]) => Number(limit) > 0 && (Number(used) > Number(limit) || (Number(used) >= 0.8 * Number(limit) && (label !== 'Outlets' || Number(limit) > 1))))
        .map(([label, used, limit]) => ({ label, used: Number(used), limit: Number(limit), over: Number(used) > Number(limit) }));
      return { organizationId: r.organization_id, organizationName: r.organization_name, planCode: r.plan_code, planName: r.plan_name, flags, over: flags.some((f) => f.over) };
    });
  }

  /** The Founding 10 programme: who is on a FOUNDING_* plan, and how many of the ten places are taken. Read-only; nothing is ever granted from here. */
  async foundingGrants() {
    const rows = await this.ds.query(
      `SELECT o.id AS organization_id, o.name AS organization_name, p.code AS plan_code, p.name AS plan_name, p.base_price::float AS base_price, p.billing_interval,
              ${effectiveStatusSql('s')} AS status, s.source, s.assigned_by, s.created_at AS assigned_at, s.current_period_start, s.current_period_end
       FROM (${LATEST_SUB_SQL}) s JOIN subscription_plans p ON p.id = s.plan_id JOIN organizations o ON o.id = s.organization_id
       WHERE p.code LIKE 'FOUNDING\\_%' ESCAPE '\\' ORDER BY s.created_at`,
    );
    return { slotsTotal: 10, slotsUsed: rows.length, grants: rows };
  }
}

import { DataSource, EntityManager } from 'typeorm';
import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { OrganizationSubscription } from './entities/organization-subscription.entity.js';
import { SubscriptionPlan } from './entities/subscription-plan.entity.js';
import { SubscriptionStatus } from '../common/enums/index.js';

import { getSetting } from '../platform/settings.service.js';
import { getOrgLifecycle } from '../platform/org-status.js';
import { resolveFeatureAccess } from '../platform/features.js';
import { notifyEntitlementChange } from './entitlement-events.js';

const graceDays = () => Number(getSetting<number>('subscription.gracePeriodDays') ?? 7);
const TTL_MS = 20_000;
const cache = new Map<string, { at: number; blocked: boolean; reason: string | null }>();

export interface OrgAccess {
  blocked: boolean;
  reason: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature catalogue: what each plan feature key means TODAY.
//   available=false means nothing in the product sits behind the key, so it must not be sold or advertised.
// ─────────────────────────────────────────────────────────────────────────────
export interface FeatureInfo {
  label: string;
  available: boolean;
  /** Where the backend enforces it (documentation; the tests assert these routes) */
  enforcedAt: string[];
  note?: string;
}
export const FEATURE_CATALOG: Record<string, FeatureInfo> = {
  QR_ORDERING: { label: 'QR table ordering', available: true, enforcedAt: ['POST /orders (guest order)', 'GET /menu/public/:slug (ordering flag)'] },
  KDS: { label: 'Live kitchen display', available: true, enforcedAt: ['POST /auth/kds-pin-login', 'socket join:kds', 'kitchen-role (CHEF) order feed and status calls'] },
  INVENTORY: { label: 'Inventory & recipes', available: true, enforcedAt: ['/inventory/*'] },
  ANALYTICS: { label: 'Sales analytics', available: true, enforcedAt: ['/reports/*'] },
  MULTI_OUTLET: { label: 'Multi-outlet management', available: true, enforcedAt: ['POST /organizations/outlets (second and later outlet)'] },
  ADVANCED_REPORTS: { label: 'Advanced reports', available: false, enforcedAt: [], note: 'Not built: no report or export sits behind this key. It is hidden from plan listings and cannot be added to a plan.' },
};
export const isFeatureAvailable = (key: string) => FEATURE_CATALOG[key]?.available === true;
/** What may be shown to customers: only features that really exist. A '*' wildcard means "every available feature". */
export function advertisedFeatures(features: unknown): string[] {
  const list = Array.isArray(features) ? (features as string[]) : String(features || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return Object.keys(FEATURE_CATALOG).filter(isFeatureAvailable);
  return list.filter(isFeatureAvailable);
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription state: ONE implementation of "is this subscription usable?" (guards, services, sweeps and tests all call these)
// ─────────────────────────────────────────────────────────────────────────────
type SubLike = {
  status: string;
  currentPeriodEnd: Date | string | null;
  gracePeriodEndsAt?: Date | string | null;
  cancelAtPeriodEnd?: boolean;
};

/** The moment the grace window closes for a subscription whose period has ended. */
export function graceEndOf(sub: SubLike, days = graceDays()): Date | null {
  if (sub.gracePeriodEndsAt) return new Date(sub.gracePeriodEndsAt);
  if (!sub.currentPeriodEnd) return null;
  return new Date(new Date(sub.currentPeriodEnd).getTime() + days * 86_400_000);
}

/**
 * The status this subscription SHOULD have right now. Pure: it never writes. The hourly sweep persists the result,
 * and every request-time decision (evaluateAccess, EntitlementService) is derived from the same function, so the two cannot disagree.
 *   TRIAL / ACTIVE / PAST_DUE / GRACE_PERIOD whose period has ended -> GRACE_PERIOD until the grace window closes, then EXPIRED
 *   ... unless the owner turned renewal off (cancelAtPeriodEnd): there is no grace, it is EXPIRED the moment the period ends
 *   GRACE_PERIOD / PAST_DUE whose own grace window (set by the payment gateway) has closed -> EXPIRED even if the period end is later
 *   CANCELLED, HALTED, EXPIRED -> unchanged
 */
export function derivedStatus(sub: SubLike, now = new Date()): string {
  const st = sub.status;
  if (![SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE, SubscriptionStatus.GRACE_PERIOD].includes(st as SubscriptionStatus)) return st;
  const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const graceEnd = graceEndOf(sub);
  const inGraceStatus = st === SubscriptionStatus.GRACE_PERIOD || st === SubscriptionStatus.PAST_DUE;
  if (inGraceStatus && sub.gracePeriodEndsAt && now.getTime() >= new Date(sub.gracePeriodEndsAt).getTime()) return SubscriptionStatus.EXPIRED;
  if (end && end.getTime() < now.getTime()) {
    if (sub.cancelAtPeriodEnd) return SubscriptionStatus.EXPIRED;
    if (graceEnd && now.getTime() < graceEnd.getTime()) return SubscriptionStatus.GRACE_PERIOD;
    return SubscriptionStatus.EXPIRED;
  }
  return st;
}

/** Pure decision used by guards and tests: is this subscription past its paid / trial / grace window? */
export function evaluateAccess(sub: SubLike | null, now = new Date()): OrgAccess {
  if (!sub) return { blocked: false, reason: null };
  const cancelledMsg = 'Your subscription was cancelled and its paid period has ended. Choose a plan to continue.';
  if (sub.status === SubscriptionStatus.EXPIRED || sub.status === SubscriptionStatus.HALTED) {
    return { blocked: true, reason: 'Your subscription has expired. Renew your plan to continue.' };
  }
  if (derivedStatus(sub, now) === SubscriptionStatus.EXPIRED) {
    return { blocked: true, reason: sub.status === SubscriptionStatus.CANCELLED || sub.cancelAtPeriodEnd ? cancelledMsg : 'Your trial or billing period has ended. Renew your plan to continue.' };
  }
  if (sub.status === SubscriptionStatus.CANCELLED) {
    // Cancelled keeps working until the paid period it already bought runs out, with no grace window
    const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
    if (!end || end.getTime() < now.getTime()) return { blocked: true, reason: cancelledMsg };
  }
  return { blocked: false, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan limits (outlets, tables per outlet, staff seats per outlet). -1 means unlimited.
// ─────────────────────────────────────────────────────────────────────────────
export type LimitKind = 'outlets' | 'tables' | 'staff';
export interface LimitDecision { kind: LimitKind; limit: number; current: number; adding: number; allowed: boolean; remaining: number | null }

export function limitFor(plan: { maxOutlets?: number | null; maxTablesPerOutlet?: number | null; maxStaffPerOutlet?: number | null } | null, kind: LimitKind): number {
  if (!plan) return 0; // no plan, no capacity
  const v = kind === 'outlets' ? plan.maxOutlets : kind === 'tables' ? plan.maxTablesPerOutlet : plan.maxStaffPerOutlet;
  if (v === null || v === undefined) return kind === 'staff' ? -1 : 0; // staff limit predates the column: unset means unlimited
  return Number(v);
}
export function evaluateLimit(plan: Parameters<typeof limitFor>[0], kind: LimitKind, current: number, adding = 1): LimitDecision {
  const limit = limitFor(plan, kind);
  if (limit === -1) return { kind, limit, current, adding, allowed: true, remaining: null };
  return { kind, limit, current, adding, allowed: current + adding <= limit, remaining: Math.max(0, limit - current) };
}
const LIMIT_WORDS: Record<LimitKind, { one: string; per: string }> = {
  outlets: { one: 'outlet', per: 'outlets' },
  tables: { one: 'table', per: 'tables per outlet' },
  staff: { one: 'staff seat', per: 'staff seats per outlet' },
};
/** One error shape for every limit: HTTP 403 + code PLAN_LIMIT_REACHED + the numbers, so the UI can explain it and offer an upgrade. */
export function planLimitError(d: LimitDecision) {
  const w = LIMIT_WORDS[d.kind];
  const over = d.current > d.limit;
  const msg =
    d.adding > 1
      ? `Your plan allows ${d.limit} ${w.per}; you have ${d.current} and asked for ${d.adding} more. Upgrade your plan to add more.`
      : over
        ? `Plan limit reached: you are already over the ${d.limit} ${w.per} your plan allows (${d.current}). Upgrade your plan or remove some to add more.`
        : `Plan limit reached (${d.limit} ${w.per}). Upgrade your plan to add more.`;
  return new HttpException(
    { message: msg, code: 'PLAN_LIMIT_REACHED', details: { limitKind: d.kind, limit: d.limit, current: d.current, requested: d.adding } },
    HttpStatus.FORBIDDEN,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Super Admin limit override: explicit, permissioned, reasoned and audited. Never implied.
// ─────────────────────────────────────────────────────────────────────────────
export interface LimitOverride { reason: string; actorId?: string; actorEmail?: string; actorName?: string }
export function authoriseLimitOverride(user: any, reason?: string | null): LimitOverride | null {
  const r = (reason ?? '').trim();
  if (!r) return null;
  const isPlatform = user?.isPlatformAdmin === true || user?.role === 'PLATFORM_SUPER_ADMIN';
  const perms: string[] = user?.platformPermissions || [];
  if (!isPlatform || !perms.includes('subscriptions.manage')) {
    throw new ForbiddenException({ message: 'Only a platform administrator with the "subscriptions.manage" permission can override a plan limit.', code: 'LIMIT_OVERRIDE_FORBIDDEN' });
  }
  if (r.length < 10) {
    throw new HttpException({ message: 'A limit override needs a reason of at least 10 characters (it is recorded in the audit trail).', code: 'LIMIT_OVERRIDE_REASON_REQUIRED' }, HttpStatus.BAD_REQUEST);
  }
  return { reason: r.slice(0, 500), actorId: user.id, actorEmail: user.email, actorName: user.name };
}
/** Writes the override to the organisation's subscription audit trail (same transaction as the change when `q` is a manager/runner). */
export async function recordLimitOverride(
  q: { query: (sql: string, params?: any[]) => Promise<any> },
  o: { organizationId: string; override: LimitOverride; decision: LimitDecision; restaurantId?: string | null; context?: string },
) {
  await q.query(
    `INSERT INTO subscription_audit_logs (organization_id, action, actor, reason, metadata) VALUES ($1,'PLAN_LIMIT_OVERRIDDEN',$2,$3,$4::jsonb)`,
    [
      o.organizationId,
      `ADMIN:${o.override.actorEmail || o.override.actorId || 'unknown'}`.slice(0, 100),
      o.override.reason,
      JSON.stringify({ kind: o.decision.kind, limit: o.decision.limit, current: o.decision.current, adding: o.decision.adding, restaurantId: o.restaurantId ?? null, context: o.context ?? null }),
    ],
  );
  // ...and in the platform audit log (the console's Audit log page), so an exception is visible where operators look for them
  await q.query(
    `INSERT INTO platform_audit_logs (actor_id, actor_name, actor_email, actor_role, action, category, entity_type, entity_id, organization_id, summary, changes, reason)
     VALUES ($1,$2,$3,'PLATFORM_SUPER_ADMIN','PLAN_LIMIT_OVERRIDDEN','SUBSCRIPTION','organization',$4::varchar,$5::uuid,$6,$7::jsonb,$8)`,
    [
      o.override.actorId ?? null, o.override.actorName ?? null, o.override.actorEmail ?? null, o.organizationId, o.organizationId,
      `Exceeded the plan's ${o.decision.kind} limit (${o.decision.current} in use + ${o.decision.adding} requested, limit ${o.decision.limit}) via ${o.context ?? 'a limit override'}`,
      JSON.stringify({ kind: o.decision.kind, limit: o.decision.limit, current: o.decision.current, adding: o.decision.adding, restaurantId: o.restaurantId ?? null }),
      o.override.reason,
    ],
  );
}

/**
 * Subscription state for an organization. Organizations that predate billing get a fresh trial the first
 * time they are checked (so nobody is locked out by the rollout, and nobody stays free forever).
 */
export async function getOrgAccess(dataSource: DataSource, organizationId: string): Promise<OrgAccess> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return { blocked: hit.blocked, reason: hit.reason };

  // A suspended / deactivated restaurant is closed regardless of its subscription
  const life = await getOrgLifecycle(dataSource, organizationId);
  if (life.status !== 'ACTIVE') {
    const closed = { blocked: true, reason: life.status === 'SUSPENDED' ? 'This restaurant account is suspended. Contact Pangat support.' : 'This restaurant account has been deactivated.' };
    cache.set(organizationId, { at: Date.now(), ...closed });
    return closed;
  }

  const subRepo = dataSource.getRepository(OrganizationSubscription);
  const sub = (await subRepo.findOne({ where: { organizationId }, order: { createdAt: 'DESC' } })) ?? (await ensureTrial(dataSource, organizationId));
  const access = evaluateAccess(sub);
  cache.set(organizationId, { at: Date.now(), ...access });
  return access;
}

/** Call after any subscription change so the new state applies immediately. */
export function invalidateOrgAccess(organizationId: string) {
  cache.delete(organizationId);
  notifyEntitlementChange(organizationId); // live kitchen connections are re-checked at once
}

export function subscriptionBlockedError(reason: string) {
  return new HttpException({ message: reason, code: 'SUBSCRIPTION_INACTIVE' }, HttpStatus.PAYMENT_REQUIRED);
}

/** The plan an organization is currently on (null if it has none yet). */
export async function getOrgPlan(dataSource: DataSource, organizationId: string): Promise<SubscriptionPlan | null> {
  await getOrgAccess(dataSource, organizationId); // makes sure a trial exists for legacy organizations
  const sub = await dataSource
    .getRepository(OrganizationSubscription)
    .findOne({ where: { organizationId }, relations: { plan: true }, order: { createdAt: 'DESC' } });
  return sub?.plan ?? null;
}

export function planHasFeature(plan: { features: unknown } | null, feature: string): boolean {
  if (!plan) return false;
  const list = Array.isArray(plan.features) ? (plan.features as string[]) : String(plan.features || '').split(',').map((s) => s.trim());
  return list.includes(feature) || list.includes('*');
}

/**
 * Make sure an organization has a subscription row: starts a trial (plan and length come from platform settings / the plan)
 * if it has none. Called at sign-up / provisioning, by the daily sweep, and lazily on first access for legacy organizations.
 */
export async function ensureTrial(dataSource: DataSource, organizationId: string, actor = 'SYSTEM'): Promise<OrganizationSubscription | null> {
  const subRepo = dataSource.getRepository(OrganizationSubscription);
  const existing = await subRepo.findOne({ where: { organizationId }, order: { createdAt: 'DESC' } });
  if (existing) return existing;
  const plan = await resolveTrialPlan(dataSource);
  if (!plan) return null;
  const now = new Date();
  const trialDays = Number(plan.trialDays ?? getSetting<number>('subscription.defaultTrialDays') ?? 14);
  const end = new Date(now.getTime() + trialDays * 86_400_000);
  const sub = await subRepo.save(
    subRepo.create({
      organizationId,
      planId: plan.id,
      status: SubscriptionStatus.TRIAL,
      currentPeriodStart: now,
      currentPeriodEnd: end,
      trialEndsAt: end,
      gracePeriodEndsAt: null,
      cancelAtPeriodEnd: false,
      source: 'TRIAL',
      assignedBy: actor,
    }),
  );
  invalidateOrgAccess(organizationId);
  return sub;
}

/** The plan a brand-new organisation starts its trial on (platform setting, else the cheapest active plan). Used by sign-up checks AND ensureTrial. */
export async function resolveTrialPlan(dataSource: DataSource): Promise<SubscriptionPlan | null> {
  const plans = dataSource.getRepository(SubscriptionPlan);
  return (
    (await plans.findOne({ where: { code: String(getSetting('subscription.defaultTrialPlanCode') || 'GROWTH'), isActive: true } })) ??
    (await plans.findOne({ where: { isActive: true }, order: { basePrice: 'ASC' } }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature decisions: plan + platform kill switch + per-organisation override, in ONE place
// ─────────────────────────────────────────────────────────────────────────────
export type FeatureDecision = { allowed: boolean; reason: 'OK' | 'PLAN' | 'DISABLED' | 'OVERRIDE_OFF' | 'OVERRIDE_ON' | 'NOT_AVAILABLE' };

export async function decideFeature(dataSource: DataSource, organizationId: string, feature: string): Promise<FeatureDecision> {
  const plan = await getOrgPlan(dataSource, organizationId);
  return resolveFeatureAccess(dataSource, organizationId, feature, planHasFeature(plan, feature));
}
/** Error for a refused feature: 402 when the PLAN lacks it (upgrade), 403 when it is switched off for the account or platform. */
export function featureError(feature: string, reason: FeatureDecision['reason']) {
  // the human name of the feature ("live kitchen display"), not its code ("kds")
  const label = (FEATURE_CATALOG[feature]?.label ?? feature.replace(/_/g, ' ')).toLowerCase();
  return new HttpException(
    reason === 'PLAN'
      ? { message: `Your current plan does not include ${label}. Upgrade to unlock it.`, code: 'FEATURE_NOT_IN_PLAN', details: { feature } }
      : { message: `${label.charAt(0).toUpperCase()}${label.slice(1)} is currently unavailable for your account.`, code: 'FEATURE_DISABLED', details: { feature } },
    reason === 'PLAN' ? HttpStatus.PAYMENT_REQUIRED : HttpStatus.FORBIDDEN,
  );
}
export async function assertFeature(dataSource: DataSource, organizationId: string, feature: string): Promise<void> {
  const d = await decideFeature(dataSource, organizationId, feature);
  if (!d.allowed) throw featureError(feature, d.reason);
}

export interface Entitlements {
  organizationId: string;
  plan: { id: string; code: string; name: string } | null;
  status: string;
  access: OrgAccess;
  /** Every KNOWN feature key with the final decision (plan, kill switch, override) */
  features: Record<string, { allowed: boolean; reason: string; available: boolean; label: string }>;
  limits: { maxOutlets: number; maxTablesPerOutlet: number; maxStaffPerOutlet: number };
}
/** The one read model of "what may this organisation do": the web console renders from it, nothing in the web hardcodes a plan. */
export async function getEntitlements(dataSource: DataSource, organizationId: string): Promise<Entitlements> {
  const access = await getOrgAccess(dataSource, organizationId); // also guarantees a trial exists for legacy organisations
  const sub = await dataSource.getRepository(OrganizationSubscription).findOne({ where: { organizationId }, relations: { plan: true }, order: { createdAt: 'DESC' } });
  const plan = sub?.plan ?? null;
  const features: Entitlements['features'] = {};
  for (const [key, info] of Object.entries(FEATURE_CATALOG)) {
    if (!info.available) {
      features[key] = { allowed: false, reason: 'NOT_AVAILABLE', available: false, label: info.label };
      continue;
    }
    const d = await resolveFeatureAccess(dataSource, organizationId, key, planHasFeature(plan, key));
    features[key] = { allowed: d.allowed, reason: d.reason, available: true, label: info.label };
  }
  return {
    organizationId,
    plan: plan ? { id: plan.id, code: plan.code, name: plan.name } : null,
    status: sub ? derivedStatus(sub) : 'NONE',
    access,
    features,
    limits: { maxOutlets: limitFor(plan, 'outlets'), maxTablesPerOutlet: limitFor(plan, 'tables'), maxStaffPerOutlet: limitFor(plan, 'staff') },
  };
}

/**
 * Serialise concurrent changes that share a limit: hold this row lock for the rest of the transaction before counting.
 * FOR NO KEY UPDATE (not FOR UPDATE) on purpose: it queues against other capacity checks and against UPDATEs of the row,
 * but NOT against the foreign-key checks (FOR KEY SHARE) that every insert of an order, audit row, table or staff row takes on
 * its parent. FOR UPDATE conflicted with those and produced deadlocks under mixed load (found in Phase 1.1 verification).
 */
export async function lockRow(em: EntityManager, table: 'restaurants' | 'organizations', id: string): Promise<void> {
  await em.query(`SELECT id FROM ${table} WHERE id = $1 FOR NO KEY UPDATE`, [id]);
}

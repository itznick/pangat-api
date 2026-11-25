// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/capacity.ts
//
// Plan capacity (tables per outlet, staff seats per outlet, outlets) checked INSIDE the transaction that makes the change.
//
// Concurrency: every check first takes a row lock (`SELECT ... FOR UPDATE`) on the thing that owns the limit
//   - tables and staff seats -> the outlet's `restaurants` row
//   - outlets                -> the `organizations` row
// so two simultaneous requests are serialised: the second one counts AFTER the first one committed.
//
// What consumes a staff seat (the definition, in one place):
//   a seat is an ACTIVE staff account that belongs to the outlet and is a real person.
//   NOT a seat: system accounts (the shared kitchen-station login, `@stations.pangat.app`), the organisation owner
//   (SUPER_OWNER is organisation-level, not tied to an outlet) and platform administrators.
//   A seat IS consumed by: STORE_MANAGER, CHEF (personal), STEWARD, CASHIER at that outlet, including a manager created at sign-up.
// ─────────────────────────────────────────────────────────────────────────────

import { EntityManager } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { Table } from '../tables/entities/table.entity.js';
import { Staff } from '../auth/entities/staff.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { DataSource } from 'typeorm';
import {
  authoriseLimitOverride,
  evaluateLimit,
  getOrgAccess,
  getOrgPlan,
  limitFor,
  type OrgAccess,
  lockRow,
  planLimitError,
  recordLimitOverride,
  subscriptionBlockedError,
  type LimitKind,
  type LimitOverride,
} from './subscription-access.js';
import type { SubscriptionPlan } from './entities/subscription-plan.entity.js';

export const SYSTEM_ACCOUNT_DOMAIN = '@stations.pangat.app';
/** System-generated accounts (kitchen station logins) never consume a paid seat and are hidden from staff lists. */
export const isSystemAccountEmail = (email: string | null | undefined) => String(email || '').toLowerCase().endsWith(SYSTEM_ACCOUNT_DOMAIN);

/** Seats currently used at an outlet (see the definition at the top of this file). */
export async function countStaffSeats(em: EntityManager, restaurantId: string): Promise<number> {
  return em
    .getRepository(Staff)
    .createQueryBuilder('s')
    .where('s.restaurantId = :restaurantId', { restaurantId })
    .andWhere('s.isActive = true')
    .andWhere('s.isPlatformAdmin = false')
    .andWhere("s.role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN')")
    .andWhere('LOWER(s.email) NOT LIKE :sys', { sys: `%${SYSTEM_ACCOUNT_DOMAIN}` })
    .getCount();
}

export async function countOutletTables(em: EntityManager, restaurantId: string): Promise<number> {
  return em.getRepository(Table).count({ where: { restaurantId } });
}

/** The organisation an outlet belongs to, taken under a lock. Returns null for legacy outlets that have no organisation (no plan applies). */
async function lockOutlet(em: EntityManager, restaurantId: string): Promise<{ organizationId: string | null } | null> {
  await lockRow(em, 'restaurants', restaurantId);
  const r = await em.getRepository(Restaurant).findOne({ where: { id: restaurantId }, select: { id: true, organizationId: true } });
  return r ? { organizationId: r.organizationId } : null;
}

/**
 * The subscription facts a capacity check needs. Load it BEFORE opening the transaction: the transaction holds one database
 * connection and a row lock, and reading the plan from inside it would need a second connection per request, which can
 * exhaust the pool when many requests arrive together (every request holding one connection while waiting for another).
 */
export interface CapacityContext { access: OrgAccess; plan: SubscriptionPlan | null }
export async function loadCapacityContext(ds: DataSource, organizationId: string | null | undefined): Promise<CapacityContext | null> {
  if (!organizationId) return null; // a legacy outlet with no organisation has no plan to enforce
  return { access: await getOrgAccess(ds, organizationId), plan: await getOrgPlan(ds, organizationId) };
}

async function enforce(
  em: EntityManager,
  organizationId: string,
  kind: LimitKind,
  current: number,
  adding: number,
  override: LimitOverride | null,
  restaurantId: string | null,
  context: string,
  ctx: CapacityContext,
) {
  if (ctx.access.blocked) throw subscriptionBlockedError(ctx.access.reason || 'Subscription inactive');
  const plan = ctx.plan;
  const decision = evaluateLimit(plan, kind, current, adding);
  if (decision.allowed) return decision;
  if (override) {
    await recordLimitOverride(em, { organizationId, override, decision, restaurantId, context });
    return decision;
  }
  throw planLimitError(decision);
}

/**
 * Take the outlet lock and make sure `adding` more tables fit the plan. Call inside the transaction that inserts the tables.
 * Each outlet is checked on its own (the limit is per outlet).
 */
export async function reserveTableCapacity(
  em: EntityManager,
  restaurantId: string,
  ctx: CapacityContext | null,
  adding = 1,
  override: LimitOverride | null = null,
  context = 'table',
): Promise<void> {
  const outlet = await lockOutlet(em, restaurantId);
  if (!outlet?.organizationId || !ctx) return;
  const current = await countOutletTables(em, restaurantId);
  await enforce(em, outlet.organizationId, 'tables', current, adding, override, restaurantId, context, ctx);
}

/** Same for staff seats. `adding` is 1 for a new or re-activated person. */
export async function reserveStaffSeat(
  em: EntityManager,
  restaurantId: string,
  ctx: CapacityContext | null,
  adding = 1,
  override: LimitOverride | null = null,
  context = 'staff',
): Promise<void> {
  const outlet = await lockOutlet(em, restaurantId);
  if (!outlet?.organizationId || !ctx) return;
  const current = await countStaffSeats(em, restaurantId);
  await enforce(em, outlet.organizationId, 'staff', current, adding, override, restaurantId, context, ctx);
}

/** Outlets: lock the organisation, then compare the live count with the plan. */
export async function reserveOutletCapacity(
  em: EntityManager,
  organizationId: string,
  ctx: CapacityContext,
  override: LimitOverride | null = null,
  /** Runs after the live count and BEFORE the numeric limit, so a missing feature is reported as such (e.g. MULTI_OUTLET for a second outlet). */
  beforeLimit?: (currentOutlets: number) => Promise<void>,
): Promise<{ current: number }> {
  await lockRow(em, 'organizations', organizationId);
  const current = await em.getRepository(Restaurant).count({ where: { organizationId } });
  if (beforeLimit) await beforeLimit(current);
  await enforce(em, organizationId, 'outlets', current, 1, override, null, 'outlet', ctx);
  return { current };
}

/**
 * How many tables a NEW outlet may start with. Explicit requests that exceed the plan are rejected (never silently trimmed);
 * when the caller did not ask for a number, the default is trimmed to what the plan allows.
 * `override` skips the check for an authorised, audited exception (the caller records it).
 */
export function resolveInitialTables(
  plan: Pick<SubscriptionPlan, 'maxTablesPerOutlet'> | null,
  requested: { indoor?: number | null; outdoor?: number | null },
  defaults: { indoor: number; outdoor: number },
  minIndoor = 1,
): { indoor: number; outdoor: number; total: number; limit: number; exceeded: boolean } {
  const limit = limitFor(plan as any, 'tables');
  const explicit = requested.indoor !== undefined && requested.indoor !== null || requested.outdoor !== undefined && requested.outdoor !== null;
  let indoor = Math.max(minIndoor, requested.indoor ?? defaults.indoor);
  let outdoor = Math.max(0, requested.outdoor ?? defaults.outdoor);
  if (limit !== -1 && !explicit) {
    indoor = Math.max(minIndoor, Math.min(indoor, limit));
    outdoor = Math.max(0, Math.min(outdoor, limit - indoor));
  }
  const total = indoor + outdoor;
  return { indoor, outdoor, total, limit, exceeded: limit !== -1 && total > limit };
}

/** Throws the standard limit error for an initial table request that does not fit; returns normally when it fits or an override applies. */
export function assertInitialTablesFit(r: ReturnType<typeof resolveInitialTables>, override: LimitOverride | null): void {
  if (!r.exceeded || override) return;
  throw planLimitError({ kind: 'tables', limit: r.limit, current: 0, adding: r.total, allowed: false, remaining: r.limit });
}

export { authoriseLimitOverride };

/** Reject a nonsensical staff seat request at sign-up (a plan with no seats cannot take a manager). */
export function assertSeatsFit(plan: Pick<SubscriptionPlan, 'maxStaffPerOutlet'> | null, seats: number, override: LimitOverride | null): void {
  if (seats <= 0 || override) return;
  const d = evaluateLimit(plan as any, 'staff', 0, seats);
  if (!d.allowed) throw planLimitError(d);
}

export function badRequest(message: string, code: string) {
  return new BadRequestException({ message, code });
}

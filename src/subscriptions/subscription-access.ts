import { DataSource } from 'typeorm';
import { HttpException, HttpStatus } from '@nestjs/common';
import { OrganizationSubscription } from './entities/organization-subscription.entity.js';
import { SubscriptionPlan } from './entities/subscription-plan.entity.js';
import { SubscriptionStatus } from '../common/enums/index.js';

import { getSetting } from '../platform/settings.service.js';
import { getOrgLifecycle } from '../platform/org-status.js';

const graceDays = () => Number(getSetting<number>('subscription.gracePeriodDays') ?? 7);
const TTL_MS = 20_000;
const cache = new Map<string, { at: number; blocked: boolean; reason: string | null }>();

export interface OrgAccess {
  blocked: boolean;
  reason: string | null;
}

/** Pure decision used by guards and tests: is this subscription past its paid / trial / grace window? */
export function evaluateAccess(
  sub: { status: string; currentPeriodEnd: Date | string | null; gracePeriodEndsAt?: Date | string | null; cancelAtPeriodEnd?: boolean } | null,
  now = new Date(),
): OrgAccess {
  if (!sub) return { blocked: false, reason: null };
  if (sub.status === SubscriptionStatus.EXPIRED || sub.status === SubscriptionStatus.HALTED) {
    return { blocked: true, reason: 'Your subscription has expired. Renew your plan to continue.' };
  }
  const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  if (end && end.getTime() < now.getTime()) {
    const graceEnd = sub.gracePeriodEndsAt
      ? new Date(sub.gracePeriodEndsAt)
      : new Date(end.getTime() + graceDays() * 86_400_000);
    if (now.getTime() >= graceEnd.getTime() || sub.status === SubscriptionStatus.CANCELLED || sub.cancelAtPeriodEnd) {
      return {
        blocked: true,
        reason:
          sub.status === SubscriptionStatus.CANCELLED || sub.cancelAtPeriodEnd
            ? 'Your subscription was cancelled and its paid period has ended. Choose a plan to continue.'
            : 'Your trial or billing period has ended. Renew your plan to continue.',
      };
    }
  }
  return { blocked: false, reason: null };
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
  const plans = dataSource.getRepository(SubscriptionPlan);
  const plan =
    (await plans.findOne({ where: { code: String(getSetting('subscription.defaultTrialPlanCode') || 'GROWTH'), isActive: true } })) ??
    (await plans.findOne({ where: { isActive: true }, order: { basePrice: 'ASC' } }));
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

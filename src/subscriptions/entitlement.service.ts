// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/entitlement.service.ts
//
// Injectable facade over the ONE implementation of subscription rules in `subscription-access.ts`.
// It holds no rules of its own: status, grace handling, feature membership and limit arithmetic all come from the same
// pure functions the request guards use, so a service call and a guard can never disagree.
//
// Differences from the guards, kept on purpose:
//  * It reads through TypeORM repositories (so it can be unit-tested with fakes); the guards read through the DataSource.
//  * It NEVER writes. Persisting a lapsed status (TRIAL/ACTIVE -> GRACE_PERIOD -> EXPIRED) is the hourly sweep's job
//    (platform/jobs.service.ts, which uses the same `derivedStatus`). A read must not change data.
// ─────────────────────────────────────────────────────────────────────────────

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationSubscription } from './entities/organization-subscription.entity.js';
import { SubscriptionPlan } from './entities/subscription-plan.entity.js';
import { SubscriptionStatus } from '../common/enums/index.js';
import { derivedStatus, evaluateAccess, evaluateLimit, limitFor, planHasFeature, type LimitKind } from './subscription-access.js';

@Injectable()
export class EntitlementService {
  constructor(
    @InjectRepository(OrganizationSubscription)
    private readonly subRepo: Repository<OrganizationSubscription>,
    @InjectRepository(SubscriptionPlan)
    private readonly planRepo: Repository<SubscriptionPlan>,
  ) {}

  /** The organisation's latest subscription with the status it effectively has right now (in memory only; nothing is saved). */
  async getEffectiveSubscription(organizationId: string): Promise<OrganizationSubscription | null> {
    const sub = await this.subRepo.findOne({ where: { organizationId }, relations: { plan: true }, order: { createdAt: 'DESC' } });
    if (!sub) return null;
    const status = derivedStatus(sub);
    if (status === sub.status) return sub;
    const view = Object.assign(Object.create(Object.getPrototypeOf(sub)), sub) as OrganizationSubscription;
    view.status = status as SubscriptionStatus;
    return view;
  }

  /** Is the plan feature available to this organisation (plan membership while the subscription is usable)? Kill switches and overrides are applied by `decideFeature`. */
  async isFeatureEntitled(organizationId: string, feature: string): Promise<boolean> {
    const sub = await this.getEffectiveSubscription(organizationId);
    if (!sub?.plan) return false;
    if (evaluateAccess(sub).blocked) return false;
    return planHasFeature(sub.plan, feature);
  }

  private async capacity(organizationId: string, kind: LimitKind, current: number) {
    const sub = await this.getEffectiveSubscription(organizationId);
    if (!sub?.plan) return { allowed: false, limit: 0 };
    if (evaluateAccess(sub).blocked) return { allowed: false, limit: limitFor(sub.plan, kind) };
    const d = evaluateLimit(sub.plan, kind, current, 1);
    return { allowed: d.allowed, limit: d.limit };
  }

  async canAddOutlet(organizationId: string, currentOutletCount: number): Promise<{ allowed: boolean; maxOutlets: number }> {
    const c = await this.capacity(organizationId, 'outlets', currentOutletCount);
    return { allowed: c.allowed, maxOutlets: c.limit };
  }

  async canAddTable(organizationId: string, currentTableCount: number): Promise<{ allowed: boolean; maxTables: number }> {
    const c = await this.capacity(organizationId, 'tables', currentTableCount);
    return { allowed: c.allowed, maxTables: c.limit };
  }

  async canAddStaff(organizationId: string, currentStaffCount: number): Promise<{ allowed: boolean; maxStaff: number }> {
    const c = await this.capacity(organizationId, 'staff', currentStaffCount);
    return { allowed: c.allowed, maxStaff: c.limit };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/entitlement.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationSubscription } from './entities/organization-subscription.entity.js';
import { SubscriptionPlan } from './entities/subscription-plan.entity.js';
import { SubscriptionStatus } from '../common/enums/index.js';

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  // Default grace period window after period end before feature cutoff (7 days)
  private readonly GRACE_PERIOD_DAYS = 7;

  constructor(
    @InjectRepository(OrganizationSubscription)
    private readonly subRepo: Repository<OrganizationSubscription>,
    @InjectRepository(SubscriptionPlan)
    private readonly planRepo: Repository<SubscriptionPlan>,
  ) {}

  /**
   * Resolve active subscription with grace period and expiry evaluation.
   */
  async getEffectiveSubscription(organizationId: string): Promise<OrganizationSubscription | null> {
    const sub = await this.subRepo.findOne({
      where: { organizationId },
      relations: { plan: true },
      order: { createdAt: 'DESC' },
    });

    if (!sub) {
      return null;
    }

    const now = new Date();

    // Check if subscription period has ended
    if (sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) < now) {
      const graceEnd = sub.gracePeriodEndsAt
        ? new Date(sub.gracePeriodEndsAt)
        : new Date(new Date(sub.currentPeriodEnd).getTime() + this.GRACE_PERIOD_DAYS * 86_400_000);

      if (now < graceEnd) {
        if (sub.status !== SubscriptionStatus.GRACE_PERIOD && sub.status !== SubscriptionStatus.PAST_DUE) {
          sub.status = SubscriptionStatus.GRACE_PERIOD;
          sub.gracePeriodEndsAt = graceEnd;
          await this.subRepo.save(sub);
        }
      } else {
        if (sub.status !== SubscriptionStatus.EXPIRED && sub.status !== SubscriptionStatus.HALTED) {
          sub.status = SubscriptionStatus.EXPIRED;
          await this.subRepo.save(sub);
        }
      }
    }

    return sub;
  }

  /**
   * Verify if the organization is entitled to use a specific feature module.
   */
  async isFeatureEntitled(organizationId: string, feature: string): Promise<boolean> {
    const sub = await this.getEffectiveSubscription(organizationId);
    if (!sub || !sub.plan) {
      return false;
    }

    // HALTED or EXPIRED subscriptions allow billing/export only
    if (sub.status === SubscriptionStatus.EXPIRED || sub.status === SubscriptionStatus.HALTED) {
      return false;
    }

    // Active, Trial, or Grace Period permits entitled plan features
    const planFeatures = Array.isArray(sub.plan.features)
      ? sub.plan.features
      : String(sub.plan.features || '').split(',').map((s) => s.trim());

    return planFeatures.includes(feature) || planFeatures.includes('*');
  }

  /**
   * Check if organization has capacity to add another outlet branch.
   */
  async canAddOutlet(organizationId: string, currentOutletCount: number): Promise<{ allowed: boolean; maxOutlets: number }> {
    const sub = await this.getEffectiveSubscription(organizationId);
    if (!sub || !sub.plan) {
      return { allowed: false, maxOutlets: 0 };
    }

    if (sub.status === SubscriptionStatus.EXPIRED || sub.status === SubscriptionStatus.HALTED) {
      return { allowed: false, maxOutlets: sub.plan.maxOutlets };
    }

    if (sub.plan.maxOutlets === -1) {
      return { allowed: true, maxOutlets: -1 };
    }

    return {
      allowed: currentOutletCount < sub.plan.maxOutlets,
      maxOutlets: sub.plan.maxOutlets,
    };
  }

  /**
   * Check if outlet has capacity to add another floor table.
   */
  async canAddTable(organizationId: string, currentTableCount: number): Promise<{ allowed: boolean; maxTables: number }> {
    const sub = await this.getEffectiveSubscription(organizationId);
    if (!sub || !sub.plan) {
      return { allowed: false, maxTables: 0 };
    }

    if (sub.status === SubscriptionStatus.EXPIRED || sub.status === SubscriptionStatus.HALTED) {
      return { allowed: false, maxTables: sub.plan.maxTablesPerOutlet };
    }

    if (sub.plan.maxTablesPerOutlet === -1) {
      return { allowed: true, maxTables: -1 };
    }

    return {
      allowed: currentTableCount < sub.plan.maxTablesPerOutlet,
      maxTables: sub.plan.maxTablesPerOutlet,
    };
  }
}

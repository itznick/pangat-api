// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/subscriptions.module.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionPlan } from './entities/subscription-plan.entity.js';
import { OrganizationSubscription } from './entities/organization-subscription.entity.js';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity.js';
import { SubscriptionAuditLog } from './entities/subscription-audit-log.entity.js';
import { Organization } from '../organizations/entities/organization.entity.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { EntitlementService } from './entitlement.service.js';
import { SubscriptionsController } from './subscriptions.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubscriptionPlan,
      OrganizationSubscription,
      SubscriptionInvoice,
      SubscriptionAuditLog,
      Organization,
    ]),
  ],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, EntitlementService],
  exports: [SubscriptionsService, EntitlementService],
})
export class SubscriptionsModule {}

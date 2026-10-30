// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/entities/organization-subscription.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SubscriptionStatus } from '../../common/enums/index.js';
import { SubscriptionPlan } from './subscription-plan.entity.js';
import { Organization } from '../../organizations/entities/organization.entity.js';

@Entity('organization_subscriptions')
@Index(['organizationId'])
@Index(['razorpaySubscriptionId'])
export class OrganizationSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId: string;

  @ManyToOne(() => SubscriptionPlan)
  @JoinColumn({ name: 'plan_id' })
  plan: SubscriptionPlan;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    default: SubscriptionStatus.TRIAL,
  })
  status: SubscriptionStatus;

  @Column({ name: 'current_period_start', type: 'timestamptz' })
  currentPeriodStart: Date;

  @Column({ name: 'current_period_end', type: 'timestamptz' })
  currentPeriodEnd: Date;

  @Column({ name: 'trial_ends_at', type: 'timestamptz', nullable: true })
  trialEndsAt: Date | null;

  @Column({ name: 'grace_period_ends_at', type: 'timestamptz', nullable: true })
  gracePeriodEndsAt: Date | null;

  @Column({ name: 'razorpay_subscription_id', type: 'varchar', length: 100, nullable: true })
  razorpaySubscriptionId: string | null;

  @Column({ name: 'razorpay_customer_id', type: 'varchar', length: 100, nullable: true })
  razorpayCustomerId: string | null;

  @Column({ name: 'cancel_at_period_end', type: 'boolean', default: false })
  cancelAtPeriodEnd: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/entities/subscription-plan.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BillingInterval } from '../../common/enums/index.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('subscription_plans')
@Index(['code'], { unique: true })
export class SubscriptionPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    name: 'billing_interval',
    type: 'enum',
    enum: BillingInterval,
    default: BillingInterval.MONTHLY,
  })
  billingInterval: BillingInterval;

  /**
   * Base recurring price in INR, exclusive of GST.
   */
  @Column({
    name: 'base_price',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  basePrice: number;

  @Column({ type: 'varchar', length: 10, default: 'INR' })
  currency: string;

  /**
   * Configurable tax percentage, e.g. 18.00% for Indian SaaS GST.
   */
  @Column({
    name: 'tax_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 18.00,
    transformer: decimalTransformer,
  })
  taxPercentage: number;

  /**
   * Maximum allowed outlets (-1 = unlimited).
   */
  @Column({ name: 'max_outlets', type: 'int', default: 1 })
  maxOutlets: number;

  /**
   * Maximum allowed tables per outlet (-1 = unlimited).
   */
  @Column({ name: 'max_tables_per_outlet', type: 'int', default: 10 })
  maxTablesPerOutlet: number;

  /**
   * Entitled feature flags (e.g. ["QR_ORDERING", "KDS", "INVENTORY", "ANALYTICS"]).
   */
  @Column({ type: 'simple-array', default: '' })
  features: string[];

  @Column({ name: 'razorpay_plan_id', type: 'varchar', length: 100, nullable: true })
  razorpayPlanId: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

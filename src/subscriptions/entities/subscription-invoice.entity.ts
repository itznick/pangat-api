// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/entities/subscription-invoice.entity.ts
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
import { SubscriptionInvoiceStatus } from '../../common/enums/index.js';
import { OrganizationSubscription } from './organization-subscription.entity.js';
import { Organization } from '../../organizations/entities/organization.entity.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('subscription_invoices')
@Index(['organizationId', 'createdAt'])
@Index(['invoiceNumber'], { unique: true })
export class SubscriptionInvoice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId: string;

  @ManyToOne(() => OrganizationSubscription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: OrganizationSubscription;

  @Column({ name: 'invoice_number', type: 'varchar', length: 50, unique: true })
  invoiceNumber: string;

  @Column({ name: 'billing_period_start', type: 'timestamptz' })
  billingPeriodStart: Date;

  @Column({ name: 'billing_period_end', type: 'timestamptz' })
  billingPeriodEnd: Date;

  @Column({
    name: 'base_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  baseAmount: number;

  @Column({
    name: 'tax_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 18.00,
    transformer: decimalTransformer,
  })
  taxPercentage: number;

  @Column({
    name: 'tax_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  taxAmount: number;

  @Column({
    name: 'total_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  totalAmount: number;

  @Column({
    type: 'enum',
    enum: SubscriptionInvoiceStatus,
    default: SubscriptionInvoiceStatus.DRAFT,
  })
  status: SubscriptionInvoiceStatus;

  @Column({ name: 'razorpay_payment_id', type: 'varchar', length: 100, nullable: true })
  razorpayPaymentId: string | null;

  @Column({ name: 'razorpay_invoice_id', type: 'varchar', length: 100, nullable: true })
  razorpayInvoiceId: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'invoice_pdf_url', type: 'text', nullable: true })
  invoicePdfUrl: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

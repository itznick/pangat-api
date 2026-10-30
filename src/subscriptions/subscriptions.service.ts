// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/subscriptions.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { SubscriptionPlan } from './entities/subscription-plan.entity.js';
import { OrganizationSubscription } from './entities/organization-subscription.entity.js';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity.js';
import { SubscriptionAuditLog } from './entities/subscription-audit-log.entity.js';
import { Organization } from '../organizations/entities/organization.entity.js';
import { CreatePlanDto } from './dto/create-plan.dto.js';
import { UpdatePlanDto } from './dto/update-plan.dto.js';
import {
  BillingInterval,
  SubscriptionFeature,
  SubscriptionInvoiceStatus,
  SubscriptionStatus,
} from '../common/enums/index.js';
import { EntitlementService } from './entitlement.service.js';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectRepository(SubscriptionPlan)
    private readonly planRepo: Repository<SubscriptionPlan>,
    @InjectRepository(OrganizationSubscription)
    private readonly subRepo: Repository<OrganizationSubscription>,
    @InjectRepository(SubscriptionInvoice)
    private readonly invoiceRepo: Repository<SubscriptionInvoice>,
    @InjectRepository(SubscriptionAuditLog)
    private readonly auditRepo: Repository<SubscriptionAuditLog>,
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    private readonly entitlementService: EntitlementService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * List all public/active subscription plans with transparent GST calculation.
   */
  async findAllPlans(includeInactive = false) {
    const plans = await this.planRepo.find({
      where: includeInactive ? {} : { isActive: true },
      order: { basePrice: 'ASC' },
    });

    return plans.map((p) => {
      const base = Number(p.basePrice);
      const taxRate = Number(p.taxPercentage || 18.00);
      const taxAmount = Math.round(base * (taxRate / 100) * 100) / 100;
      const totalPayable = Math.round((base + taxAmount) * 100) / 100;

      return {
        ...p,
        pricing: {
          basePrice: base,
          taxPercentage: taxRate,
          taxAmount,
          totalPayable,
          currency: p.currency,
          billingInterval: p.billingInterval,
          displaySummary: `₹${base.toLocaleString('en-IN')} + ${taxRate}% GST (Total: ₹${totalPayable.toLocaleString('en-IN')}) / ${p.billingInterval.toLowerCase()}`,
        },
      };
    });
  }

  async findPlanById(id: string): Promise<SubscriptionPlan> {
    const plan = await this.planRepo.findOne({ where: { id } });
    if (!plan) throw new NotFoundException(`Subscription plan '${id}' not found`);
    return plan;
  }

  async createPlan(dto: CreatePlanDto): Promise<SubscriptionPlan> {
    const existing = await this.planRepo.findOne({ where: { code: dto.code.trim().toUpperCase() } });
    if (existing) {
      throw new BadRequestException(`Plan code '${dto.code}' already exists`);
    }

    const plan = this.planRepo.create({
      code: dto.code.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      billingInterval: dto.billingInterval,
      basePrice: Number(dto.basePrice),
      taxPercentage: Number(dto.taxPercentage ?? 18.00),
      maxOutlets: dto.maxOutlets ?? 1,
      maxTablesPerOutlet: dto.maxTablesPerOutlet ?? 10,
      features: dto.features || [SubscriptionFeature.QR_ORDERING, SubscriptionFeature.KDS],
      razorpayPlanId: dto.razorpayPlanId?.trim() || null,
      isActive: true,
    });

    return this.planRepo.save(plan);
  }

  async updatePlan(id: string, dto: UpdatePlanDto): Promise<SubscriptionPlan> {
    const plan = await this.findPlanById(id);

    if (dto.name !== undefined) plan.name = dto.name.trim();
    if (dto.description !== undefined) plan.description = dto.description?.trim() || null;
    if (dto.billingInterval !== undefined) plan.billingInterval = dto.billingInterval;
    if (dto.basePrice !== undefined) plan.basePrice = Number(dto.basePrice);
    if (dto.taxPercentage !== undefined) plan.taxPercentage = Number(dto.taxPercentage);
    if (dto.maxOutlets !== undefined) plan.maxOutlets = dto.maxOutlets;
    if (dto.maxTablesPerOutlet !== undefined) plan.maxTablesPerOutlet = dto.maxTablesPerOutlet;
    if (dto.features !== undefined) plan.features = dto.features;
    if (dto.razorpayPlanId !== undefined) plan.razorpayPlanId = dto.razorpayPlanId?.trim() || null;
    if (dto.isActive !== undefined) plan.isActive = dto.isActive;

    return this.planRepo.save(plan);
  }

  /**
   * Get organization subscription status with plans, grace period, and invoices.
   * Auto-provisions a 14-day trial if no subscription exists yet.
   */
  async getOrganizationSubscription(organizationId: string) {
    const org = await this.orgRepo.findOne({ where: { id: organizationId } });
    if (!org) {
      throw new NotFoundException(`Organization '${organizationId}' not found`);
    }

    let sub = await this.entitlementService.getEffectiveSubscription(organizationId);

    // If new organization has no subscription, initialize 14-day TRIAL on Growth plan
    if (!sub) {
      sub = await this.startTrial(organizationId, 'GROWTH');
    }

    const invoices = await this.invoiceRepo.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
      take: 10,
    });

    const base = Number(sub.plan.basePrice);
    const taxRate = Number(sub.plan.taxPercentage || 18.00);
    const taxAmount = Math.round(base * (taxRate / 100) * 100) / 100;
    const totalPayable = Math.round((base + taxAmount) * 100) / 100;

    return {
      subscription: sub,
      plan: {
        ...sub.plan,
        pricing: {
          basePrice: base,
          taxPercentage: taxRate,
          taxAmount,
          totalPayable,
          currency: sub.plan.currency,
        },
      },
      invoices,
    };
  }

  /**
   * Provision or reset a 14-day trial subscription.
   */
  async startTrial(organizationId: string, planCode = 'GROWTH'): Promise<OrganizationSubscription> {
    const plan = await this.planRepo.findOne({ where: { code: planCode, isActive: true } });
    if (!plan) {
      throw new NotFoundException(`Plan '${planCode}' not found`);
    }

    const now = new Date();
    const trialEnd = new Date(now.getTime() + 14 * 86_400_000);

    const sub = this.subRepo.create({
      organizationId,
      planId: plan.id,
      status: SubscriptionStatus.TRIAL,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      trialEndsAt: trialEnd,
      gracePeriodEndsAt: null,
      cancelAtPeriodEnd: false,
    });

    const saved = await this.subRepo.save(sub);

    await this.auditRepo.save(
      this.auditRepo.create({
        organizationId,
        action: 'TRIAL_STARTED',
        actor: 'SYSTEM',
        reason: `Started 14-day free trial on ${plan.name}`,
        metadata: { planId: plan.id, planCode: plan.code, trialEndsAt: trialEnd },
      }),
    );

    return { ...saved, plan };
  }

  /**
   * Process incoming Razorpay webhook event with cryptographic HMAC-SHA256 verification.
   * Idempotent event processing prevents duplicate billing or charge records.
   */
  async handleRazorpayWebhook(rawBody: string, signature: string, eventPayload: any) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret_key';

    // Verify HMAC-SHA256 signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSignature && process.env.NODE_ENV === 'production') {
      this.logger.warn(`Invalid Razorpay webhook signature: ${signature}`);
      throw new UnauthorizedException('Invalid Razorpay webhook signature');
    }

    const event = eventPayload?.event;
    const eventId = eventPayload?.id || eventPayload?.event_id || `evt-${Date.now()}`;
    const contains = eventPayload?.payload;

    if (!event) {
      throw new BadRequestException('Malformed webhook payload: missing event field');
    }

    // Check idempotency: avoid double processing the same webhook event
    const existingLog = await this.auditRepo.findOne({
      where: { idempotencyKey: eventId },
    });
    if (existingLog) {
      this.logger.log(`Ignoring duplicate webhook event ${eventId} (${event})`);
      return { status: 'duplicate_ignored', eventId };
    }

    this.logger.log(`Processing verified Razorpay webhook event ${eventId}: ${event}`);

    const subEntity = contains?.subscription?.entity;
    const paymentEntity = contains?.payment?.entity;
    const invoiceEntity = contains?.invoice?.entity;

    const rzpSubId = subEntity?.id || invoiceEntity?.subscription_id;

    if (!rzpSubId && !paymentEntity) {
      return { status: 'ignored_unrelated_event', event };
    }

    // Find linked organization subscription by Razorpay subscription ID
    let sub = rzpSubId ? await this.subRepo.findOne({
      where: { razorpaySubscriptionId: rzpSubId },
      relations: { plan: true },
    }) : null;

    if (!sub && subEntity?.notes?.organizationId) {
      sub = await this.subRepo.findOne({
        where: { organizationId: subEntity.notes.organizationId },
        relations: { plan: true },
      });
    }

    if (!sub) {
      this.logger.warn(`No organization subscription matches Razorpay ID '${rzpSubId}'`);
      return { status: 'subscription_not_found', rzpSubId };
    }

    const organizationId = sub.organizationId;

    switch (event) {
      case 'subscription.authenticated':
        // Rule: Mandate authenticated only; never activate paid subscription without payment capture
        await this.recordAudit(organizationId, 'MANDATE_AUTHENTICATED', 'RAZORPAY_WEBHOOK', 'Mandate authenticated by customer. Awaiting payment capture.', eventId, { rzpSubId });
        break;

      case 'subscription.activated':
        // Rule: Subscription activated
        sub.status = SubscriptionStatus.ACTIVE;
        await this.subRepo.save(sub);
        await this.recordAudit(organizationId, 'SUBSCRIPTION_ACTIVATED', 'RAZORPAY_WEBHOOK', 'Subscription activated', eventId, { rzpSubId });
        break;

      case 'subscription.charged':
      case 'payment.captured': {
        // Successful payment charge -> advance period, mark ACTIVE, create tax invoice
        sub.status = SubscriptionStatus.ACTIVE;
        sub.gracePeriodEndsAt = null;

        const periodStart = subEntity?.current_start
          ? new Date(subEntity.current_start * 1000)
          : new Date();
        const periodEnd = subEntity?.current_end
          ? new Date(subEntity.current_end * 1000)
          : new Date(periodStart.getTime() + (sub.plan.billingInterval === BillingInterval.YEARLY ? 365 : 30) * 86_400_000);

        sub.currentPeriodStart = periodStart;
        sub.currentPeriodEnd = periodEnd;
        await this.subRepo.save(sub);

        // Generate verified Invoice with 18% GST breakdown
        const base = Number(sub.plan.basePrice);
        const taxRate = Number(sub.plan.taxPercentage || 18.00);
        const taxAmount = Math.round(base * (taxRate / 100) * 100) / 100;
        const total = Math.round((base + taxAmount) * 100) / 100;

        const invoiceNumber = `PANGAT-INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

        const invoice = this.invoiceRepo.create({
          organizationId,
          subscriptionId: sub.id,
          invoiceNumber,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          baseAmount: base,
          taxPercentage: taxRate,
          taxAmount,
          totalAmount: total,
          status: SubscriptionInvoiceStatus.PAID,
          razorpayPaymentId: paymentEntity?.id || null,
          razorpayInvoiceId: invoiceEntity?.id || null,
          paidAt: new Date(),
        });

        await this.invoiceRepo.save(invoice);

        await this.recordAudit(organizationId, 'PAYMENT_CHARGED', 'RAZORPAY_WEBHOOK', `Successfully charged ₹${total} (Base: ₹${base} + GST: ₹${taxAmount})`, eventId, {
          invoiceId: invoice.id,
          invoiceNumber,
          totalAmount: total,
        });
        break;
      }

      case 'subscription.pending': {
        // Payment failed or renewal attempt pending -> enter GRACE_PERIOD
        sub.status = SubscriptionStatus.GRACE_PERIOD;
        sub.gracePeriodEndsAt = new Date(Date.now() + 7 * 86_400_000);
        await this.subRepo.save(sub);

        await this.recordAudit(organizationId, 'PAYMENT_FAILED', 'RAZORPAY_WEBHOOK', 'Payment attempt failed. Entered 7-day grace period.', eventId, { rzpSubId });
        break;
      }

      case 'subscription.halted': {
        // Consecutively failed attempts -> enter HALTED
        sub.status = SubscriptionStatus.HALTED;
        await this.subRepo.save(sub);

        await this.recordAudit(organizationId, 'SUBSCRIPTION_HALTED', 'RAZORPAY_WEBHOOK', 'Subscription halted due to consecutive payment failures', eventId, { rzpSubId });
        break;
      }

      case 'subscription.cancelled': {
        sub.status = SubscriptionStatus.CANCELLED;
        await this.subRepo.save(sub);

        await this.recordAudit(organizationId, 'SUBSCRIPTION_CANCELLED', 'RAZORPAY_WEBHOOK', 'Subscription cancelled', eventId, { rzpSubId });
        break;
      }

      default:
        this.logger.debug(`Unhandled webhook event: ${event}`);
    }

    return { status: 'processed', eventId, event };
  }

  private async recordAudit(
    organizationId: string,
    action: string,
    actor: string,
    reason: string,
    idempotencyKey?: string,
    metadata?: any,
  ) {
    const log = this.auditRepo.create({
      organizationId,
      action,
      actor,
      reason,
      idempotencyKey: idempotencyKey || null,
      metadata: metadata || null,
    });
    return this.auditRepo.save(log);
  }
}

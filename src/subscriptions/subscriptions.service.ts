// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/subscriptions.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { invalidateOrgAccess } from './subscription-access.js';
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
import { DEFAULT_PLANS } from './default-plans.js';

@Injectable()
export class SubscriptionsService implements OnModuleInit {
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

  /** Make sure the plan catalogue exists on every boot, however the schema was created. */
  async onModuleInit() {
    try {
      const created = await this.ensureDefaultPlans();
      if (created > 0) this.logger.log(`Seeded ${created} missing subscription plan(s)`);
    } catch (err) {
      this.logger.error(`Could not verify default subscription plans: ${(err as Error).message}`);
    }
  }

  /**
   * Insert any canonical plan that is missing (matched by unique `code`). Existing rows are never
   * modified, so admin edits to prices and limits are preserved. Returns how many were created.
   */
  async ensureDefaultPlans(): Promise<number> {
    const existing = await this.planRepo.find({ select: { code: true } });
    const have = new Set(existing.map((p) => p.code));
    const missing = DEFAULT_PLANS.filter((p) => !have.has(p.code));
    for (const p of missing) {
      await this.planRepo.save(
        this.planRepo.create({
          id: p.id,
          code: p.code,
          name: p.name,
          description: p.description,
          billingInterval: p.billingInterval,
          basePrice: p.basePrice,
          basePricePaise: Math.round(p.basePrice * 100),
          currency: 'INR',
          taxPercentage: 18,
          maxOutlets: p.maxOutlets,
          maxTablesPerOutlet: p.maxTablesPerOutlet,
          maxStaffPerOutlet: p.maxStaffPerOutlet,
          features: p.features,
          sacCode: null,
          razorpayPlanId: null,
          isActive: true,
        }),
      );
    }
    return missing.length;
  }

  /**
   * Calculate place-of-supply tax splits in integer paise.
   * Intra-state (e.g. MH to MH): CGST 9% + SGST 9%
   * Inter-state (e.g. MH to outside MH): IGST 18%
   */
  calculateTaxes(
    basePaise: number,
    taxPercentage = 18.00,
    buyerStateCode?: string | null,
    supplierStateCode = '27',
  ) {
    const isIntraState = !buyerStateCode || buyerStateCode === supplierStateCode;
    let cgstPaise = 0;
    let sgstPaise = 0;
    let igstPaise = 0;

    if (isIntraState) {
      cgstPaise = Math.round(basePaise * (taxPercentage / 200));
      sgstPaise = Math.round(basePaise * (taxPercentage / 200));
    } else {
      igstPaise = Math.round(basePaise * (taxPercentage / 100));
    }

    const taxPaise = cgstPaise + sgstPaise + igstPaise;
    const totalPaise = basePaise + taxPaise;

    return {
      basePaise,
      taxPaise,
      totalPaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      isIntraState,
      baseRupees: Math.round(basePaise) / 100,
      taxRupees: Math.round(taxPaise) / 100,
      totalRupees: Math.round(totalPaise) / 100,
      cgstRupees: Math.round(cgstPaise) / 100,
      sgstRupees: Math.round(sgstPaise) / 100,
      igstRupees: Math.round(igstPaise) / 100,
    };
  }

  /**
   * List all public/active subscription plans with transparent GST calculation.
   */
  async findAllPlans(includeInactive = false) {
    const plans = await this.planRepo.find({
      where: includeInactive ? {} : { isActive: true },
      order: { basePrice: 'ASC' },
    });

    return plans.map((p) => {
      const basePaise = Number(p.basePricePaise) || Math.round(Number(p.basePrice) * 100);
      const taxRate = Number(p.taxPercentage || 18.00);
      const taxBreakdown = this.calculateTaxes(basePaise, taxRate);

      return {
        ...p,
        basePricePaise: basePaise,
        maxStaffPerOutlet: p.maxStaffPerOutlet ?? 5,
        sacCode: p.sacCode || null,
        pricing: {
          basePrice: taxBreakdown.baseRupees,
          basePricePaise: basePaise,
          taxPercentage: taxRate,
          taxAmount: taxBreakdown.taxRupees,
          taxAmountPaise: taxBreakdown.taxPaise,
          totalPayable: taxBreakdown.totalRupees,
          totalAmountPaise: taxBreakdown.totalPaise,
          cgstAmountPaise: taxBreakdown.cgstPaise,
          sgstAmountPaise: taxBreakdown.sgstPaise,
          igstAmountPaise: taxBreakdown.igstPaise,
          currency: p.currency,
          billingInterval: p.billingInterval,
          displaySummary: `₹${taxBreakdown.baseRupees.toLocaleString('en-IN')} + ${taxRate}% GST (Total: ₹${taxBreakdown.totalRupees.toLocaleString('en-IN')}) / ${p.billingInterval.toLowerCase()}`,
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

    const basePaise = dto.basePricePaise ?? Math.round(Number(dto.basePrice) * 100);
    const basePrice = dto.basePrice !== undefined ? Number(dto.basePrice) : Math.round(basePaise) / 100;

    const plan = this.planRepo.create({
      code: dto.code.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      billingInterval: dto.billingInterval,
      basePrice,
      basePricePaise: basePaise,
      taxPercentage: Number(dto.taxPercentage ?? 18.00),
      maxOutlets: dto.maxOutlets ?? 1,
      maxTablesPerOutlet: dto.maxTablesPerOutlet ?? 10,
      maxStaffPerOutlet: dto.maxStaffPerOutlet ?? 5,
      features: dto.features || [SubscriptionFeature.QR_ORDERING, SubscriptionFeature.KDS],
      razorpayPlanId: dto.razorpayPlanId?.trim() || null,
      sacCode: dto.sacCode?.trim() || null,
      isActive: true,
    });

    return this.planRepo.save(plan);
  }

  async updatePlan(id: string, dto: UpdatePlanDto): Promise<SubscriptionPlan> {
    const plan = await this.findPlanById(id);

    if (dto.name !== undefined) plan.name = dto.name.trim();
    if (dto.description !== undefined) plan.description = dto.description?.trim() || null;
    if (dto.billingInterval !== undefined) plan.billingInterval = dto.billingInterval;
    if (dto.basePricePaise !== undefined) {
      plan.basePricePaise = dto.basePricePaise;
      plan.basePrice = Math.round(dto.basePricePaise) / 100;
    } else if (dto.basePrice !== undefined) {
      plan.basePrice = Number(dto.basePrice);
      plan.basePricePaise = Math.round(Number(dto.basePrice) * 100);
    }
    if (dto.taxPercentage !== undefined) plan.taxPercentage = Number(dto.taxPercentage);
    if (dto.maxOutlets !== undefined) plan.maxOutlets = dto.maxOutlets;
    if (dto.maxTablesPerOutlet !== undefined) plan.maxTablesPerOutlet = dto.maxTablesPerOutlet;
    if (dto.maxStaffPerOutlet !== undefined) plan.maxStaffPerOutlet = dto.maxStaffPerOutlet;
    if (dto.sacCode !== undefined) plan.sacCode = dto.sacCode?.trim() || null;
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
    let plan = await this.planRepo.findOne({ where: { code: planCode, isActive: true } });
    if (!plan) {
      // Self-heal an empty or partially seeded catalogue, then fall back to the cheapest monthly plan
      await this.ensureDefaultPlans();
      plan =
        (await this.planRepo.findOne({ where: { code: planCode, isActive: true } })) ??
        (await this.planRepo.findOne({
          where: { isActive: true, billingInterval: BillingInterval.MONTHLY },
          order: { basePrice: 'ASC' },
        }));
    }
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
    // The webhook can grant paid access, so it is NEVER accepted unsigned, in any environment.
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error('RAZORPAY_WEBHOOK_SECRET is not configured: rejecting webhook');
      throw new ServiceUnavailableException('Webhook receiver is not configured');
    }

    // Verify HMAC-SHA256 over the exact bytes Razorpay sent, using a constant-time comparison
    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = Buffer.from(String(signature || ''), 'utf8');
    const want = Buffer.from(expectedSignature, 'utf8');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      this.logger.warn('Rejected Razorpay webhook with an invalid signature');
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
        // Rule: Subscription activated at gateway. Never grant paid ACTIVE status without verified payment capture.
        const hasVerifiedPaidInvoice = (await this.invoiceRepo.count({
          where: { subscriptionId: sub.id, status: SubscriptionInvoiceStatus.PAID },
        })) > 0;
        if (hasVerifiedPaidInvoice) {
          sub.status = SubscriptionStatus.ACTIVE;
          await this.subRepo.save(sub);
        }
        await this.recordAudit(
          organizationId,
          'SUBSCRIPTION_ACTIVATED',
          'RAZORPAY_WEBHOOK',
          hasVerifiedPaidInvoice
            ? 'Subscription activated with verified payment record'
            : 'Subscription activated at gateway; awaiting initial payment capture before granting paid access',
          eventId,
          { rzpSubId, hasVerifiedPaidInvoice },
        );
        break;

      case 'subscription.charged':
      case 'payment.captured': {
        const paymentId = paymentEntity?.id || null;

        // Idempotent duplicate invoice prevention: never issue duplicate invoices for the same payment
        if (paymentId) {
          const existingInvoice = await this.invoiceRepo.findOne({
            where: { razorpayPaymentId: paymentId },
          });
          if (existingInvoice) {
            this.logger.warn(`Invoice already exists for Razorpay payment ${paymentId}: ${existingInvoice.invoiceNumber}`);
            return {
              status: 'duplicate_payment_ignored',
              invoiceId: existingInvoice.id,
              invoiceNumber: existingInvoice.invoiceNumber,
            };
          }
        }

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

        // Generate verified Invoice with integer paise precision and place-of-supply breakdown
        const basePaise = Number(sub.plan.basePricePaise) || Math.round(Number(sub.plan.basePrice) * 100);
        const taxRate = Number(sub.plan.taxPercentage || 18.00);
        const buyerState = subEntity?.notes?.stateCode || paymentEntity?.notes?.stateCode || null;
        const buyerGstin = subEntity?.notes?.buyerGstin || paymentEntity?.notes?.buyerGstin || null;

        const taxes = this.calculateTaxes(basePaise, taxRate, buyerState);
        const invoiceNumber = `PANGAT-INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

        const invoice = this.invoiceRepo.create({
          organizationId,
          subscriptionId: sub.id,
          invoiceNumber,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          baseAmount: taxes.baseRupees,
          taxPercentage: taxRate,
          taxAmount: taxes.taxRupees,
          totalAmount: taxes.totalRupees,
          baseAmountPaise: taxes.basePaise,
          taxAmountPaise: taxes.taxPaise,
          totalAmountPaise: taxes.totalPaise,
          cgstAmountPaise: taxes.cgstPaise,
          sgstAmountPaise: taxes.sgstPaise,
          igstAmountPaise: taxes.igstPaise,
          stateCode: buyerState,
          buyerGstin,
          status: SubscriptionInvoiceStatus.PAID,
          razorpayPaymentId: paymentId,
          razorpayInvoiceId: invoiceEntity?.id || null,
          paidAt: new Date(),
        });

        await this.invoiceRepo.save(invoice);

        await this.recordAudit(
          organizationId,
          'PAYMENT_CHARGED',
          'RAZORPAY_WEBHOOK',
          `Successfully charged ₹${taxes.totalRupees} (Base: ₹${taxes.baseRupees} + GST: ₹${taxes.taxRupees})`,
          eventId,
          {
            invoiceId: invoice.id,
            invoiceNumber,
            totalAmount: taxes.totalRupees,
            totalAmountPaise: taxes.totalPaise,
            paymentId,
          },
        );
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

  // ── Manual billing & self-service ───────────────────────────────────────────

  /** Platform operator puts an organization on a plan for N months (offline / invoice billing). */
  async adminAssignPlan(
    organizationId: string,
    dto: { planId?: string; planCode?: string; months: number; note?: string },
    actor: { id?: string; email?: string },
  ) {
    const org = await this.orgRepo.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException(`Organization '${organizationId}' not found`);
    const plan = dto.planId
      ? await this.planRepo.findOne({ where: { id: dto.planId } })
      : await this.planRepo.findOne({ where: { code: dto.planCode } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (!plan.isActive) throw new BadRequestException('That plan is not active');

    const now = new Date();
    let sub = await this.subRepo.findOne({ where: { organizationId }, order: { createdAt: 'DESC' } });
    // extend from the current end when the org is still paid-up, else from now
    const startFrom = sub && sub.status === SubscriptionStatus.ACTIVE && new Date(sub.currentPeriodEnd) > now && sub.planId === plan.id
      ? new Date(sub.currentPeriodEnd)
      : now;
    const end = new Date(startFrom);
    end.setMonth(end.getMonth() + dto.months);

    if (!sub) {
      sub = this.subRepo.create({ organizationId, planId: plan.id });
    }
    sub.planId = plan.id;
    sub.status = SubscriptionStatus.ACTIVE;
    sub.currentPeriodStart = startFrom === now ? now : sub.currentPeriodStart;
    sub.currentPeriodEnd = end;
    sub.trialEndsAt = null;
    sub.gracePeriodEndsAt = null;
    sub.cancelAtPeriodEnd = false;
    const saved = await this.subRepo.save(sub);
    invalidateOrgAccess(organizationId);

    await this.recordAudit(
      organizationId,
      'PLAN_ASSIGNED_BY_ADMIN',
      `ADMIN:${actor?.email || actor?.id || 'unknown'}`,
      dto.note || `Assigned ${plan.name} for ${dto.months} month(s)`,
      undefined,
      { planCode: plan.code, months: dto.months, periodEnd: end },
    );
    return { ...saved, plan };
  }

  /** Owner: stop renewal at the end of the paid period (access continues until then). */
  async setCancelAtPeriodEnd(organizationId: string, cancel: boolean, actor: { email?: string }) {
    await this.getOrganizationSubscription(organizationId); // makes sure a (trial) subscription exists
    const sub = await this.entitlementService.getEffectiveSubscription(organizationId);
    if (!sub) throw new NotFoundException('No subscription found');
    if (sub.status === SubscriptionStatus.EXPIRED || sub.status === SubscriptionStatus.HALTED) {
      throw new BadRequestException('This subscription has already ended. Choose a plan to restart.');
    }
    if (sub.status === SubscriptionStatus.TRIAL && cancel) {
      throw new BadRequestException('A free trial just ends on its own date; there is nothing to cancel.');
    }
    sub.cancelAtPeriodEnd = cancel;
    const saved = await this.subRepo.save(sub);
    invalidateOrgAccess(organizationId);
    await this.recordAudit(
      organizationId,
      cancel ? 'CANCEL_AT_PERIOD_END' : 'CANCELLATION_REVERTED',
      `OWNER:${actor?.email || 'unknown'}`,
      cancel ? 'Owner turned off renewal' : 'Owner kept the plan renewing',
    );
    return saved;
  }

  /** Owner asks for a plan change; platform operators see it in the audit trail and follow up. */
  async requestPlanChange(organizationId: string, planCode: string, message: string | undefined, actor: { email?: string }) {
    const plan = await this.planRepo.findOne({ where: { code: planCode, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');
    await this.recordAudit(
      organizationId,
      'PLAN_CHANGE_REQUESTED',
      `OWNER:${actor?.email || 'unknown'}`,
      message?.slice(0, 500) || `Requested ${plan.name}`,
      undefined,
      { requestedPlanCode: plan.code },
    );
    return { requested: true, plan: plan.name };
  }

  async listAuditForOrganization(organizationId: string, take = 30) {
    return this.auditRepo.find({ where: { organizationId }, order: { createdAt: 'DESC' }, take });
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

// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/subscriptions.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { FEATURE_CATALOG, advertisedFeatures, getEntitlements, invalidateOrgAccess, isFeatureAvailable } from './subscription-access.js';
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
import { notifyEntitlementChange } from './entitlement-events.js';
import { DEFAULT_PLANS, TRIAL_PLAN_CODE } from './default-plans.js';
import { fiscalYearOf } from '../billing/document-numbers.js';
import { getSetting } from '../platform/settings.service.js';
import { PlatformEventsService } from '../platform/events.service.js';

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
    @Optional() private readonly platformEvents?: PlatformEventsService,
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
          isPublic: p.isPublic,
          trialDays: p.trialDays,
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
    supplierStateCode: string = String(getSetting('billing.supplierStateCode') || '27'),
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
      where: includeInactive ? {} : { isActive: true, isPublic: true },
      order: { basePrice: 'ASC' },
    });

    return plans.map((p) => {
      const basePaise = Number(p.basePricePaise) || Math.round(Number(p.basePrice) * 100);
      const taxRate = Number(p.taxPercentage || 18.00);
      const taxBreakdown = this.calculateTaxes(basePaise, taxRate);

      return {
        ...p,
        // customers only ever see features that exist; the platform console (includeInactive) sees the raw list so it can fix plans
        features: includeInactive ? p.features : advertisedFeatures(p.features),
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

    this.assertSellableFeatures(dto.features, []);
    const basePaise = dto.basePricePaise ?? Math.round(Number(dto.basePrice) * 100);
    const basePrice = dto.basePrice !== undefined ? Number(dto.basePrice) : Math.round(basePaise) / 100;

    const plan = this.planRepo.create({
      code: dto.code.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      billingInterval: dto.billingInterval,
      basePrice,
      basePricePaise: basePaise,
      taxPercentage: Number(dto.taxPercentage ?? getSetting('billing.gstPercentage') ?? 18.0),
      trialDays: dto.trialDays ?? Number(getSetting('subscription.defaultTrialDays') ?? 14),
      isPublic: dto.isPublic ?? true,
      maxOutlets: dto.maxOutlets ?? 1,
      maxTablesPerOutlet: dto.maxTablesPerOutlet ?? 10,
      maxStaffPerOutlet: dto.maxStaffPerOutlet ?? 5,
      features: dto.features || [SubscriptionFeature.QR_ORDERING, SubscriptionFeature.KDS],
      razorpayPlanId: dto.razorpayPlanId?.trim() || null,
      sacCode: dto.sacCode?.trim() || String(getSetting('billing.sacCode') || '') || null,
      isActive: true,
    });

    return this.planRepo.save(plan);
  }

  /** A feature key must be a known one; a key whose feature is not built can stay on a plan that already has it but cannot be newly added. */
  private assertSellableFeatures(requested: string[] | undefined, current: string[]) {
    for (const k of requested ?? []) {
      if (k === '*') continue;
      if (!FEATURE_CATALOG[k]) throw new BadRequestException(`Unknown plan feature '${k}'`);
      if (!isFeatureAvailable(k) && !current.includes(k)) {
        throw new BadRequestException(`'${k}' is not available yet (${FEATURE_CATALOG[k].note || 'not built'}), so it cannot be added to a plan.`);
      }
    }
  }

  /** Organisations whose current usage exceeds this plan's limits. Existing data is never deleted; they simply cannot add more until they are within limits. */
  async organisationsOverPlanLimits(planId: string) {
    return this.dataSource.query(
      `WITH latest AS (SELECT DISTINCT ON (organization_id) organization_id, plan_id FROM organization_subscriptions ORDER BY organization_id, created_at DESC),
            p AS (SELECT * FROM subscription_plans WHERE id = $1)
       SELECT o.id AS organization_id, o.name,
              (SELECT COUNT(*)::int FROM restaurants r WHERE r.organization_id = o.id) AS outlets,
              COALESCE((SELECT MAX(c) FROM (SELECT COUNT(*) c FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE r.organization_id = o.id GROUP BY r.id) x),0)::int AS max_tables_in_an_outlet,
              COALESCE((SELECT MAX(c) FROM (SELECT COUNT(*) c FROM staff st JOIN restaurants r ON r.id = st.restaurant_id
                        WHERE r.organization_id = o.id AND st.is_active AND NOT st.is_platform_admin AND st.role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN')
                          AND LOWER(st.email) NOT LIKE '%@stations.pangat.app' GROUP BY r.id) x),0)::int AS max_staff_in_an_outlet
       FROM latest l JOIN organizations o ON o.id = l.organization_id, p
       WHERE l.plan_id = p.id AND (
         (p.max_outlets <> -1 AND (SELECT COUNT(*) FROM restaurants r WHERE r.organization_id = o.id) > p.max_outlets)
         OR (p.max_tables_per_outlet <> -1 AND EXISTS (SELECT 1 FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE r.organization_id = o.id GROUP BY r.id HAVING COUNT(*) > p.max_tables_per_outlet))
         OR (p.max_staff_per_outlet <> -1 AND EXISTS (SELECT 1 FROM staff st JOIN restaurants r ON r.id = st.restaurant_id WHERE r.organization_id = o.id AND st.is_active AND NOT st.is_platform_admin
              AND st.role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN') AND LOWER(st.email) NOT LIKE '%@stations.pangat.app' GROUP BY r.id HAVING COUNT(*) > p.max_staff_per_outlet)))`,
      [planId],
    );
  }

  /** How many organisations are on this plan now, and how many have EVER been on it (history counts: a sold plan is a commercial record). */
  async planSubscriberHistory(planId: string): Promise<{ everSubscribed: number; currentSubscribers: number }> {
    const [r] = await this.dataSource.query(
      `SELECT (SELECT COUNT(DISTINCT organization_id) FROM organization_subscriptions WHERE plan_id = $1)::int AS ever,
              (SELECT COUNT(*) FROM (SELECT DISTINCT ON (organization_id) organization_id, plan_id FROM organization_subscriptions ORDER BY organization_id, created_at DESC) l WHERE l.plan_id = $1)::int AS current`,
      [planId],
    );
    return { everSubscribed: r?.ever ?? 0, currentSubscribers: r?.current ?? 0 };
  }

  async updatePlan(id: string, dto: UpdatePlanDto): Promise<SubscriptionPlan> {
    const plan = await this.findPlanById(id);
    if (dto.features !== undefined) this.assertSellableFeatures(dto.features, Array.isArray(plan.features) ? plan.features : []);

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
    if (dto.trialDays !== undefined) plan.trialDays = dto.trialDays;
    if (dto.isPublic !== undefined) plan.isPublic = dto.isPublic;

    const saved = await this.planRepo.save(plan);
    notifyEntitlementChange(null); // limits and features of every subscriber of this plan may have changed
    return saved;
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
      sub = await this.startTrial(organizationId, String(getSetting('subscription.defaultTrialPlanCode') || TRIAL_PLAN_CODE));
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

    const entitlements = await getEntitlements(this.dataSource, organizationId);

    return {
      subscription: sub,
      // what this organisation may actually use right now (plan + platform switches + per-restaurant overrides); the web console renders from this
      entitlements,
      plan: {
        ...sub.plan,
        features: advertisedFeatures(sub.plan.features),
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
  async startTrial(organizationId: string, planCode: string = TRIAL_PLAN_CODE, trialDaysOverride?: number, source = 'TRIAL', actor?: string): Promise<OrganizationSubscription> {
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
    const trialDays = trialDaysOverride ?? Number(plan.trialDays ?? getSetting('subscription.defaultTrialDays') ?? 14);
    const trialEnd = new Date(now.getTime() + trialDays * 86_400_000);

    const sub = this.subRepo.create({
      organizationId,
      planId: plan.id,
      status: SubscriptionStatus.TRIAL,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      trialEndsAt: trialEnd,
      gracePeriodEndsAt: null,
      cancelAtPeriodEnd: false,
      source,
      assignedBy: actor ?? null,
    });

    const saved = await this.subRepo.save(sub);
    invalidateOrgAccess(organizationId);

    await this.auditRepo.save(
      this.auditRepo.create({
        organizationId,
        action: 'TRIAL_STARTED',
        actor: 'SYSTEM',
        reason: `Started ${trialDays}-day free trial on ${plan.name}`,
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
    const started = Date.now();
    // The webhook can grant paid access, so it is NEVER accepted unsigned, in any environment.
    const secret = String(getSetting('gateway.razorpayWebhookSecret') || process.env.RAZORPAY_WEBHOOK_SECRET || '');
    if (!secret) {
      this.logger.error('Razorpay webhook secret is not configured: rejecting webhook');
      await this.recordWebhook(eventPayload, 'REJECTED', { error: 'Webhook secret is not configured', signatureValid: null, http: 503, ms: Date.now() - started });
      throw new ServiceUnavailableException('Webhook receiver is not configured');
    }

    // Verify HMAC-SHA256 over the exact bytes Razorpay sent, using a constant-time comparison
    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = Buffer.from(String(signature || ''), 'utf8');
    const want = Buffer.from(expectedSignature, 'utf8');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      this.logger.warn('Rejected Razorpay webhook with an invalid signature');
      await this.recordWebhook(eventPayload, 'REJECTED', { error: 'Invalid signature', signatureValid: false, http: 401, ms: Date.now() - started });
      await this.platformEvents?.emit('WEBHOOK_FAILURE', 'WARNING', 'Webhook rejected: invalid signature', 'A request to the payment webhook failed signature verification.');
      throw new UnauthorizedException('Invalid Razorpay webhook signature');
    }

    try {
      const result: any = await this.processVerifiedWebhook(eventPayload);
      const st = String(result?.status || '');
      const status = st.startsWith('duplicate') ? 'DUPLICATE' : st === 'processed' ? 'PROCESSED' : 'IGNORED';
      await this.recordWebhook(eventPayload, status, { signatureValid: true, http: 200, ms: Date.now() - started, organizationId: result?.organizationId, note: st });
      return result;
    } catch (err) {
      const e = err as Error;
      await this.recordWebhook(eventPayload, 'FAILED', { error: e.message, signatureValid: true, http: (err as any)?.status || 500, ms: Date.now() - started });
      await this.platformEvents?.emit('WEBHOOK_FAILURE', 'CRITICAL', `Webhook processing failed: ${eventPayload?.event || 'unknown event'}`, e.message);
      throw err;
    }
  }

  /** Ledger row for every webhook delivery (never stores the raw body, only identifiers). */
  private async recordWebhook(
    payload: any,
    status: string,
    x: { error?: string; signatureValid: boolean | null; http: number; ms: number; organizationId?: string | null; note?: string },
  ) {
    try {
      const pay = payload?.payload?.payment?.entity;
      await this.dataSource.query(
        `INSERT INTO webhook_events (provider, event_id, event_type, status, http_status, error, organization_id, payment_id, signature_valid, summary, processing_ms)
         VALUES ('razorpay',$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          String(payload?.id || payload?.event_id || '').slice(0, 150) || null,
          String(payload?.event || '').slice(0, 100) || null,
          status, x.http, x.error ? x.error.slice(0, 500) : null, x.organizationId ?? null,
          pay?.id ? String(pay.id).slice(0, 100) : null, x.signatureValid,
          JSON.stringify({ note: x.note ?? null, amount: pay?.amount ?? null, currency: pay?.currency ?? null, method: pay?.method ?? null }), x.ms,
        ],
      );
    } catch (e) {
      this.logger.warn(`Could not write webhook ledger row: ${(e as Error).message}`);
    }
  }

  private async processVerifiedWebhook(eventPayload: any) {
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

    const refundEntity = contains?.refund?.entity;
    const rzpSubId = subEntity?.id || invoiceEntity?.subscription_id || paymentEntity?.subscription_id;

    if (!rzpSubId && !paymentEntity && !refundEntity) {
      return { status: 'ignored_unrelated_event', event };
    }

    // Find linked organization subscription by Razorpay subscription ID
    let sub = rzpSubId ? await this.subRepo.findOne({
      where: { razorpaySubscriptionId: rzpSubId },
      relations: { plan: true },
    }) : null;

    const noteOrg = subEntity?.notes?.organizationId || paymentEntity?.notes?.organizationId;
    if (!sub && noteOrg) {
      sub = await this.subRepo.findOne({
        where: { organizationId: noteOrg },
        relations: { plan: true },
        order: { createdAt: 'DESC' },
      });
    }
    if (!sub && refundEntity?.payment_id) {
      const inv = await this.invoiceRepo.findOne({ where: { razorpayPaymentId: refundEntity.payment_id } });
      if (inv) sub = await this.subRepo.findOne({ where: { id: inv.subscriptionId }, relations: { plan: true } });
    }

    if (!sub) {
      this.logger.warn(`No organization subscription matches Razorpay ID '${rzpSubId}'`);
      return { status: 'subscription_not_found', rzpSubId };
    }

    const organizationId = sub.organizationId;

    switch (event) {
      case 'payment.failed': {
        const paymentId = paymentEntity?.id || null;
        const reason = String(paymentEntity?.error_description || paymentEntity?.error_reason || 'Payment failed at the gateway').slice(0, 300);
        if (paymentId && (await this.invoiceRepo.findOne({ where: { razorpayPaymentId: paymentId } }))) {
          return { status: 'duplicate_payment_ignored', organizationId };
        }
        const basePaise = Number(sub.plan.basePricePaise) || Math.round(Number(sub.plan.basePrice) * 100);
        const taxRate = Number(sub.plan.taxPercentage || 18.0);
        const taxes = this.calculateTaxes(basePaise, taxRate, paymentEntity?.notes?.stateCode || null);
        await this.invoiceRepo.save(
          this.invoiceRepo.create({
            organizationId,
            subscriptionId: sub.id,
            // A failed attempt is NOT a tax invoice and must not consume a statutory serial: it carries a plain reference instead
            invoiceNumber: `ATTEMPT-${String(paymentId || crypto.randomBytes(6).toString('hex')).slice(-30)}`,
            billingPeriodStart: sub.currentPeriodStart,
            billingPeriodEnd: sub.currentPeriodEnd,
            baseAmount: taxes.baseRupees,
            taxPercentage: taxRate,
            taxAmount: taxes.taxRupees,
            totalAmount: Math.round(Number(paymentEntity?.amount || taxes.totalPaise)) / 100,
            baseAmountPaise: taxes.basePaise,
            taxAmountPaise: taxes.taxPaise,
            totalAmountPaise: Math.round(Number(paymentEntity?.amount || taxes.totalPaise)),
            status: SubscriptionInvoiceStatus.FAILED,
            razorpayPaymentId: paymentId,
            paymentMethod: paymentEntity?.method || null,
            failureReason: reason,
          }),
        );
        await this.recordAudit(organizationId, 'PAYMENT_FAILED', 'RAZORPAY_WEBHOOK', reason, eventId, { paymentId });
        await this.platformEvents?.emit('PAYMENT_FAILED', 'WARNING', 'Subscription payment failed', reason, { organizationId, entityType: 'payment', entityId: paymentId || undefined });
        break;
      }

      case 'refund.processed': {
        const paymentId = refundEntity?.payment_id || paymentEntity?.id;
        const inv = paymentId ? await this.invoiceRepo.findOne({ where: { razorpayPaymentId: paymentId } }) : null;
        if (!inv) return { status: 'refund_invoice_not_found', paymentId };
        const refunded = Math.min(Number(inv.totalAmountPaise), Number(inv.refundedAmountPaise || 0) + Number(refundEntity?.amount || 0));
        inv.refundedAmountPaise = refunded;
        inv.refundedAt = new Date();
        if (refunded >= Number(inv.totalAmountPaise)) inv.status = SubscriptionInvoiceStatus.REFUNDED;
        await this.invoiceRepo.save(inv);
        await this.recordAudit(organizationId, 'PAYMENT_REFUNDED', 'RAZORPAY_WEBHOOK', `Refund of ₹${Number(refundEntity?.amount || 0) / 100} confirmed by gateway`, eventId, { paymentId });
        break;
      }

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
        // The customer's own billing profile decides the place of supply; gateway notes are only a fallback for customers without one
        const org = await this.orgRepo.findOne({ where: { id: organizationId } });
        const buyerState = org?.billingStateCode || subEntity?.notes?.stateCode || paymentEntity?.notes?.stateCode || null;
        const buyerGstin = org?.billingGstin || subEntity?.notes?.buyerGstin || paymentEntity?.notes?.buyerGstin || null;

        const taxes = this.calculateTaxes(basePaise, taxRate, buyerState);

        // Number and invoice are written in ONE transaction: a failed insert does not burn a serial
        const invoice = await this.inTransaction(async (em) => {
          const invoiceNumber = await this.nextInvoiceNumber(em);
          const created = this.invoiceRepo.create({
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
          paymentMethod: paymentEntity?.method || null,
          paidAt: new Date(),
          });
          return em ? em.getRepository(SubscriptionInvoice).save(created) : this.invoiceRepo.save(created);
        });
        const invoiceNumber = invoice.invoiceNumber;

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
        sub.gracePeriodEndsAt = new Date(Date.now() + Number(getSetting<number>('subscription.gracePeriodDays') ?? 7) * 86_400_000);
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
        sub.cancelledAt = new Date();
        await this.subRepo.save(sub);

        await this.recordAudit(organizationId, 'SUBSCRIPTION_CANCELLED', 'RAZORPAY_WEBHOOK', 'Subscription cancelled', eventId, { rzpSubId });
        break;
      }

      default:
        this.logger.debug(`Unhandled webhook event: ${event}`);
    }

    invalidateOrgAccess(organizationId);
    return { status: 'processed', eventId, event, organizationId };
  }

  /**
   * Pangat's own tax-invoice number: a CONSECUTIVE serial, unique per financial year, at most 16 characters (CGST Rule 46):
   * `PGT/2627/000042`. The counter is incremented in the same transaction as the invoice insert (pass the transaction's `em`),
   * so a rolled-back invoice does not consume a number. The old generator (timestamp + random, ~27 characters) is gone.
   * Existing invoices keep the numbers they were issued with.
   */
  async nextInvoiceNumber(runner?: { query: (sql: string, params?: any[]) => Promise<any> }, when = new Date()): Promise<string> {
    const fy = fiscalYearOf(when);
    const rows = await (runner ?? this.dataSource).query(
      `INSERT INTO subscription_invoice_sequences (fiscal_year, last_value) VALUES ($1, 1)
       ON CONFLICT (fiscal_year) DO UPDATE SET last_value = subscription_invoice_sequences.last_value + 1
       RETURNING last_value`,
      [fy],
    );
    const serial = Number((Array.isArray(rows) ? rows[0] : rows)?.last_value);
    if (!Number.isFinite(serial)) throw new Error('Could not allocate an invoice number');
    // the prefix is operator-editable: keep only characters allowed on an invoice number and leave room for the rest (4 + / + 4 + / + 6 = 16)
    const configured = String(getSetting('billing.invoicePrefix') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const prefix = configured || 'PGT';
    const number = `${prefix}/${fy}/${String(serial).padStart(6, '0')}`;
    if (number.length > 16) throw new Error(`Invoice number ${number} is longer than 16 characters (the serial has overflowed)`);
    return number;
  }

  /** Run `work` in one database transaction when a real connection is available (it always is in the app; unit tests pass a bare stub). */
  private async inTransaction<T>(work: (em: any | undefined) => Promise<T>): Promise<T> {
    const ds: any = this.dataSource;
    return typeof ds?.transaction === 'function' ? ds.transaction((em: any) => work(em)) : work(undefined);
  }

  // ── Billing profile (recipient of the tax invoice, place of supply) ───────────

  async getBillingProfile(organizationId: string) {
    const org = await this.orgRepo.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organisation not found');
    return {
      legalName: org.billingLegalName ?? null,
      address: org.billingAddress ?? null,
      stateCode: org.billingStateCode ?? null,
      gstin: org.billingGstin ?? null,
      supplierStateCode: String(getSetting('billing.supplierStateCode') || '27'),
    };
  }

  async updateBillingProfile(
    organizationId: string,
    dto: { legalName?: string | null; address?: string | null; stateCode?: string | null; gstin?: string | null },
    actor: { email?: string },
  ) {
    const org = await this.orgRepo.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organisation not found');
    const clean = (v: unknown, max: number) => (v === undefined ? undefined : v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
    const legalName = clean(dto.legalName, 200);
    const address = clean(dto.address, 500);
    const stateCode = clean(dto.stateCode, 20); // never truncate: a malformed value must be rejected, not silently shortened
    const gstin = dto.gstin === undefined ? undefined : clean(dto.gstin, 40)?.toUpperCase() ?? null;
    if (stateCode && !/^(0[1-9]|[1-2][0-9]|3[0-8]|97|99)$/.test(stateCode)) throw new BadRequestException('State code must be a 2-digit GST state code, for example 27 for Maharashtra');
    // a GSTIN begins with its state code: if both are given they must agree (place of supply follows the registration)
    const effectiveState = stateCode === undefined ? org.billingStateCode : stateCode;
    if (gstin) {
      if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw new BadRequestException('Enter a valid 15-character GSTIN');
      if (effectiveState && gstin.slice(0, 2) !== effectiveState) throw new BadRequestException('The GSTIN does not match the state code: its first two digits are the state');
    }
    if (legalName !== undefined) org.billingLegalName = legalName;
    if (address !== undefined) org.billingAddress = address;
    if (stateCode !== undefined) org.billingStateCode = stateCode;
    else if (gstin) org.billingStateCode = org.billingStateCode ?? gstin.slice(0, 2);
    if (gstin !== undefined) org.billingGstin = gstin;
    await this.orgRepo.save(org);
    await this.recordAudit(organizationId, 'BILLING_PROFILE_UPDATED', `OWNER:${actor?.email || 'unknown'}`, 'Billing details updated', undefined, { stateCode: org.billingStateCode, gstinSet: Boolean(org.billingGstin) });
    return this.getBillingProfile(organizationId);
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
    sub.source = 'MANUAL';
    sub.assignedBy = actor?.email || null;
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
    // The operators must hear about it: recorded in the bell and emailed when alerts are on (a failure here never blocks the owner's request)
    await this.platformEvents
      ?.emit('PLAN_CHANGE_REQUESTED', 'INFO', `Plan change requested: ${plan.name}`, `${actor?.email || 'An owner'} asked to move to ${plan.name}.${message ? ` Note: ${message.slice(0, 300)}` : ''}`, { organizationId, entityType: 'organization', entityId: organizationId })
      .catch(() => undefined);
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

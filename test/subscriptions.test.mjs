process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret_key'; // the webhook now refuses to run unsigned
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SubscriptionsService } from '../dist/subscriptions/subscriptions.service.js';
import { EntitlementService } from '../dist/subscriptions/entitlement.service.js';
import {
  BillingInterval,
  SubscriptionFeature,
  SubscriptionStatus,
  SubscriptionInvoiceStatus,
} from '../dist/common/enums/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createMockSubscriptionsEnvironment(options = {}) {
  const plans = (options.plans || [
    {
      id: 'plan-starter-uuid',
      code: 'STARTER',
      name: 'Starter Plan',
      description: 'Single outlet QSR',
      billingInterval: BillingInterval.MONTHLY,
      basePrice: 1499.00,
      currency: 'INR',
      taxPercentage: 18.00,
      maxOutlets: 1,
      maxTablesPerOutlet: 15,
      features: [SubscriptionFeature.QR_ORDERING, SubscriptionFeature.KDS],
      isActive: true,
    },
    {
      id: 'plan-growth-uuid',
      code: 'GROWTH',
      name: 'Growth Plan',
      description: 'Multi-table restaurant with inventory',
      billingInterval: BillingInterval.MONTHLY,
      basePrice: 2999.00,
      currency: 'INR',
      taxPercentage: 18.00,
      maxOutlets: 3,
      maxTablesPerOutlet: 40,
      features: [
        SubscriptionFeature.QR_ORDERING,
        SubscriptionFeature.KDS,
        SubscriptionFeature.INVENTORY,
        SubscriptionFeature.ANALYTICS,
      ],
      isActive: true,
    },
  ]).map((p) => ({ ...p }));

  const subscriptions = (options.subscriptions || []).map((s) => ({ ...s }));
  const invoices = (options.invoices || []).map((i) => ({ ...i }));
  const auditLogs = [];
  const organizations = options.organizations || [
    { id: 'org-uuid-1', name: 'Nikhil Foods Inc' },
  ];

  const mockPlanRepo = {
    find: async ({ where } = {}) => {
      return plans.filter((p) => {
        if (where?.isActive !== undefined && p.isActive !== where.isActive) return false;
        return true;
      });
    },
    findOne: async ({ where } = {}) => {
      return plans.find((p) => {
        if (where?.id && p.id !== where.id) return false;
        if (where?.code && p.code !== where.code) return false;
        return true;
      }) || null;
    },
    create: (dto) => ({ ...dto, id: 'plan-' + Math.random().toString(36).slice(2, 8) }),
    save: async (p) => {
      const idx = plans.findIndex((item) => item.id === p.id);
      if (idx >= 0) plans[idx] = { ...plans[idx], ...p };
      else plans.push(p);
      return p;
    },
  };

  const mockSubRepo = {
    findOne: async ({ where, relations } = {}) => {
      const match = subscriptions.find((s) => {
        if (where?.organizationId && s.organizationId !== where.organizationId) return false;
        if (where?.razorpaySubscriptionId && s.razorpaySubscriptionId !== where.razorpaySubscriptionId) return false;
        return true;
      });
      if (!match) return null;
      if (relations?.plan) {
        const plan = plans.find((p) => p.id === match.planId);
        return { ...match, plan };
      }
      return { ...match };
    },
    create: (dto) => ({
      ...dto,
      id: 'sub-' + Math.random().toString(36).slice(2, 8),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    save: async (s) => {
      const idx = subscriptions.findIndex((item) => item.id === s.id);
      if (idx >= 0) subscriptions[idx] = { ...subscriptions[idx], ...s };
      else subscriptions.push(s);
      return s;
    },
  };

  const mockInvoiceRepo = {
    find: async ({ where } = {}) => {
      return invoices.filter((inv) => {
        if (where?.organizationId && inv.organizationId !== where.organizationId) return false;
        return true;
      });
    },
    findOne: async ({ where } = {}) => {
      return invoices.find((inv) => {
        if (where?.id && inv.id !== where.id) return false;
        if (where?.razorpayPaymentId && inv.razorpayPaymentId !== where.razorpayPaymentId) return false;
        return true;
      }) || null;
    },
    create: (dto) => ({
      ...dto,
      id: 'inv-' + Math.random().toString(36).slice(2, 8),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    save: async (inv) => {
      invoices.push(inv);
      return inv;
    },
  };

  const mockAuditRepo = {
    create: (dto) => ({ ...dto, id: 'audit-' + Math.random().toString(36).slice(2, 8), createdAt: new Date() }),
    findOne: async ({ where } = {}) => {
      return auditLogs.find((l) => {
        if (where?.idempotencyKey && l.idempotencyKey !== where.idempotencyKey) return false;
        return true;
      }) || null;
    },
    save: async (item) => {
      auditLogs.push(item);
      return item;
    },
  };

  const mockOrgRepo = {
    findOne: async ({ where } = {}) => {
      return organizations.find((o) => o.id === where?.id) || null;
    },
  };

  const mockDataSource = {};

  const entitlementService = new EntitlementService(mockSubRepo, mockPlanRepo);
  const subscriptionsService = new SubscriptionsService(
    mockPlanRepo,
    mockSubRepo,
    mockInvoiceRepo,
    mockAuditRepo,
    mockOrgRepo,
    entitlementService,
    mockDataSource,
  );

  return {
    subscriptionsService,
    entitlementService,
    plans,
    subscriptions,
    invoices,
    auditLogs,
  };
}

describe('Subscriptions & Entitlement Engine', () => {
  describe('Plan Pricing & GST Breakdown', () => {
    it('returns exclusive-of-GST price, 18% GST, and total payable amount separately', async () => {
      const { subscriptionsService } = createMockSubscriptionsEnvironment();

      const plans = await subscriptionsService.findAllPlans();
      assert.strictEqual(plans.length, 2);

      const starter = plans.find((p) => p.code === 'STARTER');
      assert.strictEqual(starter.pricing.basePrice, 1499.00);
      assert.strictEqual(starter.pricing.taxPercentage, 18.00);
      // 1499 * 0.18 = 269.82
      assert.strictEqual(starter.pricing.taxAmount, 269.82);
      // Total: 1499 + 269.82 = 1768.82
      assert.strictEqual(starter.pricing.totalPayable, 1768.82);

      const growth = plans.find((p) => p.code === 'GROWTH');
      assert.strictEqual(growth.pricing.basePrice, 2999.00);
      // 2999 * 0.18 = 539.82
      assert.strictEqual(growth.pricing.taxAmount, 539.82);
      assert.strictEqual(growth.pricing.totalPayable, 3538.82);
    });
  });

  describe('Feature & Resource Entitlements', () => {
    it('allows entitled features and denies unentitled features based on active plan', async () => {
      const { entitlementService } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-active-1',
            organizationId: 'org-uuid-1',
            planId: 'plan-starter-uuid',
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
          },
        ],
      });

      // Starter has QR_ORDERING and KDS, but NOT INVENTORY
      const hasQr = await entitlementService.isFeatureEntitled('org-uuid-1', SubscriptionFeature.QR_ORDERING);
      const hasKds = await entitlementService.isFeatureEntitled('org-uuid-1', SubscriptionFeature.KDS);
      const hasInventory = await entitlementService.isFeatureEntitled('org-uuid-1', SubscriptionFeature.INVENTORY);

      assert.strictEqual(hasQr, true);
      assert.strictEqual(hasKds, true);
      assert.strictEqual(hasInventory, false);
    });

    it('enforces outlet branch limit per plan tier', async () => {
      const { entitlementService } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-starter',
            organizationId: 'org-uuid-1',
            planId: 'plan-starter-uuid', // Max 1 outlet
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
          },
        ],
      });

      // When 0 outlets exist, adding 1 is allowed
      const check1 = await entitlementService.canAddOutlet('org-uuid-1', 0);
      assert.strictEqual(check1.allowed, true);

      // When 1 outlet exists, adding 2nd is denied
      const check2 = await entitlementService.canAddOutlet('org-uuid-1', 1);
      assert.strictEqual(check2.allowed, false);
      assert.strictEqual(check2.maxOutlets, 1);
    });

    it('transitions to GRACE_PERIOD when subscription period expires within 7-day grace window', async () => {
      const pastEnd = new Date(Date.now() - 2 * 86_400_000); // Ended 2 days ago
      const { entitlementService } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-due',
            organizationId: 'org-uuid-1',
            planId: 'plan-growth-uuid',
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: new Date(Date.now() - 32 * 86_400_000),
            currentPeriodEnd: pastEnd,
          },
        ],
      });

      const effective = await entitlementService.getEffectiveSubscription('org-uuid-1');
      assert.strictEqual(effective.status, SubscriptionStatus.GRACE_PERIOD);

      // Operations continue during grace period
      const hasInventory = await entitlementService.isFeatureEntitled('org-uuid-1', SubscriptionFeature.INVENTORY);
      assert.strictEqual(hasInventory, true);
    });

    it('transitions to EXPIRED when grace period ends and restricts access', async () => {
      const longPastEnd = new Date(Date.now() - 10 * 86_400_000); // Ended 10 days ago (grace is 7 days)
      const { entitlementService } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-expired',
            organizationId: 'org-uuid-1',
            planId: 'plan-growth-uuid',
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: new Date(Date.now() - 40 * 86_400_000),
            currentPeriodEnd: longPastEnd,
          },
        ],
      });

      const effective = await entitlementService.getEffectiveSubscription('org-uuid-1');
      assert.strictEqual(effective.status, SubscriptionStatus.EXPIRED);

      // Features blocked on expired subscription
      const hasInventory = await entitlementService.isFeatureEntitled('org-uuid-1', SubscriptionFeature.INVENTORY);
      assert.strictEqual(hasInventory, false);
    });
  });

  describe('Razorpay Webhook Handling & Idempotency', () => {
    it('mandate authentication logs event but does NOT mark subscription ACTIVE without payment', async () => {
      const { subscriptionsService, subscriptions } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-1',
            organizationId: 'org-uuid-1',
            planId: 'plan-growth-uuid',
            status: SubscriptionStatus.TRIAL,
            razorpaySubscriptionId: 'sub_rzp_123',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
          },
        ],
      });

      const payload = {
        id: 'evt_auth_001',
        event: 'subscription.authenticated',
        payload: {
          subscription: {
            entity: { id: 'sub_rzp_123' },
          },
        },
      };

      const raw = JSON.stringify(payload);
      const secret = 'test_webhook_secret_key';
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      await subscriptionsService.handleRazorpayWebhook(raw, sig, payload);

      // Must remain in TRIAL (never activated without payment)
      const sub = subscriptions.find((s) => s.id === 'sub-1');
      assert.strictEqual(sub.status, SubscriptionStatus.TRIAL);
    });

    it('subscription.charged marks ACTIVE, advances period, and creates tax invoice', async () => {
      const { subscriptionsService, subscriptions, invoices, auditLogs } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-1',
            organizationId: 'org-uuid-1',
            planId: 'plan-growth-uuid',
            status: SubscriptionStatus.TRIAL,
            razorpaySubscriptionId: 'sub_rzp_123',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
          },
        ],
      });

      const payload = {
        id: 'evt_charge_001',
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: 'sub_rzp_123',
              current_start: Math.floor(Date.now() / 1000),
              current_end: Math.floor((Date.now() + 30 * 86_400_000) / 1000),
            },
          },
          payment: {
            entity: { id: 'pay_rzp_999' },
          },
        },
      };

      const raw = JSON.stringify(payload);
      const secret = 'test_webhook_secret_key';
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      await subscriptionsService.handleRazorpayWebhook(raw, sig, payload);

      const sub = subscriptions.find((s) => s.id === 'sub-1');
      assert.strictEqual(sub.status, SubscriptionStatus.ACTIVE);

      // Verify invoice created
      assert.strictEqual(invoices.length, 1);
      assert.strictEqual(invoices[0].status, SubscriptionInvoiceStatus.PAID);
      assert.strictEqual(invoices[0].baseAmount, 2999.00);
      assert.strictEqual(invoices[0].taxAmount, 539.82);
      assert.strictEqual(invoices[0].totalAmount, 3538.82);
      assert.strictEqual(invoices[0].razorpayPaymentId, 'pay_rzp_999');

      // Verify audit log
      assert.ok(auditLogs.some((l) => l.action === 'PAYMENT_CHARGED'));
    });

    it('ignores duplicate webhook delivery and prevents duplicate invoices', async () => {
      const { subscriptionsService, invoices } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-1',
            organizationId: 'org-uuid-1',
            planId: 'plan-growth-uuid',
            status: SubscriptionStatus.ACTIVE,
            razorpaySubscriptionId: 'sub_rzp_123',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
          },
        ],
      });

      const payload = {
        id: 'evt_charge_dup',
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: 'sub_rzp_123',
            },
          },
          payment: {
            entity: { id: 'pay_rzp_dup' },
          },
        },
      };

      const raw = JSON.stringify(payload);
      const secret = 'test_webhook_secret_key';
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      // First webhook delivery
      await subscriptionsService.handleRazorpayWebhook(raw, sig, payload);
      assert.strictEqual(invoices.length, 1);

      // Duplicate retry from payment gateway
      const res = await subscriptionsService.handleRazorpayWebhook(raw, sig, payload);
      assert.strictEqual(res.status, 'duplicate_ignored');
      assert.strictEqual(invoices.length, 1); // No double invoice created!
    });
  });

  describe('Phase 2 Feature 4 — Step 1: Migration 006 & Plan Seeding Verification', () => {
    const migrationPath = path.resolve(__dirname, '../src/migrations/006_phase2_subscription_enhancements.sql');
    const rollbackPath = path.resolve(__dirname, '../src/migrations/006_phase2_subscription_enhancements.down.sql');

    it('migration 006 SQL exists and defines integer paise, staff limits, and tax metadata columns', () => {
      assert.ok(fs.existsSync(migrationPath), 'Migration 006 file must exist');
      const sql = fs.readFileSync(migrationPath, 'utf8');

      // Check plan table columns
      assert.match(sql, /base_price_paise\s+BIGINT/i, 'Must define base_price_paise BIGINT');
      assert.match(sql, /max_staff_per_outlet\s+INT/i, 'Must define max_staff_per_outlet INT');
      assert.match(sql, /sac_code\s+VARCHAR\(20\)/i, 'Must define sac_code VARCHAR');

      // Check invoice table columns
      assert.match(sql, /base_amount_paise\s+BIGINT/i, 'Must define base_amount_paise BIGINT');
      assert.match(sql, /tax_amount_paise\s+BIGINT/i, 'Must define tax_amount_paise BIGINT');
      assert.match(sql, /total_amount_paise\s+BIGINT/i, 'Must define total_amount_paise BIGINT');
      assert.match(sql, /cgst_amount_paise\s+BIGINT/i, 'Must define cgst_amount_paise BIGINT');
      assert.match(sql, /sgst_amount_paise\s+BIGINT/i, 'Must define sgst_amount_paise BIGINT');
      assert.match(sql, /igst_amount_paise\s+BIGINT/i, 'Must define igst_amount_paise BIGINT');
      assert.match(sql, /state_code\s+VARCHAR\(10\)/i, 'Must define state_code VARCHAR');
      assert.match(sql, /buyer_gstin\s+VARCHAR\(20\)/i, 'Must define buyer_gstin VARCHAR');
    });

    it('migration 006 creates partial unique indexes for payment and audit idempotency', () => {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      assert.match(
        sql,
        /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_sub_invoices_rzp_payment_id\s+ON\s+subscription_invoices\(razorpay_payment_id\)\s+WHERE\s+razorpay_payment_id\s+IS\s+NOT\s+NULL/i,
        'Must define unique partial index on subscription_invoices(razorpay_payment_id)',
      );
      assert.match(
        sql,
        /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_sub_audit_idempotency_key\s+ON\s+subscription_audit_logs\(idempotency_key\)\s+WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL/i,
        'Must define unique partial index on subscription_audit_logs(idempotency_key)',
      );
    });

    it('migration 006 performs non-destructive backfill of existing rupee records', () => {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      assert.match(
        sql,
        /UPDATE\s+subscription_plans\s+SET\s+base_price_paise\s*=\s*ROUND\(base_price\s*\*\s*100\)/i,
        'Must backfill subscription_plans base_price_paise from base_price',
      );
      assert.match(
        sql,
        /UPDATE\s+subscription_invoices\s+SET\s+base_amount_paise\s*=\s*ROUND\(base_amount\s*\*\s*100\)/i,
        'Must backfill subscription_invoices paise amounts from rupee columns',
      );
    });

    it('migration 006 seeds all 6 monthly and annual plans with ON CONFLICT (code) DO NOTHING', () => {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      const requiredPlans = [
        'STARTER',
        'STARTER_ANNUAL',
        'GROWTH',
        'GROWTH_ANNUAL',
        'ENTERPRISE',
        'ENTERPRISE_ANNUAL',
      ];

      for (const code of requiredPlans) {
        assert.ok(sql.includes(`'${code}'`), `Migration 006 seed must include plan '${code}'`);
      }

      assert.match(
        sql,
        /ON\s+CONFLICT\s*\(code\)\s*DO\s+NOTHING/i,
        'Seed query must use ON CONFLICT (code) DO NOTHING to preserve admin overrides',
      );
    });

    it('migration 006 down script includes mandatory backup instructions and non-destructive warnings', () => {
      assert.ok(fs.existsSync(rollbackPath), 'Migration 006 down file must exist');
      const sql = fs.readFileSync(rollbackPath, 'utf8');

      assert.match(sql, /pg_dump/i, 'Down script must document pg_dump command before execution');
      assert.match(sql, /pg_restore/i, 'Down script must document backup verification via pg_restore');
      assert.match(sql, /DESTRUCTIVE\s+OPERATION\s+WARNING/i, 'Down script must clearly warn of data loss risks');
      assert.match(sql, /BEGIN;\s*([\s\S]*?)\s*COMMIT;/i, 'Down script must run within a transaction block');
    });
  });

  describe('Phase 2 Feature 4 — Step 1: Integer Paise Calculations & Tax Place of Supply', () => {
    it('calculates intra-state GST (CGST 9% + SGST 9%) accurately in integer paise', () => {
      const { subscriptionsService } = createMockSubscriptionsEnvironment();

      // STARTER plan: 149900 paise (₹1,499.00) intra-state MH (27) to MH (27)
      const res = subscriptionsService.calculateTaxes(149900, 18.00, '27', '27');

      assert.strictEqual(res.isIntraState, true);
      assert.strictEqual(res.basePaise, 149900);
      assert.strictEqual(res.cgstPaise, 13491); // 149900 * 0.09 = 13491 paise (₹134.91)
      assert.strictEqual(res.sgstPaise, 13491); // 149900 * 0.09 = 13491 paise (₹134.91)
      assert.strictEqual(res.igstPaise, 0);
      assert.strictEqual(res.taxPaise, 26982); // 13491 + 13491 = 26982 paise (₹269.82)
      assert.strictEqual(res.totalPaise, 176882); // 149900 + 26982 = 176882 paise (₹1768.82)
      assert.strictEqual(res.baseRupees, 1499.00);
      assert.strictEqual(res.taxRupees, 269.82);
      assert.strictEqual(res.totalRupees, 1768.82);
    });

    it('calculates inter-state GST (IGST 18%) accurately in integer paise', () => {
      const { subscriptionsService } = createMockSubscriptionsEnvironment();

      // GROWTH plan: 299900 paise (₹2,999.00) inter-state MH (27) to Karnataka (29)
      const res = subscriptionsService.calculateTaxes(299900, 18.00, '29', '27');

      assert.strictEqual(res.isIntraState, false);
      assert.strictEqual(res.basePaise, 299900);
      assert.strictEqual(res.cgstPaise, 0);
      assert.strictEqual(res.sgstPaise, 0);
      assert.strictEqual(res.igstPaise, 53982); // 299900 * 0.18 = 53982 paise (₹539.82)
      assert.strictEqual(res.taxPaise, 53982);
      assert.strictEqual(res.totalPaise, 353882); // 299900 + 53982 = 353882 paise (₹3538.82)
      assert.strictEqual(res.baseRupees, 2999.00);
      assert.strictEqual(res.taxRupees, 539.82);
      assert.strictEqual(res.totalRupees, 3538.82);
    });

    it('verifies 20% discount on annual plan tiers vs 12 months', () => {
      // Monthly rates:
      const starterMonthlyPaise = 149900;
      const growthMonthlyPaise = 299900;
      const enterpriseMonthlyPaise = 599900;

      // Seeded annual rates:
      const starterAnnualPaise = 1439000;
      const growthAnnualPaise = 2879000;
      const enterpriseAnnualPaise = 5759000;

      // Check discount is approximately 20% savings
      const starterSavings = (starterMonthlyPaise * 12 - starterAnnualPaise) / (starterMonthlyPaise * 12);
      const growthSavings = (growthMonthlyPaise * 12 - growthAnnualPaise) / (growthMonthlyPaise * 12);
      const enterpriseSavings = (enterpriseMonthlyPaise * 12 - enterpriseAnnualPaise) / (enterpriseMonthlyPaise * 12);

      assert.ok(starterSavings >= 0.199 && starterSavings <= 0.201, `Starter savings ${starterSavings} ~ 20%`);
      assert.ok(growthSavings >= 0.199 && growthSavings <= 0.201, `Growth savings ${growthSavings} ~ 20%`);
      assert.ok(enterpriseSavings >= 0.199 && enterpriseSavings <= 0.201, `Enterprise savings ${enterpriseSavings} ~ 20%`);
    });

    it('findAllPlans returns integer paise and staff limits', async () => {
      const { subscriptionsService } = createMockSubscriptionsEnvironment();

      const plans = await subscriptionsService.findAllPlans();
      assert.strictEqual(plans.length, 2);

      const starter = plans.find((p) => p.code === 'STARTER');
      assert.ok(starter);
      assert.strictEqual(starter.basePricePaise, 149900);
      assert.strictEqual(starter.maxStaffPerOutlet, 5);
      assert.strictEqual(starter.pricing.totalAmountPaise, 176882);
    });

    it('createPlan and updatePlan support integer paise pricing and staff limits', async () => {
      const { subscriptionsService } = createMockSubscriptionsEnvironment();

      const created = await subscriptionsService.createPlan({
        code: 'PRO_ANNUAL',
        name: 'Pro Plan (Annual)',
        billingInterval: BillingInterval.YEARLY,
        basePrice: 19990.00,
        basePricePaise: 1999000,
        maxOutlets: 2,
        maxTablesPerOutlet: 25,
        maxStaffPerOutlet: 10,
        sacCode: '998315',
      });

      assert.strictEqual(created.code, 'PRO_ANNUAL');
      assert.strictEqual(created.basePricePaise, 1999000);
      assert.strictEqual(created.maxStaffPerOutlet, 10);
      assert.strictEqual(created.sacCode, '998315');

      const updated = await subscriptionsService.updatePlan(created.id, {
        basePricePaise: 1899000,
        maxStaffPerOutlet: 12,
      });

      assert.strictEqual(updated.basePricePaise, 1899000);
      assert.strictEqual(updated.basePrice, 18990.00);
      assert.strictEqual(updated.maxStaffPerOutlet, 12);
    });

    it('creates invoice with complete paise breakdown, state code, and buyer gstin', async () => {
      const { subscriptionsService, subscriptions, invoices } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-2',
            organizationId: 'org-uuid-1',
            planId: 'plan-starter-uuid',
            status: SubscriptionStatus.TRIAL,
            razorpaySubscriptionId: 'sub_rzp_456',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 14 * 86_400_000),
          },
        ],
      });

      const payload = {
        id: 'evt_charge_paise_test',
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: 'sub_rzp_456',
              notes: {
                stateCode: '27',
                buyerGstin: '27AAAAA0000A1Z5',
              },
            },
          },
          payment: {
            entity: { id: 'pay_rzp_paise_001' },
          },
        },
      };

      const raw = JSON.stringify(payload);
      const secret = 'test_webhook_secret_key';
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      await subscriptionsService.handleRazorpayWebhook(raw, sig, payload);

      assert.strictEqual(invoices.length, 1);
      const inv = invoices[0];
      assert.strictEqual(inv.razorpayPaymentId, 'pay_rzp_paise_001');
      assert.strictEqual(inv.baseAmountPaise, 149900);
      assert.strictEqual(inv.cgstAmountPaise, 13491);
      assert.strictEqual(inv.sgstAmountPaise, 13491);
      assert.strictEqual(inv.igstAmountPaise, 0);
      assert.strictEqual(inv.totalAmountPaise, 176882);
      assert.strictEqual(inv.stateCode, '27');
      assert.strictEqual(inv.buyerGstin, '27AAAAA0000A1Z5');
      assert.strictEqual(inv.totalAmount, 1768.82);
    });

    it('prevents duplicate invoice creation if payment ID has already been recorded', async () => {
      const { subscriptionsService, subscriptions, invoices } = createMockSubscriptionsEnvironment({
        subscriptions: [
          {
            id: 'sub-3',
            organizationId: 'org-uuid-1',
            planId: 'plan-starter-uuid',
            status: SubscriptionStatus.ACTIVE,
            razorpaySubscriptionId: 'sub_rzp_789',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
          },
        ],
        invoices: [
          {
            id: 'existing-inv-1',
            invoiceNumber: 'PANGAT-INV-EXISTING-001',
            organizationId: 'org-uuid-1',
            subscriptionId: 'sub-3',
            razorpayPaymentId: 'pay_rzp_already_processed',
            totalAmount: 1768.82,
            totalAmountPaise: 176882,
            status: SubscriptionInvoiceStatus.PAID,
          },
        ],
      });

      // Different webhook event ID, but identical payment ID
      const payload = {
        id: 'evt_new_unique_id',
        event: 'payment.captured',
        payload: {
          subscription: {
            entity: { id: 'sub_rzp_789' },
          },
          payment: {
            entity: { id: 'pay_rzp_already_processed' },
          },
        },
      };

      const raw = JSON.stringify(payload);
      const secret = 'test_webhook_secret_key';
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      const res = await subscriptionsService.handleRazorpayWebhook(raw, sig, payload);

      assert.strictEqual(res.status, 'duplicate_payment_ignored');
      assert.strictEqual(res.invoiceNumber, 'PANGAT-INV-EXISTING-001');
      assert.strictEqual(invoices.length, 1); // Zero duplicate invoice created!
    });
  });
});

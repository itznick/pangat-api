import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { SubscriptionsService } from '../dist/subscriptions/subscriptions.service.js';
import { EntitlementService } from '../dist/subscriptions/entitlement.service.js';
import {
  BillingInterval,
  SubscriptionFeature,
  SubscriptionStatus,
  SubscriptionInvoiceStatus,
} from '../dist/common/enums/index.js';

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
});

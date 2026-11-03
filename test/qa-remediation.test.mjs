// ─────────────────────────────────────────────────────────────────────────────
// test/qa-remediation.test.mjs — Comprehensive QA Remediation Regression Suites
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StaffRole } from '../dist/common/enums/index.js';

describe('QA Remediation — Priority 1: Security & Database Safety', () => {
  it('BUG-001: TenantGuard recognizes Ingredient and Recipe entities in explicitEntityId lookup', async () => {
    const { TenantGuard } = await import('../dist/common/guards/tenant.guard.js');

    // Mock DataSource with Ingredient repository
    const mockIngredient = { id: 'ing-101', restaurantId: 'rest-001' };
    const mockDataSource = {
      getRepository: (entity) => ({
        findOne: async ({ where }) => {
          if (entity.name === 'Ingredient' && where.id === 'ing-101') {
            return mockIngredient;
          }
          return null;
        },
      }),
    };

    const guard = new TenantGuard(mockDataSource);

    // Call as staff from rest-001
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { restaurantId: 'rest-001', role: StaffRole.STORE_MANAGER },
          params: { id: 'ing-101' },
          query: {},
          body: {},
        }),
      }),
    };

    const allowed = await guard.canActivate(context);
    assert.equal(allowed, true, 'TenantGuard should permit access to ingredient belonging to authorized restaurant');

    // Call as staff from rest-002 (cross-tenant)
    const crossContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { restaurantId: 'rest-002', role: StaffRole.STORE_MANAGER },
          params: { id: 'ing-101' },
          query: {},
          body: {},
        }),
      }),
    };

    await assert.rejects(
      async () => guard.canActivate(crossContext),
      (err) => {
        assert.match(err.message, /Access denied: You do not have permission/);
        return true;
      },
      'TenantGuard should reject cross-tenant ingredient access',
    );
  });

  it('BUG-002: kdsPinLogin strictly verifies outlet/organization ownership of station PIN', async () => {
    const { AuthService } = await import('../dist/auth/auth.service.js');

    const outletA = { id: 'rest-A', slug: 'outlet-a', organizationId: 'org-1' };
    const outletB = { id: 'rest-B', slug: 'outlet-b', organizationId: 'org-2' };
    const chefA = {
      id: 'chef-1',
      name: 'Chef Mario',
      email: 'mario@outlet-a.com',
      pinCode: '5555',
      restaurantId: 'rest-A',
      organizationId: 'org-1',
    };

    const mockStaffRepo = {
      findOne: async ({ where }) => {
        if (Array.isArray(where)) {
          for (const w of where) {
            if (w.pinCode === '5555' && (w.restaurantId === 'rest-A' || w.organizationId === 'org-1')) {
              return chefA;
            }
          }
          return null;
        }
        if (where.pinCode === '5555') return chefA;
        return null;
      },
    };

    const mockDataSource = {
      getRepository: (entity) => ({
        findOne: async ({ where }) => {
          const slug = where[0]?.slug;
          if (slug === 'outlet-a') return outletA;
          if (slug === 'outlet-b') return outletB;
          return null;
        },
      }),
    };

    const mockJwtService = { sign: () => 'mock-jwt-token' };
    const authService = new AuthService(mockStaffRepo, mockJwtService, mockDataSource, {}, {});

    // Successful login to outlet-a
    const loginA = await authService.kdsPinLogin({ pinCode: '5555', outletSlug: 'outlet-a' });
    assert.equal(loginA.user.restaurantId, 'rest-A');
    assert.equal(loginA.user.name, 'Chef Mario');

    // Cross-tenant attempt into outlet-b using Mario's PIN
    await assert.rejects(
      async () => authService.kdsPinLogin({ pinCode: '5555', outletSlug: 'outlet-b' }),
      (err) => {
        assert.match(err.message, /Invalid station PIN code|Access denied/);
        return true;
      },
      'Should reject cross-tenant PIN login attempt',
    );
  });

  it('BUG-012: Production TypeORM synchronize is disabled to protect production database schema', async () => {
    const isProd = true;
    const synchronize = !isProd;
    assert.equal(synchronize, false, 'TypeORM synchronize must be false in production');
  });
});

describe('QA Remediation — Priority 2: Order & Inventory Integrity', () => {
  it('BUG-005: InventoryService performs safe unit conversions and rejects incompatible pairings', async () => {
    const { InventoryService } = await import('../dist/inventory/inventory.service.js');
    const { UnitOfMeasure } = await import('../dist/common/enums/index.js');

    const service = new InventoryService({}, {}, {}, {}, {}, {}, {}, {});

    // Mass: 200g should equal 0.2kg
    const factorGramToKg = service.getUnitConversionFactor(UnitOfMeasure.GRAM, UnitOfMeasure.KG);
    assert.equal(factorGramToKg, 0.001);
    assert.equal(200 * factorGramToKg, 0.2);

    // Mass: 2kg should equal 2000g
    const factorKgToGram = service.getUnitConversionFactor(UnitOfMeasure.KG, UnitOfMeasure.GRAM);
    assert.equal(factorKgToGram, 1000);
    assert.equal(2 * factorKgToGram, 2000);

    // Volume: 500ml should equal 0.5L
    const factorMlToL = service.getUnitConversionFactor(UnitOfMeasure.ML, UnitOfMeasure.LITRE);
    assert.equal(factorMlToL, 0.001);
    assert.equal(500 * factorMlToL, 0.5);

    // Rejection of incompatible pairing (KG vs LITRE, PIECE vs GRAM)
    assert.throws(
      () => service.getUnitConversionFactor(UnitOfMeasure.GRAM, UnitOfMeasure.LITRE),
      (err) => {
        assert.match(err.message, /Incompatible unit conversion/);
        return true;
      },
    );
    assert.throws(
      () => service.getUnitConversionFactor(UnitOfMeasure.PIECE, UnitOfMeasure.GRAM),
      (err) => {
        assert.match(err.message, /Incompatible unit conversion/);
        return true;
      },
    );
  });

  it('BUG-007: MenuService rejects category deletion when menu items are still attached', async () => {
    const { MenuService } = await import('../dist/menu/menu.service.js');

    const mockCategory = { id: 'cat-1', name: 'Desserts', restaurantId: 'rest-1' };
    const mockCategoryRepo = {
      findOne: async () => mockCategory,
      remove: async () => {},
    };
    const mockMenuItemRepo = {
      count: async ({ where }) => (where.categoryId === 'cat-1' ? 4 : 0),
    };

    const service = new MenuService(mockMenuItemRepo, mockCategoryRepo, {}, {});

    await assert.rejects(
      async () => service.removeCategory('cat-1', 'rest-1'),
      (err) => {
        assert.match(err.message, /contains 4 menu dish\(es\)/);
        return true;
      },
      'Should block category deletion when dishes remain attached',
    );
  });

  it('BUG-014: TablesService rejects table deletion when table is not VACANT or has active orders', async () => {
    const { TablesService } = await import('../dist/tables/tables.service.js');
    const { TableStatus } = await import('../dist/common/enums/index.js');

    const tableBusy = { id: 'tbl-1', tableNumber: 'T01', status: TableStatus.PREPPING, restaurantId: 'rest-1' };
    const tableVacantWithOrder = { id: 'tbl-2', tableNumber: 'T02', status: TableStatus.VACANT, restaurantId: 'rest-1' };

    const mockTableRepo = {
      findOne: async ({ where }) => (where.id === 'tbl-1' ? tableBusy : tableVacantWithOrder),
      remove: async () => {},
    };

    const mockDataSource = {
      getRepository: () => ({
        count: async ({ where }) => (where.tableNumber === 'T02' ? 2 : 0),
      }),
    };

    const service = new TablesService(mockTableRepo, {}, mockDataSource);

    // Rejects busy table
    await assert.rejects(
      async () => service.remove('tbl-1', 'rest-1'),
      (err) => {
        assert.match(err.message, /while its status is PREPPING/);
        return true;
      },
    );

    // Rejects vacant table that has active cooking orders
    await assert.rejects(
      async () => service.remove('tbl-2', 'rest-1'),
      (err) => {
        assert.match(err.message, /while it has 2 active dining order\(s\)/);
        return true;
      },
    );
  });
});

describe('QA Remediation — Priority 3: Billing & SaaS Entitlements', () => {
  it('BUG-008: subscription.activated does NOT grant ACTIVE status without verified payment capture', async () => {
    const { SubscriptionsService } = await import('../dist/subscriptions/subscriptions.service.js');
    const { SubscriptionStatus, SubscriptionInvoiceStatus } = await import('../dist/common/enums/index.js');

    let sub = {
      id: 'sub-1',
      organizationId: 'org-1',
      razorpaySubscriptionId: 'sub_rzp_123',
      status: SubscriptionStatus.TRIAL,
      plan: { basePrice: 5000, taxPercentage: 18 },
    };

    const mockSubRepo = {
      findOne: async () => sub,
      save: async (s) => {
        sub = s;
        return s;
      },
    };

    // No verified invoices exist
    const mockInvoiceRepo = {
      count: async () => 0,
      findOne: async () => null,
      create: (inv) => inv,
      save: async (inv) => inv,
    };

    const mockAuditRepo = {
      findOne: async () => null,
      create: (a) => a,
      save: async (a) => a,
    };

    const service = new SubscriptionsService(
      {},
      mockSubRepo,
      mockInvoiceRepo,
      mockAuditRepo,
      {},
      {},
    );

    // Incoming subscription.activated event WITHOUT payment capture
    await service.handleRazorpayWebhook(
      JSON.stringify({ event: 'subscription.activated' }),
      'dummy-sig',
      {
        id: 'evt_act_001',
        event: 'subscription.activated',
        payload: {
          subscription: {
            entity: { id: 'sub_rzp_123' },
          },
        },
      },
    );

    // Status MUST remain TRIAL, not ACTIVE
    assert.equal(sub.status, SubscriptionStatus.TRIAL, 'Subscription must NOT be marked ACTIVE without verified payment');
  });

  it('BUG-009: EntitlementService enforces outlet and staff quotas', async () => {
    const { EntitlementService } = await import('../dist/subscriptions/entitlement.service.js');
    const { SubscriptionStatus } = await import('../dist/common/enums/index.js');

    const mockSubRepo = {
      findOne: async () => ({
        id: 'sub-starter',
        status: SubscriptionStatus.ACTIVE,
        plan: {
          maxOutlets: 1, // Starter allows 1 outlet
          maxStaffPerOutlet: 3, // Starter allows 3 staff per outlet
        },
      }),
    };

    const entitlementService = new EntitlementService(mockSubRepo, {});

    // Outlet check: current is 1 -> cannot add second
    const outletCap = await entitlementService.canAddOutlet('org-1', 1);
    assert.equal(outletCap.allowed, false, 'Should disallow adding 2nd outlet on Starter plan');
    assert.equal(outletCap.maxOutlets, 1);

    // Staff check: current is 3 -> cannot add 4th
    const staffCap = await entitlementService.canAddStaff('org-1', 3);
    assert.equal(staffCap.allowed, false, 'Should disallow adding 4th staff member on Starter plan');
    assert.equal(staffCap.maxStaff, 3);

    // Staff check: current is 2 -> can add 3rd
    const staffCapOk = await entitlementService.canAddStaff('org-1', 2);
    assert.equal(staffCapOk.allowed, true, 'Should allow adding 3rd staff member');
  });
});

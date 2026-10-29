import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EmailDeliveryService } from '../dist/common/services/email-delivery.service.js'
import { TenantGuard } from '../dist/common/guards/tenant.guard.js'
import { OrdersService } from '../dist/orders/orders.service.js'
import { AuthService } from '../dist/auth/auth.service.js'
import { StaffRole } from '../dist/common/enums/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Real HTTP & Integration Security Test Suite: Phase 1 Remediation
// ─────────────────────────────────────────────────────────────────────────────

describe('1. Real Email Delivery & Failure Reporting', () => {
  it('handles missing configuration safely (returns delivered: false and provider: "none")', async () => {
    const mockConfigService = {
      get: (key) => {
        if (key === 'EMAIL_FROM') return 'no-reply@pangat.in'
        return undefined
      },
    }
    const service = new EmailDeliveryService(mockConfigService)
    const result = await service.sendTransactionalEmail({
      to: 'staff@example.com',
      subject: 'Password Reset',
      htmlContent: '<p>Reset link</p>',
    })

    assert.equal(result.delivered, false)
    assert.equal(result.provider, 'none')
    assert.equal(result.messageId, undefined)
    assert.match(result.error || '', /Transactional email provider is not configured/)
  })

  it('handles provider acceptance and returns genuine provider message ID', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        new Response(null, {
          status: 202,
          headers: new Headers({ 'x-message-id': 'sg_real_unique_message_header_9981' }),
        })

      const mockConfigService = {
        get: (key) => {
          if (key === 'SENDGRID_API_KEY') return 'SG.valid_mock_key'
          if (key === 'EMAIL_FROM') return 'no-reply@pangat.in'
          return undefined
        },
      }
      const service = new EmailDeliveryService(mockConfigService)
      const result = await service.sendTransactionalEmail({
        to: 'staff@example.com',
        subject: 'Password Reset',
        htmlContent: '<p>Reset link</p>',
      })

      assert.equal(result.delivered, true)
      assert.equal(result.provider, 'sendgrid')
      assert.equal(result.messageId, 'sg_real_unique_message_header_9981')
      assert.equal(result.error, undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles provider acceptance without message ID without fabricating synthetic fallbacks', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        new Response(null, {
          status: 200,
          headers: new Headers({}),
        })

      const mockConfigService = {
        get: (key) => {
          if (key === 'SENDGRID_API_KEY') return 'SG.valid_mock_key'
          return undefined
        },
      }
      const service = new EmailDeliveryService(mockConfigService)
      const result = await service.sendTransactionalEmail({
        to: 'staff@example.com',
        subject: 'Password Reset',
        htmlContent: '<p>Reset link</p>',
      })

      assert.equal(result.delivered, true)
      assert.equal(result.provider, 'sendgrid')
      assert.equal(result.messageId, undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles rejected provider requests safely without returning false success or leaking secrets', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ errors: [{ message: 'Unauthorized grant' }] }), {
          status: 401,
          statusText: 'Unauthorized',
        })

      const mockConfigService = {
        get: (key) => {
          if (key === 'SENDGRID_API_KEY') return 'SG.invalid_key'
          return undefined
        },
      }
      const service = new EmailDeliveryService(mockConfigService)
      const result = await service.sendTransactionalEmail({
        to: 'staff@example.com',
        subject: 'Password Reset',
        htmlContent: '<p>Reset link</p>',
      })

      assert.equal(result.delivered, false)
      assert.equal(result.provider, 'sendgrid')
      assert.equal(result.messageId, undefined)
      assert.match(result.error || '', /SendGrid HTTP 401/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles network errors gracefully without crashing or fabricating message IDs', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => {
        throw new Error('connect ECONNREFUSED api.sendgrid.com:443')
      }

      const mockConfigService = {
        get: (key) => {
          if (key === 'SENDGRID_API_KEY') return 'SG.mock_key'
          return undefined
        },
      }
      const service = new EmailDeliveryService(mockConfigService)
      const result = await service.sendTransactionalEmail({
        to: 'staff@example.com',
        subject: 'Password Reset',
        htmlContent: '<p>Reset link</p>',
      })

      assert.equal(result.delivered, false)
      assert.equal(result.provider, 'sendgrid')
      assert.equal(result.messageId, undefined)
      assert.match(result.error || '', /connect ECONNREFUSED/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('2. P0: Platform Admin Provisioning & Privilege Isolation', () => {
  it('rejects unauthenticated requests to setup-super-admin without bootstrap secret', async () => {
    const mockConfig = { get: (k) => (k === 'PLATFORM_BOOTSTRAP_SECRET' ? 'super_secret_bootstrap_token_32chars' : undefined) }
    const authService = new AuthService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mockConfig as any,
    )

    await assert.rejects(
      () => authService.setupPlatformAdmin({ name: 'Hacker', email: 'hacker@example.com', password: 'Pass' }, undefined, undefined),
      (err: any) => err.status === 401 && /Unauthorized/.test(err.message),
    )
  })

  it('rejects setup-super-admin requests with invalid bootstrap secret', async () => {
    const mockConfig = { get: (k) => (k === 'PLATFORM_BOOTSTRAP_SECRET' ? 'super_secret_bootstrap_token_32chars' : undefined) }
    const authService = new AuthService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mockConfig as any,
    )

    await assert.rejects(
      () => authService.setupPlatformAdmin({ name: 'Hacker', email: 'hacker@example.com', password: 'Pass' }, undefined, 'wrong_token'),
      (err: any) => err.status === 401 && /Unauthorized/.test(err.message),
    )
  })

  it('login does not automatically promote @pangat.in emails to PLATFORM_SUPER_ADMIN', async () => {
    const staffEntity = {
      id: 'staff-1',
      email: 'alice@pangat.in',
      passwordHash: '$2b$10$hashed',
      role: StaffRole.CHEF,
      isPlatformAdmin: false,
    }
    const mockStaffRepo = {
      findOne: async () => staffEntity,
      update: async () => { throw new Error('Should not update role') },
    }
    const mockJwt = { sign: () => 'token' }
    const mockDataSource = {
      getRepository: () => ({
        findOne: async () => null,
        find: async () => [],
      }),
    }

    // Verify bcrypt compare will pass
    const originalBcryptCompare = (await import('bcrypt')).default.compare
    ;(await import('bcrypt')).default.compare = (async () => true) as any

    try {
      const authService = new AuthService(
        mockStaffRepo as any,
        mockJwt as any,
        mockDataSource as any,
        {} as any,
        { get: () => undefined } as any,
      )

      const result = await authService.login({ email: 'alice@pangat.in', password: 'correct' })
      assert.equal(result.user.role, StaffRole.CHEF)
      assert.equal(result.user.isPlatformAdmin, false)
    } finally {
      ;(await import('bcrypt')).default.compare = originalBcryptCompare
    }
  })
})

describe('3. P1: Tenant Isolation & Conflicting Resource / Tenant ID Defense', () => {
  const mockDb = {
    restaurants: [
      { id: 'rest-A1', slug: 'cafe-a1', organizationId: 'org-A' },
      { id: 'rest-B1', slug: 'bistro-b1', organizationId: 'org-B' },
    ],
    orders: [
      { id: 'ord-A1', restaurantId: 'rest-A1' },
      { id: 'ord-B1', restaurantId: 'rest-B1' },
    ],
    tables: [
      { id: 'tbl-A1', restaurantId: 'rest-A1' },
      { id: 'tbl-B1', restaurantId: 'rest-B1' },
    ],
    menuItems: [
      { id: 'item-A1', restaurantId: 'rest-A1' },
      { id: 'item-B1', restaurantId: 'rest-B1' },
    ],
    categories: [
      { id: 'cat-A1', restaurantId: 'rest-A1' },
      { id: 'cat-B1', restaurantId: 'rest-B1' },
    ],
  }

  const staffA = { id: 'staff-A', role: 'STORE_MANAGER', organizationId: 'org-A', restaurantId: 'rest-A1' }
  const _staffB = { id: 'staff-B', role: 'STORE_MANAGER', organizationId: 'org-B', restaurantId: 'rest-B1' }

  const mockDataSource = {
    getRepository: (_entityClass: any) => ({
      findOne: async (opts: any) => {
        const id = opts?.where?.id || (Array.isArray(opts?.where) ? opts.where[0]?.id : undefined)
        const slug = opts?.where?.slug || (Array.isArray(opts?.where) ? opts.where[0]?.slug : undefined)
        if (id) {
          return (
            mockDb.orders.find((o) => o.id === id) ||
            mockDb.tables.find((t) => t.id === id) ||
            mockDb.menuItems.find((m) => m.id === id) ||
            mockDb.categories.find((c) => c.id === id) ||
            mockDb.restaurants.find((r) => r.id === id) ||
            null
          )
        }
        if (slug) {
          return mockDb.restaurants.find((r) => r.slug === slug.toLowerCase() || r.slug === slug) || null
        }
        return null
      },
    }),
  }

  const guard = new TenantGuard(mockDataSource as any)

  function createMockContext(user: any, params: any = {}, body: any = {}, query: any = {}) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user, params, body, query }),
      }),
    } as any
  }

  it('rejects cross-tenant table mutation when attacker targets victim resource with conflicting restaurantId', async () => {
    // Attacker staffA attempts to patch victim table tbl-B1 while supplying attacker's rest-A1 in body
    const context = createMockContext(staffA, { id: 'tbl-B1' }, { restaurantId: 'rest-A1', status: 'VACANT' })

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => err.status === 403 && /Tenant conflict/.test(err.message),
    )
  })

  it('rejects cross-tenant menu price update when attacker targets victim item with conflicting slug', async () => {
    const context = createMockContext(staffA, { id: 'item-B1' }, {}, { restaurantSlug: 'cafe-a1' })

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => err.status === 403 && /Tenant conflict/.test(err.message),
    )
  })

  it('rejects cross-tenant resource access when attacker directly targets victim item without params', async () => {
    const context = createMockContext(staffA, { id: 'item-B1' })

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => err.status === 403 && /Access denied/.test(err.message),
    )
  })

  it('allows authorized staff to access resources within their own restaurant', async () => {
    const context = createMockContext(staffA, { id: 'tbl-A1' })
    const allowed = await guard.canActivate(context)
    assert.equal(allowed, true)
  })
})

describe('4. P1: Order Pricing, Verification & Public Tracking Security', () => {
  it('ignores client-supplied prices and calculates total strictly from DB', async () => {
    const verifiedDish = {
      id: 'dish-1',
      name: 'Paneer Tikka',
      price: 350.0,
      restaurantId: 'rest-A1',
      isAvailable: true,
      modifiers: [],
    }

    const mockMenuItemRepo = {
      findOne: async () => verifiedDish,
    }
    const mockOrderRepo = {
      create: (entity: any) => entity,
      save: async (entity: any) => entity,
    }
    const mockOrderItemRepo = {
      create: (entity: any) => entity,
    }
    const mockRestaurantRepo = {
      findOne: async () => ({ id: 'rest-A1', name: 'Cafe A1', gstPercentage: 5, slug: 'cafe-a1' }),
    }
    const mockTableRepo = {
      findOne: async () => ({ id: 'tbl-1', tableNumber: 'T01', status: 'VACANT' }),
      save: async () => {},
    }
    const mockGateway = {
      emitTableStatus: () => {},
      emitNewOrder: () => {},
    }

    const ordersService = new OrdersService(
      mockOrderRepo as any,
      mockOrderItemRepo as any,
      mockRestaurantRepo as any,
      mockTableRepo as any,
      mockMenuItemRepo as any,
      {} as any,
      mockGateway as any,
    )

    // Attacker attempts to buy ₹350 dish for ₹10
    const manipulatedDto = {
      restaurantSlug: 'cafe-a1',
      tableNumber: 'T01',
      items: [
        {
          menuItemId: 'dish-1',
          name: 'Hacked Dish',
          price: 10.0,
          quantity: 2,
        },
      ],
    }

    const createdOrder = await ordersService.create(manipulatedDto as any, 'idempotency-key-1')

    // Verified subtotal must be 350 * 2 = 700, NOT 10 * 2 = 20
    assert.equal(createdOrder.subtotal, 700)
    assert.equal(createdOrder.gstAmount, 35)
    assert.equal(createdOrder.totalAmount, 735)
    assert.ok(createdOrder.trackingToken && createdOrder.trackingToken.length >= 32)
  })

  it('rejects order with cross-restaurant menu items', async () => {
    const foreignDish = {
      id: 'dish-foreign',
      name: 'Biryani',
      price: 400.0,
      restaurantId: 'rest-B1', // Belongs to restaurant B
      isAvailable: true,
      modifiers: [],
    }

    const ordersService = new OrdersService(
      {} as any,
      {} as any,
      { findOne: async () => ({ id: 'rest-A1', name: 'Cafe A1' }) } as any,
      { findOne: async () => ({ id: 'tbl-1', tableNumber: 'T01' }) } as any,
      { findOne: async () => foreignDish } as any,
      {} as any,
      {} as any,
    )

    await assert.rejects(
      () =>
        ordersService.create(
          {
            restaurantSlug: 'cafe-a1',
            tableNumber: 'T01',
            items: [{ menuItemId: 'dish-foreign', quantity: 1 }],
          } as any,
          'key-2',
        ),
      (err: any) => err.status === 400 && /does not belong to restaurant/.test(err.message),
    )
  })

  it('rejects order with out-of-stock items', async () => {
    const unavailableDish = {
      id: 'dish-soldout',
      name: 'Gulab Jamun',
      price: 120.0,
      restaurantId: 'rest-A1',
      isAvailable: false, // Out of stock
      modifiers: [],
    }

    const ordersService = new OrdersService(
      {} as any,
      {} as any,
      { findOne: async () => ({ id: 'rest-A1', name: 'Cafe A1' }) } as any,
      { findOne: async () => ({ id: 'tbl-1', tableNumber: 'T01' }) } as any,
      { findOne: async () => unavailableDish } as any,
      {} as any,
      {} as any,
    )

    await assert.rejects(
      () =>
        ordersService.create(
          {
            restaurantSlug: 'cafe-a1',
            tableNumber: 'T01',
            items: [{ menuItemId: 'dish-soldout', quantity: 1 }],
          } as any,
          'key-3',
        ),
      (err: any) => err.status === 400 && /unavailable \(out of stock\)/.test(err.message),
    )
  })

  it('blocks order enumeration attacks when queried by enumerable ID without tracking token', async () => {
    const sampleOrder = {
      id: 'ORD-1234',
      trackingToken: '0123456789abcdef0123456789abcdef0123456789abcdef',
      customerPhone: '+919876543210',
      totalAmount: 500,
    }

    const ordersService = new OrdersService(
      { findOne: async () => sampleOrder } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    // Unauthenticated caller attempting to scrape ORD-1234 without tracking token
    await assert.rejects(
      () => ordersService.findOrderForCaller('ORD-1234', undefined, undefined),
      (err: any) => err.status === 404 && /Order not found/.test(err.message),
    )

    // Valid tracking token returns restricted diner projection without customer phone
    const dinerView = await ordersService.findOrderForCaller(
      sampleOrder.trackingToken,
      undefined,
      undefined,
    )
    assert.equal(dinerView.id, 'ORD-1234')
    assert.equal(dinerView.customerPhone, undefined) // Stripped from diner view
    assert.equal(dinerView.totalAmount, 500)
  })
})

describe('5. P2: Password-Reset Neutral Response & Security', () => {
  it('returns neutral public response and tracks internal delivered status without leaking email', async () => {
    const mockStaff = {
      id: 'staff-1',
      name: 'Nikhil',
      email: 'nikhil@pangat.in',
      resetTokenHash: null,
      resetTokenExpiresAt: null,
    }

    const mockStaffRepo = {
      findOne: async () => mockStaff,
      save: async () => mockStaff,
    }
    const mockEmailService = {
      sendTransactionalEmail: async () => ({ delivered: true, provider: 'sendgrid' as const }),
    }
    const mockConfig = {
      get: (k: string) => (k === 'FRONTEND_URL' ? 'https://layerform.in' : undefined),
    }

    const authService = new AuthService(
      mockStaffRepo as any,
      {} as any,
      {} as any,
      mockEmailService as any,
      mockConfig as any,
    )

    const response = await authService.requestPasswordReset('nikhil@pangat.in')
    assert.equal(response.success, true)
    // Neutral public message preventing enumeration
    assert.match(response.message, /If the email exists, a password reset link has been dispatched/)
    // Accurate internal delivered status
    assert.equal(response.delivered, true)
    assert.equal(response.deliveryProvider, 'sendgrid')
  })
})

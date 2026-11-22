import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
process.env.JWT_SECRET = 'x'.repeat(40)
const { AuditService } = await import('../dist/audit/audit.service.js')
const { requestContextMiddleware, currentRequest } = await import('../dist/common/request-context.js')
const { assertPlatformMerchantAccess } = await import('../dist/common/guards/platform-merchant-access.js')
const { PlatformAccessInterceptor } = await import('../dist/platform/access-log.interceptor.js')
const { clientMeta } = await import('../dist/platform/login-events.js')
const { actorOf } = await import('../dist/platform/audit.service.js')
const { MenuService } = await import('../dist/menu/menu.service.js')
const { RestaurantsService } = await import('../dist/restaurants/restaurants.service.js')
const { PLATFORM_ROLES } = await import('../dist/platform/permissions.js')

const inRequest = (ip, ua, fn) => new Promise((resolve, reject) => {
  const res = { setHeader() {} }
  requestContextMiddleware({ ip, headers: { 'user-agent': ua }, socket: {} }, res, () => Promise.resolve().then(fn).then(resolve, reject))
})

describe('request context and real client address', () => {
  it('gives each request an id, exposes it in X-Request-Id and keeps proxy-verified ip + user agent', async () => {
    const headers = {}
    let seen
    await new Promise((r) => requestContextMiddleware({ ip: '203.0.113.9', headers: { 'user-agent': 'UA/1' }, socket: {} }, { setHeader: (k, v) => (headers[k] = v) }, () => { seen = currentRequest(); r() }))
    assert.match(headers['X-Request-Id'], /^[0-9a-f-]{36}$/); assert.equal(seen.requestId, headers['X-Request-Id'])
    assert.equal(seen.ip, '203.0.113.9'); assert.equal(seen.userAgent, 'UA/1')
  })
  it('audit evidence ignores a client-supplied X-Forwarded-For header', () => {
    const req = { ip: '198.51.100.7', headers: { 'x-forwarded-for': '6.6.6.6, 1.1.1.1', 'user-agent': 'x' }, user: { id: 'u' } }
    assert.equal(clientMeta(req).ip, '198.51.100.7'); assert.equal(actorOf(req).ip, '198.51.100.7')
  })
})

describe('AuditService', () => {
  const mk = (failing = false) => {
    const saved = []
    const repo = { create: (x) => x, save: async (x) => { if (failing) throw new Error('db down'); saved.push(x); return x } }
    const em = { getRepository: () => repo }
    const svc = new AuditService({ create: () => { throw new Error('should use the transaction manager') } })
    return { svc, em, saved }
  }
  it('writes through the supplied transaction manager and stamps who/where/which request', async () => {
    const { svc, em, saved } = mk()
    await inRequest('203.0.113.9', 'Mozilla/5.0', async () => { await svc.record({ restaurantId: 'r1', entityType: 'ORDER', entityId: 'o1', action: 'ORDER_CANCELLED', staffId: 's1', staffName: 'Asha', staffRole: 'STEWARD', staffEmail: 'a@b.in' }, em) })
    assert.equal(saved.length, 1)
    assert.equal(saved[0].ip, '203.0.113.9'); assert.equal(saved[0].userAgent, 'Mozilla/5.0'); assert.match(saved[0].requestId, /^[0-9a-f-]{36}$/); assert.equal(saved[0].actorEmail, 'a@b.in')
  })
  it('throws when the write fails so the surrounding transaction rolls back', async () => {
    const { svc, em } = mk(true)
    await assert.rejects(() => svc.record({ restaurantId: 'r1', entityType: 'ORDER', entityId: 'o1', action: 'X' }, em), /db down/)
  })
})

describe('migration 013 makes the restaurant audit append-only', () => {
  const sql = fs.readFileSync(new URL('../src/migrations/013_audit_hardening.sql', import.meta.url), 'utf8')
  it('blocks update, delete and truncate, and stops deletes from cascading into history', () => {
    assert.match(sql, /BEFORE UPDATE OR DELETE ON audit_logs/); assert.match(sql, /BEFORE TRUNCATE ON audit_logs/)
    assert.match(sql, /ON DELETE RESTRICT/); assert.match(sql, /request_id/); assert.match(sql, /ip varchar/)
  })
  it('is picked up by the migration runner naming rule', () => assert.match('013_audit_hardening.sql', /^\d{3}_.+\.sql$/))
})

describe('platform staff inside restaurant consoles', () => {
  it('reading needs merchant.view (or operate); changing needs merchant.operate', () => {
    assert.throws(() => assertPlatformMerchantAccess({ platformPermissions: ['dashboard.view', 'payments.view'] }, 'GET'), /cannot open restaurant consoles/)
    assert.doesNotThrow(() => assertPlatformMerchantAccess({ platformPermissions: ['merchant.view'] }, 'GET'))
    assert.throws(() => assertPlatformMerchantAccess({ platformPermissions: ['merchant.view'] }, 'PATCH'), /read-only/)
    assert.doesNotThrow(() => assertPlatformMerchantAccess({ platformPermissions: ['merchant.operate'] }, 'PATCH'))
    assert.doesNotThrow(() => assertPlatformMerchantAccess({ platformPermissions: ['merchant.operate'] }, 'GET'))
    assert.throws(() => assertPlatformMerchantAccess({}, 'GET'))
  })
  it('only owner, admin and support roles can open a console; analyst, finance and compliance cannot', () => {
    const has = (r) => PLATFORM_ROLES[r].permissions.some((p) => p === 'merchant.view' || p === 'merchant.operate')
    assert.deepEqual(['OWNER', 'ADMIN', 'SUPPORT'].map(has), [true, true, true])
    assert.deepEqual(['ANALYST', 'FINANCE', 'COMPLIANCE'].map(has), [false, false, false])
  })
  it('every opening is written to the platform audit once per window, never for restaurant staff or other areas', () => {
    const recorded = []
    const itc = new PlatformAccessInterceptor({ record: async (actor, e) => { recorded.push({ actor, e }) } })
    const next = { handle: () => 'ok' }
    const ctx = (req) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) })
    const admin = { id: 'a1', name: 'Sam', role: 'SUPPORT', isPlatformAdmin: true }
    const get = (path, user = admin, extra = {}) => ({ method: 'GET', originalUrl: path, user, query: { restaurantSlug: 'cafe' }, params: {}, ip: '1.1.1.1', headers: {}, ...extra })
    itc.intercept(ctx(get('/api/v1/orders?restaurantSlug=cafe')), next)
    itc.intercept(ctx(get('/api/v1/orders?restaurantSlug=cafe&page=2')), next) // same window: not repeated
    itc.intercept(ctx(get('/api/v1/menu/items?x')), next) // a different area
    itc.intercept(ctx(get('/api/v1/orders?restaurantSlug=cafe', { id: 'o1', role: 'STORE_MANAGER' })), next) // restaurant staff
    itc.intercept(ctx(get('/api/v1/admin/restaurants')), next) // platform's own pages
    itc.intercept(ctx({ ...get('/api/v1/orders/abc'), method: 'PATCH' }), next)
    assert.deepEqual(recorded.map((r) => r.e.action), ['MERCHANT_DATA_VIEWED', 'MERCHANT_DATA_VIEWED', 'MERCHANT_DATA_CHANGED'])
    assert.equal(recorded[0].e.category, 'PRIVACY'); assert.equal(recorded[0].e.entityId, 'cafe'); assert.equal(recorded[0].actor.name, 'Sam')
  })
})

describe('menu changes are audited atomically, including price edits made through the general edit form', () => {
  const build = ({ failAudit = false } = {}) => {
    const item = { id: 'i1', restaurantId: 'r1', name: 'Misal', price: 110, categoryId: 'c1', isVeg: true, isAvailable: true, description: '' }
    const audits = [], saved = []
    const em = { getRepository: () => ({ save: async (x) => { saved.push({ ...x }); return x }, delete: async () => {}, create: (x) => x }) }
    const menuItemRepo = { findOne: async () => item, manager: { transaction: async (cb) => cb(em) } }
    const audit = { record: async (a) => { if (failAudit) throw new Error('audit down'); audits.push(a) } }
    return { svc: new MenuService(menuItemRepo, { findOne: async () => ({ id: 'c1', restaurantId: 'r1' }) }, {}, { findOne: async () => ({ id: 'r1', slug: 'cafe' }) }, audit, undefined), audits, saved, item }
  }
  const actor = { id: 's1', name: 'Manu', role: 'STORE_MANAGER', email: 'm@x.in' }
  it('a price edit through updateItem is recorded as PRICE_CHANGED with before and after', async () => {
    const { svc, audits } = build()
    await svc.updateItem('i1', { price: 140 }, 'r1', actor)
    const p = audits.find((a) => a.action === 'PRICE_CHANGED')
    assert.ok(p); assert.deepEqual([p.metadata.from, p.metadata.to], [110, 140]); assert.equal(p.staffId, 's1'); assert.equal(p.staffEmail, 'm@x.in')
  })
  it('other edits and availability toggles are recorded, and an unchanged save writes nothing', async () => {
    const a = build(); await a.svc.updateItem('i1', { name: 'Misal Pav', isVeg: false }, 'r1', actor)
    const u = a.audits.find((x) => x.action === 'ITEM_UPDATED'); assert.deepEqual(u.metadata.changed.sort(), ['isVeg', 'name']); assert.equal(u.metadata.before.name, 'Misal')
    const b = build(); await b.svc.updateAvailability('i1', false, 'r1', actor); assert.equal(b.audits[0].action, 'ITEM_MARKED_SOLD_OUT')
    const c = build(); await c.svc.updateItem('i1', { name: 'Misal' }, 'r1', actor); assert.equal(c.audits.length, 0)
  })
  it('if the audit record cannot be written the whole change fails (nothing is saved without its record)', async () => {
    const { svc } = build({ failAudit: true })
    await assert.rejects(() => svc.updateItem('i1', { price: 99 }, 'r1', actor), /audit down/)
  })
})

describe('staff changes record before and after', () => {
  it('a role change is its own action with the old and new role', async () => {
    const staff = { id: 's9', email: 'chef@cafe.in', name: 'Ravi', phone: null, role: 'CHEF', isActive: true, restaurantId: 'r1', organizationId: 'org1' }
    const audits = []
    const staffRepo = { findOne: async () => staff, manager: { transaction: async (cb) => cb({ getRepository: () => ({ save: async (x) => x }) }) } }
    const svc = new RestaurantsService({}, staffRepo, {}, undefined, { record: async (a) => { audits.push(a) } })
    await svc.updateStaff('r1', 's9', { role: 'STORE_MANAGER' }, { id: 'o1', name: 'Asha', role: 'SUPER_OWNER' })
    assert.equal(audits[0].action, 'STAFF_ROLE_CHANGED'); assert.equal(audits[0].metadata.before.role, 'CHEF'); assert.equal(audits[0].metadata.after.role, 'STORE_MANAGER')
    audits.length = 0
    await svc.updateStaff('r1', 's9', { isActive: false }, { id: 'o1', name: 'Asha', role: 'SUPER_OWNER' })
    assert.equal(audits[0].action, 'STAFF_DEACTIVATED')
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
process.env.JWT_SECRET = 'x'.repeat(40)
const { redactForKitchen, redactOrdersFor, isKitchenOnly } = await import('../dist/orders/order-redaction.js')
const { resolvePlatformPermissions, PLATFORM_ROLES, ALL_PERMISSIONS } = await import('../dist/platform/permissions.js')
const { RestaurantsService } = await import('../dist/restaurants/restaurants.service.js')
const { PasswordLinkService } = await import('../dist/common/services/password-link.service.js')
const { resolveOperations } = await import('../dist/restaurants/operations.js')

const order = {
  id: 'o1', tableNumber: '4', orderType: 'DELIVERY', orderStatus: 'PREPARING', customerName: 'Rahul Sharma', customerPhone: '9876543210',
  deliveryAddress: '12 MG Road', deliveryInstructions: 'ring twice', trackingToken: 'tok', totalAmount: 540, subtotal: 500, gstAmount: 25, paymentStatus: 'PAID', paymentMethod: 'UPI_INSTANT',
  refundAmount: 0, feedback: { rating: 5 }, restaurant: { id: 'r1', name: 'Cafe', slug: 'cafe', upiVpa: 'cafe@upi', gstin: 'X' },
  items: [{ id: 'i1', name: 'Misal', quantity: 2, price: 110, notes: 'spicy', selectedModifiers: [{ name: 'Extra pav', price: 10 }] }],
}

describe('kitchen (CHEF) least-privilege order view', () => {
  const k = redactForKitchen(order)
  it('keeps only what is needed to cook and serve', () => {
    assert.equal(k.tableNumber, '4'); assert.equal(k.orderStatus, 'PREPARING'); assert.equal(k.items[0].name, 'Misal'); assert.equal(k.items[0].quantity, 2); assert.equal(k.items[0].notes, 'spicy')
    assert.equal(k.customerName, 'Rahul') // enough to call out a parcel
  })
  it('removes contact details, address, tracking token and all money fields', () => {
    for (const f of ['customerPhone', 'deliveryAddress', 'deliveryInstructions', 'trackingToken', 'totalAmount', 'subtotal', 'gstAmount', 'paymentStatus', 'paymentMethod', 'refundAmount', 'feedback']) assert.equal(f in k, false, f)
    assert.equal('price' in k.items[0], false); assert.equal('price' in k.items[0].selectedModifiers[0], false)
    assert.deepEqual(Object.keys(k.restaurant).sort(), ['id', 'name', 'slug'])
  })
  it('does not mutate the original and only applies to the chef role', () => {
    assert.equal(order.customerPhone, '9876543210')
    assert.equal(isKitchenOnly({ role: 'CHEF' }), true)
    for (const r of ['SUPER_OWNER', 'STORE_MANAGER', 'STEWARD', 'CASHIER']) assert.equal(isKitchenOnly({ role: r }), false)
    assert.equal(isKitchenOnly({ role: 'CHEF', isPlatformAdmin: true }), false)
    assert.equal(redactOrdersFor({ role: 'STEWARD' }, [order])[0].customerPhone, '9876543210')
    assert.equal(redactOrdersFor({ role: 'CHEF' }, [order])[0].customerPhone, undefined)
  })
})

describe('platform permissions fail closed', () => {
  it('an unknown or misspelt role gets nothing; a legacy account with no role stays a full owner', () => {
    assert.deepEqual(resolvePlatformPermissions('OWNNER'), [])
    assert.deepEqual(resolvePlatformPermissions('support'), [])
    assert.deepEqual(resolvePlatformPermissions(null), ALL_PERMISSIONS)
    assert.deepEqual(resolvePlatformPermissions(undefined), ALL_PERMISSIONS)
  })
  it('an explicit list wins and unknown permission names are dropped', () => {
    assert.deepEqual(resolvePlatformPermissions('OWNER', ['dashboard.view', 'made.up']), ['dashboard.view'])
  })
  it('read-only and finance roles cannot see audit, settings or the user directory', () => {
    for (const r of ['ANALYST', 'FINANCE']) {
      const p = PLATFORM_ROLES[r].permissions
      for (const bad of ['audit.view', 'settings.view', 'users.view', 'monitoring.view']) assert.equal(p.includes(bad), false, `${r} must not have ${bad}`)
      assert.ok(!p.some((x) => x.endsWith('.manage') && r === 'ANALYST'))
    }
  })
  it('the compliance role handles privacy requests but cannot touch billing, settings or accounts', () => {
    const p = PLATFORM_ROLES.COMPLIANCE.permissions
    assert.ok(p.includes('privacy.manage') && p.includes('audit.view'))
    for (const bad of ['subscriptions.manage', 'settings.manage', 'users.manage', 'admins.manage', 'payments.export']) assert.equal(p.includes(bad), false)
  })
})

describe('owner-only payment and tax settings', () => {
  const mk = (overrides = {}) => {
    const outlet = { id: 'r1', slug: 'cafe', name: 'Cafe', organizationId: 'org1', upiVpa: 'cafe@okhdfc', gstin: '27AAAAA0000A1Z5', hsnSac: '9963', gstPercentage: 5, serviceChargePercentage: 0, operations: null, ...overrides }
    const sent = [], audits = []
    const restaurantRepo = { findOne: async () => outlet, save: async (r) => r }
    const staffRepo = { findOne: async () => ({ name: 'Owner', email: 'owner@cafe.in' }) }
    const audit = { record: async (a) => { audits.push(a) } }
    const email = { sendTransactionalEmail: async (m) => { sent.push(m); return { delivered: true, provider: 'brevo' } } }
    return { svc: new RestaurantsService(restaurantRepo, staffRepo, {}, undefined, audit, email), outlet, sent, audits }
  }
  const manager = { id: 'm1', name: 'Manu', role: 'STORE_MANAGER' }
  const owner = { id: 'o1', name: 'Asha', role: 'SUPER_OWNER' }

  it('a manager cannot change the UPI ID, GSTIN, HSN or tax rates', async () => {
    for (const dto of [{ upiVpa: 'me@okaxis' }, { gstin: '29BBBBB1111B1Z9' }, { hsnSac: '9999' }, { gstPercentage: 18 }, { serviceChargePercentage: 10 }]) {
      const { svc, sent } = mk()
      await assert.rejects(() => svc.updateSettings('cafe', dto, manager), /Only the owner/)
      assert.equal(sent.length, 0)
    }
  })
  it('a manager can still save the form when those values are unchanged, and can change everything else', async () => {
    const { svc } = mk()
    const saved = await svc.updateSettings('cafe', { upiVpa: 'cafe@okhdfc', gstPercentage: 5, serviceChargePercentage: 0, phone: '9999999999', operations: { stewardCanSettle: true } }, manager)
    assert.equal(saved.phone, '9999999999')
    assert.equal(resolveOperations(saved.operations).stewardCanSettle, true)
  })
  it('the owner can change them, and is emailed a masked summary naming who did it', async () => {
    const { svc, sent, outlet } = mk()
    await svc.updateSettings('cafe', { upiVpa: 'new.account@okicici' }, owner)
    assert.equal(outlet.upiVpa, 'new.account@okicici')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(sent.length, 1); assert.equal(sent[0].to, 'owner@cafe.in')
    assert.match(sent[0].textContent, /ca\*\*\*@okhdfc → ne\*\*\*@okicici/)
    assert.ok(!sent[0].textContent.includes('new.account'))
    assert.match(sent[0].textContent, /Asha/)
  })
  it('no email when nothing sensitive changed', async () => {
    const { svc, sent } = mk()
    await svc.updateSettings('cafe', { phone: '1' }, owner)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(sent.length, 0)
  })
})

describe('steward settlement is off by default', () => {
  it('defaults to off and is switchable per outlet', () => {
    assert.equal(resolveOperations(null).stewardCanSettle, false)
    assert.equal(resolveOperations({ stewardCanSettle: true }).stewardCanSettle, true)
  })
})

describe('password links (support never sees a password)', () => {
  const build = ({ delivered = true, configured = true } = {}) => {
    const queries = [], mails = []
    const ds = { query: async (sql, p) => { queries.push({ sql, p }); return [] } }
    const email = { sendTransactionalEmail: async (m) => { mails.push(m); return { delivered, provider: 'brevo' } } }
    const svc = new PasswordLinkService(ds, email, { get: (k) => (k === 'FRONTEND_URL' ? 'https://app.pangat.test/' : undefined) })
    if (!configured) svc.canSend = () => false
    return { svc, queries, mails }
  }
  const person = { id: 's1', name: 'Asha', email: 'asha@cafe.in' }
  it('stores only a hash of a random token and emails the raw link to the person', async () => {
    const { svc, queries, mails } = build()
    process.env.BREVO_API_KEY = 'k'
    try { await svc.send(person, 'RESET') } finally { delete process.env.BREVO_API_KEY }
    const m = /resetToken=([a-f0-9]{64})/.exec(mails[0].textContent)
    assert.ok(m); assert.equal(mails[0].to, 'asha@cafe.in'); assert.match(mails[0].textContent, /^Namaskar Asha,/)
    assert.ok(!JSON.stringify(queries).includes(m[1]), 'raw token must never be stored')
    assert.equal(queries[0].p[1].length, 64)
    assert.ok(!queries.some((q) => /password_hash/i.test(q.sql)), 'the current password must not be touched')
  })
  it('refuses (503) when email is not configured and removes the token if the mail is rejected', async () => {
    await assert.rejects(() => build({ configured: false }).svc.send(person, 'RESET'), (e) => e.getStatus() === 503)
    process.env.BREVO_API_KEY = 'k'
    try {
      const { svc, queries } = build({ delivered: false })
      await assert.rejects(() => svc.send(person, 'RESET'), (e) => e.getStatus() === 503)
      assert.match(queries.at(-1).sql, /reset_token_hash = NULL/)
    } finally { delete process.env.BREVO_API_KEY }
  })
})

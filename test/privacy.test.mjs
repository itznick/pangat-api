import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
process.env.JWT_SECRET = 'x'.repeat(40)
const { PrivacyService } = await import('../dist/privacy/privacy.service.js')
const { runPrivacyRetention } = await import('../dist/privacy/retention.js')
const { phoneKey, maskPhone, PRIVACY_POLICY_VERSION } = await import('../dist/platform/compliance.js')
const { PlatformSettingsService } = await import('../dist/platform/settings.service.js')
const { PLATFORM_ROLES } = await import('../dist/platform/permissions.js')
const { validate } = await import('class-validator')
const { plainToInstance } = await import('class-transformer')
const { CreateLeadDto } = await import('../dist/leads/dto/create-lead.dto.js')
const { CreatePrivacyRequestDto } = await import('../dist/privacy/privacy.dto.js')
const { OrdersService } = await import('../dist/orders/orders.service.js')

const setSettings = (kv) => new PlatformSettingsService({ query: async () => Object.entries(kv).map(([key, value]) => ({ key, value, encrypted: null, is_secret: false })) }).refresh()

describe('phone helpers', () => {
  it('match the same number however it is written, and mask it for logs', () => {
    for (const v of ['9876543210', '+91 98765 43210', '098765-43210', '(91) 9876543210']) assert.equal(phoneKey(v), '9876543210')
    assert.equal(maskPhone('+919876543210'), '******3210'); assert.equal(maskPhone('12'), '****')
  })
})

describe('consent is mandatory and recorded', () => {
  it('demo requests are rejected unless the privacy notice was accepted', async () => {
    const base = { name: 'A', restaurantName: 'R', phone: '9999999999', city: 'Pune' }
    assert.ok((await validate(plainToInstance(CreateLeadDto, { ...base }))).length > 0)
    assert.ok((await validate(plainToInstance(CreateLeadDto, { ...base, consentAccepted: false }))).length > 0)
    assert.equal((await validate(plainToInstance(CreateLeadDto, { ...base, consentAccepted: true }))).length, 0)
  })
  it('an order that collects a name, phone or address needs consent; a plain dine-in order does not', async () => {
    const svc = new OrdersService({ findOne: async () => null }, {}, { findOne: async () => ({ id: 'r1', slug: 'cafe', name: 'Cafe', operations: null }) }, {}, {}, {}, {}, {}, {})
    const item = [{ menuItemId: 'm1', name: 'Tea', price: 10, quantity: 1 }]
    await assert.rejects(() => svc.create({ restaurantSlug: 'cafe', orderType: 'TAKEAWAY', customerName: 'Asha', items: item }, 'k1'), /Privacy Notice/)
    await assert.rejects(() => svc.create({ restaurantSlug: 'cafe', orderType: 'DELIVERY', customerName: 'Asha', customerPhone: '9999999999', deliveryAddress: 'MG Road', consentAccepted: false, items: item }, 'k2'), /Privacy Notice/)
    // a dine-in order with no personal details gets past the consent rule (it fails later for unrelated mock reasons, never with a privacy message)
    await svc.create({ restaurantSlug: 'cafe', orderType: 'DINE_IN', tableNumber: 'T1', items: item }, 'k3').catch((e) => assert.doesNotMatch(String(e.message), /Privacy Notice/))
  })
})

describe('privacy requests', () => {
  const build = () => {
    const queries = [], audits = [], mails = []
    const ds = { query: async (sql, p) => { queries.push({ sql, p }); return /SELECT \* FROM privacy_requests/.test(sql) ? [{ id: 'u1', reference: 'PR-ABC', kind: 'ERASURE', status: 'OPEN', contact: 'asha@x.in', name: 'Asha', resolution_note: null }] : [] } }
    const audit = { record: async (actor, e) => { audits.push({ actor, e }) } }
    const email = { sendTransactionalEmail: async (m) => { mails.push(m); return { delivered: true, provider: 'brevo' } } }
    return { svc: new PrivacyService(ds, audit, email), queries, audits, mails }
  }
  const dto = (o = {}) => ({ kind: 'ERASURE', name: 'Asha', contact: 'asha@x.in', message: 'please delete', confirm: true, ...o })

  it('stores the request with a readable reference and a due date, audits it, and tells the officer and the requester', async () => {
    await setSettings({ 'compliance.grievanceOfficerEmail': 'officer@pangat.in', 'compliance.responseDays': 20 })
    process.env.BREVO_API_KEY = 'k'
    try {
      const { svc, queries, audits, mails } = build()
      const r = await svc.create(dto(), { ip: '1.2.3.4' })
      assert.match(r.reference, /^PR-[A-HJ-NP-Z2-9]{8}$/); assert.equal(r.dueDays, 20)
      assert.match(queries[0].sql, /INSERT INTO privacy_requests/); assert.equal(queries[0].p[1], 'ERASURE'); assert.equal(queries[0].p[6], '20'); assert.equal(queries[0].p[7], PRIVACY_POLICY_VERSION)
      assert.equal(audits[0].e.category, 'PRIVACY'); assert.equal(audits[0].actor.ip, '1.2.3.4')
      await new Promise((x) => setTimeout(x, 30))
      assert.deepEqual(mails.map((m) => m.to).sort(), ['asha@x.in', 'officer@pangat.in'])
    } finally { delete process.env.BREVO_API_KEY; await setSettings({}) }
  })
  it('needs a reachable email or phone, and a bot filling the hidden field stores nothing', async () => {
    const { svc, queries } = build()
    await assert.rejects(() => svc.create(dto({ contact: 'not a contact' }), {}), /email address or a 10-digit phone/)
    await svc.create(dto({ website: 'http://spam.example' }), {})
    assert.equal(queries.length, 0)
    await svc.create(dto({ contact: '+91 98765 43210' }), {})
    assert.equal(queries.length, 1)
  })
  it('the public form requires the confirmation tick', async () => {
    assert.ok((await validate(plainToInstance(CreatePrivacyRequestDto, { ...dto(), confirm: false }))).length > 0)
    assert.equal((await validate(plainToInstance(CreatePrivacyRequestDto, dto()))).length, 0)
  })
  it('a request cannot be closed without saying what was done', async () => {
    const { svc } = build()
    await assert.rejects(() => svc.update('u1', { status: 'RESOLVED' }, { name: 'Nikhil' }), /Write what was done/)
  })
  it('closing records who handled it and audits the change', async () => {
    const { svc, queries, audits } = build()
    await svc.update('u1', { status: 'RESOLVED', resolutionNote: 'Erased all orders' }, { name: 'Nikhil Bhamare' })
    assert.match(queries.find((q) => /UPDATE privacy_requests/.test(q.sql)).sql, /resolved_at/); assert.equal(queries.find((q) => /UPDATE privacy_requests/.test(q.sql)).p[3], 'Nikhil Bhamare')
    assert.equal(audits[0].e.action, 'PRIVACY_REQUEST_UPDATED')
  })
  it('lookup and erasure use the last 10 digits, mask the phone in the audit, and need a full number', async () => {
    const { svc, queries, audits } = build()
    await assert.rejects(() => svc.lookup('123', {}), /10-digit/)
    await svc.lookup('+91 98765 43210', { name: 'Nikhil' })
    assert.ok(queries.some((q) => q.p?.[0] === '9876543210'))
    await svc.anonymise('+91 98765 43210', { name: 'Nikhil' }, 'PR-ABC')
    assert.ok(audits.every((a) => !JSON.stringify(a).includes('9876543210')), 'the full number must never reach the audit log')
    assert.ok(audits.some((a) => a.e.action === 'PRIVACY_ERASURE_EXECUTED' && a.e.reason === 'Privacy request PR-ABC'))
    const erase = queries.find((q) => /UPDATE orders SET customer_name = NULL/.test(q.sql)).sql
    assert.ok(!/total_amount|gst_amount|subtotal/.test(erase), 'financial fields must be left alone')
  })
})

describe('retention sweep', () => {
  it('removes personal details from old finished orders, never touches amounts, and 0 months keeps everything', async () => {
    const queries = []
    const ds = { query: async (sql, p) => { queries.push({ sql, p }); return [[], 3] } }
    await setSettings({ 'compliance.dinerDataRetentionMonths': 6, 'compliance.leadRetentionMonths': 10 })
    const r = await runPrivacyRetention(ds)
    assert.deepEqual(r, { ordersAnonymised: 3, leadsDeleted: 3 })
    assert.equal(queries[0].p[0], '6'); assert.match(queries[0].sql, /order_status IN \('COMPLETED','CANCELLED'\)/); assert.ok(!/total_amount|subtotal|gst/.test(queries[0].sql)); assert.equal(queries[1].p[0], '10')
    queries.length = 0
    await setSettings({ 'compliance.dinerDataRetentionMonths': 0 })
    assert.equal((await runPrivacyRetention(ds)).ordersAnonymised, 0)
    assert.ok(!queries.some((q) => /UPDATE orders/.test(q.sql)))
    await setSettings({})
  })
})

describe('grievance officer and published configuration', () => {
  it('Nikhil Bhamare is the default grievance officer and the public config exposes only what the policy needs', () => {
    const cfg = new PlatformSettingsService({ query: async () => [] }).publicConfig()
    assert.equal(cfg.compliance.grievanceOfficer.name, 'Nikhil Bhamare'); assert.equal(cfg.compliance.grievanceOfficer.email, null)
    assert.equal(cfg.compliance.policyVersion, PRIVACY_POLICY_VERSION); assert.equal(cfg.compliance.responseDays, 30); assert.equal(cfg.compliance.dinerDataRetentionMonths, 12)
  })
  it('only the compliance role (and owners/admins) can handle privacy requests', () => {
    const can = (r) => PLATFORM_ROLES[r].permissions.includes('privacy.manage')
    assert.deepEqual(['OWNER', 'ADMIN', 'COMPLIANCE'].map(can), [true, true, true])
    assert.deepEqual(['SUPPORT', 'FINANCE', 'ANALYST'].map(can), [false, false, false])
  })
  it('migration 014 stores consent evidence and the request register', () => {
    const sql = fs.readFileSync(new URL('../src/migrations/014_privacy.sql', import.meta.url), 'utf8')
    for (const frag of ['consent_version', 'consent_at', 'CREATE TABLE IF NOT EXISTS privacy_requests', 'due_at']) assert.ok(sql.includes(frag), frag)
  })
})

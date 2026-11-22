import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
process.env.JWT_SECRET = 'x'.repeat(40)
const { fiscalYearOf, formatDocumentNumber, issueBillNumber, issueCreditNote, ensureInvoicePrefix } = await import('../dist/billing/document-numbers.js')
const { OrdersService } = await import('../dist/orders/orders.service.js')
const { validate } = await import('class-validator')
const { plainToInstance } = await import('class-transformer')
const { UpdateSettingsDto } = await import('../dist/restaurants/dto/update-settings.dto.js')
const { RestaurantsService } = await import('../dist/restaurants/restaurants.service.js')

/** A faithful in-memory stand-in for the three tables the numbering touches, with transaction rollback. */
function fakeDb() {
  const state = { prefixes: new Map(), seq: new Map(), docs: [] }
  let snapshot
  const em = {
    async query(sql, p = []) {
      if (/SELECT invoice_prefix FROM restaurants/.test(sql)) return [{ invoice_prefix: state.prefixes.get(p[0]) ?? null }]
      if (/UPDATE restaurants SET invoice_prefix/.test(sql)) { if (![...state.prefixes.values()].includes(p[1]) && !state.prefixes.has(p[0])) state.prefixes.set(p[0], p[1]); return [] }
      if (/INSERT INTO document_sequences/.test(sql)) { const k = p.join('|'); state.seq.set(k, (state.seq.get(k) ?? 0) + 1); return [{ last_value: state.seq.get(k) }] }
      if (/INSERT INTO tax_documents/.test(sql)) { state.docs.push({ kind: /'BILL'/.test(sql) ? 'BILL' : 'CREDIT_NOTE', params: p }); return [] }
      throw new Error('unexpected sql ' + sql)
    },
    async transaction(cb) {
      snapshot = { prefixes: new Map(state.prefixes), seq: new Map(state.seq), docs: [...state.docs] }
      try { return await cb(em) } catch (e) { state.prefixes = snapshot.prefixes; state.seq = snapshot.seq; state.docs = snapshot.docs; throw e }
    },
  }
  return { em, state }
}
const order = (o = {}) => ({ id: 'o1', restaurantId: 'r1', totalAmount: 525, billNumber: null, billIssuedAt: null, ...o })

describe('financial year (India: 1 April to 31 March, in IST)', () => {
  it('labels the year and flips at midnight IST on 1 April, not midnight UTC', () => {
    assert.equal(fiscalYearOf(new Date('2026-11-22T10:00:00Z')), '2627')
    assert.equal(fiscalYearOf(new Date('2027-03-31T12:00:00Z')), '2627')
    assert.equal(fiscalYearOf(new Date('2027-03-31T18:29:59Z')), '2627')
    assert.equal(fiscalYearOf(new Date('2027-03-31T18:30:00Z')), '2728') // 00:00 on 1 April in India
    assert.equal(fiscalYearOf(new Date('2026-03-31T23:00:00Z')), '2627')
    assert.equal(fiscalYearOf(new Date('2099-06-01T00:00:00Z')), '9900')
  })
})

describe('document numbers', () => {
  it('fit the 16-character legal limit, are zero-padded, and credit notes use their own series', () => {
    const b = formatDocumentNumber('BILL', 'A1B2', '2627', 123); const c = formatDocumentNumber('CREDIT_NOTE', 'A1B2', '2627', 7)
    assert.equal(b, 'A1B2/2627/000123'); assert.equal(c, 'A1B2/2627/C00007'); assert.equal(b.length, 16); assert.equal(c.length, 16)
    assert.match(b, /^[A-Z0-9]+\/\d{4}\/\d{6}$/)
  })
  it('refuse to overflow rather than silently exceed 16 characters', () => {
    assert.throws(() => formatDocumentNumber('BILL', 'A1B2', '2627', 1_000_000), /longer than 16/)
    assert.throws(() => formatDocumentNumber('CREDIT_NOTE', 'A1B2', '2627', 100_000), /longer than 16/)
  })
})

describe('issuing bill numbers', () => {
  it('are consecutive per outlet, unique across outlets, and an order keeps its number on retry', async () => {
    const { em, state } = fakeDb()
    const a = order({ id: 'a' }), b = order({ id: 'b' }), other = order({ id: 'c', restaurantId: 'r2' })
    const when = new Date('2026-11-22T10:00:00Z')
    const na = await issueBillNumber(em, a, { name: 'Cashier' }, when); const nb = await issueBillNumber(em, b, {}, when); const nc = await issueBillNumber(em, other, {}, when)
    assert.deepEqual([na.slice(-6), nb.slice(-6)], ['000001', '000002']); assert.equal(nc.slice(-6), '000001')
    assert.notEqual(na.split('/')[0], nc.split('/')[0], 'two outlets must never share a series')
    assert.equal(await issueBillNumber(em, a, {}, when), na); assert.equal(state.docs.length, 3, 'a retry must not consume a number')
    assert.equal(a.billIssuedAt, when)
  })
  it('restart at 1 in a new financial year', async () => {
    const { em } = fakeDb()
    const x = order({ id: 'x' }), y = order({ id: 'y' })
    await issueBillNumber(em, x, {}, new Date('2027-03-31T18:00:00Z'))
    const ny = await issueBillNumber(em, y, {}, new Date('2027-03-31T19:00:00Z'))
    assert.match(ny, /\/2728\/000001$/)
  })
  it('a rolled-back payment gives its number back (no gaps)', async () => {
    const { em, state } = fakeDb()
    await issueBillNumber(em, order({ id: 'ok' }), {}, new Date('2026-11-22T10:00:00Z'))
    await assert.rejects(() => em.transaction(async (tx) => { await issueBillNumber(tx, order({ id: 'fails' }), {}, new Date('2026-11-22T10:00:00Z')); throw new Error('payment save failed') }))
    const next = await issueBillNumber(em, order({ id: 'next' }), {}, new Date('2026-11-22T10:00:00Z'))
    assert.match(next, /000002$/); assert.equal(state.docs.length, 2)
  })
  it('the outlet code is created once and never changes', async () => {
    const { em } = fakeDb()
    const p1 = await ensureInvoicePrefix(em, 'r1'); assert.match(p1, /^[AB][0-9A-Z]{3}$/); assert.equal(await ensureInvoicePrefix(em, 'r1'), p1)
  })
})

describe('credit notes', () => {
  it('get their own consecutive series, record the reason, and make sure the original bill exists', async () => {
    const { em, state } = fakeDb()
    const o = order({ id: 'legacy', settledAt: new Date('2026-11-20T10:00:00Z') }) // paid before numbering existed
    const c1 = await issueCreditNote(em, o, 100, 'wrong dish', { name: 'Mgr' }, new Date('2026-11-22T10:00:00Z'))
    const c2 = await issueCreditNote(em, o, 50, 'spilt', { name: 'Mgr' }, new Date('2026-11-22T11:00:00Z'))
    assert.match(c1, /\/C00001$/); assert.match(c2, /\/C00002$/); assert.ok(o.billNumber, 'the bill the credit refers to must exist')
    assert.deepEqual(state.docs.map((d) => d.kind), ['BILL', 'CREDIT_NOTE', 'CREDIT_NOTE'])
    assert.equal(state.docs[1].params[4], 100); assert.equal(state.docs[1].params[5], 'wrong dish')
    assert.match(o.billNumber, /\/000001$/, 'bill series is independent of the credit-note series')
  })
})

describe('bill document', () => {
  const build = (order, creditNotes = []) => {
    const svc = new OrdersService({ findOne: async () => order, manager: { query: async () => creditNotes } }, {}, { findOne: async () => order.restaurant }, {}, {}, {}, {}, {}, {})
    return svc
  }
  const o = (extra = {}) => ({
    id: 'o1', restaurantId: 'r1', orderType: 'DINE_IN', tableNumber: 'T4', createdAt: new Date('2026-11-22T10:00:00Z'), customerName: 'Asha', customerPhone: '9999999999',
    subtotal: 500, gstAmount: 25, serviceChargeAmount: 0, deliveryFee: 0, totalAmount: 525, paymentStatus: 'PAID', paymentMethod: 'UPI_INSTANT', billNumber: 'A1B2/2627/000009', billIssuedAt: new Date(), refundAmount: 0,
    restaurant: { id: 'r1', name: 'Cafe', gstin: '27AAAAA0000A1Z5', fssaiLicense: '12345678901234', hsnSac: '9963', branchArea: 'Baner' },
    items: [{ name: 'Misal', quantity: 2, price: 110, selectedModifiers: [{ name: 'Extra pav', price: 10 }] }, { name: 'Chai', quantity: 1, price: 30, selectedModifiers: [] }], ...extra,
  })
  it('shows number, GSTIN, FSSAI, the CGST/SGST split and line amounts from the stored values', async () => {
    const b = await build(o()).getBill('o1', undefined, { id: 's', role: 'STORE_MANAGER', restaurantId: 'r1' })
    assert.equal(b.status, 'ISSUED'); assert.equal(b.billNumber, 'A1B2/2627/000009'); assert.equal(b.restaurant.gstin, '27AAAAA0000A1Z5'); assert.equal(b.restaurant.fssaiLicense, '12345678901234')
    assert.deepEqual(b.gst, { ratePercent: 5, cgst: 12.5, sgst: 12.5, total: 25 }); assert.equal(b.taxableValue, 500); assert.equal(b.total, 525)
    assert.deepEqual(b.items.map((i) => i.amount), [240, 30]); assert.equal(b.items[0].unitPrice, 120)
    assert.equal(JSON.stringify(b).includes('9999999999'), false, 'the diner phone number is not part of the bill')
  })
  it('an unpaid order only has a provisional bill, and credit notes are listed', async () => {
    const b = await build(o({ billNumber: null, paymentStatus: 'PENDING' })).getBill('o1', undefined, { id: 's', role: 'CASHIER', restaurantId: 'r1' })
    assert.equal(b.status, 'PROVISIONAL'); assert.equal(b.billNumber, null)
    const c = await build(o(), [{ number: 'A1B2/2627/C00001', amount: '100.00', reason: 'wrong dish', issuedAt: new Date() }]).getBill('o1', undefined, { id: 's', role: 'SUPER_OWNER', restaurantId: 'r1' })
    assert.deepEqual(c.creditNotes.map((x) => [x.number, x.amount]), [['A1B2/2627/C00001', 100]])
  })
  it('is never given to the kitchen role', async () => {
    await assert.rejects(() => build(o()).getBill('o1', undefined, { id: 'k', role: 'CHEF', restaurantId: 'r1' }), /kitchen/)
  })
})

describe('GSTIN and FSSAI validation', () => {
  const ok = async (d) => (await validate(plainToInstance(UpdateSettingsDto, d))).length === 0
  it('accepts a valid GSTIN and 14-digit FSSAI, and rejects malformed ones; empty clears', async () => {
    assert.ok(await ok({ gstin: '27AAAAA0000A1Z5', fssaiLicense: '12345678901234' }))
    assert.ok(await ok({ gstin: '', fssaiLicense: '' }))
    assert.ok(!(await ok({ gstin: '27AAAAA0000A1Z' }))); assert.ok(!(await ok({ gstin: 'not-a-gstin' })))
    assert.ok(!(await ok({ fssaiLicense: '1234567' }))); assert.ok(!(await ok({ fssaiLicense: 'ABCDEFGHIJKLMN' })))
  })
  it('the FSSAI licence is owner-only like the other tax identity fields', async () => {
    assert.ok(RestaurantsService.OWNER_ONLY_SETTINGS.includes('fssaiLicense'))
  })
})

describe('migration 015', () => {
  const sql = fs.readFileSync(new URL('../src/migrations/015_tax_documents.sql', import.meta.url), 'utf8')
  it('makes the register append-only and keeps numbers unique per outlet', () => {
    for (const f of ['BEFORE UPDATE OR DELETE ON tax_documents', 'BEFORE TRUNCATE ON tax_documents', 'UNIQUE (restaurant_id, number)', 'uq_orders_bill_number', 'uq_restaurants_invoice_prefix', 'ON DELETE RESTRICT']) assert.ok(sql.includes(f), f)
  })
})

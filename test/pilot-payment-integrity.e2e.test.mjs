/**
 * Pilot readiness: money safety, live. A RUNNING API on a THROWAWAY database (never production).
 *
 *   DATABASE_URL=postgres://... THROTTLE_DISABLED=true PLATFORM_BOOTSTRAP_SECRET=bootstrapsecret1234567 \
 *     RAZORPAY_WEBHOOK_SECRET=whsec_test_123 PORT=4000 node dist/main &
 *   npm run test:pilot-payments
 *
 * Proves against real PostgreSQL, with genuinely simultaneous requests:
 *  - order creation is idempotent on the SERVER (retries, double taps, concurrent duplicates, key reuse with another request = 409)
 *  - mark-paid issues exactly one bill however many cashiers press it
 *  - a refund key creates exactly one refund / credit note / audit row; refunds can never exceed what was paid
 *  - cancel racing payment leaves a consistent order
 *  - guest UPI goes only to the outlet's own, owner-confirmed ID, and nowhere else
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const PW2 = 'Tulsi-Wada-Pune-42';
const db = new pg.Client({ connectionString: DB });

async function call(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, code: json?.code };
}
const idem = () => `idem-${crypto.randomBytes(8).toString('hex')}`;
const all = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

const body = (tag, extra = {}) => ({
  brandName: `Brand ${tag}`, ownerFullName: `Owner ${tag}`, mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW,
  outletName: `Outlet ${tag}`, slug: `pi-${tag}-${run}`, upiVpa: `${tag}shop@upi`, gstPercentage: 5, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468',
  indoorTableCount: 2, outdoorTableCount: 0, ...extra,
});
async function onboard(tag, extra = {}) {
  const r = await call('POST', '/auth/onboard', { body: body(tag, extra) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug: `pi-${tag}-${run}`, email: `o-${tag}-${run}@example.com`, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}
const firstItem = async (slug) => { const i = (await call('GET', `/menu/public/${slug}`)).data.items[0]; return { menuItemId: i.id, name: i.name, price: Number(i.price), quantity: 1 }; };
const orderBody = (slug, items, extra = {}) => ({ restaurantSlug: slug, orderType: 'TAKEAWAY', customerName: 'Guest', consentAccepted: true, paymentMethod: 'PAY_AT_COUNTER', items, ...extra });
const place = (slug, items, key = idem(), extra = {}) => call('POST', '/orders', { headers: { 'x-idempotency-key': key }, body: orderBody(slug, items, extra) });
const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].n);
const bills = (id) => count("SELECT COUNT(*) n FROM tax_documents WHERE order_id = $1 AND kind = 'BILL'", [id]);
const creditNotes = (id) => count("SELECT COUNT(*) n FROM tax_documents WHERE order_id = $1 AND kind = 'CREDIT_NOTE'", [id]);
const refunds = (id) => count('SELECT COUNT(*) n FROM order_refunds WHERE order_id = $1', [id]);
const audits = (id, action) => count('SELECT COUNT(*) n FROM audit_logs WHERE entity_id = $1 AND action = $2', [id, action]);
const orderRow = async (id) => (await db.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
const paid = async (o, id) => call('PATCH', `/orders/${id}/mark-paid`, { token: o.token });
const cancel = (o, id) => call('POST', `/orders/${id}/cancel`, { token: o.token, body: { reason: 'guest left' } });
const refund = (o, id, extra = {}) => call('POST', `/orders/${id}/refund`, { token: o.token, body: { refundMethod: 'COUNTER_CASH', reason: 'test refund', idempotencyKey: idem(), ...extra } });
/** an order that is PAID, then cancelled: the state in which refunds are allowed */
async function refundable(o, item) {
  const ord = await place(o.slug, [item]);
  assert.equal(ord.status, 201, JSON.stringify(ord.body));
  assert.equal((await paid(o, ord.data.id)).status, 200);
  assert.equal((await cancel(o, ord.data.id)).status, 201);
  return ord.data;
}

let O;
let ITEM;
before(async () => {
  await db.connect();
  O = await onboard('main');
  ITEM = await firstItem(O.slug);
});
after(async () => { await db.end(); });

describe('Order creation is idempotent on the server', () => {
  it('ten simultaneous identical submissions (double tap / retry storm) create exactly one order', async () => {
    const key = idem();
    const rs = await all(10, () => place(O.slug, [ITEM], key));
    assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join(','));
    assert.equal(new Set(rs.map((r) => r.data.id)).size, 1, 'every caller got the same order');
    assert.equal(await count('SELECT COUNT(*) n FROM orders WHERE idempotency_key = $1', [key]), 1);
    assert.equal(await count('SELECT COUNT(*) n FROM order_items WHERE order_id = $1', [rs[0].data.id]), 1);
  });

  it('a network timeout followed by a retry with the same key returns the original order, unchanged', async () => {
    const key = idem();
    const first = await place(O.slug, [ITEM], key);
    const retry = await place(O.slug, [ITEM], key);
    assert.equal(retry.status, 201);
    assert.equal(retry.data.id, first.data.id);
    assert.equal(retry.data.trackingToken, first.data.trackingToken);
  });

  it('the same key with a DIFFERENT request is a conflict, not a silent replay and not a second order', async () => {
    const key = idem();
    const first = await place(O.slug, [ITEM], key);
    const moreItems = await place(O.slug, [{ ...ITEM, quantity: 3 }], key);
    assert.equal(moreItems.status, 409);
    assert.equal(moreItems.code, 'IDEMPOTENCY_KEY_REUSED');
    const otherName = await place(O.slug, [ITEM], key, { customerName: 'Somebody else' });
    assert.equal(otherName.status, 409);
    assert.equal(await count('SELECT COUNT(*) n FROM orders WHERE idempotency_key = $1', [key]), 1);
    assert.equal((await place(O.slug, [ITEM], key)).data.id, first.data.id, 'the original request still replays');
  });

  it('a key cannot be replayed against another outlet', async () => {
    const other = await onboard('xo');
    const key = idem();
    assert.equal((await place(O.slug, [ITEM], key)).status, 201);
    const cross = await place(other.slug, [await firstItem(other.slug)], key);
    assert.equal(cross.status, 409);
  });

  it('a genuinely new order with a new key is a new order', async () => {
    const a = await place(O.slug, [ITEM]);
    const b = await place(O.slug, [ITEM]);
    assert.notEqual(a.data.id, b.data.id);
  });

  it('different-payload requests racing on one key: exactly one wins, the rest are conflicts', async () => {
    const key = idem();
    const rs = await all(6, (i) => place(O.slug, [{ ...ITEM, quantity: 1 + (i % 3) }], key));
    const created = new Set(rs.filter((r) => r.status === 201).map((r) => r.data.id));
    assert.equal(created.size, 1);
    assert.ok(rs.every((r) => r.status === 201 || r.status === 409), rs.map((r) => r.status).join(','));
    assert.equal(await count('SELECT COUNT(*) n FROM orders WHERE idempotency_key = $1', [key]), 1);
  });

  it('the idempotency key is required, and there is no client-side shortcut: no header, no order', async () => {
    const r = await call('POST', '/orders', { body: orderBody(O.slug, [ITEM]) });
    assert.equal(r.status, 400);
  });
});

describe('Mark paid is atomic: one bill per order however many cashiers press it', () => {
  it('ten simultaneous mark-paid requests issue exactly one bill, one serial and one audit record', async () => {
    const ord = (await place(O.slug, [ITEM])).data;
    const seqBefore = await count("SELECT COALESCE(MAX(last_value),0) n FROM document_sequences WHERE kind = 'BILL' AND restaurant_id = $1", [O.outlet.id]);
    const rs = await all(10, () => paid(O, ord.id));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','));
    assert.equal(new Set(rs.map((r) => r.data.billNumber)).size, 1, 'everyone sees the same bill number');
    assert.equal(await bills(ord.id), 1, 'one BILL document');
    assert.equal(await count("SELECT COALESCE(MAX(last_value),0) n FROM document_sequences WHERE kind = 'BILL' AND restaurant_id = $1", [O.outlet.id]), seqBefore + 1, 'exactly one serial was consumed');
    assert.equal(await audits(ord.id, 'PAYMENT_MARKED_PAID'), 1, 'one audit record');
    const row = await orderRow(ord.id);
    assert.equal(row.payment_status, 'PAID');
    assert.equal(row.bill_number, rs[0].data.billNumber);
  });

  it('marking paid again later returns the original result and moves nothing', async () => {
    const ord = (await place(O.slug, [ITEM])).data;
    const a = await paid(O, ord.id);
    const settled = (await orderRow(ord.id)).settled_at;
    const b = await paid(O, ord.id);
    assert.equal(b.data.billNumber, a.data.billNumber);
    assert.equal(+(await orderRow(ord.id)).settled_at, +settled, 'settlement time did not move');
  });

  it('bill numbers across different orders are consecutive and unique', async () => {
    const ords = await all(5, () => place(O.slug, [ITEM]));
    const rs = await all(5, (i) => paid(O, ords[i].data.id));
    const nums = rs.map((r) => Number(r.data.billNumber.split('/').pop())).sort((x, y) => x - y);
    assert.equal(new Set(nums).size, 5);
    assert.equal(nums[4] - nums[0], 4, `no gaps: ${nums.join(',')}`);
  });
});

describe('Refunds are atomic and idempotent', () => {
  it('ten simultaneous identical refunds (same key) create one refund, one credit note, one audit record', async () => {
    const ord = await refundable(O, ITEM);
    const key = idem();
    const rs = await all(10, () => refund(O, ord.id, { idempotencyKey: key }));
    assert.ok(rs.every((r) => r.status === 201), rs.map((r) => `${r.status}`).join(','));
    assert.equal(await refunds(ord.id), 1);
    assert.equal(await creditNotes(ord.id), 1);
    assert.equal(await audits(ord.id, 'ORDER_REFUND_SETTLED'), 1);
    const row = await orderRow(ord.id);
    assert.equal(Number(row.refund_amount), Number(row.total_amount), 'refunded once, in full');
    assert.equal(row.payment_status, 'REFUNDED');
    assert.equal((await db.query('SELECT credit_note_number FROM order_refunds WHERE order_id = $1', [ord.id])).rows[0].credit_note_number.length > 0, true);
  });

  it('a retry of a completed refund returns the original result and does not refund again', async () => {
    const ord = await refundable(O, ITEM);
    const key = idem();
    assert.equal((await refund(O, ord.id, { idempotencyKey: key })).status, 201);
    const again = await refund(O, ord.id, { idempotencyKey: key });
    assert.equal(again.status, 201);
    assert.equal(again.data.paymentStatus, 'REFUNDED');
    assert.equal(await refunds(ord.id), 1);
    assert.equal(await creditNotes(ord.id), 1);
  });

  it('the same key reused for a different amount, method or reason is a 409 and changes nothing', async () => {
    const ord = await refundable(O, ITEM);
    const total = Number((await orderRow(ord.id)).total_amount);
    const key = idem();
    const part = Math.floor(total * 30) / 100;
    assert.equal((await refund(O, ord.id, { idempotencyKey: key, amount: part })).status, 201);
    const diffAmount = await refund(O, ord.id, { idempotencyKey: key, amount: part + 1 });
    assert.equal(diffAmount.status, 409);
    assert.equal(diffAmount.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await refund(O, ord.id, { idempotencyKey: key, amount: part, reason: 'a different reason' })).status, 409);
    assert.equal(Number((await orderRow(ord.id)).refund_amount), part);
    assert.equal(await refunds(ord.id), 1);
  });

  it('refunds with DIFFERENT keys racing can never exceed what was paid', async () => {
    const ord = await refundable(O, ITEM);
    const total = Number((await orderRow(ord.id)).total_amount);
    const slice = Math.floor(total * 40) / 100; // 40% each: only two can fit
    const rs = await all(8, () => refund(O, ord.id, { amount: slice }));
    const ok = rs.filter((r) => r.status === 201);
    const rejected = rs.filter((r) => r.status === 400);
    assert.equal(ok.length, 2, rs.map((r) => r.status).join(','));
    assert.equal(ok.length + rejected.length, 8, 'every request was either applied or cleanly rejected');
    const row = await orderRow(ord.id);
    assert.equal(Number(row.refund_amount), Math.round(slice * 2 * 100) / 100);
    assert.ok(Number(row.refund_amount) <= Number(row.total_amount));
    assert.equal(row.payment_status, 'PARTIALLY_REFUNDED');
    assert.equal(await refunds(ord.id), 2);
    assert.equal(await creditNotes(ord.id), 2);
    assert.equal(await audits(ord.id, 'ORDER_REFUND_SETTLED'), 2);
  });

  it('simultaneous full refunds with different keys: exactly one succeeds', async () => {
    const ord = await refundable(O, ITEM);
    const rs = await all(6, () => refund(O, ord.id));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join(','));
    assert.equal(await refunds(ord.id), 1);
    assert.equal(await creditNotes(ord.id), 1);
    assert.equal((await orderRow(ord.id)).payment_status, 'REFUNDED');
  });

  it('a refund that is rejected consumes no credit-note serial and leaves no refund or audit row', async () => {
    const ord = await refundable(O, ITEM);
    const seq = () => count("SELECT COALESCE(MAX(last_value),0) n FROM document_sequences WHERE kind = 'CREDIT_NOTE' AND restaurant_id = $1", [O.outlet.id]);
    const before = await seq();
    const tooMuch = await refund(O, ord.id, { amount: 99999 });
    assert.equal(tooMuch.status, 400);
    assert.equal(await seq(), before, 'no serial was consumed by a rejected refund');
    assert.equal(await refunds(ord.id), 0);
    assert.equal(await audits(ord.id, 'ORDER_REFUND_SETTLED'), 0);
  });

  it('an order that was never paid cannot be refunded; the refund route stays staff-only', async () => {
    const ord = (await place(O.slug, [ITEM])).data;
    assert.equal((await refund(O, ord.id)).status, 400);
    assert.equal((await call('POST', `/orders/${ord.id}/refund`, { body: { refundMethod: 'COUNTER_CASH', reason: 'xxx', idempotencyKey: idem() } })).status, 401);
  });
});

describe('Payment and cancellation racing each other stay consistent', () => {
  it('mark-paid and cancel fired together never leave a CANCELLED order with a bill but no refund request, nor a paid order with no bill', async () => {
    for (let i = 0; i < 6; i++) {
      const ord = (await place(O.slug, [ITEM])).data;
      const [a, b] = await Promise.all([paid(O, ord.id), cancel(O, ord.id)]);
      const row = await orderRow(ord.id);
      const billed = await bills(ord.id);
      assert.ok(billed <= 1);
      if (row.payment_status === 'PAID') assert.equal(billed, 1, 'PAID means billed');
      if (row.payment_status === 'REFUND_PENDING') {
        assert.equal(row.order_status, 'CANCELLED');
        assert.equal(billed, 1, 'a refund is only ever owed on a billed order');
      }
      if (row.payment_status === 'FAILED') {
        assert.equal(row.order_status, 'CANCELLED');
        assert.equal(billed, 0, 'a cancelled unpaid order has no bill');
      }
      assert.ok([a.status, b.status].every((s) => [200, 201, 400].includes(s)), `${a.status} ${b.status}`);
    }
  });

  it('a double cancel records the cancellation once', async () => {
    const ord = (await place(O.slug, [ITEM])).data;
    const rs = await all(5, () => cancel(O, ord.id));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join(','));
    assert.equal(await audits(ord.id, 'ORDER_CANCELLED'), 1);
  });
});

describe('Guest UPI goes only to the outlet\'s own, owner-confirmed ID', () => {
  const menu = async (slug) => (await call('GET', `/menu/public/${slug}`)).data;
  const upiOrder = (slug, item) => call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: orderBody(slug, [item], { paymentMethod: 'UPI_INSTANT' }) });
  const confirm = (o, vpa) => call('POST', `/restaurants/${o.outlet.id}/upi/confirm`, { token: o.token, body: { vpa } });

  it('an outlet whose ID the owner has NOT confirmed offers no UPI: not in the public menu, and UPI orders are refused', async () => {
    const o = await onboard('u1');
    const m = await menu(o.slug);
    assert.equal(m.restaurant.upiVpa, '', 'the ID is not even sent to guests');
    assert.equal(m.restaurant.operations.payments.upi, false);
    const r = await upiOrder(o.slug, await firstItem(o.slug));
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body.message), /UPI payment is not available/);
    const outlet = await call('GET', `/restaurants/${o.slug}`);
    assert.equal(outlet.data.upiVpa, '', 'the anonymous outlet profile does not leak it either');
  });

  it('the owner confirms the exact ID on file; then it is offered, and tracking shows THIS outlet\'s ID and name', async () => {
    const o = await onboard('u2');
    assert.equal((await confirm(o, 'someoneelse@upi')).status, 400, 'a different ID cannot be confirmed');
    assert.equal((await confirm(o, 'not a vpa')).status, 400, 'a malformed ID is rejected');
    const ok = await confirm(o, 'u2shop@upi');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const m = await menu(o.slug);
    assert.equal(m.restaurant.upiVpa, 'u2shop@upi');
    assert.equal(m.restaurant.operations.payments.upi, true);
    const item = await firstItem(o.slug);
    const ord = await upiOrder(o.slug, item);
    assert.equal(ord.status, 201, JSON.stringify(ord.body));
    const tracked = await call('GET', `/orders/${ord.data.id}?token=${ord.data.trackingToken}`);
    assert.deepEqual(tracked.data.payee, { vpa: 'u2shop@upi', name: 'Outlet u2' });
    assert.equal(tracked.data.paymentStatus, 'PENDING', 'creating a UPI order does not pay it');
    assert.equal((await orderRow(ord.data.id)).bill_number, null, 'no bill, no settlement, until staff confirm receipt');
    assert.equal((await paid(o, ord.data.id)).status, 200);
    assert.equal((await call('GET', `/orders/${ord.data.id}?token=${ord.data.trackingToken}`)).data.payee, null, 'nothing left to pay once settled');
  });

  it('changing the UPI ID clears the confirmation: the new destination is not trusted until the owner confirms it', async () => {
    const o = await onboard('u3');
    assert.equal((await confirm(o, 'u3shop@upi')).status, 201);
    const ch = await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { upiVpa: 'newid@upi' } });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const m = await menu(o.slug);
    assert.equal(m.restaurant.upiVpa, '');
    assert.equal(m.restaurant.operations.payments.upi, false);
    assert.equal((await upiOrder(o.slug, await firstItem(o.slug))).status, 400);
    assert.equal((await confirm(o, 'u3shop@upi')).status, 400, 'the old ID can no longer be confirmed');
    assert.equal((await confirm(o, 'newid@upi')).status, 201);
    assert.equal((await menu(o.slug)).restaurant.upiVpa, 'newid@upi');
  });

  it('an invalid ID is rejected everywhere it can be entered (settings, sign-up, new outlet)', async () => {
    const o = await onboard('u4');
    assert.equal((await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { upiVpa: 'nope' } })).status, 400);
    assert.equal((await call('POST', '/auth/onboard', { body: body('u4b', { upiVpa: 'nope' }) })).status, 400);
    // blank is NOT invalid: it means "no UPI yet" (the owner adds and confirms their own later). Nothing is invented in its place.
    const blank = await call('POST', '/auth/onboard', { body: body('u4c', { upiVpa: '' }) });
    assert.equal(blank.status, 201, JSON.stringify(blank.body));
    assert.equal((await menu(blank.data.outlet.slug)).restaurant.upiVpa, '', 'no destination, no UPI offered');
  });

  it('UPI switched off for the outlet: no UPI even with a confirmed ID', async () => {
    const o = await onboard('u5');
    assert.equal((await confirm(o, 'u5shop@upi')).status, 201);
    assert.equal((await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { operations: { payments: { upi: false } } } })).status, 200);
    const m = await menu(o.slug);
    assert.equal(m.restaurant.operations.payments.upi, false);
    assert.equal(m.restaurant.upiVpa, '', 'not sent while UPI is off');
    assert.equal((await upiOrder(o.slug, await firstItem(o.slug))).status, 400);
  });

  it('counter payment keeps working with UPI unavailable; the tracking payload has no payee', async () => {
    const o = await onboard('u6');
    const ord = await place(o.slug, [await firstItem(o.slug)]);
    assert.equal(ord.status, 201);
    const tracked = await call('GET', `/orders/${ord.data.id}?token=${ord.data.trackingToken}`);
    assert.equal(tracked.data.payee, null);
    assert.equal((await paid(o, ord.data.id)).status, 200);
  });

  it('tenants are isolated: one restaurant cannot confirm another\'s ID, and a guest never sees another outlet\'s ID', async () => {
    const a = await onboard('ua');
    const b = await onboard('ub');
    assert.equal((await confirm(a, 'uashop@upi')).status, 201);
    assert.equal((await confirm(b, 'ubshop@upi')).status, 201);
    const cross = await call('POST', `/restaurants/${a.outlet.id}/upi/confirm`, { token: b.token, body: { vpa: 'uashop@upi' } });
    assert.ok([403, 404].includes(cross.status), `cross-tenant confirm refused (${cross.status})`);
    const oa = await upiOrder(a.slug, await firstItem(a.slug));
    const ob = await upiOrder(b.slug, await firstItem(b.slug));
    const ta = (await call('GET', `/orders/${oa.data.id}?token=${oa.data.trackingToken}`)).data.payee;
    const tb = (await call('GET', `/orders/${ob.data.id}?token=${ob.data.trackingToken}`)).data.payee;
    assert.equal(ta.vpa, 'uashop@upi');
    assert.equal(tb.vpa, 'ubshop@upi');
    assert.ok(!JSON.stringify((await menu(a.slug))).includes('ubshop'), 'outlet A\'s public data never contains outlet B\'s ID');
    // a token only ever opens ITS OWN order: asking for B's order with A's token returns A's order, never B's data
    const mixed = await call('GET', `/orders/${ob.data.id}?token=${oa.data.trackingToken}`);
    assert.ok(mixed.status === 404 || (mixed.data.id === oa.data.id && mixed.data.payee?.vpa === 'uashop@upi'), 'never B\'s order');
  });

  it('a manager cannot confirm the UPI ID (the owner decides where customer money goes)', async () => {
    const o = await onboard('u7');
    const mgr = await call('POST', `/restaurants/${o.outlet.id}/staff`, { token: o.token, body: { name: 'Mgr', email: `mgr-u7-${run}@example.com`, password: PW, role: 'STORE_MANAGER' } });
    assert.equal(mgr.status, 201, JSON.stringify(mgr.body));
    const first = await call('POST', '/auth/login', { body: { email: `mgr-u7-${run}@example.com`, password: PW } });
    const t = (await call('POST', '/auth/change-password', { token: first.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
    assert.equal((await call('POST', `/restaurants/${o.outlet.id}/upi/confirm`, { token: t, body: { vpa: 'u7shop@upi' } })).status, 403);
    assert.equal((await call('POST', `/restaurants/${o.outlet.id}/upi/confirm`, { body: { vpa: 'u7shop@upi' } })).status, 401);
  });

  it('there is no hardcoded fallback destination anywhere in the API source', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]));
    const hits = walk(path.join(__dirname, '../src')).filter((f) => /\.ts$/.test(f) && /pangat@(icici|upi|hdfc|sbi)|@icici/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(hits, []);
  });
});

describe('Migration 020', () => {
  const up = fs.readFileSync(path.join(__dirname, '../src/migrations/020_payment_integrity.sql'), 'utf8');
  it('is idempotent and changes no existing order or refund data', async () => {
    const snap = async () => (await db.query('SELECT COUNT(*)::int n, COALESCE(SUM(total_amount),0)::text t, COALESCE(SUM(refund_amount),0)::text r FROM orders')).rows[0];
    const before = await snap();
    await db.query(up);
    await db.query(up);
    assert.deepEqual(await snap(), before);
    assert.equal((await db.query("SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_refund_within_total'")).rowCount, 1);
    assert.equal((await db.query("SELECT 1 FROM pg_indexes WHERE indexname = 'uq_tax_documents_bill_per_order'")).rowCount, 1);
  });
  it('the database itself refuses a second bill for an order and a refund beyond the total', async () => {
    const ord = (await place(O.slug, [ITEM])).data;
    await paid(O, ord.id);
    await assert.rejects(db.query("INSERT INTO tax_documents (restaurant_id, order_id, kind, number, fiscal_year, amount) VALUES ($1,$2,'BILL','ZZ/9999/000001','9999',1)", [O.outlet.id, ord.id]), /uq_tax_documents_bill_per_order|duplicate key/);
    await assert.rejects(db.query('UPDATE orders SET refund_amount = total_amount + 1 WHERE id = $1', [ord.id]), /chk_orders_refund_within_total/);
  });
});

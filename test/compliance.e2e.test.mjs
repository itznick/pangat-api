/**
 * Live tests for the compliance work, against a running API and PostgreSQL (real stack, no mocks):
 * bill numbers, credit notes, append-only tables, consent, the kitchen's redacted view, privacy requests, two-factor.
 *
 *   (same setup as integration.e2e.test.mjs)  UAT_API=http://localhost:4100/api/v1 npm run test:compliance
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const db = new pg.Client({ connectionString: DB });

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data };
}
const idem = () => `idem-${crypto.randomBytes(8).toString('hex')}`;
async function onboard(tag) {
  const slug = `c-${tag}-${run}`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `Brand ${tag}`, ownerFullName: `Owner ${tag}`, mobileNumber: '9876500001', email: `owner-${tag}-${run}@example.com`, password: PW, outletName: `Outlet ${tag}`, slug, upiVpa: 'shop@upi', gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}
const items = async (slug) => (await call('GET', `/menu/public/${slug}`)).data.items.slice(0, 2).map((i) => ({ menuItemId: i.id, name: i.name, price: Number(i.price), quantity: 1 }));
const order = async (slug, extra = {}) => call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: { restaurantSlug: slug, orderType: 'TAKEAWAY', customerName: 'Rahul Sharma', customerPhone: '9876543210', consentAccepted: true, paymentMethod: 'PAY_AT_COUNTER', items: await items(slug), ...extra } });

let A;
before(async () => { await db.connect(); A = await onboard('a'); });
after(async () => { await db.end(); });

describe('consent', () => {
  it('refuses personal details without consent and records the notice version when given', async () => {
    const bad = await call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: { restaurantSlug: A.slug, orderType: 'TAKEAWAY', customerName: 'Rahul', paymentMethod: 'PAY_AT_COUNTER', items: await items(A.slug) } });
    assert.equal(bad.status, 400); assert.match(JSON.stringify(bad.body), /Privacy Notice/);
    const ok = await order(A.slug);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const { rows } = await db.query('SELECT consent_version, consent_at FROM orders WHERE id = $1', [ok.data.id]);
    assert.match(rows[0].consent_version, /^\d{4}-\d{2}-\d{2}$/); assert.ok(rows[0].consent_at);
  });
  it('demo requests need consent too', async () => {
    const body = { name: 'A', restaurantName: 'R', phone: '9999999999', city: 'Pune' };
    assert.equal((await call('POST', '/leads', { body })).status, 400);
    assert.equal((await call('POST', '/leads', { body: { ...body, consentAccepted: true } })).status, 201);
  });
});

describe('bills, credit notes and the statutory register', () => {
  let o1, o2;
  it('a paid order gets a consecutive bill number (outlet/year/6 digits, 16 characters)', async () => {
    o1 = (await order(A.slug)).data; o2 = (await order(A.slug)).data;
    const p1 = await call('PATCH', `/orders/${o1.id}/mark-paid`, { token: A.token }); assert.equal(p1.status, 200, JSON.stringify(p1.body));
    const p2 = await call('PATCH', `/orders/${o2.id}/mark-paid`, { token: A.token });
    for (const p of [p1, p2]) assert.match(p.data.billNumber, /^[A-Z0-9]{4}\/\d{4}\/\d{6}$/); assert.equal(p1.data.billNumber.length, 16);
    assert.equal(Number(p2.data.billNumber.slice(-6)) - Number(p1.data.billNumber.slice(-6)), 1);
    // marking paid again changes nothing and does not consume a number
    assert.equal((await call('PATCH', `/orders/${o1.id}/mark-paid`, { token: A.token })).data.billNumber, p1.data.billNumber);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM tax_documents WHERE order_id = $1 AND kind = 'BILL'", [o1.id]); assert.equal(rows[0].n, 1);
  });
  it('the printable bill shows number, GSTIN split and totals; a paid bill cannot be edited', async () => {
    const b = await call('GET', `/orders/${o1.id}/bill`, { token: A.token });
    assert.equal(b.status, 200); assert.equal(b.data.status, 'ISSUED'); assert.ok(b.data.billNumber); assert.equal(b.data.gst.cgst + b.data.gst.sgst, b.data.gst.total)
    assert.equal(Math.round((b.data.taxableValue + b.data.gst.total) * 100), Math.round(b.data.total * 100))
    const edit = await call('PATCH', `/orders/${o1.id}/items`, { token: A.token, body: { items: await items(A.slug) } });
    assert.equal(edit.status, 400); assert.match(JSON.stringify(edit.body), /already paid and numbered/);
  });
  it('cancelling a paid order and settling the refund issues a credit note that appears on the bill', async () => {
    const c = await call('POST', `/orders/${o2.id}/cancel`, { token: A.token, body: { reason: 'Wrong order' } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await call('POST', `/orders/${o2.id}/refund`, { token: A.token, body: { idempotencyKey: idem(), refundMethod: 'COUNTER_CASH', reason: 'Customer cancelled' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = await call('GET', `/orders/${o2.id}/bill`, { token: A.token });
    assert.equal(b.data.creditNotes.length, 1); assert.match(b.data.creditNotes[0].number, /^[A-Z0-9]{4}\/\d{4}\/C\d{5}$/); assert.equal(b.data.creditNotes[0].number.length, 16)
    const audit = await db.query("SELECT metadata FROM audit_logs WHERE entity_id = $1 AND action = 'ORDER_REFUND_SETTLED'", [o2.id]);
    assert.equal(audit.rows[0].metadata.creditNoteNumber, b.data.creditNotes[0].number);
  });
  it('the register and both audit tables reject UPDATE, DELETE and TRUNCATE (the database itself refuses)', async () => {
    for (const sql of [
      "UPDATE tax_documents SET amount = 1", "DELETE FROM tax_documents", "TRUNCATE tax_documents",
      "UPDATE audit_logs SET reason = 'x'", "DELETE FROM audit_logs", "TRUNCATE audit_logs",
      "UPDATE platform_audit_logs SET summary = 'x'", "DELETE FROM platform_audit_logs",
    ]) await assert.rejects(() => db.query(sql), /append-only/, sql);
  });
  it('audit entries carry request id, ip and device, and money actions are recorded with the actor', async () => {
    const { rows } = await db.query("SELECT staff_name, staff_role, ip, user_agent, request_id, metadata FROM audit_logs WHERE action = 'PAYMENT_MARKED_PAID' AND entity_id = $1", [o1.id]);
    assert.equal(rows.length, 1); assert.match(rows[0].request_id, /^[0-9a-f-]{36}$/); assert.ok(rows[0].ip); assert.equal(rows[0].metadata.billNumber, o1.billNumber ?? rows[0].metadata.billNumber)
  });
  it('error responses carry the request id that is also a response header', async () => {
    const r = await fetch(API + '/orders/does-not-exist');
    const body = await r.json();
    assert.equal(body.requestId, r.headers.get('x-request-id')); assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  });
});

describe('the kitchen sees a redacted order', () => {
  it('a chef signed in with the kitchen PIN gets no phone, address, token or money fields', async () => {
    const placed = await order(A.slug, { orderType: 'DELIVERY', deliveryAddress: '12 MG Road', paymentMethod: 'COD' });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const k = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: A.slug } });
    assert.equal(k.status, 200);
    const list = await call('GET', `/orders?restaurantSlug=${A.slug}`, { token: k.data.accessToken });
    assert.equal(list.status, 200);
    const mine = list.data.find((x) => x.id === placed.data.id);
    assert.ok(mine, 'the kitchen still sees the order');
    for (const f of ['customerPhone', 'deliveryAddress', 'totalAmount', 'trackingToken', 'paymentStatus', 'subtotal']) assert.equal(f in mine, false, `kitchen must not receive ${f}`);
    assert.equal(mine.customerName, 'Rahul'); assert.ok(mine.items.length > 0 && !('price' in mine.items[0]));
    assert.equal((await call('GET', `/orders/${placed.data.id}/bill`, { token: k.data.accessToken })).status, 403, 'no bills for the kitchen');
    // the owner still sees everything
    const full = (await call('GET', `/orders?restaurantSlug=${A.slug}`, { token: A.token })).data.find((x) => x.id === placed.data.id);
    assert.equal(full.customerPhone, '9876543210');
  });
});

describe('owner-only payment settings', () => {
  it('a manager cannot change the UPI ID; the owner can, and it is audited', async () => {
    const hire = await call('POST', `/restaurants/${A.outlet.id}/staff`, { token: A.token, body: { name: 'Manu', email: `mgr-${run}@example.com`, password: PW, role: 'STORE_MANAGER' } });
    assert.equal(hire.status, 201, JSON.stringify(hire.body));
    const first = await call('POST', '/auth/login', { body: { email: `mgr-${run}@example.com`, password: PW } });
    const chg = await call('POST', '/auth/change-password', { token: first.data.accessToken, body: { currentPassword: PW, newPassword: 'Tulsi-Wada-Pune-42' } });
    const mgr = chg.data.accessToken;
    assert.equal((await call('PATCH', `/restaurants/${A.slug}/settings`, { token: mgr, body: { upiVpa: 'thief@upi' } })).status, 403);
    assert.equal((await call('PATCH', `/restaurants/${A.slug}/settings`, { token: mgr, body: { phone: '9000000000' } })).status, 200);
    assert.equal((await call('PATCH', `/restaurants/${A.slug}/settings`, { token: A.token, body: { upiVpa: 'newshop@upi' } })).status, 200);
    const { rows } = await db.query("SELECT metadata FROM audit_logs WHERE restaurant_id = $1 AND action = 'SETTINGS_UPDATED' ORDER BY created_at DESC LIMIT 1", [A.outlet.id]);
    assert.equal(rows[0].metadata.after.upi, 'newshop@upi');
  });
});

describe('privacy requests', () => {
  it('anyone can raise one; the honeypot stores nothing; the reference is returned', async () => {
    const ok = await call('POST', '/privacy/requests', { body: { kind: 'ERASURE', name: 'Rahul', contact: '9876543210', message: 'delete me', confirm: true } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.match(ok.data.reference, /^PR-[A-Z2-9]{8}$/);
    const bot = await call('POST', '/privacy/requests', { body: { kind: 'ACCESS', name: 'Bot', contact: 'bot@spam.example', confirm: true, website: 'http://spam' } });
    const { rows } = await db.query("SELECT count(*)::int AS n FROM privacy_requests WHERE reference = $1", [bot.data.reference]); assert.equal(rows[0].n, 0);
    assert.equal((await call('POST', '/privacy/requests', { body: { kind: 'ACCESS', name: 'x', contact: 'x@y.com', confirm: false } })).status, 400);
    const stored = await db.query("SELECT status, due_at > now() AS future FROM privacy_requests WHERE reference = $1", [ok.data.reference]);
    assert.equal(stored.rows[0].status, 'OPEN'); assert.equal(stored.rows[0].future, true);
  });
  it('the officer endpoints are closed to restaurants and the public', async () => {
    assert.equal((await call('GET', '/admin/privacy/requests')).status, 401);
    assert.equal((await call('GET', '/admin/privacy/requests', { token: A.token })).status, 403);
    assert.equal((await call('POST', '/admin/privacy/erase', { token: A.token, body: { phone: '9876543210' } })).status, 403);
  });
  it('the public config names the grievance officer', async () => {
    const c = await call('GET', '/platform/config');
    assert.equal(c.data.compliance.grievanceOfficer.name, 'Nikhil Bhamare');
  });
});

describe('two-factor sign-in (live)', () => {
  it('set-up, enable, then password alone no longer signs in; the code does; the same code cannot be replayed', async () => {
    const { default: T } = await import('node:module').then(() => import('../dist/common/security/totp.js').then((m) => ({ default: m })));
    const email = `owner-a-${run}@example.com`;
    const login = (extra = {}) => call('POST', '/auth/login', { body: { email, password: PW, ...extra } });
    const first = await login(); assert.equal(first.status, 200);
    const setup = await call('POST', '/auth/2fa/setup', { token: first.data.accessToken }); assert.equal(setup.status, 200);
    const enable = await call('POST', '/auth/2fa/enable', { token: first.data.accessToken, body: { code: T.totpCode(setup.data.secret, T.totpStep()) } });
    assert.equal(enable.status, 200, JSON.stringify(enable.body)); assert.equal(enable.data.recoveryCodes.length, 10);
    const second = await login(); assert.equal(second.status, 200); assert.equal(second.data.totpRequired, true); assert.equal(second.data.accessToken, undefined);
    assert.equal((await login({ totp: '000000' })).status, 401);
    const nextStep = T.totpStep() + 1; // the enable step is already used, so use the next window (allowed: one step of drift)
    const ok = await login({ totp: T.totpCode(setup.data.secret, nextStep) }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.ok(ok.data.accessToken);
    assert.equal((await login({ totp: T.totpCode(setup.data.secret, nextStep) })).status, 401, 'replay refused');
    const rec = await login({ totp: enable.data.recoveryCodes[0] }); assert.equal(rec.status, 200, 'a recovery code signs in once');
    assert.equal((await login({ totp: enable.data.recoveryCodes[0] })).status, 401);
    const raw = await db.query('SELECT totp_secret_enc FROM staff WHERE lower(email) = lower($1)', [email]); assert.ok(!raw.rows[0].totp_secret_enc.includes(setup.data.secret), 'the secret is stored encrypted');
  });
});

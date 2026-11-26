/**
 * Pilot readiness: security behaviours that real restaurants depend on, against a RUNNING API on a THROWAWAY database.
 *   node --test --test-concurrency=1 test/pilot-security.e2e.test.mjs
 * (Rate limiting itself is switched off for the test API, so per-IP throttles are not exercised here; account lockout is.)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const PW2 = 'Tulsi-Wada-Pune-42';
const db = new pg.Client({ connectionString: DB });
let seq = 0;
async function raw(method, path, { token, body, headers = {} } = {}) {
  return fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(method, path, o) {
  const res = await raw(method, path, o);
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, headers: res.headers };
}
async function tenant(tag) {
  const slug = `sc-${tag}-${run}`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `Sec ${tag}`, ownerFullName: 'Olive Owner', mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW, outletName: `Sec ${tag}`, branchArea: 'Pune', slug, upiVpa: `sc${tag}@upi`, gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const menu = (await call('GET', `/menu/public/${slug}`)).data;
  return { slug, token: r.data.accessToken, id: r.data.outlet.id, email: `o-${tag}-${run}@example.com`, item: menu.items[0] };
}
const order = (t) => call('POST', '/orders', { headers: { 'x-idempotency-key': `sc-${run}-${++seq}` }, body: { restaurantSlug: t.slug, orderType: 'DINE_IN', tableNumber: '01', paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: t.item.id, name: t.item.name, price: Number(t.item.price), quantity: 1 }] } });
let A; let B;
before(async () => { await db.connect(); A = await tenant('a'); B = await tenant('b'); });
after(async () => { await db.end(); });

describe('Input validation and mass assignment', () => {
  it('unknown fields are refused, not silently accepted', async () => {
    const r = await call('POST', '/orders', { headers: { 'x-idempotency-key': `sc-${run}-x` }, body: { restaurantSlug: A.slug, items: [], totalAmount: 1, orderStatus: 'COMPLETED', paymentStatus: 'PAID' } });
    assert.equal(r.status, 400);
  });
  it('a guest cannot choose their own price or mark their own order paid', async () => {
    const r = await call('POST', '/orders', { headers: { 'x-idempotency-key': `sc-${run}-p` }, body: { restaurantSlug: A.slug, orderType: 'DINE_IN', tableNumber: '01', paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: A.item.id, name: A.item.name, price: 0.01, quantity: 1 }] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(Number(r.data.totalAmount) > 1, true, 'the server priced it from the menu');
    assert.notEqual(r.data.paymentStatus, 'PAID');
  });
  it('sign-up cannot grant a platform role or flag', async () => {
    const r = await call('POST', '/auth/onboard', { body: { brandName: 'X', ownerFullName: 'X Y', mobileNumber: '9876500003', email: `esc-${run}@example.com`, password: PW, outletName: 'X', slug: `esc-${run}`, upiVpa: 'xx@upi', gstPercentage: 5, indoorTableCount: 2, outdoorTableCount: 0, menuPreset: 'blank', teamMode: 'solo', role: 'PLATFORM_SUPER_ADMIN', isPlatformAdmin: true } });
    assert.equal(r.status, 400);
  });
  it('an owner cannot create a platform administrator through the staff form', async () => {
    const r = await call('POST', `/restaurants/${A.id}/staff`, { token: A.token, body: { name: 'Eve', email: `eve-${run}@example.com`, password: PW, role: 'PLATFORM_SUPER_ADMIN' } });
    assert.ok([400, 403].includes(r.status), String(r.status));
  });
  it('odd input in an id or slug is a clean 4xx, never a server error', async () => {
    for (const p of ["/menu/public/' OR 1=1 --", '/menu/public/%00', `/orders/not-a-uuid?token=${'a'.repeat(5000)}`, '/tables/00000000-0000-0000-0000-000000000000']) {
      const r = await call('GET', p, { token: A.token });
      assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
    }
  });
  it('error bodies never contain a stack trace or internal paths', async () => {
    const r = await call('GET', '/orders/not-a-uuid');
    const text = JSON.stringify(r.body);
    assert.doesNotMatch(text, /node_modules|\.ts:\d+|at .*\(/);
  });
});

describe('Sessions and credentials', () => {
  it('a tampered or foreign-signed token is rejected', async () => {
    const [h, p, s] = A.token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'PLATFORM_SUPER_ADMIN', isPlatformAdmin: true })).toString('base64url')}.${s}`;
    assert.equal((await call('GET', `/orders?restaurantSlug=${A.slug}`, { token: forged })).status, 401);
    assert.equal((await call('GET', `/orders?restaurantSlug=${A.slug}`, { token: 'x.y.z' })).status, 401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    assert.equal((await call('GET', `/orders?restaurantSlug=${A.slug}`, { token: none })).status, 401);
  });
  it('repeated wrong passwords lock the account, and a locked account refuses even the right password', async () => {
    const email = `o-b-${run}@example.com`;
    let last;
    for (let i = 0; i < 12; i++) last = await call('POST', '/auth/login', { body: { email, password: `wrong-${i}-Password!` } });
    assert.ok([401, 423, 429].includes(last.status), String(last.status));
    const good = await call('POST', '/auth/login', { body: { email, password: PW } });
    assert.notEqual(good.status, 200, 'a locked account must not sign in even with the right password');
    // the owner of ANOTHER restaurant is unaffected
    assert.equal((await call('POST', '/auth/login', { body: { email: A.email, password: PW } })).status, 200);
  });
  it('login does not reveal whether an email exists', async () => {
    const known = await call('POST', '/auth/login', { body: { email: A.email, password: 'Wrong-pass-123' } });
    const unknown = await call('POST', '/auth/login', { body: { email: `nobody-${run}@example.com`, password: 'Wrong-pass-123' } });
    assert.equal(known.status, unknown.status);
    assert.equal(JSON.stringify(known.body.message), JSON.stringify(unknown.body.message));
  });
  it('a weak or name-based password is refused', async () => {
    const r = await call('POST', `/restaurants/${A.id}/staff`, { token: A.token, body: { name: 'Priya Patil', email: `pp-${run}@example.com`, password: 'priya123', role: 'CASHIER' } });
    assert.equal(r.status, 400);
  });
});

describe('Tracking links and what the API gives away', () => {
  it('an order is opened only with ITS token; another order\'s token or none does not work', async () => {
    const o1 = (await order(A)).data; const o2 = (await order(A)).data;
    assert.equal((await call('GET', `/orders/${o1.id}?token=${o1.trackingToken}`)).status, 200);
    assert.notEqual((await call('GET', `/orders/${o1.id}?token=${o2.trackingToken}`)).status, 200);
    assert.notEqual((await call('GET', `/orders/${o1.id}`)).status, 200);
    // another restaurant's staff cannot read it either
    assert.notEqual((await call('GET', `/orders/${o1.id}`, { token: B.token })).status, 200);
  });
  it('the token is not echoed back in an error body (redacted path)', async () => {
    const secret = `zzSECRETzz${run}`;
    const r = await call('GET', `/orders/00000000-0000-0000-0000-000000000000?token=${secret}`);
    assert.ok(!JSON.stringify(r.body).includes(secret), JSON.stringify(r.body));
  });
  it('the public order view contains no staff-only or other-guest data', async () => {
    const o = (await order(A)).data;
    const v = (await call('GET', `/orders/${o.id}?token=${o.trackingToken}`)).data;
    for (const f of ['refundedByStaffId', 'requestHash', 'restaurantId']) assert.equal(v[f], undefined, `public view leaks ${f}`);
  });
  it('API responses carry hardening headers and no server fingerprint', async () => {
    const r = await call('GET', '/platform/config');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('strict-transport-security'));
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.ok(r.headers.get('x-request-id'));
  });
});

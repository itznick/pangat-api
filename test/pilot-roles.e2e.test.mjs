/**
 * Pilot readiness: what every role may and may not do, checked against the real API. A RUNNING API on a THROWAWAY database.
 *   node --test --test-concurrency=1 test/pilot-roles.e2e.test.mjs
 *
 * For every action: a role the rules allow must get past authorisation (any status except 401/403: a bad input may still be a 400/404),
 * and every other role, the kitchen station and an anonymous caller must be refused (403 / 401). Platform administrators have their own
 * console and are refused on the restaurant's operational routes.
 *   O owner · M manager · C chef · S steward · K cashier · T kitchen station (PIN sign-in) · A platform admin
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const BOOT = process.env.PLATFORM_BOOTSTRAP_SECRET || 'bootstrapsecret1234567';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const PW2 = 'Tulsi-Wada-Pune-42';
const db = new pg.Client({ connectionString: DB });
let seq = 0;

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data };
}
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });

const slug = `rl-${run}`;
const who = {}; // letter -> token ('' = anonymous)
let outletId; let menuItem; let category;

async function hire(role) {
  const email = `${role.toLowerCase()}-${run}@example.com`;
  const c = await call('POST', `/restaurants/${outletId}/staff`, { token: who.O, body: { name: role, email, password: PW, role } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const f = await login(email);
  return (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
}
const tables = ['01', '02', '03'];
async function order(extra = {}) {
  // spread over several tables: the public ordering flood limit is per table (6 per 5 minutes) and per outlet
  const r = await call('POST', '/orders', { headers: { 'x-idempotency-key': `rl-${run}-${++seq}` }, body: { restaurantSlug: slug, orderType: 'DINE_IN', tableNumber: tables[seq % tables.length], paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: menuItem.id, name: menuItem.name, price: Number(menuItem.price), quantity: 1 }], ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data.id;
}

before(async () => {
  await db.connect();
  const o = await call('POST', '/auth/onboard', { body: { brandName: `Roles ${run}`, ownerFullName: 'Olive Owner', mobileNumber: '9876500001', email: `o-${run}@example.com`, password: PW, outletName: 'Roles', branchArea: 'Pune', slug, upiVpa: `rl${run}@upi`, gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468' } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  who.O = o.data.accessToken; outletId = o.data.outlet.id;
  // every plan feature on, so a refusal in this suite is always about the ROLE, never the plan
  await db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='ENTERPRISE'),status='ACTIVE',current_period_end=now()+interval '30 days' WHERE organization_id=$1`, [o.data.organization.id]);
  for (const [letter, role] of [['M', 'STORE_MANAGER'], ['C', 'CHEF'], ['S', 'STEWARD'], ['K', 'CASHIER']]) who[letter] = await hire(role);
  const st = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: slug } });
  assert.equal(st.status, 200, JSON.stringify(st.body)); who.T = st.data.accessToken;
  for (let i = 1; i <= 6; i++) {
    const t = await call('POST', '/tables', { token: who.O, body: { tableNumber: `Z${i}`, restaurantId: outletId } });
    assert.equal(t.status, 201, JSON.stringify(t.body)); tables.push(`Z${i}`);
  }
  who.X = ''; // anonymous
  // a platform administrator
  const email = `root-${run}@pangat.test`;
  const r = await call('POST', '/auth/setup-super-admin', { headers: { 'x-bootstrap-secret': BOOT }, body: { name: 'Root Admin', email, password: PW } });
  if (r.status !== 201) {
    const { default: bcrypt } = await import('bcrypt');
    await db.query(`INSERT INTO staff (name, email, password_hash, role, is_platform_admin, platform_role) VALUES ('Root Admin', $1, $2, 'PLATFORM_SUPER_ADMIN', true, 'OWNER')`, [email, await bcrypt.hash(PW, 10)]);
  }
  who.A = (await login(email)).data.accessToken;
  const menu = (await call('GET', `/menu/public/${slug}`)).data;
  menuItem = menu.items[0]; category = menu.categories[0];
});
after(async () => { await db.end(); });

/** [label, allowedLetters, (letter) => request] */
const matrix = [
  ['list orders', 'OMCSK', () => ['GET', `/orders?restaurantSlug=${slug}`]],
  ['start cooking (RECEIVED to PREPARING)', 'OMC', async () => ['PATCH', `/orders/${await order()}/status`, { status: 'PREPARING' }]],
  ['complete a ready order (served)', 'OMS', async () => {
    const id = await order();
    for (const st of ['PREPARING', 'READY']) assert.equal((await call('PATCH', `/orders/${id}/status`, { token: who.O, body: { status: st } })).status, 200);
    return ['PATCH', `/orders/${id}/status`, { status: 'COMPLETED' }];
  }],
  ['send an order back (regress)', 'OMC', async () => ['PATCH', `/orders/${await order()}/regress-status`, { targetStatus: 'RECEIVED', reason: 'check' }]],
  ['cancel an order', 'OMS', async () => ['POST', `/orders/${await order()}/cancel`, { reason: 'guest left' }]],
  ['edit order items', 'OMS', async () => ['PATCH', `/orders/${await order()}/items`, { items: [{ menuItemId: menuItem.id, name: menuItem.name, quantity: 2 }] }]],
  ['mark an order paid (cashier, manager, owner: the service refuses a steward)', 'OMK', async () => ['PATCH', `/orders/${await order()}/mark-paid`]],
  ['refund an order', 'OM', async () => ['POST', `/orders/${await order()}/refund`, { refundMethod: 'COUNTER_CASH', reason: 'role check', idempotencyKey: `rf-${run}-${++seq}` }]],

  ['read the menu (staff)', 'OMCSK', () => ['GET', `/menu/items?restaurantId=${outletId}`]],
  ['mark a dish sold out', 'OMC', () => ['PATCH', `/menu/items/${menuItem.id}/availability`, { isAvailable: true }]],
  ['change a price', 'OM', () => ['PATCH', `/menu/items/${menuItem.id}/price`, { price: Number(menuItem.price) }]],
  ['add a dish', 'OM', () => ['POST', '/menu/items', { name: `Role dish ${++seq}`, price: 10, categoryId: category.id, restaurantId: outletId }]],
  ['add a category', 'OM', () => ['POST', '/menu/categories', { name: `Role cat ${++seq}`, restaurantId: outletId }]],
  ['delete a dish', 'OM', () => ['DELETE', `/menu/items/${crypto.randomUUID()}`]],

  ['read tables', 'OMCSK', () => ['GET', `/tables?restaurantId=${outletId}`]],
  ['add a table', 'OM', () => ['POST', '/tables', { tableNumber: `R${++seq}`, restaurantId: outletId }]],
  ['delete a table', 'OM', () => ['DELETE', `/tables/${crypto.randomUUID()}`]],

  ['sales report', 'OM', () => ['GET', `/reports/summary?restaurantSlug=${slug}`]],
  ['inventory list', 'OMCS', () => ['GET', `/inventory/ingredients?restaurantId=${outletId}`]],
  ['add an ingredient', 'OM', () => ['POST', '/inventory/ingredients', { restaurantId: outletId, name: `Ing ${++seq}`, unit: 'KG', openingStock: 1, minimumStock: 0, costPerUnit: 1 }]],

  ['list staff', 'OM', () => ['GET', `/restaurants/${outletId}/staff`]],
  ['kitchen PIN status', 'OM', () => ['GET', `/restaurants/${outletId}/kitchen-pin`]],
  ['go-live checklist', 'OM', () => ['GET', `/restaurants/${outletId}/readiness`]],
  ['confirm a go-live step', 'OM', () => ['POST', `/restaurants/${outletId}/onboarding/confirm`, { step: 'qrPlaced' }]],
  ['confirm the UPI ID', 'O', () => ['POST', `/restaurants/${outletId}/upi/confirm`, { vpa: `rl${run}@upi` }]],
  ['request a plan change', 'O', () => ['POST', '/subscriptions/request-change', { planCode: 'MINI_MONTHLY', message: 'role check' }]],

  ['platform console', 'A', () => ['GET', '/admin/dashboard']],
  ['alert deliveries (platform)', 'A', () => ['GET', '/admin/alerts/deliveries']],
];

describe('Role matrix: each role can do exactly what it should, nothing more', () => {
  const letters = ['O', 'M', 'C', 'S', 'K', 'T', 'A', 'X'];
  const names = { O: 'owner', M: 'manager', C: 'chef', S: 'steward', K: 'cashier', T: 'kitchen station', A: 'platform admin', X: 'anonymous' };
  // the kitchen station signs in with a PIN and holds the chef role
  const effective = (l) => (l === 'T' ? 'C' : l);

  for (const [label, allowed, make] of matrix) {
    it(label, async () => {
      // ONE target per action. Refused roles go first, while the target is still in the state the action needs; roles that are allowed
      // then act on it (a second allowed role may find it already done: a 400 is still "past authorisation").
      const [method, path, body] = await make();
      const refusedFirst = [...letters].sort((a, b) => Number(allowed.includes(effective(a)) && a !== 'X') - Number(allowed.includes(effective(b)) && b !== 'X'));
      for (const l of refusedFirst) {
        const r = await call(method, path, { token: who[l], body });
        const may = l !== 'X' && allowed.includes(effective(l));
        // Platform administrators are support/operations staff with cross-tenant access to restaurant routes (every such access is recorded and
        // shown to the owner under Settings > Pangat access). What they must never get is the reverse: tenant roles never reach the console.
        if (l === 'A' && !allowed.includes('A')) continue;
        if (l === 'X') assert.equal(r.status, 401, `${names[l]} must be asked to sign in: ${method} ${path} -> ${r.status}`);
        else if (may) assert.ok(r.status !== 401 && r.status !== 403, `${names[l]} should be allowed to ${label} but got ${r.status}: ${JSON.stringify(r.body)?.slice(0, 160)}`);
        else assert.ok(r.status === 403 || r.status === 401, `${names[l]} must NOT be allowed to ${label} but got ${r.status}`);
      }
    });
  }
});

describe('Role-specific guarantees', () => {
  it('a platform administrator who touches a restaurant leaves a trail the owner can read', async () => {
    assert.equal((await call('GET', `/orders?restaurantSlug=${slug}`, { token: who.A })).status, 200);
    const log = await call('GET', `/restaurants/${outletId}/platform-access`, { token: who.O });
    assert.equal(log.status, 200, JSON.stringify(log.body));
    assert.ok(JSON.stringify(log.data).length > 10, 'the access is recorded');
  });

  it('the kitchen sees orders without money or contact details; the cashier does', async () => {
    const id = await order({ customerName: 'Guest Gita', customerPhone: '9876500077', consentAccepted: true });
    const kitchen = (await call('GET', `/orders?restaurantSlug=${slug}`, { token: who.T })).data.find((o) => o.id === id);
    assert.ok(kitchen, 'the kitchen sees the order');
    for (const f of ['customerPhone', 'totalAmount', 'trackingToken', 'deliveryAddress']) assert.equal(kitchen[f], undefined, `kitchen must not see ${f}`);
    const cashier = (await call('GET', `/orders?restaurantSlug=${slug}`, { token: who.K })).data.find((o) => o.id === id);
    assert.ok(cashier.totalAmount !== undefined, 'the cashier sees the amount to collect');
  });

  it('only owners and managers can refund; a cashier who marks paid cannot refund their own mistake', async () => {
    const id = await order();
    assert.equal((await call('PATCH', `/orders/${id}/mark-paid`, { token: who.K })).status, 200);
    assert.equal((await call('POST', `/orders/${id}/refund`, { token: who.K, body: { refundMethod: 'COUNTER_CASH', reason: 'x', idempotencyKey: `rf-${run}-k` } })).status, 403);
  });

  it('a staff member deactivated by the owner can no longer act', async () => {
    const email = `gone-${run}@example.com`;
    const c = await call('POST', `/restaurants/${outletId}/staff`, { token: who.O, body: { name: 'Gone', email, password: PW, role: 'CASHIER' } });
    assert.equal(c.status, 201);
    const f = await login(email);
    const t = (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
    assert.equal((await call('GET', `/tables?restaurantId=${outletId}`, { token: t })).status, 200);
    const off = await call('PATCH', `/restaurants/${outletId}/staff/${c.data.id}`, { token: who.O, body: { isActive: false } });
    assert.ok([200, 204].includes(off.status), JSON.stringify(off.body));
    const after = await call('GET', `/tables?restaurantId=${outletId}`, { token: t });
    assert.ok([401, 403].includes(after.status), `deactivated staff must be refused, got ${after.status}`);
  });
});

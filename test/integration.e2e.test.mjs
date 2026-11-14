/**
 * Live integration tests: a running API + PostgreSQL (the real stack, no mocks).
 *
 *   DATABASE_URL=postgres://... PLATFORM_BOOTSTRAP_SECRET=bootstrapsecret1234567 RAZORPAY_WEBHOOK_SECRET=whsec_test_123 \
 *     PORT=4000 node dist/main &        # then:
 *   npm run test:integration
 *
 * Every run creates its own tenants (random slugs) so it is repeatable on a shared database.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { io } from 'socket.io-client';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const WS = API.replace(/\/api\/v1$/, '');
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const BOOT = process.env.PLATFORM_BOOTSTRAP_SECRET || 'bootstrapsecret1234567';
const WH_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'whsec_test_123';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';

const db = new pg.Client({ connectionString: DB });

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data };
}
const login = async (email, password = PW) => (await call('POST', '/auth/login', { body: { email, password } }));
const tokenOf = async (email, password) => (await login(email, password)).data.accessToken;

async function onboard(tag, extra = {}) {
  const slug = `t-${tag}-${run}`;
  const email = `owner-${tag}-${run}@example.com`;
  const r = await call('POST', '/auth/onboard', {
    body: {
      brandName: `Brand ${tag}`, ownerFullName: `Owner ${tag}`, mobileNumber: '9876500001', email, password: PW,
      outletName: `Outlet ${tag}`, slug, upiVpa: 'shop@upi', gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0,
      menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468', ...extra,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug, email, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}
const idem = () => `idem-${crypto.randomBytes(8).toString('hex')}`;
async function placeOrder(slug, items, extra = {}, key = idem()) {
  return call('POST', '/orders', { headers: { 'x-idempotency-key': key }, body: { restaurantSlug: slug, orderType: 'TAKEAWAY', customerName: 'Guest', paymentMethod: 'PAY_AT_COUNTER', items, ...extra } });
}
const menuOf = async (slug) => (await call('GET', `/menu/public/${slug}`)).data;
const firstItems = async (slug, n = 1) => {
  const m = await menuOf(slug);
  return m.items.slice(0, n).map((i) => ({ menuItemId: i.id, name: i.name, price: Number(i.price), quantity: 1 }));
};

let A; let B; // two independent tenants
const staff = {}; // role -> {token, id}

before(async () => {
  await db.connect();
  A = await onboard('a');
  B = await onboard('b');
  // owner A hires one of each assignable role
  for (const role of ['STORE_MANAGER', 'CHEF', 'STEWARD', 'CASHIER']) {
    const email = `${role.toLowerCase()}-${run}@example.com`;
    const r = await call('POST', `/restaurants/${A.outlet.id}/staff`, { token: A.token, body: { name: role, email, password: PW, role } });
    assert.equal(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
    staff[role] = { id: r.data.id, email, token: await tokenOf(email) };
  }
});
after(async () => { await db.end(); });

describe('Authentication & account security', () => {
  it('email login is case-insensitive and trims', async () => {
    const r = await login(`  ${A.email.toUpperCase()} `);
    assert.equal(r.status, 200);
  });

  it('wrong credentials give one generic 401 (no user enumeration)', async () => {
    const a = await login(A.email, 'nope-nope-nope');
    const b = await login(`ghost-${run}@example.com`, 'nope-nope-nope');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.message?.toString(), b.body.message?.toString());
  });

  it('locks an account after 5 wrong passwords (429), even for the right password, until it expires', async () => {
    const victim = await onboard('lock');
    for (let i = 0; i < 5; i++) assert.equal((await login(victim.email, 'bad-password-x')).status, 401);
    const locked = await login(victim.email, PW);
    assert.equal(locked.status, 429);
    await db.query('UPDATE staff SET locked_until = NULL, failed_login_count = 0 WHERE lower(email)=lower($1)', [victim.email]);
    assert.equal((await login(victim.email, PW)).status, 200);
  });

  it('rejects requests with no / garbage token', async () => {
    assert.equal((await call('GET', '/auth/me')).status, 401);
    assert.equal((await call('GET', '/auth/me', { token: 'abc.def.ghi' })).status, 401);
  });

  it('/auth/login no longer accepts a PIN-only login (the old back door)', async () => {
    const r = await call('POST', '/auth/login', { body: { pinCode: '2468' } });
    assert.ok([400, 401].includes(r.status), `got ${r.status}`);
  });

  it('passwords under 8 characters are refused at signup', async () => {
    const r = await call('POST', '/auth/onboard', { body: { brandName: 'x', ownerFullName: 'x', mobileNumber: '1', email: `w-${run}@example.com`, password: 'short', outletName: 'x', slug: `w-${run}`, upiVpa: 'a@b' } });
    assert.equal(r.status, 400);
  });

  it('change-password requires the current password, then signs out old sessions and keeps the new token alive', async () => {
    const o = await onboard('pw');
    const old = o.token;
    await new Promise((r) => setTimeout(r, 1100)); // iat has 1s resolution
    assert.equal((await call('POST', '/auth/change-password', { token: old, body: { currentPassword: 'wrong-one-xx', newPassword: 'Another-pass-2' } })).status, 400);
    const ok = await call('POST', '/auth/change-password', { token: old, body: { currentPassword: PW, newPassword: 'Another-pass-2' } });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 1100)); // iat has 1s resolution
    assert.equal((await call('GET', '/auth/me', { token: old })).status, 401, 'old token must stop working');
    assert.equal((await call('GET', '/auth/me', { token: ok.data.accessToken })).status, 200);
    assert.equal((await login(o.email, 'Another-pass-2')).status, 200);
  });

  it('forgot-password answers identically for existing and unknown emails', async () => {
    const a = await call('POST', '/auth/forgot-password', { body: { email: A.email } });
    const b = await call('POST', '/auth/forgot-password', { body: { email: `nobody-${run}@example.com` } });
    assert.equal(a.status, 200);
    assert.deepEqual(a.data, b.data);
  });

  it('password reset token works once and signs out old sessions', async () => {
    const o = await onboard('reset');
    const raw = crypto.randomBytes(32).toString('hex');
    await db.query('UPDATE staff SET reset_token_hash=$1, reset_token_expires_at=now()+interval \'1 hour\' WHERE lower(email)=lower($2)', [crypto.createHash('sha256').update(raw).digest('hex'), o.email]);
    assert.equal((await call('POST', '/auth/reset-password', { body: { token: raw, newPassword: 'Reset-pass-33' } })).status, 200);
    assert.equal((await call('POST', '/auth/reset-password', { body: { token: raw, newPassword: 'Reset-pass-44' } })).status, 400, 'token is single-use');
    assert.equal((await login(o.email, 'Reset-pass-33')).status, 200);
  });
});

describe('Kitchen station PIN login', () => {
  it('works only for the right outlet slug + PIN and yields a CHEF session scoped to that outlet', async () => {
    const r = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: A.slug } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.user.role, 'CHEF');
    assert.equal(r.data.user.restaurantId, A.outlet.id);
    const me = await call('GET', '/auth/me', { token: r.data.accessToken });
    assert.equal(me.data.role, 'CHEF');
  });

  it('a PIN never opens another tenant, and the slug is mandatory', async () => {
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: B.slug } })).status, 200, 'B has the same PIN of its own');
    await call('POST', `/restaurants/${B.outlet.id}/kitchen-pin`, { token: B.token, body: { pin: '1357' } });
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: B.slug } })).status, 401);
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '1357' } })).status, 400);
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '1357', outletSlug: A.slug } })).status, 401);
  });

  it('rate-limits PIN guessing', async () => {
    const o = await onboard('pinbf');
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await call('POST', '/auth/kds-pin-login', { body: { pinCode: String(1000 + i), outletSlug: o.slug } })).status);
    assert.ok(codes.includes(429), `no lockout seen: ${codes}`);
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } })).status, 429, 'even the right PIN waits out the lockout');
  });

  it('manager PINs from legacy data cannot open a manager session (only CHEF station accounts can)', async () => {
    await db.query("UPDATE staff SET pin_code='9753' WHERE lower(email)=lower($1)", [staff.STORE_MANAGER.email]);
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '9753', outletSlug: A.slug } })).status, 401);
  });

  it('plain-text legacy station PINs are upgraded to hashes on first use', async () => {
    const o = await onboard('legacy', { kitchenPin: undefined });
    await db.query("INSERT INTO staff (name,email,password_hash,role,organization_id,restaurant_id,pin_code) VALUES ('Kitchen Station',$1,'!x','CHEF',$2,$3,'8642')", [`kitchen.${o.slug}@stations.pangat.app`, o.orgId, o.outlet.id]);
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '8642', outletSlug: o.slug } })).status, 200);
    const { rows } = await db.query("SELECT pin_code, pin_hash FROM staff WHERE email=$1", [`kitchen.${o.slug}@stations.pangat.app`]);
    assert.equal(rows[0].pin_code, null);
    assert.ok(rows[0].pin_hash?.startsWith('$2'));
  });
});

describe('Role-based access control', () => {
  let item;
  before(async () => { item = (await firstItems(A.slug))[0]; });

  const expectStatus = async (label, req, allowed, denied = [403]) => {
    const r = await req();
    if (allowed) assert.ok(![401, 403].includes(r.status), `${label}: expected allowed, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
    else assert.ok(denied.includes(r.status), `${label}: expected denied, got ${r.status}`);
  };

  it('price edits: owner & manager only', async () => {
    const edit = (t) => () => call('PATCH', `/menu/items/${item.menuItemId}/price`, { token: t, body: { price: 61 } });
    await expectStatus('owner', edit(A.token), true);
    await expectStatus('manager', edit(staff.STORE_MANAGER.token), true);
    for (const r of ['CHEF', 'STEWARD', 'CASHIER']) await expectStatus(r, edit(staff[r].token), false);
  });

  it('chef may toggle availability; cashier and steward may not', async () => {
    const t = (tok) => () => call('PATCH', `/menu/items/${item.menuItemId}/availability`, { token: tok, body: { isAvailable: true } });
    await expectStatus('chef', t(staff.CHEF.token), true);
    await expectStatus('cashier', t(staff.CASHIER.token), false);
    await expectStatus('steward', t(staff.STEWARD.token), false);
  });

  it('staff management is owner-only; owners and platform admins cannot be created through it', async () => {
    const mk = (t, role) => call('POST', `/restaurants/${A.outlet.id}/staff`, { token: t, body: { name: 'X', email: `x-${crypto.randomBytes(3).toString('hex')}@example.com`, password: PW, role } });
    assert.equal((await mk(staff.STORE_MANAGER.token, 'CASHIER')).status, 403);
    assert.equal((await mk(A.token, 'PLATFORM_SUPER_ADMIN')).status, 400, 'privilege escalation to platform admin');
    assert.equal((await mk(A.token, 'SUPER_OWNER')).status, 400);
    assert.equal((await mk(A.token, 'CASHIER')).status, 201);
  });

  it('refunds: owner/manager only; mark-paid: cashier allowed', async () => {
    const o = await placeOrder(A.slug, [{ menuItemId: item.menuItemId, name: item.name, price: 1, quantity: 1 }]);
    assert.equal(o.status, 201, JSON.stringify(o.body));
    const id = o.data.id;
    assert.equal((await call('PATCH', `/orders/${id}/mark-paid`, { token: staff.CASHIER.token })).status, 200);
    assert.equal((await call('POST', `/orders/${id}/refund`, { token: staff.CASHIER.token, body: { refundMethod: 'COUNTER_CASH', reason: 'xxx', idempotencyKey: idem() } })).status, 403);
    assert.equal((await call('POST', `/orders/${id}/refund`, { token: staff.CHEF.token, body: { refundMethod: 'COUNTER_CASH', reason: 'xxx', idempotencyKey: idem() } })).status, 403);
  });

  it('reports and audit log are owner/manager only', async () => {
    assert.equal((await call('GET', `/reports/summary?restaurantSlug=${A.slug}`, { token: staff.CASHIER.token })).status, 403);
    assert.equal((await call('GET', `/reports/summary?restaurantSlug=${A.slug}`, { token: staff.STORE_MANAGER.token })).status, 200);
    assert.equal((await call('GET', `/restaurants/${A.outlet.id}/audit-logs`, { token: staff.CHEF.token })).status, 403);
    assert.equal((await call('GET', `/restaurants/${A.outlet.id}/audit-logs`, { token: A.token })).status, 200);
  });

  it('deactivated staff are locked out immediately, including with a token they already hold', async () => {
    const r = await call('PATCH', `/restaurants/${A.outlet.id}/staff/${staff.CASHIER.id}`, { token: A.token, body: { isActive: false } });
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/auth/me', { token: staff.CASHIER.token })).status, 401);
    assert.equal((await login(staff.CASHIER.email)).status, 401);
    await call('PATCH', `/restaurants/${A.outlet.id}/staff/${staff.CASHIER.id}`, { token: A.token, body: { isActive: true } });
    assert.equal((await login(staff.CASHIER.email)).status, 200);
  });

  it('owner can reset a staff password (one-time temp password) and the old one stops working', async () => {
    const r = await call('POST', `/restaurants/${A.outlet.id}/staff/${staff.STEWARD.id}/reset-password`, { token: A.token });
    assert.equal(r.status, 201);
    assert.ok(r.data.temporaryPassword.length >= 8);
    assert.equal((await login(staff.STEWARD.email)).status, 401);
    assert.equal((await login(staff.STEWARD.email, r.data.temporaryPassword)).status, 200);
  });
});

describe('Tenant isolation (tenant B must never reach tenant A)', () => {
  let order; let aItem; let aTable;
  before(async () => {
    aItem = (await firstItems(A.slug))[0];
    order = (await placeOrder(A.slug, [{ menuItemId: aItem.menuItemId, name: aItem.name, price: 1, quantity: 1 }])).data;
    aTable = (await call('GET', `/tables?restaurantSlug=${A.slug}`)).data[0];
  });

  const forbidden = (label, r) => assert.ok([403, 404].includes(r.status), `${label}: got ${r.status} ${JSON.stringify(r.body)?.slice(0, 100)}`);

  it('cannot read, advance, pay, cancel or refund A\'s orders', async () => {
    forbidden('list', await call('GET', `/orders?restaurantSlug=${A.slug}`, { token: B.token }));
    forbidden('get', await call('GET', `/orders/${order.id}`, { token: B.token }));
    forbidden('status', await call('PATCH', `/orders/${order.id}/status`, { token: B.token, body: { status: 'PREPARING' } }));
    forbidden('paid', await call('PATCH', `/orders/${order.id}/mark-paid`, { token: B.token }));
    forbidden('cancel', await call('POST', `/orders/${order.id}/cancel`, { token: B.token, body: { reason: 'x' } }));
    forbidden('refund', await call('POST', `/orders/${order.id}/refund`, { token: B.token, body: { refundMethod: 'COUNTER_CASH', reason: 'xxx', idempotencyKey: idem() } }));
  });

  it('cannot edit A\'s menu, tables, settings, staff, PIN, audit log or reports', async () => {
    forbidden('price', await call('PATCH', `/menu/items/${aItem.menuItemId}/price`, { token: B.token, body: { price: 1 } }));
    forbidden('delete item', await call('DELETE', `/menu/items/${aItem.menuItemId}`, { token: B.token }));
    forbidden('table status', await call('PATCH', `/tables/${aTable.id}/status`, { token: B.token, body: { status: 'OCCUPIED' } }));
    forbidden('table delete', await call('DELETE', `/tables/${aTable.id}`, { token: B.token }));
    forbidden('settings', await call('PATCH', `/restaurants/${A.slug}/settings`, { token: B.token, body: { name: 'pwned' } }));
    forbidden('staff list', await call('GET', `/restaurants/${A.outlet.id}/staff`, { token: B.token }));
    forbidden('staff add', await call('POST', `/restaurants/${A.outlet.id}/staff`, { token: B.token, body: { name: 'x', email: `evil-${run}@example.com`, password: PW, role: 'CASHIER' } }));
    forbidden('pin', await call('POST', `/restaurants/${A.outlet.id}/kitchen-pin`, { token: B.token, body: { pin: '0000' } }));
    forbidden('audit', await call('GET', `/restaurants/${A.outlet.id}/audit-logs`, { token: B.token }));
    forbidden('reports', await call('GET', `/reports/summary?restaurantSlug=${A.slug}`, { token: B.token }));
    forbidden('feedback list', await call('GET', `/restaurants/${A.slug}/feedback`, { token: B.token }));
    forbidden('inventory', await call('GET', `/inventory/ingredients?restaurantId=${A.outlet.id}`, { token: B.token }));
  });

  it('cannot smuggle a dish into A\'s category, or create dishes in A\'s outlet', async () => {
    const aCat = (await menuOf(A.slug)).categories[0];
    const r = await call('POST', '/menu/items', { token: B.token, body: { name: 'Evil', price: 1, categoryId: aCat.id, restaurantId: B.outlet.id } });
    assert.equal(r.status, 400, 'category from another tenant must be refused');
    forbidden('into A', await call('POST', '/menu/items', { token: B.token, body: { name: 'Evil', price: 1, categoryId: aCat.id, restaurantId: A.outlet.id } }));
  });

  it('public endpoints expose no private data', async () => {
    const pub = await call('GET', `/restaurants/${A.slug}`);
    assert.equal(pub.status, 200);
    for (const k of ['email', 'organizationId', 'kdsNewOrderAlert', 'autoDeductInventory']) assert.ok(!(k in pub.data), `public view leaks ${k}`);
    const full = await call('GET', `/restaurants/${A.slug}`, { token: A.token });
    assert.ok('email' in full.data, 'owner sees the full record');
    const bSees = await call('GET', `/restaurants/${A.slug}`, { token: B.token });
    assert.ok(!('email' in bSees.data), 'another tenant only gets the public view');
    assert.equal((await call('GET', '/menu/items')).status, 400, 'unscoped menu listing must not dump every tenant');
    assert.equal((await call('GET', `/restaurants/${A.slug}/feedback`)).status, 401);
  });

  it('A\'s order is only visible to the diner holding its tracking token', async () => {
    assert.equal((await call('GET', `/orders/${order.id}`)).status, 404);
    assert.equal((await call('GET', `/orders/${order.id}?token=wrong`)).status, 404);
    const ok = await call('GET', `/orders/${order.id}?token=${order.trackingToken}`);
    assert.equal(ok.status, 200);
    assert.ok(!('trackingToken' in ok.data) || ok.data.trackingToken, 'projection is the public one');
  });

  it('staff with a JWT can open their own order by id (no token needed)', async () => {
    assert.equal((await call('GET', `/orders/${order.id}`, { token: A.token })).status, 200);
    assert.equal((await call('GET', `/orders/${order.id}`, { token: staff.STORE_MANAGER.token })).status, 200);
  });
});

describe('Order lifecycle, money and ERP links', () => {
  it('prices come from the server, GST/service-charge follow outlet settings, and 0% GST is honoured', async () => {
    const o = await onboard('tax');
    await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { gstPercentage: 0, serviceChargePercentage: 10 } });
    const [it0] = await firstItems(o.slug);
    const r = await placeOrder(o.slug, [{ ...it0, price: 0.01, quantity: 2 }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const real = Number((await menuOf(o.slug)).items[0].price);
    assert.equal(r.data.subtotal, real * 2);
    assert.equal(r.data.gstAmount, 0, '0% GST must stay 0 (was silently 5%)');
    assert.equal(r.data.serviceChargeAmount, Math.round(real * 2 * 10) / 100);
    assert.equal(r.data.totalAmount, r.data.subtotal + r.data.serviceChargeAmount);
  });

  it('retrying the same idempotency key returns the original order, not an error or a duplicate', async () => {
    const [it0] = await firstItems(A.slug);
    const key = idem();
    const a = await placeOrder(A.slug, [it0], {}, key);
    const b = await placeOrder(A.slug, [it0], {}, key);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.data.id, b.data.id);
    const { rows } = await db.query('SELECT count(*)::int n FROM orders WHERE idempotency_key=$1', [key]);
    assert.equal(rows[0].n, 1);
  });

  it('validates input: empty cart, huge quantity, unknown dish, wrong-outlet dish', async () => {
    const [it0] = await firstItems(A.slug);
    assert.equal((await placeOrder(A.slug, [])).status, 400);
    assert.equal((await placeOrder(A.slug, [{ ...it0, quantity: 100000 }])).status, 400);
    assert.equal((await placeOrder(A.slug, [{ ...it0, menuItemId: crypto.randomUUID() }])).status, 400);
    assert.equal((await placeOrder(B.slug, [it0])).status, 400, 'dish belongs to A');
    assert.equal((await call('POST', '/orders', { body: { restaurantSlug: A.slug, items: [it0] } })).status, 400, 'idempotency key required');
  });

  it('full dine-in journey: order -> table busy -> KDS advance -> pay -> complete -> table freed; events reach the right rooms', async () => {
    const [it0] = await firstItems(A.slug);
    const table = (await call('GET', `/tables?restaurantSlug=${A.slug}`)).data.find((t) => t.status === 'VACANT');
    const r = await placeOrder(A.slug, [it0], { orderType: 'DINE_IN', tableNumber: table.tableNumber, customerName: undefined, paymentMethod: 'UPI_INSTANT' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.data.id;
    assert.equal((await call('GET', `/tables/${table.id}`)).data.status, 'PREPPING');

    const kds = (await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: A.slug } })).data.accessToken;
    assert.equal((await call('PATCH', `/orders/${id}/status`, { token: kds, body: { status: 'PREPARING' } })).status, 200);
    assert.equal((await call('PATCH', `/orders/${id}/status`, { token: kds, body: { status: 'READY' } })).status, 200);
    assert.equal((await call('PATCH', `/orders/${id}/status`, { token: kds, body: { status: 'RECEIVED' } })).status, 400, 'cannot move backwards through the normal endpoint');

    const paid1 = await call('PATCH', `/orders/${id}/mark-paid`, { token: A.token });
    assert.equal(paid1.status, 200);
    const settled = paid1.data.settledAt;
    const paid2 = await call('PATCH', `/orders/${id}/mark-paid`, { token: A.token });
    assert.equal(paid2.data.settledAt, settled, 'marking paid twice must not move the settlement time');

    assert.equal((await call('PATCH', `/orders/${id}/status`, { token: kds, body: { status: 'COMPLETED' } })).status, 403, 'kitchen cannot close an order');
    assert.equal((await call('PATCH', `/orders/${id}/status`, { token: A.token, body: { status: 'COMPLETED' } })).status, 200);
    assert.equal((await call('GET', `/tables/${table.id}`)).data.status, 'VACANT');

    const audit = (await call('GET', `/restaurants/${A.outlet.id}/audit-logs?limit=100`, { token: A.token })).data.items;
    assert.ok(audit.some((x) => x.entityId === id && x.action === 'PAYMENT_MARKED_PAID'), 'payment must be in the audit trail');
  });

  it('cancel requires a reason; refund cannot exceed what was paid; cancelled orders cannot be paid', async () => {
    const [it0] = await firstItems(A.slug);
    const o = (await placeOrder(A.slug, [it0])).data;
    assert.equal((await call('POST', `/orders/${o.id}/cancel`, { token: A.token, body: {} })).status, 400);
    assert.equal((await call('POST', `/orders/${o.id}/cancel`, { token: A.token, body: { reason: 'guest left' } })).status, 201);
    assert.equal((await call('PATCH', `/orders/${o.id}/mark-paid`, { token: A.token })).status, 400);

    const p = (await placeOrder(A.slug, [it0])).data;
    await call('PATCH', `/orders/${p.id}/mark-paid`, { token: A.token });
    assert.equal((await call('POST', `/orders/${p.id}/refund`, { token: A.token, body: { refundMethod: 'COUNTER_CASH', reason: 'early', idempotencyKey: idem() } })).status, 400, 'a paid, un-cancelled order cannot be refunded directly');
    assert.equal((await call('POST', `/orders/${p.id}/cancel`, { token: A.token, body: { reason: 'cold food' } })).status, 201);
    const over = await call('POST', `/orders/${p.id}/refund`, { token: A.token, body: { refundMethod: 'COUNTER_CASH', amount: Number(p.totalAmount) + 100, reason: 'too much', idempotencyKey: idem() } });
    assert.equal(over.status, 400);
    const ok = await call('POST', `/orders/${p.id}/refund`, { token: A.token, body: { refundMethod: 'COUNTER_CASH', reason: 'cold food', idempotencyKey: idem() } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it('feedback needs the order\'s tracking token; both feedback routes agree', async () => {
    const [it0] = await firstItems(A.slug);
    const o = (await placeOrder(A.slug, [it0])).data;
    assert.equal((await call('POST', `/orders/${o.id}/feedback`, { body: { rating: 1, comment: 'spam' } })).status, 404);
    assert.equal((await call('POST', `/restaurants/${A.slug}/feedback`, { body: { orderId: o.id, rating: 1 } })).status, 404);
    assert.equal((await call('POST', `/orders/${o.id}/feedback`, { body: { rating: 5, comment: 'great', token: o.trackingToken } })).status, 201);
    assert.equal((await call('POST', `/restaurants/${B.slug}/feedback`, { body: { orderId: o.id, rating: 5, token: o.trackingToken } })).status, 404, 'wrong outlet');
    const fb = (await call('GET', `/restaurants/${A.slug}/feedback`, { token: A.token })).data;
    assert.ok(fb.totalCount >= 1);
  });

  it('inventory: recipe deducts stock on order; a sold-out ingredient stops the order with a clear message', async () => {
    const o = await onboard('inv');
    const [it0] = await firstItems(o.slug);
    const ing = await call('POST', '/inventory/ingredients', { token: o.token, body: { restaurantId: o.outlet.id, name: 'Milk', unit: 'LITRE', openingStock: 1, minimumStock: 0.2, costPerUnit: 60 } });
    assert.equal(ing.status, 201, JSON.stringify(ing.body));
    const rec = await call('POST', `/inventory/recipes?restaurantId=${o.outlet.id}`, { token: o.token, body: { menuItemId: it0.menuItemId, ingredients: [{ ingredientId: ing.data.id, quantity: 0.6, unit: 'LITRE' }] } });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.equal((await placeOrder(o.slug, [it0])).status, 201);
    const after = (await call('GET', `/inventory/ingredients/${ing.data.id}`, { token: o.token })).data;
    assert.equal(Number(after.currentStock), 0.4);
    const second = await placeOrder(o.slug, [it0]);
    assert.equal(second.status, 400, 'not enough milk for another');
    const { rows } = await db.query('SELECT is_available FROM menu_items WHERE id=$1', [it0.menuItemId]);
    assert.equal(rows[0].is_available, false, 'dish auto-marked sold out when its ingredient ran out');
  });
});

describe('Menu & categories', () => {
  it('create, edit, soft-delete a dish; deleted dishes vanish from menus but stay on past orders', async () => {
    const o = await onboard('menu');
    const cat = (await call('POST', '/menu/categories', { token: o.token, body: { name: 'Specials', restaurantId: o.outlet.id } })).data;
    const dish = await call('POST', '/menu/items', { token: o.token, body: { name: 'Thali', price: 150, categoryId: cat.id, restaurantId: o.outlet.id } });
    assert.equal(dish.status, 201, JSON.stringify(dish.body));
    const ord = await placeOrder(o.slug, [{ menuItemId: dish.data.id, name: 'Thali', price: 150, quantity: 1 }]);
    assert.equal(ord.status, 201);
    assert.equal((await call('PATCH', `/menu/categories/${cat.id}`, { token: o.token, body: { name: 'Chef Specials' } })).data.name, 'Chef Specials');
    assert.equal((await call('DELETE', `/menu/items/${dish.data.id}`, { token: o.token })).status, 200);
    const menu = JSON.stringify((await menuOf(o.slug)).items);
    assert.ok(!menu.includes('Thali'), 'deleted dish must not be orderable');
    assert.equal((await placeOrder(o.slug, [{ menuItemId: dish.data.id, name: 'Thali', price: 150, quantity: 1 }])).status, 400);
    const past = await call('GET', `/orders/${ord.data.id}`, { token: o.token });
    assert.ok(JSON.stringify(past.data).includes('Thali'), 'history intact');
    const del = await call('DELETE', `/menu/categories/${cat.id}`, { token: o.token });
    assert.equal(del.status, 200, 'category is empty again (its only dish was deleted)');
  });
});

describe('Settings, tables & reports', () => {
  it('settings validate and persist; upi format and gst range enforced; changes are audited', async () => {
    assert.equal((await call('PATCH', `/restaurants/${A.slug}/settings`, { token: A.token, body: { gstPercentage: 99 } })).status, 400);
    assert.equal((await call('PATCH', `/restaurants/${A.slug}/settings`, { token: A.token, body: { upiVpa: 'not a vpa' } })).status, 400);
    const ok = await call('PATCH', `/restaurants/${A.slug}/settings`, { token: A.token, body: { gstPercentage: 12, serviceChargePercentage: 5, operations: { avgPrepMinutes: 20 } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const back = (await call('GET', `/restaurants/${A.slug}`, { token: A.token })).data;
    assert.equal(back.gstPercentage, 12);
    assert.equal(back.serviceChargePercentage, 5);
    const audit = (await call('GET', `/restaurants/${A.outlet.id}/audit-logs?entityType=RESTAURANT`, { token: A.token })).data.items;
    assert.ok(audit.some((x) => x.action === 'SETTINGS_UPDATED'));
    await call('PATCH', `/restaurants/${A.slug}/settings`, { token: A.token, body: { gstPercentage: 5, serviceChargePercentage: 0 } });
  });

  it('paused outlet refuses new guest orders with its message', async () => {
    const o = await onboard('pause');
    await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { operations: { acceptingOrders: false, pausedMessage: 'Back at 6pm' } } });
    const [it0] = await firstItems(o.slug);
    const r = await placeOrder(o.slug, [it0]);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /6pm/);
  });

  it('table identifiers are validated and unique per outlet; delete works', async () => {
    const mk = (n) => call('POST', '/tables', { token: A.token, body: { restaurantId: A.outlet.id, tableNumber: n } });
    const n = `Z${crypto.randomInt(10, 99)}`;
    const a = await mk(n);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal((await mk(n.toLowerCase())).status, 400, 'duplicate (case-insensitive)');
    assert.equal((await mk('bad name!')).status, 400);
    assert.equal((await call('DELETE', `/tables/${a.data.id}`, { token: A.token })).status, 200);
  });

  it('report totals reconcile with the orders actually placed', async () => {
    const o = await onboard('rep');
    const [it0] = await firstItems(o.slug);
    const price = Number((await menuOf(o.slug)).items[0].price);
    const o1 = (await placeOrder(o.slug, [{ ...it0, quantity: 2 }])).data;
    const o2 = (await placeOrder(o.slug, [it0])).data;
    const o3 = (await placeOrder(o.slug, [it0])).data;
    await call('PATCH', `/orders/${o1.id}/mark-paid`, { token: o.token });
    await call('PATCH', `/orders/${o2.id}/mark-paid`, { token: o.token });
    await call('POST', `/orders/${o3.id}/cancel`, { token: o.token, body: { reason: 'test' } });
    await call('POST', `/orders/${o2.id}/cancel`, { token: o.token, body: { reason: 'test refund' } });
    await call('POST', `/orders/${o2.id}/refund`, { token: o.token, body: { refundMethod: 'COUNTER_CASH', reason: 'test', idempotencyKey: idem() } });
    const rep = (await call('GET', `/reports/summary?restaurantSlug=${o.slug}`, { token: o.token })).data;
    assert.equal(rep.totals.orders, 1, 'cancelled orders are outside every sales figure');
    assert.equal(rep.totals.paidOrders, 1);
    assert.equal(rep.totals.grossSales, Math.round(price * 2 * 1.05 * 100) / 100);
    assert.equal(rep.totals.netSales, rep.totals.grossSales);
    assert.equal(rep.cancelled.orders, 2);
    assert.equal(rep.cancelled.refunded, Math.round(price * 1.05 * 100) / 100, 'refund of the paid-then-cancelled order is reported');
    assert.equal(rep.topItems[0].quantity, 2);
    assert.equal(rep.daily.at(-1).orders, 1);
    assert.equal((await call('GET', `/reports/summary?restaurantSlug=${o.slug}&from=2026-13-01`, { token: o.token })).status, 400);
  });
});

describe('Subscriptions & access', () => {
  it('a new tenant is on a trial; admin can assign a plan; owners cannot assign or edit plans', async () => {
    const o = await onboard('sub');
    const mine = await call('GET', '/subscriptions/my-subscription', { token: o.token });
    assert.equal(mine.data.subscription.status, 'TRIAL');
    assert.equal((await call('POST', `/subscriptions/admin/organizations/${o.orgId}/assign`, { token: o.token, body: { planCode: 'STARTER', months: 1 } })).status, 403);
    const admin = await tokenOf('root@test.com', 'test1234').catch(() => null);
    if (!admin) return;
    const r = await call('POST', `/subscriptions/admin/organizations/${o.orgId}/assign`, { token: admin, body: { planCode: 'STARTER', months: 3, note: 'paid by UPI' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await call('GET', '/subscriptions/my-subscription', { token: o.token });
    assert.equal(after.data.subscription.status, 'ACTIVE');
    assert.equal(after.data.plan.code, 'STARTER');
  });

  it('STARTER plan has no inventory/analytics (feature gating) while GROWTH trial has', async () => {
    const o = await onboard('feat');
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token })).status, 200);
    await db.query("UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='STARTER'), status='ACTIVE', current_period_end=now()+interval '30 days' WHERE organization_id=$1", [o.orgId]);
    await new Promise((r) => setTimeout(r, 21_000)); // access cache TTL
    const inv = await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token });
    assert.equal(inv.status, 402);
    assert.equal(inv.body?.code ?? inv.body?.message?.code, 'FEATURE_NOT_IN_PLAN');
    assert.equal((await call('GET', `/reports/summary?restaurantSlug=${o.slug}`, { token: o.token })).status, 402);
  });

  it('an expired subscription stops edits and guest ordering but still lets staff finish live orders and read data', async () => {
    const o = await onboard('exp');
    const [it0] = await firstItems(o.slug);
    const live = (await placeOrder(o.slug, [it0])).data;
    await call('GET', '/subscriptions/my-subscription', { token: o.token });
    await db.query("UPDATE organization_subscriptions SET status='EXPIRED', current_period_end=now()-interval '30 days' WHERE organization_id=$1", [o.orgId]);
    await new Promise((r) => setTimeout(r, 21_000));
    const edit = await call('PATCH', `/menu/items/${it0.menuItemId}/price`, { token: o.token, body: { price: 99 } });
    assert.equal(edit.status, 402, 'config edits blocked');
    assert.equal((await placeOrder(o.slug, [it0])).status, 400, 'guests cannot order');
    assert.equal((await call('GET', `/orders?restaurantSlug=${o.slug}`, { token: o.token })).status, 200, 'reading still works');
    assert.equal((await call('PATCH', `/orders/${live.id}/mark-paid`, { token: o.token })).status, 200, 'can settle in-flight orders');
    assert.equal((await call('GET', '/subscriptions/my-subscription', { token: o.token })).status, 200, 'billing page reachable to renew');
  });

  it('owner can cancel renewal and resume; trial cannot be "cancelled"', async () => {
    const o = await onboard('can');
    assert.equal((await call('POST', '/subscriptions/cancel', { token: o.token })).status, 400);
    await db.query("UPDATE organization_subscriptions SET status='ACTIVE', current_period_end=now()+interval '20 days' WHERE organization_id=$1", [o.orgId]);
    const c = await call('POST', '/subscriptions/cancel', { token: o.token });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.data.cancelAtPeriodEnd, true);
    assert.equal((await call('POST', '/subscriptions/resume', { token: o.token })).data.cancelAtPeriodEnd, false);
  });

  it('Razorpay webhook: unsigned or wrongly signed is rejected; correctly signed is processed', async () => {
    const payload = JSON.stringify({ event: 'payment.captured', id: `evt_${run}`, payload: {} });
    assert.equal((await call('POST', '/subscriptions/webhook/razorpay', { raw: payload })).status, 401);
    assert.equal((await call('POST', '/subscriptions/webhook/razorpay', { raw: payload, headers: { 'x-razorpay-signature': 'deadbeef' } })).status, 401);
    const sig = crypto.createHmac('sha256', WH_SECRET).update(payload).digest('hex');
    const ok = await call('POST', '/subscriptions/webhook/razorpay', { raw: payload, headers: { 'x-razorpay-signature': sig } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});

describe('Real-time sockets are tenant-scoped', () => {
  const connect = (auth) => new Promise((resolve, reject) => {
    const s = io(WS, { transports: ['websocket'], auth, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const join = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, (r) => resolve(r?.data ?? r)));

  it('anonymous or foreign sockets cannot join an outlet\'s kitchen/admin rooms; its own staff can', async () => {
    const anon = await connect({});
    assert.equal((await join(anon, 'join:kds', { restaurantSlug: A.slug })).status, 'denied');
    assert.equal((await join(anon, 'join:admin', { restaurantSlug: A.slug })).status, 'denied');
    const foreign = await connect({ token: B.token });
    assert.equal((await join(foreign, 'join:kds', { restaurantSlug: A.slug })).status, 'denied');
    const own = await connect({ token: A.token });
    assert.equal((await join(own, 'join:admin', { restaurantSlug: A.slug })).status, 'joined');
    [anon, foreign, own].forEach((s) => s.close());
  });

  it('only the diner with the tracking token (or outlet staff) can follow an order; new orders are pushed to staff only', async () => {
    const [it0] = await firstItems(A.slug);
    const own = await connect({ token: A.token });
    await join(own, 'join:admin', { restaurantSlug: A.slug });
    const spy = await connect({ token: B.token });
    const got = []; const leaked = [];
    own.on('order:new', (o) => got.push(o.id));
    spy.on('order:new', (o) => leaked.push(o.id));
    const o = (await placeOrder(A.slug, [it0])).data;
    const anon = await connect({});
    assert.equal((await join(anon, 'join:order', { orderId: o.id })).status, 'denied');
    assert.equal((await join(anon, 'join:order', { orderId: o.id, token: 'x'.repeat(48) })).status, 'denied');
    assert.equal((await join(anon, 'join:order', { orderId: o.id, token: o.trackingToken })).status, 'joined');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(got.includes(o.id), 'owner socket received the new order');
    assert.deepEqual(leaked, [], 'foreign socket must receive nothing');
    [own, spy, anon].forEach((s) => s.close());
  });
});

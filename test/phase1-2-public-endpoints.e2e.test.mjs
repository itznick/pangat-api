/**
 * Phase 1.2 live tests: the staff-only listings (GET /tables, GET /tables/:id, GET /menu/items) and the public diner journey.
 * Needs a RUNNING API on a THROWAWAY database (see phase1-entitlements.e2e.test.mjs for the start command).   npm run test:phase1_2
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
async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, code: json?.code };
}
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });
const idem = () => `idem-${crypto.randomBytes(8).toString('hex')}`;
async function onboard(tag) {
  const slug = `p12-${tag}-${run}`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `B ${tag}`, ownerFullName: 'O', mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW, outletName: `O ${tag}`, slug, upiVpa: 'shop@upi', gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}
async function hire(o, role, i) {
  const email = `${role.toLowerCase()}-${i}-${o.slug}@example.com`;
  const c = await call('POST', `/restaurants/${o.outlet.id}/staff`, { token: o.token, body: { name: role, email, password: PW, role } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const f = await login(email);
  return (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
}
let A; let B; const staff = {}; let ADMIN; let SUPPORT; // SUPPORT holds the ANALYST (read-only, no merchant.view) token
before(async () => {
  await db.connect();
  A = await onboard('a'); B = await onboard('b');
  for (const role of ['STORE_MANAGER', 'CHEF', 'STEWARD', 'CASHIER']) staff[role] = await hire(A, role, 1);
  const { default: bcrypt } = await import('bcrypt');
  const e = `root-p12-${run}@pangat.test`;
  await db.query(`INSERT INTO staff (name,email,password_hash,role,is_platform_admin,platform_role) VALUES ('Root',$1,$2,'PLATFORM_SUPER_ADMIN',true,'OWNER')`, [e, await bcrypt.hash(PW, 10)]);
  ADMIN = (await login(e)).data.accessToken;
  const se = `sup-p12-${run}@pangat.test`;
  assert.equal((await call('POST', '/admin/admins', { token: ADMIN, body: { name: 'Analyst P12', email: se, role: 'ANALYST', password: PW + 'xyz' } })).status, 201);
  const f = await login(se, PW + 'xyz');
  SUPPORT = (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW + 'xyz', newPassword: PW2 } })).data.accessToken;
});
after(async () => { await db.end(); });

describe('Unauthenticated callers are refused', () => {
  it('GET /tables, /tables/:id and /menu/items need a sign-in (401), whatever the parameters', async () => {
    const tbl = (await call('GET', `/tables?restaurantId=${A.outlet.id}`, { token: A.token })).data[0];
    for (const path of [`/tables?restaurantId=${A.outlet.id}`, `/tables?restaurantSlug=${A.slug}`, `/tables/${tbl.id}`, `/menu/items?restaurantId=${A.outlet.id}`, '/tables', '/menu/items', '/tables/not-a-uuid', '/tables?restaurantId=not-a-uuid']) {
      const r = await call('GET', path);
      assert.equal(r.status, 401, `${path} -> ${r.status}`);
    }
  });
  it('a garbage token is refused too', async () => {
    assert.equal((await call('GET', `/tables?restaurantId=${A.outlet.id}`, { token: 'abc.def.ghi' })).status, 401);
  });
});

describe('Authorised staff keep working, each within their own outlet', () => {
  it('every staff role of outlet A can list its tables and menu items, and read a single table', async () => {
    for (const [role, token] of [['OWNER', A.token], ...Object.entries(staff)]) {
      const t = await call('GET', `/tables?restaurantId=${A.outlet.id}`, { token });
      assert.equal(t.status, 200, `${role} tables: ${JSON.stringify(t.body)}`);
      assert.equal(t.data.length, 3);
      assert.deepEqual(Object.keys(t.data[0]).sort(), ['createdAt', 'id', 'qrCodeUrl', 'restaurantId', 'status', 'tableNumber', 'updatedAt']);
      assert.equal((await call('GET', `/tables?restaurantSlug=${A.slug}`, { token })).status, 200, `${role} by slug`);
      assert.equal((await call('GET', `/tables/${t.data[0].id}`, { token })).status, 200, `${role} single`);
      const m = await call('GET', `/menu/items?restaurantId=${A.outlet.id}`, { token });
      assert.equal(m.status, 200, `${role} menu: ${JSON.stringify(m.body)}`);
      assert.ok(m.data.length > 0);
    }
  });
  it('the kitchen PIN session (the real KDS login) can read the menu items it needs', async () => {
    const k = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: A.slug } });
    assert.ok([200, 201].includes(k.status));
    assert.equal((await call('GET', `/menu/items?restaurantId=${A.outlet.id}`, { token: k.data.accessToken })).status, 200);
  });
});

describe('Cross-tenant and cross-outlet access is refused', () => {
  it('owner B and all of B\'s staff cannot read A\'s tables or menu, by id, slug or single table', async () => {
    const bMgr = await hire(B, 'STORE_MANAGER', 1);
    const tblA = (await call('GET', `/tables?restaurantId=${A.outlet.id}`, { token: A.token })).data[0];
    for (const token of [B.token, bMgr]) {
      for (const path of [`/tables?restaurantId=${A.outlet.id}`, `/tables?restaurantSlug=${A.slug}`, `/tables/${tblA.id}`, `/menu/items?restaurantId=${A.outlet.id}`]) {
        const r = await call('GET', path, { token });
        assert.equal(r.status, 403, `${path} -> ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
  });
  it('a staff member cannot reach a second outlet of the same organisation; the owner can', async () => {
    await db.query(`UPDATE organization_subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code='ENTERPRISE') WHERE organization_id = $1`, [A.orgId]);
    const two = await call('POST', '/organizations/outlets', { token: A.token, body: { name: 'Second', slug: `p12-a2-${run}`, upiVpa: 'xx@upi', tableCount: 2 } });
    assert.equal(two.status, 201, JSON.stringify(two.body));
    assert.equal((await call('GET', `/tables?restaurantId=${two.data.id}`, { token: A.token })).status, 200, 'the owner spans the organisation');
    assert.equal((await call('GET', `/tables?restaurantId=${two.data.id}`, { token: staff.CASHIER })).status, 403, 'a cashier is bound to their own outlet');
    assert.equal((await call('GET', `/menu/items?restaurantId=${two.data.id}`, { token: staff.CHEF })).status, 403);
  });
  it('a restaurantId in the query that does not match the single table requested is a conflict (403)', async () => {
    const tblA = (await call('GET', `/tables?restaurantId=${A.outlet.id}`, { token: A.token })).data[0];
    assert.equal((await call('GET', `/tables/${tblA.id}?restaurantId=${B.outlet.id}`, { token: A.token })).status, 403);
  });
  it('unscoped requests are refused, not answered with everything', async () => {
    assert.equal((await call('GET', '/tables', { token: A.token })).status, 403);
    assert.equal((await call('GET', '/menu/items', { token: A.token })).status, 403);
  });
});

describe('Platform administrators', () => {
  it('may read restaurant data only with the console permission', async () => {
    assert.equal((await call('GET', `/tables?restaurantId=${A.outlet.id}`, { token: ADMIN })).status, 200, 'owner role: merchant.view');
    assert.equal((await call('GET', `/menu/items?restaurantId=${A.outlet.id}`, { token: ADMIN })).status, 200);
    assert.equal((await call('GET', `/tables?restaurantId=${A.outlet.id}`, { token: SUPPORT })).status, 403, 'analyst role has no merchant.view');
    assert.equal((await call('GET', `/menu/items?restaurantId=${A.outlet.id}`, { token: SUPPORT })).status, 403);
  });
});

describe('Malformed identifiers are a clean 400, never a 500', () => {
  it('bad ids, bad restaurantId, bad slug and repeated parameters', async () => {
    const cases = [
      ['/tables/not-a-uuid', 'id'], ['/tables/1', 'id'], [`/tables/${A.outlet.id}x`, 'id'],
      ['/tables?restaurantId=not-a-uuid', 'restaurantId'], ['/tables?restaurantId=', 'restaurantId'], [`/tables?restaurantId=${A.outlet.id}&restaurantId=${B.outlet.id}`, 'restaurantId'],
      ['/menu/items?restaurantId=not-a-uuid', 'restaurantId'], ["/menu/items?restaurantId=' OR 1=1 --", 'restaurantId'],
      ['/tables?restaurantSlug=has space', 'slug'], [`/tables?restaurantSlug=${'x'.repeat(200)}`, 'slug'],
    ];
    for (const [path] of cases) {
      const r = await call('GET', path.replace(/ /g, '%20'), { token: A.token });
      assert.equal(r.status, 400, `${path} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.code, 'INVALID_IDENTIFIER');
      assert.doesNotMatch(JSON.stringify(r.body), /invalid input syntax|select |postgres/i);
    }
    for (const path of ['/tables/not-a-uuid/status']) {
      assert.equal((await call('PATCH', path, { token: A.token, body: { status: 'VACANT' } })).status, 400);
    }
    assert.equal((await call('DELETE', '/tables/not-a-uuid', { token: A.token })).status, 400);
    assert.equal((await call('GET', `/tables/${crypto.randomUUID()}`, { token: A.token })).status, 404, 'a well-formed id that does not exist is a 404');
  });
});

describe('The public diner journey is unchanged', () => {
  it('QR menu, restaurant info, ordering, tracking and feedback work with no sign-in', async () => {
    const menu = await call('GET', `/menu/public/${A.slug}`);
    assert.equal(menu.status, 200);
    assert.ok(menu.data.items.length > 0);
    assert.equal((await call('GET', `/restaurants/${A.slug}`)).status, 200);
    const it0 = menu.data.items[0];
    const placed = await call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: { restaurantSlug: A.slug, orderType: 'DINE_IN', tableNumber: 'T01', customerName: 'Guest', consentAccepted: true, paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: it0.id, name: it0.name, price: Number(it0.price), quantity: 1 }] } });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const token = placed.data.trackingToken;
    assert.ok(token, 'the diner receives a tracking token');
    const track = await call('GET', `/orders/${placed.data.id}?token=${token}`);
    assert.equal(track.status, 200, JSON.stringify(track.body));
    assert.equal((await call('GET', `/orders/${placed.data.id}`)).status === 200, false, 'tracking needs the private token');
    // a takeaway order needs no table at all
    const take = await call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: { restaurantSlug: A.slug, orderType: 'TAKEAWAY', customerName: 'Guest', consentAccepted: true, paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: it0.id, name: it0.name, price: Number(it0.price), quantity: 1 }] } });
    assert.equal(take.status, 201);
  });
});

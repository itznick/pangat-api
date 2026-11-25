/**
 * Phase 1.1 independent verification (live): bypass attempts, mixed-operation concurrency, plan-change isolation and platform permissions.
 * Needs a RUNNING API on a THROWAWAY database (never production):
 *
 *   DATABASE_URL=postgres://... THROTTLE_DISABLED=true PLATFORM_BOOTSTRAP_SECRET=bootstrapsecret1234567 \
 *     RAZORPAY_WEBHOOK_SECRET=whsec_test_123 PORT=4000 node dist/main &
 *   npm run test:phase1_1
 *
 * Every run creates its own tenants and plans (random codes) and restores the platform settings it touches.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { io } from 'socket.io-client';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const WS = API.replace(/\/api\/v1$/, '');
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const PW2 = 'Tulsi-Wada-Pune-42';
const db = new pg.Client({ connectionString: DB });

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, code: json?.code };
}
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });
const tokenOf = async (email, password = PW) => (await login(email, password)).data.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idem = () => `idem-${crypto.randomBytes(8).toString('hex')}`;

let ADMIN; // platform owner (every permission)
let ADMIN_FIN; // platform finance role: has subscriptions.manage but NOT merchant.operate
let n = 0;
const plansMade = [];
const settingsTouched = new Set();

/** A throwaway plan with exactly the limits and features a test needs. */
async function makePlan({ outlets = 1, tables = 5, staff = 3, features = ['QR_ORDERING', 'KDS'] } = {}) {
  const code = `P1${run}${(n++).toString(36)}`.toUpperCase();
  const r = await call('POST', '/subscriptions/admin/plans', {
    token: ADMIN.token,
    body: { code, name: `Test ${code}`, billingInterval: 'MONTHLY', basePrice: 100, maxOutlets: outlets, maxTablesPerOutlet: tables, maxStaffPerOutlet: staff, features, trialDays: 30, isPublic: false },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  plansMade.push(code);
  return { code, id: r.data.id };
}
const setPlan = (orgId, planCode) =>
  db.query(
    `UPDATE organization_subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = $2), status = 'ACTIVE', current_period_start = now(),
            current_period_end = now() + interval '30 days', grace_period_ends_at = NULL, cancel_at_period_end = false WHERE organization_id = $1`,
    [orgId, planCode],
  );
async function setSetting(key, value) {
  settingsTouched.add(key);
  const r = await call('PUT', '/admin/settings', { token: ADMIN.token, body: { changes: { [key]: value } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const onboardBody = (tag, extra = {}) => ({
  brandName: `Brand ${tag}`, ownerFullName: `Owner ${tag}`, mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW,
  outletName: `Outlet ${tag}`, slug: `p1-${tag}-${run}`, upiVpa: 'shop@upi', gstPercentage: 5, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468', ...extra,
});
async function onboard(tag, extra = {}) {
  const r = await call('POST', '/auth/onboard', { body: onboardBody(tag, extra) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug: `p1-${tag}-${run}`, email: `o-${tag}-${run}@example.com`, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}
/** An organisation moved onto a chosen plan right after sign-up. */
async function orgOn(tag, plan, extra = {}) {
  const o = await onboard(tag, { indoorTableCount: 1, outdoorTableCount: 0, ...extra });
  await setPlan(o.orgId, plan.code);
  return o;
}
const tableCount = async (outletId) => Number((await db.query('SELECT COUNT(*) FROM tables WHERE restaurant_id = $1', [outletId])).rows[0].count);
const seatCount = async (outletId) =>
  Number((await db.query(`SELECT COUNT(*) FROM staff WHERE restaurant_id = $1 AND is_active AND email NOT LIKE '%@stations.pangat.app' AND role NOT IN ('SUPER_OWNER','PLATFORM_SUPER_ADMIN')`, [outletId])).rows[0].count);
const addTable = (o, num, extra = {}) => call('POST', '/tables', { token: o.token, body: { restaurantId: o.outlet.id, tableNumber: num, ...extra } });
const addStaff = (o, i, role = 'STEWARD') =>
  call('POST', `/restaurants/${o.outlet.id}/staff`, { token: o.token, body: { name: `S${i}`, email: `s${i}-${o.slug}@example.com`, password: PW, role } });
const firstItem = async (slug) => {
  const m = (await call('GET', `/menu/public/${slug}`)).data;
  const i = m.items[0];
  return { menuItemId: i.id, name: i.name, price: Number(i.price), quantity: 1 };
};
const order = (slug, item) =>
  call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: { restaurantSlug: slug, orderType: 'TAKEAWAY', customerName: 'Guest', consentAccepted: true, paymentMethod: 'PAY_AT_COUNTER', items: [item] } });

before(async () => {
  await db.connect();
  const email = `root-p1-${run}@pangat.test`;
  const { default: bcrypt } = await import('bcrypt');
  await db.query(`INSERT INTO staff (name, email, password_hash, role, is_platform_admin, platform_role) VALUES ('Root P1', $1, $2, 'PLATFORM_SUPER_ADMIN', true, 'OWNER')`, [email, await bcrypt.hash(PW, 10)]);
  ADMIN = { email, token: await tokenOf(email) };
  const fe = `fin-p1-${run}@pangat.test`;
  const c = await call('POST', '/admin/admins', { token: ADMIN.token, body: { name: 'Fin P1', email: fe, role: 'FINANCE', password: PW + 'xyz' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const first = await login(fe, PW + 'xyz');
  const chg = await call('POST', '/auth/change-password', { token: first.data.accessToken, body: { currentPassword: PW + 'xyz', newPassword: PW2 } });
  ADMIN_FIN = { email: fe, token: chg.data.accessToken };
});
after(async () => {
  for (const k of settingsTouched) await call('PUT', '/admin/settings', { token: ADMIN.token, body: { changes: { [k]: k === 'subscription.defaultTrialPlanCode' ? 'GROWTH' : null } } });
  for (const k of ['QR_ORDERING', 'KDS', 'MULTI_OUTLET']) await call('PATCH', `/admin/feature-flags/${k}`, { token: ADMIN.token, body: { enabled: true } });
  await db.query('UPDATE subscription_plans SET is_active = false WHERE code = ANY($1)', [plansMade]);
  await db.end();
});


// ─────────────────────────────────────────────────────────────────────────────
describe('KDS cannot be bypassed through another door', () => {
  const sock = (token) => io(WS, { auth: { token }, transports: ['websocket'] });
  const join = (token, room, slug) =>
    new Promise((resolve) => {
      const s = sock(token);
      s.on('connect', () => s.emit(room, { restaurantSlug: slug }, (ack) => { s.close(); resolve(ack?.data ?? ack); }));
    });

  it('a kitchen-role (CHEF) token without KDS gets no live feed from the admin room either', async () => {
    const without = await makePlan({ features: ['QR_ORDERING'] });
    const withIt = await makePlan({ features: ['QR_ORDERING', 'KDS'] });
    const o = await orgOn('bp1', withIt);
    const chef = await addStaff(o, 1, 'CHEF');
    assert.equal(chef.status, 201);
    const first = await login(`s1-${o.slug}@example.com`);
    const chefTok = (await call('POST', '/auth/change-password', { token: first.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
    assert.equal((await join(chefTok, 'join:kds', o.slug)).status, 'joined', 'with KDS the kitchen room works');
    await setPlan(o.orgId, without.code);
    assert.equal((await join(chefTok, 'join:kds', o.slug)).status, 'denied', 'without KDS the kitchen room is refused');
    const adm = await join(chefTok, 'join:admin', o.slug);
    assert.equal(adm.status, 'denied', `the kitchen role must not receive the full (unredacted) admin feed instead: got ${JSON.stringify(adm)}`);
  });
});

describe('Mixed concurrent operations on one organisation (deadlock / lost-update hunt)', () => {
  it('tables + staff + outlets + guest orders + status changes + settings all at once: no 5xx, exact limits', async () => {
    const dl0 = Number((await db.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
    const plan = await makePlan({ outlets: 4, tables: 12, staff: 6, features: ['QR_ORDERING', 'KDS', 'MULTI_OUTLET'] });
    const o = await orgOn('mx1', plan, { indoorTableCount: 2 });
    const item = await firstItem(o.slug);
    const seed = (await order(o.slug, item)).data;
    const kds = (await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } })).data.accessToken;
    const mkOutlet = (i) => call('POST', '/organizations/outlets', { token: o.token, body: { name: `X${i}`, slug: `p1-mx-${i}-${run}`, upiVpa: 'xx@upi', tableCount: 2 } });
    const jobs = [];
    for (let i = 0; i < 20; i++) jobs.push(addTable(o, `M${i}`));
    for (let i = 0; i < 12; i++) jobs.push(addStaff(o, i));
    for (let i = 0; i < 8; i++) jobs.push(mkOutlet(i));
    for (let i = 0; i < 20; i++) jobs.push(order(o.slug, item));
    for (let i = 0; i < 6; i++) jobs.push(call('PATCH', `/orders/${seed.id}/status`, { token: kds, body: { status: i % 2 ? 'READY' : 'PREPARING' } }));
    for (let i = 0; i < 4; i++) jobs.push(call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { gstPercentage: 5 + (i % 2) } }));
    for (let i = 0; i < 6; i++) jobs.push(call('GET', '/subscriptions/my-subscription', { token: o.token }));
    const res = await Promise.all(jobs);
    const fivexx = res.filter((r) => r.status >= 500);
    assert.equal(fivexx.length, 0, `5xx responses (possible deadlock): ${JSON.stringify(fivexx.map((r) => r.body?.message))}`);
    assert.equal(await tableCount(o.outlet.id), 12, 'tables stop exactly at the limit');
    assert.equal(await seatCount(o.outlet.id), 6, 'seats stop exactly at the limit');
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM restaurants WHERE organization_id = $1', [o.orgId])).rows[0].count), 4, 'outlets stop exactly at the limit');
    for (const r of res) assert.ok([200, 201, 400, 403, 429].includes(r.status), `unexpected status ${r.status}`);
    const dl1 = Number((await db.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
    assert.equal(dl1, dl0, `the database reported ${dl1 - dl0} deadlock(s) during the run`);
  });

  it('saving outlet settings never deletes or duplicates tables created at the same moment (pre-existing data-loss race)', async () => {
    const plan = await makePlan({ tables: -1 });
    const o = await orgOn('mx3', plan, { indoorTableCount: 1 });
    const jobs = [];
    for (let i = 0; i < 25; i++) jobs.push(addTable(o, `S${i}`));
    for (let i = 0; i < 25; i++) jobs.push(call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { gstPercentage: 5 + (i % 3) } }));
    const res = await Promise.all(jobs);
    assert.equal(res.filter((r) => r.status >= 500).length, 0, JSON.stringify(res.filter((r) => r.status >= 500).map((r) => r.body?.message)));
    const created = res.slice(0, 25).filter((r) => r.status === 201).length;
    assert.equal(created, 25);
    assert.equal(await tableCount(o.outlet.id), 26, 'every table that was created is still there');
  });

  it('two organisations hammering their own limits in parallel do not affect each other', async () => {
    const plan = await makePlan({ tables: 5 });
    const a = await orgOn('mx2a', plan, { indoorTableCount: 1 });
    const b = await orgOn('mx2b', plan, { indoorTableCount: 1 });
    const res = await Promise.all([...Array.from({ length: 12 }, (_, i) => addTable(a, `A${i}`)), ...Array.from({ length: 12 }, (_, i) => addTable(b, `B${i}`))]);
    assert.equal(res.filter((r) => r.status >= 500).length, 0);
    assert.equal(await tableCount(a.outlet.id), 5);
    assert.equal(await tableCount(b.outlet.id), 5);
  });
});

describe('A plan change affects exactly the organisation it was made for', () => {
  it('changing A\'s plan through the console changes A immediately and leaves B alone; editing a shared plan changes both', async () => {
    const small = await makePlan({ tables: 2, features: ['QR_ORDERING', 'KDS'] });
    const big = await makePlan({ tables: 50, features: ['QR_ORDERING', 'KDS', 'INVENTORY'] });
    const a = await orgOn('pc1a', small, { indoorTableCount: 2 });
    const b = await orgOn('pc1b', small, { indoorTableCount: 2 });
    assert.equal((await addTable(a, 'N1')).status, 403);
    assert.equal((await addTable(b, 'N1')).status, 403);
    const ch = await call('POST', `/admin/restaurants/${a.orgId}/subscription/change-plan`, { token: ADMIN.token, body: { planCode: big.code, reason: 'Upgrade after payment' } });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.equal((await addTable(a, 'N2')).status, 201, 'A sees the bigger plan at once');
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${a.outlet.id}`, { token: a.token })).status, 200);
    assert.equal((await addTable(b, 'N2')).status, 403, 'B is untouched');
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${b.outlet.id}`, { token: b.token })).status, 402);
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${small.id}`, { token: ADMIN.token, body: { maxTablesPerOutlet: 4 } })).status, 200);
    assert.equal((await addTable(b, 'N3')).status, 201, 'a shared plan edit reaches its subscribers immediately');
    const ent = (await call('GET', '/subscriptions/my-subscription', { token: a.token })).data.entitlements;
    assert.equal(ent.plan.code, big.code);
    assert.equal(ent.limits.maxTablesPerOutlet, 50);
  });
});

describe('Platform administrator permissions', () => {
  it('only the right permissions reach plan edits, overrides, provisioning and restaurant consoles', async () => {
    const mkAdmin = async (role) => {
      const e = `${role.toLowerCase()}-p11-${run}@pangat.test`;
      const c = await call('POST', '/admin/admins', { token: ADMIN.token, body: { name: role, email: e, role, password: PW + 'xyz' } });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      const f = await login(e, PW + 'xyz');
      return (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW + 'xyz', newPassword: PW2 } })).data.accessToken;
    };
    const plan = await makePlan({ tables: 2 });
    const o = await orgOn('pa1', plan, { indoorTableCount: 2 });
    const reason = 'Festival week extra tables, approved';
    for (const role of ['ANALYST', 'SUPPORT', 'FINANCE']) {
      const t = await mkAdmin(role);
      const over = await call('POST', '/tables', { token: t, body: { restaurantId: o.outlet.id, tableNumber: `X${role}`, limitOverrideReason: reason } });
      assert.equal(over.status, 403, `${role} must not override (got ${over.status})`);
      assert.equal((await call('PATCH', `/subscriptions/admin/plans/${plan.id}`, { token: t, body: { maxTablesPerOutlet: 99 } })).status, 403, `${role} must not edit plans`);
      assert.equal((await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: t, body: { feature: 'KDS', mode: 'FORCE_OFF', reason: 'x' } })).status, 403, `${role} must not set overrides`);
    }
    assert.equal(await tableCount(o.outlet.id), 2);
    // ADMIN has everything except admin management: an override works for it and is audited under its own identity
    const adminTok = await mkAdmin('ADMIN');
    const ok = await call('POST', '/tables', { token: adminTok, body: { restaurantId: o.outlet.id, tableNumber: 'OKADMIN', limitOverrideReason: reason } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const a = await db.query(`SELECT actor FROM subscription_audit_logs WHERE organization_id = $1 AND action = 'PLAN_LIMIT_OVERRIDDEN'`, [o.orgId]);
    assert.match(a.rows[0].actor, /^ADMIN:admin-p11-/);
  });
});

describe('Error responses do not leak internals', () => {
  it('limit and feature errors carry only numbers and codes; a malformed id is a clean error', async () => {
    const plan = await makePlan({ tables: 1, features: ['QR_ORDERING'] });
    const o = await orgOn('lk1', plan);
    const r = await addTable(o, 'Z');
    const txt = JSON.stringify(r.body);
    assert.equal(r.status, 403);
    assert.doesNotMatch(txt, /stack|SELECT |organization_id|postgres|node_modules|at .*\.js/i);
    assert.deepEqual(Object.keys(r.body.details).sort(), ['current', 'limit', 'limitKind', 'requested']);
    const f = await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token });
    assert.deepEqual(Object.keys(f.body.details), ['feature']);
    const bad = await call('GET', '/tables?restaurantId=not-a-uuid', { token: o.token });
    assert.doesNotMatch(String(bad.body.message), /invalid input syntax|select|postgres|uuid/i, 'the database error text is never echoed');
    assert.equal(bad.status, 400, 'a malformed id is a 400 (it was a generic 500 before Phase 1.2)');
    assert.equal((await call('GET', '/tables?restaurantId=not-a-uuid')).status, 401, 'and anonymous callers get no validation hints at all');
  });
});

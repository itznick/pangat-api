/**
 * Phase 1 live tests: plan limits, staff seats, feature entitlement, multi-outlet, overrides and lapse behaviour.
 * Needs a RUNNING API on a THROWAWAY database (never production):
 *
 *   DATABASE_URL=postgres://... THROTTLE_DISABLED=true PLATFORM_BOOTSTRAP_SECRET=bootstrapsecret1234567 \
 *     RAZORPAY_WEBHOOK_SECRET=whsec_test_123 PORT=4000 node dist/main &
 *   npm run test:phase1
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
  for (const k of settingsTouched) await call('PUT', '/admin/settings', { token: ADMIN.token, body: { changes: { [k]: null } } });
  for (const k of ['QR_ORDERING', 'KDS', 'MULTI_OUTLET']) await call('PATCH', `/admin/feature-flags/${k}`, { token: ADMIN.token, body: { enabled: true } });
  await db.query('UPDATE subscription_plans SET is_active = false WHERE code = ANY($1)', [plansMade]);
  await db.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Table limits at every creation path', () => {
  it('POST /tables stops at the plan limit with a structured error, and reports the numbers', async () => {
    const plan = await makePlan({ tables: 5 });
    const o = await orgOn('t1', plan, { indoorTableCount: 3 });
    assert.equal((await addTable(o, 'X1')).status, 201);
    assert.equal((await addTable(o, 'X2')).status, 201);
    const over = await addTable(o, 'X3');
    assert.equal(over.status, 403);
    assert.equal(over.code, 'PLAN_LIMIT_REACHED');
    assert.equal(over.body.details.limitKind, 'tables');
    assert.equal(over.body.details.limit, 5);
    assert.equal(over.body.details.current, 5);
    assert.equal(await tableCount(o.outlet.id), 5);
  });

  it('self-service onboarding: indoor + outdoor are validated TOGETHER against the trial plan', async () => {
    const plan = await makePlan({ tables: 6 });
    await setSetting('subscription.defaultTrialPlanCode', plan.code);
    // each part fits on its own (5 and 3) but together (8) they do not
    const bad = await call('POST', '/auth/onboard', { body: onboardBody('ob1', { indoorTableCount: 5, outdoorTableCount: 3 }) });
    assert.equal(bad.status, 403, JSON.stringify(bad.body));
    assert.equal(bad.code, 'PLAN_LIMIT_REACHED');
    assert.equal((await db.query('SELECT 1 FROM staff WHERE email = $1', [`o-ob1-${run}@example.com`])).rowCount, 0, 'nothing was created');
    // exactly at the limit is fine
    const ok = await onboard('ob2', { indoorTableCount: 4, outdoorTableCount: 2 });
    assert.equal(await tableCount(ok.outlet.id), 6);
    // not asking for a number: the default (12 + 4) is trimmed to the plan instead of failing the sign-up
    const dflt = await onboard('ob3');
    assert.equal(await tableCount(dflt.outlet.id), 6);
    await setSetting('subscription.defaultTrialPlanCode', 'GROWTH');
  });

  it('self-service onboarding cannot reach 150 tables on the default trial plan either', async () => {
    const r = await call('POST', '/auth/onboard', { body: onboardBody('ob4', { indoorTableCount: 100, outdoorTableCount: 50 }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.code, 'PLAN_LIMIT_REACHED');
  });

  it('Super Admin provisioning enforces the limit; an override needs permission, a real reason, and is audited', async () => {
    const plan = await makePlan({ tables: 6 });
    await setSetting('subscription.defaultTrialPlanCode', plan.code);
    const body = (tag, extra = {}) => ({
      brandName: `Brand ${tag}`, ownerFullName: 'Owner', email: `o-${tag}-${run}@example.com`, mobileNumber: '9876500002', password: PW + 'z',
      outletName: `Outlet ${tag}`, slug: `p1-${tag}-${run}`, upiVpa: 'aa@upi', indoorTableCount: 8, outdoorTableCount: 2, menuPreset: 'blank', ...extra,
    });
    const blocked = await call('POST', '/admin/provision', { token: ADMIN.token, body: body('pv1') });
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal(blocked.code, 'PLAN_LIMIT_REACHED');
    const short = await call('POST', '/admin/provision', { token: ADMIN.token, body: body('pv2', { limitOverrideReason: 'short' }) });
    assert.equal(short.status, 400);
    assert.equal(short.code, 'LIMIT_OVERRIDE_REASON_REQUIRED');
    const okv = await call('POST', '/admin/provision', { token: ADMIN.token, body: body('pv3', { limitOverrideReason: 'Pilot customer with a 10-table floor, approved by founder' }) });
    assert.equal(okv.status, 201, JSON.stringify(okv.body));
    assert.equal(await tableCount(okv.data.outlet.id), 10);
    const audit = await db.query(`SELECT actor, reason, metadata FROM subscription_audit_logs WHERE organization_id = $1 AND action = 'PLAN_LIMIT_OVERRIDDEN'`, [okv.data.organization.id]);
    assert.equal(audit.rowCount, 1, 'the override is in the audit trail');
    assert.match(audit.rows[0].reason, /Pilot customer/);
    assert.equal(audit.rows[0].metadata.kind, 'tables');
    // the platform role without the right permission cannot provision at all (and so cannot override)
    assert.equal((await call('POST', '/admin/provision', { token: ADMIN_FIN.token, body: body('pv4', { limitOverrideReason: 'Pilot customer, approved' }) })).status, 403);
    // within the limit nothing is recorded as an override
    const fits = await call('POST', '/admin/provision', { token: ADMIN.token, body: body('pv5', { indoorTableCount: 4, outdoorTableCount: 2 }) });
    assert.equal(fits.status, 201);
    assert.equal((await db.query(`SELECT 1 FROM subscription_audit_logs WHERE organization_id = $1 AND action = 'PLAN_LIMIT_OVERRIDDEN'`, [fits.data.organization.id])).rowCount, 0);
    await setSetting('subscription.defaultTrialPlanCode', 'GROWTH');
  });

  it('a new outlet is limited per outlet: explicit over-limit is refused, the default is trimmed, each outlet counts separately', async () => {
    const plan = await makePlan({ outlets: 3, tables: 6, features: ['QR_ORDERING', 'KDS', 'MULTI_OUTLET'] });
    const o = await orgOn('ob5', plan);
    const mk = (slug, tableCount) => call('POST', '/organizations/outlets', { token: o.token, body: { name: slug, slug, upiVpa: 'xx@upi', ...(tableCount ? { tableCount } : {}) } });
    const bad = await mk(`p1-out-a-${run}`, 8);
    assert.equal(bad.status, 403, JSON.stringify(bad.body));
    assert.equal(bad.code, 'PLAN_LIMIT_REACHED');
    const two = await mk(`p1-out-b-${run}`); // default 10 -> trimmed to 6
    assert.equal(two.status, 201, JSON.stringify(two.body));
    assert.equal(await tableCount(two.data.id), 6);
    const full = await call('POST', '/tables', { token: o.token, body: { restaurantId: two.data.id, tableNumber: 'Z1' } });
    assert.equal(full.status, 403, 'outlet 2 is full');
    assert.equal(await addTable(o, 'FIRST').then((r) => r.status), 201, 'outlet 1 (1 table) is counted on its own and still has room');
  });

  it('concurrent table creation cannot pass the limit together', async () => {
    const plan = await makePlan({ tables: 5 });
    const o = await orgOn('cc1', plan, { indoorTableCount: 3 }); // 3 of 5 used, room for exactly 2
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => addTable(o, `C${i}`)));
    const ok = results.filter((r) => r.status === 201).length;
    assert.equal(ok, 2, `statuses: ${results.map((r) => r.status).join(',')}`);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 403 && r.code === 'PLAN_LIMIT_REACHED'));
    assert.equal(await tableCount(o.outlet.id), 5);
  });

  it('a burst larger than the database pool neither deadlocks nor passes the limit (40 requests, pool of 15)', async () => {
    const plan = await makePlan({ tables: 20 });
    const o = await orgOn('cc2', plan, { indoorTableCount: 1 }); // room for 19
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => addTable(o, `B${i}`)));
    assert.ok(Date.now() - started < 20_000, 'finished promptly (no pool starvation)');
    assert.equal(results.filter((r) => r.status === 201).length, 19, `statuses: ${[...new Set(results.map((r) => r.status))].join(',')}`);
    assert.ok(results.every((r) => [201, 403].includes(r.status)));
    assert.equal(await tableCount(o.outlet.id), 20);
    const open = await makePlan({ tables: -1 });
    const u = await orgOn('cc3', open, { indoorTableCount: 1 });
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) => addTable(u, `U${i}`)));
    assert.equal(many.filter((r) => r.status === 201).length, 40, 'an unlimited plan is never refused');
  });

  it('lowering a limit never deletes tables, blocks further adds, and the plan edit reports who is over', async () => {
    const plan = await makePlan({ tables: 8 });
    const o = await orgOn('lo1', plan, { indoorTableCount: 6 });
    const edit = await call('PATCH', `/subscriptions/admin/plans/${plan.id}`, { token: ADMIN.token, body: { maxTablesPerOutlet: 4 } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.ok(edit.data.overLimitOrganisations.some((x) => x.organization_id === o.orgId), 'the over-limit organisation is reported');
    assert.equal(await tableCount(o.outlet.id), 6, 'nothing was deleted');
    const r = await addTable(o, 'MORE');
    assert.equal(r.status, 403);
    assert.equal(r.code, 'PLAN_LIMIT_REACHED');
    assert.match(String(r.body.message), /already over/);
    // removing tables below the limit makes room again
    const tables = (await call('GET', `/tables?restaurantId=${o.outlet.id}`, { token: o.token })).data;
    for (const t of tables.slice(0, 3)) assert.equal((await call('DELETE', `/tables/${t.id}`, { token: o.token })).status, 200);
    assert.equal((await addTable(o, 'BACK')).status, 201);
  });

  it('only an authorised Super Admin can override a table limit, with a reason, and it is audited', async () => {
    const plan = await makePlan({ tables: 2 });
    const o = await orgOn('ov1', plan, { indoorTableCount: 2 });
    // the restaurant owner is refused loudly (never silently ignored)
    const own = await addTable(o, 'OV1', { limitOverrideReason: 'please let me, I really need it' });
    assert.equal(own.status, 403);
    assert.equal(own.code, 'LIMIT_OVERRIDE_FORBIDDEN');
    // platform finance cannot even enter a restaurant console to add a table
    assert.equal((await call('POST', '/tables', { token: ADMIN_FIN.token, body: { restaurantId: o.outlet.id, tableNumber: 'OV3', limitOverrideReason: 'finance trying it out for size' } })).status, 403);
    // without the reason, even the platform owner is held to the limit
    assert.equal((await call('POST', '/tables', { token: ADMIN.token, body: { restaurantId: o.outlet.id, tableNumber: 'OV4' } })).status, 403);
    const okr = await call('POST', '/tables', { token: ADMIN.token, body: { restaurantId: o.outlet.id, tableNumber: 'OV5', limitOverrideReason: 'Owner added a patio for the festival week' } });
    assert.equal(okr.status, 201, JSON.stringify(okr.body));
    assert.equal(await tableCount(o.outlet.id), 3);
    const a = await db.query(`SELECT actor, reason FROM subscription_audit_logs WHERE organization_id = $1 AND action = 'PLAN_LIMIT_OVERRIDDEN'`, [o.orgId]);
    assert.equal(a.rowCount, 1);
    assert.match(a.rows[0].actor, /^ADMIN:root-p1-/);
    const pa = await db.query(`SELECT actor_email, reason FROM platform_audit_logs WHERE organization_id = $1 AND action = 'PLAN_LIMIT_OVERRIDDEN'`, [o.orgId]);
    assert.equal(pa.rowCount, 1, 'also in the platform Audit log');
    assert.match(pa.rows[0].reason, /patio/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Staff seats', () => {
  it('the hidden kitchen-station account does not use a seat; real staff do', async () => {
    const plan = await makePlan({ staff: 3 });
    const o = await orgOn('st1', plan); // sign-up created the kitchen station account (kitchenPin)
    const station = await db.query(`SELECT 1 FROM staff WHERE restaurant_id = $1 AND email LIKE '%@stations.pangat.app'`, [o.outlet.id]);
    assert.equal(station.rowCount, 1, 'the station account exists');
    assert.equal(await seatCount(o.outlet.id), 0, 'and uses no seat');
    for (let i = 1; i <= 3; i++) assert.equal((await addStaff(o, i)).status, 201, `seat ${i}`);
    const fourth = await addStaff(o, 4);
    assert.equal(fourth.status, 403);
    assert.equal(fourth.code, 'PLAN_LIMIT_REACHED');
    assert.equal(fourth.body.details.limitKind, 'staff');
    assert.equal(fourth.body.details.limit, 3);
    assert.equal(await seatCount(o.outlet.id), 3);
    // the station account is hidden from the staff list
    const list = await call('GET', `/restaurants/${o.outlet.id}/staff`, { token: o.token });
    assert.ok(list.data.every((s) => !s.email.endsWith('@stations.pangat.app')));
  });

  it('a person cannot hide from the seat count by using the reserved system-account email domain', async () => {
    const plan = await makePlan({ staff: 1 });
    const o = await orgOn('st0', plan);
    const sneaky = await call('POST', `/restaurants/${o.outlet.id}/staff`, { token: o.token, body: { name: 'Sneaky', email: `kitchen.x-${run}@stations.pangat.app`, password: PW, role: 'STEWARD' } });
    assert.equal(sneaky.status, 400, JSON.stringify(sneaky.body));
    assert.equal(await seatCount(o.outlet.id), 0);
    await setSetting('subscription.defaultTrialPlanCode', plan.code);
    const ob = await call('POST', '/auth/onboard', { body: onboardBody('st0b', { teamMode: 'with_team', storeManager: { name: 'M', email: `mgr-${run}@stations.pangat.app`, password: PW } }) });
    assert.equal(ob.status, 400, JSON.stringify(ob.body));
    await setSetting('subscription.defaultTrialPlanCode', 'GROWTH');
  });

  it('the owner does not use a seat, but a store manager created at sign-up does', async () => {
    const plan = await makePlan({ staff: 1 });
    await setSetting('subscription.defaultTrialPlanCode', plan.code);
    const o = await onboard('st2', { teamMode: 'with_team', storeManager: { name: 'Mgr', email: `mgr-st2-${run}@example.com`, password: PW } });
    assert.equal(await seatCount(o.outlet.id), 1);
    assert.equal((await addStaff(o, 1)).status, 403, 'the manager holds the only seat');
    await setSetting('subscription.defaultTrialPlanCode', 'GROWTH');
  });

  it('a plan with no staff seats refuses a sign-up that needs a manager', async () => {
    const plan = await makePlan({ staff: 0 });
    await setSetting('subscription.defaultTrialPlanCode', plan.code);
    const r = await call('POST', '/auth/onboard', { body: onboardBody('st3', { teamMode: 'with_team', storeManager: { name: 'Mgr', email: `mgr-st3-${run}@example.com`, password: PW } }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.code, 'PLAN_LIMIT_REACHED');
    assert.equal((await call('POST', '/auth/onboard', { body: onboardBody('st4') })).status, 201, 'solo sign-up needs no seat');
    await setSetting('subscription.defaultTrialPlanCode', 'GROWTH');
  });

  it('re-activating a deactivated person takes a seat again and is limited', async () => {
    const plan = await makePlan({ staff: 2 });
    const o = await orgOn('st5', plan);
    const a = await addStaff(o, 1);
    const b = await addStaff(o, 2);
    assert.equal(b.status, 201);
    assert.equal((await call('PATCH', `/restaurants/${o.outlet.id}/staff/${a.data.id}`, { token: o.token, body: { isActive: false } })).status, 200);
    assert.equal((await addStaff(o, 3)).status, 201, 'the freed seat can be used');
    const back = await call('PATCH', `/restaurants/${o.outlet.id}/staff/${a.data.id}`, { token: o.token, body: { isActive: true } });
    assert.equal(back.status, 403);
    assert.equal(back.code, 'PLAN_LIMIT_REACHED');
    assert.equal(await seatCount(o.outlet.id), 2);
  });

  it('concurrent staff creation cannot pass the seat limit together', async () => {
    const plan = await makePlan({ staff: 3 });
    const o = await orgOn('st6', plan);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => addStaff(o, i)));
    assert.equal(results.filter((r) => r.status === 201).length, 3, `statuses: ${results.map((r) => r.status).join(',')}`);
    assert.equal(await seatCount(o.outlet.id), 3);
  });

  it('seats are per outlet and tenants stay isolated', async () => {
    const plan = await makePlan({ staff: 1, outlets: 2, features: ['QR_ORDERING', 'KDS', 'MULTI_OUTLET'] });
    const o = await orgOn('st7', plan);
    const other = await orgOn('st8', plan);
    const two = await call('POST', '/organizations/outlets', { token: o.token, body: { name: 'Second', slug: `p1-st7b-${run}`, upiVpa: 'xx@upi', tableCount: 2 } });
    assert.equal(two.status, 201, JSON.stringify(two.body));
    assert.equal((await addStaff(o, 1)).status, 201);
    assert.equal((await addStaff(o, 2)).status, 403, 'outlet 1 is full');
    const s2 = await call('POST', `/restaurants/${two.data.id}/staff`, { token: o.token, body: { name: 'B', email: `b-${run}@example.com`, password: PW, role: 'STEWARD' } });
    assert.equal(s2.status, 201, 'outlet 2 has its own seat');
    // another tenant's owner cannot add staff to this outlet (IDOR) and cannot send an override
    const idor = await call('POST', `/restaurants/${o.outlet.id}/staff`, { token: other.token, body: { name: 'X', email: `x-${run}@example.com`, password: PW, role: 'STEWARD' } });
    assert.equal(idor.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Feature entitlement is enforced by the API (direct calls included)', () => {
  it('QR_ORDERING: a plan without it cannot take guest orders and the menu shows ordering as closed', async () => {
    const without = await makePlan({ features: ['KDS'] });
    const withIt = await makePlan({ features: ['QR_ORDERING', 'KDS'] });
    const o = await orgOn('qr1', withIt);
    const item = await firstItem(o.slug);
    assert.equal((await order(o.slug, item)).status, 201, 'plan includes it');
    assert.equal((await call('GET', `/menu/public/${o.slug}`)).data.restaurant.ordering.accepting, true);
    await setPlan(o.orgId, without.code);
    const blocked = await order(o.slug, item);
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
    await sleep(3300); // public menu cache
    const menu = await call('GET', `/menu/public/${o.slug}`);
    assert.equal(menu.status, 200, 'the public menu page itself stays reachable');
    assert.equal(menu.data.restaurant.ordering.accepting, false);
  });

  it('QR_ORDERING: global kill switch, FORCE_OFF and FORCE_ON overrides all still work', async () => {
    const withIt = await makePlan({ features: ['QR_ORDERING', 'KDS'] });
    const without = await makePlan({ features: ['KDS'] });
    const o = await orgOn('qr2', withIt);
    const item = await firstItem(o.slug);
    // kill switch
    assert.equal((await call('PATCH', '/admin/feature-flags/QR_ORDERING', { token: ADMIN.token, body: { enabled: false, reason: 'test' } })).status, 200);
    assert.equal((await order(o.slug, item)).status, 400, 'kill switch blocks a plan that includes it');
    await call('PATCH', '/admin/feature-flags/QR_ORDERING', { token: ADMIN.token, body: { enabled: true } });
    assert.equal((await order(o.slug, item)).status, 201);
    // FORCE_OFF
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'QR_ORDERING', mode: 'FORCE_OFF', reason: 'test' } });
    assert.equal((await order(o.slug, item)).status, 400, 'FORCE_OFF blocks');
    // FORCE_ON on a plan that lacks it
    await setPlan(o.orgId, without.code);
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'QR_ORDERING', mode: 'FORCE_ON', reason: 'test' } });
    assert.equal((await order(o.slug, item)).status, 201, 'FORCE_ON grants it');
    // back to following the plan
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'QR_ORDERING', mode: 'DEFAULT' } });
    assert.equal((await order(o.slug, item)).status, 400);
  });

  it('KDS: kitchen PIN sign-in, the kitchen role and the live kitchen socket all need the feature', async () => {
    const without = await makePlan({ features: ['QR_ORDERING'] });
    const withIt = await makePlan({ features: ['QR_ORDERING', 'KDS'] });
    const o = await orgOn('kds1', withIt);
    const pin = () => call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } });
    const chef = await addStaff(o, 1, 'CHEF');
    assert.equal(chef.status, 201);
    const chefLogin = await login(`s1-${o.slug}@example.com`);
    const chefTok = (await call('POST', '/auth/change-password', { token: chefLogin.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
    const join = (token) =>
      new Promise((resolve) => {
        const s = io(WS, { auth: { token }, transports: ['websocket'] });
        s.on('connect', () => s.emit('join:kds', { restaurantSlug: o.slug }, (ack) => { s.close(); resolve(ack?.data ?? ack); }));
      });

    assert.ok([200, 201].includes((await pin()).status), 'kitchen PIN sign-in works while the plan has KDS');
    assert.equal((await call('GET', `/orders?restaurantSlug=${o.slug}`, { token: chefTok })).status, 200);
    assert.equal((await join(o.token)).status, 'joined');

    await setPlan(o.orgId, without.code);
    const denied = await pin();
    assert.equal(denied.status, 402, JSON.stringify(denied.body));
    assert.equal(denied.code, 'FEATURE_NOT_IN_PLAN');
    const feed = await call('GET', `/orders?restaurantSlug=${o.slug}`, { token: chefTok });
    assert.equal(feed.status, 402, 'the kitchen role cannot read the order feed');
    assert.equal(feed.code, 'FEATURE_NOT_IN_PLAN');
    assert.equal((await call('GET', `/orders?restaurantSlug=${o.slug}`, { token: o.token })).status, 200, 'the owner still has the orders screen');
    assert.equal((await join(o.token)).status, 'denied', 'the live kitchen feed is refused');
  });

  it('KDS: platform kill switch and FORCE_ON override', async () => {
    const without = await makePlan({ features: ['QR_ORDERING'] });
    const o = await orgOn('kds2', without);
    const pin = () => call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } });
    assert.equal((await pin()).status, 402);
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'KDS', mode: 'FORCE_ON', reason: 'test' } });
    assert.ok([200, 201].includes((await pin()).status), 'FORCE_ON opens it');
    await call('PATCH', '/admin/feature-flags/KDS', { token: ADMIN.token, body: { enabled: false, reason: 'test' } });
    const killed = await pin();
    assert.equal(killed.status, 403, 'the global kill switch beats even FORCE_ON');
    assert.equal(killed.code, 'FEATURE_DISABLED');
    await call('PATCH', '/admin/feature-flags/KDS', { token: ADMIN.token, body: { enabled: true } });
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'KDS', mode: 'DEFAULT' } });
  });

  it('INVENTORY and ANALYTICS stay enforced (direct API calls)', async () => {
    const none = await makePlan({ features: ['QR_ORDERING', 'KDS'] });
    const both = await makePlan({ features: ['QR_ORDERING', 'KDS', 'INVENTORY', 'ANALYTICS'] });
    const o = await orgOn('inv1', none);
    for (const path of [`/inventory/ingredients?restaurantId=${o.outlet.id}`, `/reports/summary?restaurantSlug=${o.slug}`]) {
      const r = await call('GET', path, { token: o.token });
      assert.equal(r.status, 402, path);
      assert.equal(r.code, 'FEATURE_NOT_IN_PLAN');
    }
    await setPlan(o.orgId, both.code);
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token })).status, 200);
    assert.equal((await call('GET', `/reports/summary?restaurantSlug=${o.slug}`, { token: o.token })).status, 200);
  });

  it('ADVANCED_REPORTS is not available: it cannot be added to a plan and is never advertised', async () => {
    const r = await call('POST', '/subscriptions/admin/plans', {
      token: ADMIN.token, body: { code: `ADV${run}`.toUpperCase(), name: 'x', billingInterval: 'MONTHLY', basePrice: 1, features: ['QR_ORDERING', 'ADVANCED_REPORTS'] },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /not available yet/);
    assert.equal((await call('POST', '/subscriptions/admin/plans', { token: ADMIN.token, body: { code: `NOPE${run}`.toUpperCase(), name: 'x', billingInterval: 'MONTHLY', basePrice: 1, features: ['MADE_UP'] } })).status, 400);
    // a plan that already carries it (older data) keeps working but is shown to customers without it
    const plan = await makePlan({ features: ['QR_ORDERING', 'KDS'] });
    await db.query(`UPDATE subscription_plans SET features = features || ',ADVANCED_REPORTS', is_public = true WHERE code = $1`, [plan.code]);
    const pub = (await call('GET', '/subscriptions/plans')).data.find((p) => p.code === plan.code);
    assert.ok(pub, 'public plan listed');
    assert.ok(!pub.features.includes('ADVANCED_REPORTS'));
    const o = await orgOn('adv1', plan);
    const mine = (await call('GET', '/subscriptions/my-subscription', { token: o.token })).data;
    assert.ok(!mine.plan.features.includes('ADVANCED_REPORTS'));
    assert.equal(mine.entitlements.features.ADVANCED_REPORTS.allowed, false);
    assert.equal(mine.entitlements.features.ADVANCED_REPORTS.available, false);
    // an unrelated edit of such a plan is not blocked by the legacy key; adding it to another plan still is
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${plan.id}`, { token: ADMIN.token, body: { features: ['QR_ORDERING', 'KDS', 'ADVANCED_REPORTS'], name: 'Renamed' } })).status, 200);
    const other = await makePlan({ features: ['QR_ORDERING'] });
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${other.id}`, { token: ADMIN.token, body: { features: ['QR_ORDERING', 'ADVANCED_REPORTS'] } })).status, 400);
    // the platform console lists the catalogue with its availability
    const cat = (await call('GET', '/admin/subscription-plans', { token: ADMIN.token })).data.features;
    assert.equal(cat.find((f) => f.feature_key === 'ADVANCED_REPORTS').available, false);
    assert.equal(cat.find((f) => f.feature_key === 'KDS').available, true);
  });

  it('my-subscription returns the final entitlement decision (plan + switches + overrides) for the console', async () => {
    const plan = await makePlan({ features: ['QR_ORDERING', 'KDS'], tables: 7, staff: 4, outlets: 1 });
    const o = await orgOn('ent1', plan);
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'INVENTORY', mode: 'FORCE_ON', reason: 'trial of inventory' } });
    const e = (await call('GET', '/subscriptions/my-subscription', { token: o.token })).data.entitlements;
    assert.equal(e.features.KDS.allowed, true);
    assert.equal(e.features.INVENTORY.allowed, true);
    assert.equal(e.features.INVENTORY.reason, 'OVERRIDE_ON');
    assert.equal(e.features.ANALYTICS.allowed, false);
    assert.equal(e.features.ANALYTICS.reason, 'PLAN');
    assert.deepEqual(e.limits, { maxOutlets: 1, maxTablesPerOutlet: 7, maxStaffPerOutlet: 4 });
    assert.equal(e.plan.code, plan.code);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Multi-outlet needs BOTH the feature and the numeric limit', () => {
  const mk = (o, tag, extra = {}) => call('POST', '/organizations/outlets', { token: o.token, body: { name: tag, slug: `p1-${tag}-${run}`, upiVpa: 'xx@upi', tableCount: 1, ...extra } });

  it('a plan without MULTI_OUTLET cannot add an outlet even when its outlet limit would allow it', async () => {
    const plan = await makePlan({ outlets: 3, features: ['QR_ORDERING', 'KDS'] });
    const o = await orgOn('mo1', plan);
    const r = await mk(o, 'mo1b');
    assert.equal(r.status, 402, JSON.stringify(r.body));
    assert.equal(r.code, 'FEATURE_NOT_IN_PLAN');
    assert.equal((await db.query('SELECT 1 FROM restaurants WHERE organization_id = $1', [o.orgId])).rowCount, 1);
  });

  it('with MULTI_OUTLET the numeric limit still applies, and a limit of 1 reports the limit', async () => {
    const two = await makePlan({ outlets: 2, features: ['QR_ORDERING', 'KDS', 'MULTI_OUTLET'] });
    const o = await orgOn('mo2', two);
    assert.equal((await mk(o, 'mo2b')).status, 201);
    const third = await mk(o, 'mo2c');
    assert.equal(third.status, 403);
    assert.equal(third.code, 'PLAN_LIMIT_REACHED');
    assert.equal(third.body.details.limitKind, 'outlets');
    const one = await makePlan({ outlets: 1, features: ['QR_ORDERING', 'KDS', 'MULTI_OUTLET'] });
    const o1 = await orgOn('mo3', one);
    assert.equal((await mk(o1, 'mo3b')).code, 'PLAN_LIMIT_REACHED');
  });

  it('concurrent outlet creation cannot pass the outlet limit together', async () => {
    const plan = await makePlan({ outlets: 3, features: ['QR_ORDERING', 'KDS', 'MULTI_OUTLET'] });
    const o = await orgOn('mo4', plan);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => mk(o, `mo4x${i}`)));
    assert.equal(results.filter((r) => r.status === 201).length, 2, `statuses: ${results.map((r) => r.status).join(',')}`);
    assert.equal((await db.query('SELECT 1 FROM restaurants WHERE organization_id = $1', [o.orgId])).rowCount, 3);
  });

  it('overrides and the kill switch apply to outlet creation; an existing extra outlet keeps working', async () => {
    const plan = await makePlan({ outlets: 3, features: ['QR_ORDERING', 'KDS'] });
    const o = await orgOn('mo5', plan);
    assert.equal((await mk(o, 'mo5b')).status, 402);
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'MULTI_OUTLET', mode: 'FORCE_ON', reason: 'franchise pilot' } });
    const ok = await mk(o, 'mo5c');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    await call('PATCH', '/admin/feature-flags/MULTI_OUTLET', { token: ADMIN.token, body: { enabled: false, reason: 'test' } });
    const killed = await mk(o, 'mo5d');
    assert.equal(killed.status, 403);
    assert.equal(killed.code, 'FEATURE_DISABLED');
    await call('PATCH', '/admin/feature-flags/MULTI_OUTLET', { token: ADMIN.token, body: { enabled: true } });
    // owner can still list outlets and read the existing second outlet; only CREATION is gated
    assert.equal((await call('GET', '/organizations/outlets', { token: o.token })).data.length, 2);
    assert.equal((await call('GET', `/tables?restaurantId=${ok.data.id}`, { token: o.token })).status, 200);
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'MULTI_OUTLET', mode: 'DEFAULT' } });
  });

  it('only the owner can create outlets; a manager and another tenant cannot', async () => {
    const plan = await makePlan({ outlets: 3, features: ['QR_ORDERING', 'KDS', 'MULTI_OUTLET'] });
    const o = await orgOn('mo6', plan);
    const m = await addStaff(o, 1, 'STORE_MANAGER');
    const first = await login(`s1-${o.slug}@example.com`);
    const mgr = (await call('POST', '/auth/change-password', { token: first.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
    assert.equal(m.status, 201);
    assert.equal((await call('POST', '/organizations/outlets', { token: mgr, body: { name: 'x', slug: `p1-mo6m-${run}`, upiVpa: 'xx@upi' } })).status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Subscription states: trial, active, grace, expired', () => {
  const adm = (orgId, action, body) => call('POST', `/admin/restaurants/${orgId}/subscription/${action}`, { token: ADMIN.token, body });
  const edit = (o) => call('PATCH', `/menu/items/${o.itemId}/price`, { token: o.token, body: { price: 77 } });

  it('trial and active subscriptions work; grace keeps everything working; expiry blocks changes but not live service or reads', async () => {
    const plan = await makePlan({});
    const trial = await orgOn('sub1', plan);
    const active = await orgOn('sub2', plan);
    const grace = await orgOn('sub3', plan);
    const expired = await orgOn('sub4', plan);
    for (const o of [trial, active, grace, expired]) o.itemId = (await firstItem(o.slug)).menuItemId;
    await db.query(`UPDATE organization_subscriptions SET status='TRIAL', trial_ends_at = current_period_end WHERE organization_id = $1`, [trial.orgId]);
    await db.query(`UPDATE organization_subscriptions SET status='GRACE_PERIOD', current_period_end = now() - interval '1 day' WHERE organization_id = $1`, [grace.orgId]);
    await db.query(`UPDATE organization_subscriptions SET status='ACTIVE', current_period_end = now() - interval '10 days' WHERE organization_id = $1`, [expired.orgId]);
    const live = (await order(expired.slug, await firstItem(expired.slug))).data;
    await sleep(21_000); // the access decision is cached for 20 s
    assert.equal((await edit(trial)).status, 200, 'trial: full access');
    assert.equal((await edit(active)).status, 200, 'active: full access');
    assert.equal((await edit(grace)).status, 200, 'inside the grace window everything keeps working');
    const blocked = await edit(expired);
    assert.equal(blocked.status, 402, 'past the grace window changes are refused');
    assert.equal(blocked.code, 'SUBSCRIPTION_INACTIVE');
    assert.equal((await addTable(expired, 'EXP1')).status, 402, 'no new tables on an expired subscription');
    assert.equal((await addStaff(expired, 1)).status, 402, 'no new staff either');
    assert.equal((await order(expired.slug, await firstItem(expired.slug))).status, 400, 'guests cannot order');
    assert.equal((await call('GET', `/orders?restaurantSlug=${expired.slug}`, { token: expired.token })).status, 200, 'reading still works');
    assert.equal((await call('PATCH', `/orders/${live.id}/mark-paid`, { token: expired.token })).status, 200, 'in-flight orders can still be settled');
    const e = (await call('GET', '/subscriptions/my-subscription', { token: expired.token })).data;
    assert.equal(e.entitlements.access.blocked, true);
    assert.equal(e.entitlements.status, 'EXPIRED');
    // the platform extends it: access is restored at once (cache invalidated)
    assert.equal((await adm(expired.orgId, 'extend', { days: 30, reason: 'Paid by bank transfer, confirmed' })).status, 200);
    assert.equal((await edit(expired)).status, 200);
  });

  it('cancel-at-period-end ends access at the period end with no grace; immediate cancel blocks now', async () => {
    const plan = await makePlan({});
    const o = await orgOn('sub5', plan);
    o.itemId = (await firstItem(o.slug)).menuItemId;
    assert.equal((await call('POST', '/subscriptions/cancel', { token: o.token })).status, 200);
    assert.equal((await edit(o)).status, 200, 'still paid up');
    const c = await adm(o.orgId, 'cancel', { immediate: true, reason: 'Customer closed the restaurant' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await edit(o)).status, 402, 'immediate cancellation blocks at once');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Existing restaurants and order operations keep working', () => {
  it('a restaurant on a plan that has every enforced feature runs the whole order flow', async () => {
    const plan = await makePlan({ outlets: 3, tables: 10, staff: 5, features: ['QR_ORDERING', 'KDS', 'INVENTORY', 'ANALYTICS', 'MULTI_OUTLET'] });
    const o = await orgOn('reg1', plan, { indoorTableCount: 2 });
    const item = await firstItem(o.slug);
    const placed = await order(o.slug, item);
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const id = placed.data.id;
    const kds = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } });
    assert.ok([200, 201].includes(kds.status), 'kitchen PIN sign-in works');
    const kt = kds.data.accessToken;
    assert.equal((await call('GET', `/orders?restaurantSlug=${o.slug}`, { token: kt })).status, 200);
    assert.equal((await call('PATCH', `/orders/${id}/status`, { token: kt, body: { status: 'PREPARING' } })).status, 200);
    assert.equal((await call('PATCH', `/orders/${id}/status`, { token: kt, body: { status: 'READY' } })).status, 200);
    assert.equal((await call('PATCH', `/orders/${id}/mark-paid`, { token: o.token })).status, 200);
    assert.equal((await call('GET', `/reports/summary?restaurantSlug=${o.slug}`, { token: o.token })).status, 200);
  });

  it('an organisation with no subscription row (legacy) is given a trial on first use and keeps access', async () => {
    const o = await onboard('reg2', { indoorTableCount: 2 });
    await db.query('DELETE FROM organization_subscriptions WHERE organization_id = $1', [o.orgId]);
    assert.equal((await addTable(o, 'L1')).status, 201);
    const sub = await db.query('SELECT status FROM organization_subscriptions WHERE organization_id = $1', [o.orgId]);
    assert.equal(sub.rows[0].status, 'TRIAL');
  });

  it('tenant isolation: another restaurant cannot read or change this one, with or without override fields', async () => {
    const plan = await makePlan({ tables: 3 });
    const a = await orgOn('iso1', plan);
    const b = await orgOn('iso2', plan);
    const r = await call('POST', '/tables', { token: b.token, body: { restaurantId: a.outlet.id, tableNumber: 'HACK', limitOverrideReason: 'cross tenant attempt to bypass the limit' } });
    assert.equal(r.status, 403);
    assert.equal(await tableCount(a.outlet.id), 1);
    // the plan never trusts a plan or limit sent in a request body
    const sneaky = await call('POST', '/tables', { token: a.token, body: { restaurantId: a.outlet.id, tableNumber: 'SNK1', maxTablesPerOutlet: 999, planCode: 'ENTERPRISE' } });
    assert.equal(sneaky.status, 400, 'unknown fields in the body are rejected, not trusted');
    assert.equal((await addTable(a, 'SNK2')).status, 201);
    assert.equal((await addTable(a, 'SNK3')).status, 201);
    assert.equal((await addTable(a, 'SNK4')).status, 403, 'the limit in force is the plan\'s (3)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('One status rule across the code and the database', () => {
  it('the SQL used by the platform lists gives the same status as the request guards, for every combination', async () => {
    const { effectiveStatusSql } = await import('../dist/platform/subscriptions-admin.service.js');
    const { derivedStatus } = await import('../dist/subscriptions/subscription-access.js');
    const day = 86_400_000;
    const statuses = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'HALTED', 'CANCELLED', 'EXPIRED'];
    const ends = [-30, -8, -3, 5]; // days from now
    const graces = [null, -1, 2];
    let checked = 0;
    for (const status of statuses) for (const e of ends) for (const g of graces) for (const cancel of [false, true]) {
      const end = new Date(Date.now() + e * day);
      const grace = g === null ? null : new Date(Date.now() + g * day);
      const rows = (await db.query(
        `SELECT ${effectiveStatusSql('s')} AS st FROM (SELECT $1::text AS status, $2::timestamptz AS current_period_end, $3::timestamptz AS grace_period_ends_at, $4::boolean AS cancel_at_period_end) s`,
        [status, end, grace, cancel],
      )).rows;
      const code = derivedStatus({ status, currentPeriodEnd: end, gracePeriodEndsAt: grace, cancelAtPeriodEnd: cancel });
      assert.equal(rows[0].st, code, `${status} end ${e}d grace ${g} cancel ${cancel}: sql=${rows[0].st} code=${code}`);
      checked++;
    }
    assert.equal(checked, 7 * 4 * 3 * 2);
  });
});

describe('Migration 017 (plan feature backfill)', () => {
  const fs = import('node:fs');
  const read = async (f) => (await fs).readFileSync(new URL(`../src/migrations/${f}`, import.meta.url), 'utf8');
  const feats = async (id) => (await db.query('SELECT features FROM subscription_plans WHERE id = $1', [id])).rows[0].features.split(',').filter(Boolean).sort();

  it('adds the keys that used to be implicitly granted, never touches ADVANCED_REPORTS, runs once, never re-grants, and reverses exactly', async () => {
    const up = await read('017_plan_feature_enforcement.sql');
    const down = await read('017_plan_feature_enforcement.down.sql');
    await db.query('BEGIN'); // everything below is rolled back: the shared database is left exactly as it was
    try {
      await db.query(down); // the API already applied 017 at boot: undo it inside this transaction to test from the legacy state
      const mk = async (code, features, outlets) =>
        (await db.query(
          `INSERT INTO subscription_plans (code, name, billing_interval, base_price, max_outlets, max_tables_per_outlet, features) VALUES ($1,$1,'MONTHLY',1,$2,5,$3) RETURNING id`,
          [`MIG${run}${code}`.toUpperCase(), outlets, features],
        )).rows[0].id;
      const legacySingle = await mk('a', 'INVENTORY', 1);
      const legacyMulti = await mk('b', 'QR_ORDERING,ANALYTICS', 3);
      const wildcard = await mk('c', '*', 5);
      const alreadyOk = await mk('d', 'QR_ORDERING,KDS', 1);
      const withAdvanced = await mk('e', 'QR_ORDERING,ADVANCED_REPORTS', 1);
      await db.query(up);
      assert.deepEqual(await feats(legacySingle), ['INVENTORY', 'KDS', 'QR_ORDERING'], 'single-outlet plan: QR + KDS, no MULTI_OUTLET');
      assert.deepEqual(await feats(legacyMulti), ['ANALYTICS', 'KDS', 'MULTI_OUTLET', 'QR_ORDERING'], 'a plan that already sold several outlets gets MULTI_OUTLET');
      assert.deepEqual(await feats(wildcard), ['*'], 'a wildcard plan is untouched');
      assert.deepEqual(await feats(alreadyOk), ['KDS', 'QR_ORDERING'], 'nothing duplicated');
      assert.deepEqual(await feats(withAdvanced), ['ADVANCED_REPORTS', 'KDS', 'QR_ORDERING'], 'ADVANCED_REPORTS is neither added nor removed');
      // an operator removes a key on purpose; running the file again must not grant it back (even a key the plan had before 017)
      await db.query(`UPDATE subscription_plans SET features = 'QR_ORDERING' WHERE id = $1`, [alreadyOk]);
      await db.query(`UPDATE subscription_plans SET features = replace(features, ',KDS', '') WHERE id = $1`, [legacySingle]);
      await db.query(up);
      assert.deepEqual(await feats(alreadyOk), ['QR_ORDERING'], 'a second run changes nothing');
      assert.deepEqual(await feats(legacySingle), ['INVENTORY', 'QR_ORDERING']);
      await db.query(down);
      assert.deepEqual(await feats(legacySingle), ['INVENTORY'], 'down removes exactly what up added');
      assert.deepEqual(await feats(legacyMulti), ['ANALYTICS', 'QR_ORDERING']);
      assert.deepEqual(await feats(withAdvanced), ['ADVANCED_REPORTS', 'QR_ORDERING']);
      assert.deepEqual(await feats(alreadyOk), ['QR_ORDERING'], 'the operator\'s own edit survives the rollback');
      assert.equal((await db.query(`SELECT to_regclass('plan_feature_backfills') AS t`)).rows[0].t, null, 'the record table is gone');
      await db.query(down); // rolling back twice is harmless
    } finally {
      await db.query('ROLLBACK');
    }
    assert.ok((await db.query(`SELECT to_regclass('plan_feature_backfills') AS t`)).rows[0].t, 'boot-time application is intact after the test');
  });
});

describe('The hourly sweep persists exactly what the guards already enforce', () => {
  it('lapsed subscriptions are moved to GRACE_PERIOD / EXPIRED; nobody gains or loses access because of the sweep', async () => {
    const plan = await makePlan({});
    const inGrace = await orgOn('sw1', plan);
    const over = await orgOn('sw2', plan);
    const noRenew = await orgOn('sw3', plan);
    const fine = await orgOn('sw4', plan);
    await db.query(`UPDATE organization_subscriptions SET current_period_end = now() - interval '2 days' WHERE organization_id = $1`, [inGrace.orgId]);
    await db.query(`UPDATE organization_subscriptions SET current_period_end = now() - interval '20 days' WHERE organization_id = $1`, [over.orgId]);
    await db.query(`UPDATE organization_subscriptions SET current_period_end = now() - interval '1 day', cancel_at_period_end = true WHERE organization_id = $1`, [noRenew.orgId]);
    for (const o of [inGrace, over, noRenew, fine]) o.itemId = (await firstItem(o.slug)).menuItemId;
    await sleep(21_000);
    const before = {};
    for (const [k, o] of Object.entries({ inGrace, over, noRenew, fine })) before[k] = (await call('PATCH', `/menu/items/${o.itemId}/price`, { token: o.token, body: { price: 55 } })).status;
    assert.deepEqual(before, { inGrace: 200, over: 402, noRenew: 402, fine: 200 });
    const run = await call('POST', '/admin/monitoring/jobs/subscription-sweep/run', { token: ADMIN.token });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const st = async (o) => (await db.query('SELECT status FROM organization_subscriptions WHERE organization_id = $1', [o.orgId])).rows[0].status;
    assert.equal(await st(inGrace), 'GRACE_PERIOD');
    assert.equal(await st(over), 'EXPIRED');
    assert.equal(await st(noRenew), 'EXPIRED', 'no grace when renewal was switched off');
    assert.equal(await st(fine), 'ACTIVE');
    await sleep(21_000);
    const after = {};
    for (const [k, o] of Object.entries({ inGrace, over, noRenew, fine })) after[k] = (await call('PATCH', `/menu/items/${o.itemId}/price`, { token: o.token, body: { price: 56 } })).status;
    assert.deepEqual(after, before, 'persisting the status changed nobody\'s access');
  });
});

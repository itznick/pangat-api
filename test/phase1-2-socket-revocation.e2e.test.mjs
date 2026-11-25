/**
 * Phase 1.2 live tests: live kitchen feed revocation.
 * Start the API with a short re-check interval so the safety-net tests are quick, and tell the tests the same value:
 *
 *   SOCKET_REVALIDATE_MS=1500 DATABASE_URL=... THROTTLE_DISABLED=true PORT=4000 node dist/main &
 *   SOCKET_REVALIDATE_MS=1500 npm run test:phase1_2
 *
 * Without SOCKET_REVALIDATE_MS in the test environment the tests that depend on the periodic safety net are skipped (and reported as skipped).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { io } from 'socket.io-client';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const WS = API.replace(/\/api\/v1$/, '');
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const PERIODIC = Number(process.env.SOCKET_REVALIDATE_MS) > 0 && Number(process.env.SOCKET_REVALIDATE_MS) <= 3000;
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const PW2 = 'Tulsi-Wada-Pune-42';
const db = new pg.Client({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, code: json?.code };
}
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });
const idem = () => `idem-${crypto.randomBytes(8).toString('hex')}`;
let ADMIN; let n = 0; const plans = [];
async function makePlan(features) {
  const code = `SK${run}${(n++).toString(36)}`.toUpperCase();
  const r = await call('POST', '/subscriptions/admin/plans', { token: ADMIN, body: { code, name: `Sock ${code}`, billingInterval: 'MONTHLY', basePrice: 1, maxOutlets: 1, maxTablesPerOutlet: 10, maxStaffPerOutlet: 10, features, trialDays: 30, isPublic: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  plans.push(code);
  return code;
}
const setPlanDb = (orgId, code) => db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code=$2),status='ACTIVE',current_period_end=now()+interval '30 days',grace_period_ends_at=NULL,cancel_at_period_end=false WHERE organization_id=$1`, [orgId, code]);
async function tenant(tag, planCode) {
  const slug = `sk-${tag}-${run}`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `B ${tag}`, ownerFullName: 'O', mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW, outletName: `O ${tag}`, slug, upiVpa: 'shop@upi', gstPercentage: 5, indoorTableCount: 2, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = { slug, owner: r.data.accessToken, outletId: r.data.outlet.id, orgId: r.data.organization.id };
  await setPlanDb(o.orgId, planCode);
  const email = `chef-${tag}-${run}@example.com`;
  const c = await call('POST', `/restaurants/${o.outletId}/staff`, { token: o.owner, body: { name: 'Chef Test', email, password: PW, role: 'CHEF' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  o.chefId = c.data.id;
  const f = await login(email);
  o.chef = (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
  return o;
}
/** A live socket that records everything it receives. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(WS, { auth: { token }, transports: ['websocket'], reconnection: false });
    const rec = { socket: s, events: [], disconnected: false };
    s.onAny((name, payload) => rec.events.push({ name, payload }));
    s.on('disconnect', () => { rec.disconnected = true; });
    s.on('connect', () => resolve(rec));
    s.on('connect_error', reject);
  });
}
const join = (rec, ev, slug, extra = {}) => new Promise((resolve) => rec.socket.emit(ev, { restaurantSlug: slug, ...extra }, (ack) => resolve(ack?.data ?? ack)));
const got = (rec, name) => rec.events.filter((e) => e.name === name);
async function until(fn, ms = 6000, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; }
async function guestOrder(slug) {
  const m = (await call('GET', `/menu/public/${slug}`)).data.items[0];
  const r = await call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: { restaurantSlug: slug, orderType: 'DINE_IN', tableNumber: 'T01', customerName: 'Secret Guest', customerPhone: '9123456789', consentAccepted: true, paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: m.id, name: m.name, price: Number(m.price), quantity: 1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
const adm = (path, body, method = 'POST') => call(method, path, { token: ADMIN, body });
const sockets = [];
const open = async (token) => { const r = await connect(token); sockets.push(r.socket); return r; };

before(async () => {
  await db.connect();
  const e = `root-sk-${run}@pangat.test`;
  const { default: bcrypt } = await import('bcrypt');
  await db.query(`INSERT INTO staff (name,email,password_hash,role,is_platform_admin,platform_role) VALUES ('Root',$1,$2,'PLATFORM_SUPER_ADMIN',true,'OWNER')`, [e, await bcrypt.hash(PW, 10)]);
  ADMIN = (await login(e)).data.accessToken;
});
after(async () => {
  sockets.forEach((s) => s.close());
  for (const k of ['KDS']) await call('PATCH', `/admin/feature-flags/${k}`, { token: ADMIN, body: { enabled: true } });
  await db.query('UPDATE subscription_plans SET is_active=false WHERE code = ANY($1)', [plans]);
  await db.end();
});

describe('A kitchen user cannot see more than the kitchen may', () => {
  it('a CHEF cannot join the admin room or an order room, and only ever receives redacted events', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const o = await tenant('red', withKds);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    assert.equal((await join(chef, 'join:admin', o.slug)).status, 'denied', 'no admin room for the kitchen role');
    const order = await guestOrder(o.slug);
    assert.equal((await join(chef, 'join:order', o.slug, { orderId: order.id })).status, 'denied', 'no order room either (it carries the full order)');
    assert.ok(await until(() => got(chef, 'order:new').length > 0), 'the kitchen still gets its ticket');
    const payload = JSON.stringify(got(chef, 'order:new')[0].payload);
    assert.doesNotMatch(payload, /Secret Guest|9123456789|customerPhone|totalAmount|gstAmount|trackingToken/, 'no customer details, amounts or tokens');
    // the owner's order screen is unaffected: owner joins the admin room and sees the full order
    const owner = await open(o.owner);
    assert.equal((await join(owner, 'join:admin', o.slug)).status, 'joined');
    await guestOrder(o.slug);
    assert.ok(await until(() => got(owner, 'order:new').length > 0));
    assert.match(JSON.stringify(got(owner, 'order:new')[0].payload), /Secret Guest/);
  });
});

describe('Live kitchen connections lose access when the entitlement changes', () => {
  it('KDS removed from the plan while a CHEF is connected (console plan change): revoked at once, owner screen untouched', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const without = await makePlan(['QR_ORDERING']);
    const o = await tenant('plan', withKds);
    const chef = await open(o.chef);
    const ownerKds = await open(o.owner); // the owner may also have the KDS page open
    const ownerAdmin = ownerKds;
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    assert.equal((await join(ownerKds, 'join:kds', o.slug)).status, 'joined');
    assert.equal((await join(ownerAdmin, 'join:admin', o.slug)).status, 'joined');
    await guestOrder(o.slug);
    assert.ok(await until(() => got(chef, 'order:new').length === 1));
    const ch = await adm(`/admin/restaurants/${o.orgId}/subscription/change-plan`, { planCode: without, reason: 'KDS removed for this test' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0 && chef.disconnected), 'the kitchen session is told and cut off');
    assert.equal(got(chef, 'access:revoked')[0].payload.feature, 'KDS');
    const before = got(chef, 'order:new').length;
    await guestOrder(o.slug);
    await sleep(800);
    assert.equal(got(chef, 'order:new').length, before, 'no further tickets reach the revoked kitchen session');
    // the owner stays connected, loses only the kitchen room, keeps the admin room
    assert.ok(await until(() => got(ownerKds, 'access:revoked').length > 0));
    assert.equal(ownerKds.disconnected, false, 'an owner session is not disconnected');
    const ownerBefore = got(ownerAdmin, 'order:new').length;
    await guestOrder(o.slug);
    assert.ok(await until(() => got(ownerAdmin, 'order:new').length > ownerBefore), 'the owner still receives orders in the admin room');
  });

  it('subscription expiry while a CHEF is connected: kitchen feed revoked; a new kitchen sign-in and join are refused', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const o = await tenant('exp', withKds);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    const c = await adm(`/admin/restaurants/${o.orgId}/subscription/cancel`, { immediate: true, reason: 'Subscription lapsed for the revocation test' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0), 'revoked');
    assert.equal(got(chef, 'access:revoked')[0].payload.reason, 'SUBSCRIPTION');
    const pin = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } });
    assert.equal(pin.status, 402, 'no new kitchen session on a lapsed subscription');
    const again = await open(o.chef);
    assert.equal((await join(again, 'join:kds', o.slug)).reason, 'subscription_inactive');
    // restored by the platform: the kitchen can reconnect
    assert.equal((await adm(`/admin/restaurants/${o.orgId}/subscription/extend`, { days: 30, reason: 'Paid, restoring the kitchen' })).status, 200);
    const back = await open(o.chef);
    assert.equal((await join(back, 'join:kds', o.slug)).status, 'joined', 'KDS restored: reconnect works');
    await guestOrder(o.slug);
    assert.ok(await until(() => got(back, 'order:new').length > 0), 'and the restored session receives tickets');
  });

  it('global KDS kill switch while a CHEF is connected: revoked; restored switch lets the kitchen reconnect', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const o = await tenant('kill', withKds);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    assert.equal((await adm('/admin/feature-flags/KDS', { enabled: false, reason: 'incident drill' }, 'PATCH')).status, 200);
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0 && chef.disconnected));
    assert.equal(got(chef, 'access:revoked')[0].payload.reason, 'DISABLED');
    const denied = await open(o.chef);
    assert.equal((await join(denied, 'join:kds', o.slug)).status, 'denied');
    assert.equal((await adm('/admin/feature-flags/KDS', { enabled: true }, 'PATCH')).status, 200);
    const back = await open(o.chef);
    assert.equal((await join(back, 'join:kds', o.slug)).status, 'joined', 'switch restored: reconnect works');
  });

  it('organisation override changed while connected: FORCE_OFF revokes; FORCE_ON grants a plan that lacks KDS; back to default follows the plan', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const without = await makePlan(['QR_ORDERING']);
    const o = await tenant('ovr', withKds);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    await adm(`/admin/restaurants/${o.orgId}/feature-overrides`, { feature: 'KDS', mode: 'FORCE_OFF', reason: 'test' });
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0));
    assert.equal(got(chef, 'access:revoked')[0].payload.reason, 'OVERRIDE_OFF');
    await adm(`/admin/restaurants/${o.orgId}/feature-overrides`, { feature: 'KDS', mode: 'DEFAULT' });
    await setPlanDb(o.orgId, without);
    const denied = await open(o.chef);
    assert.equal((await join(denied, 'join:kds', o.slug)).status, 'denied', 'the plan lacks KDS');
    await adm(`/admin/restaurants/${o.orgId}/feature-overrides`, { feature: 'KDS', mode: 'FORCE_ON', reason: 'pilot' });
    const granted = await open(o.chef);
    assert.equal((await join(granted, 'join:kds', o.slug)).status, 'joined', 'FORCE_ON grants it');
    await adm(`/admin/restaurants/${o.orgId}/feature-overrides`, { feature: 'KDS', mode: 'DEFAULT', reason: 'pilot over' });
    assert.ok(await until(() => got(granted, 'access:revoked').length > 0), 'dropping the override revokes the session that depended on it');
  });

  it('editing a plan that many restaurants share revokes the affected sessions', async () => {
    const shared = await makePlan(['QR_ORDERING', 'KDS']);
    const o = await tenant('shr', shared);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    const id = (await db.query('SELECT id FROM subscription_plans WHERE code=$1', [shared])).rows[0].id;
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN, body: { features: ['QR_ORDERING'] } })).status, 200);
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0 && chef.disconnected));
  });
});

describe('Safety net: changes nobody announced (periodic re-check)', { skip: !PERIODIC && 'set SOCKET_REVALIDATE_MS (<= 3000) for the API and for this run' }, () => {
  it('a plan changed directly in the database is picked up by the periodic re-check', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const without = await makePlan(['QR_ORDERING']);
    const o = await tenant('db', withKds);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    await setPlanDb(o.orgId, without);
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0, 12_000), 'revoked by the periodic re-check');
  });

  it('a deactivated kitchen account loses the feed', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const o = await tenant('acct', withKds);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    assert.equal((await call('PATCH', `/restaurants/${o.outletId}/staff/${o.chefId}`, { token: o.owner, body: { isActive: false } })).status, 200);
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0, 12_000));
    assert.equal(got(chef, 'access:revoked')[0].payload.reason, 'ACCOUNT');
  });

  it('a subscription that simply ends (no admin action) is detected', async () => {
    const withKds = await makePlan(['QR_ORDERING', 'KDS']);
    const o = await tenant('end', withKds);
    const chef = await open(o.chef);
    assert.equal((await join(chef, 'join:kds', o.slug)).status, 'joined');
    await db.query(`UPDATE organization_subscriptions SET status='ACTIVE', current_period_end = now() - interval '30 days' WHERE organization_id = $1`, [o.orgId]);
    // the access decision is cached for up to 20 s by design; the periodic pass picks the change up after that
    assert.ok(await until(() => got(chef, 'access:revoked').length > 0, 40_000, 500), 'revoked after the access cache expires');
  });
});

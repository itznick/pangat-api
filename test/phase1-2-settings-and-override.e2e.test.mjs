/**
 * Phase 1.2 live tests: (1) outlet settings saves versus concurrent table changes and other saves; (2) the audit record of a limit override.
 * Needs a running API on a throwaway database.   npm run test:phase1_2
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
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, code: json?.code };
}
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });
let ADMIN; let n = 0; const plans = [];
async function plan(tables) {
  const code = `ST${run}${(n++).toString(36)}`.toUpperCase();
  const r = await call('POST', '/subscriptions/admin/plans', { token: ADMIN, body: { code, name: code, billingInterval: 'MONTHLY', basePrice: 1, maxOutlets: 1, maxTablesPerOutlet: tables, maxStaffPerOutlet: 5, features: ['QR_ORDERING', 'KDS'], trialDays: 30, isPublic: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  plans.push(code);
  return code;
}
async function tenant(tag, code, tables = 1) {
  const slug = `st-${tag}-${run}`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `B ${tag}`, ownerFullName: 'O', mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW, outletName: `O ${tag}`, slug, upiVpa: 'shop@upi', gstPercentage: 5, indoorTableCount: tables, outdoorTableCount: 0, menuPreset: 'blank', teamMode: 'solo' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code=$2),status='ACTIVE',current_period_end=now()+interval '30 days' WHERE organization_id=$1`, [r.data.organization.id, code]);
  return { slug, token: r.data.accessToken, outletId: r.data.outlet.id, orgId: r.data.organization.id };
}
const tableCount = async (id) => Number((await db.query('SELECT COUNT(*) FROM tables WHERE restaurant_id=$1', [id])).rows[0].count);
const outletRow = async (id) => (await db.query('SELECT * FROM restaurants WHERE id=$1', [id])).rows[0];

before(async () => {
  await db.connect();
  const e = `root-st-${run}@pangat.test`;
  const { default: bcrypt } = await import('bcrypt');
  await db.query(`INSERT INTO staff (name,email,password_hash,role,is_platform_admin,platform_role) VALUES ('Root',$1,$2,'PLATFORM_SUPER_ADMIN',true,'OWNER')`, [e, await bcrypt.hash(PW, 10)]);
  ADMIN = (await login(e)).data.accessToken;
});
after(async () => { await db.query('UPDATE subscription_plans SET is_active=false WHERE code = ANY($1)', [plans]); await db.end(); });

describe('Saving outlet settings never disturbs tables or other fields', () => {
  it('the original failure: settings saves racing with table creation lose and duplicate nothing', async () => {
    const o = await tenant('race', await plan(-1));
    const adds = Array.from({ length: 30 }, (_, i) => call('POST', '/tables', { token: o.token, body: { restaurantId: o.outletId, tableNumber: `R${i}` } }));
    const saves = Array.from({ length: 30 }, (_, i) => call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { gstPercentage: 5 + (i % 4) } }));
    const res = await Promise.all([...adds, ...saves]);
    assert.equal(res.filter((r) => r.status >= 500).length, 0, JSON.stringify(res.filter((r) => r.status >= 500).map((r) => r.body?.message)));
    assert.equal(res.slice(0, 30).filter((r) => r.status === 201).length, 30);
    assert.equal(await tableCount(o.outletId), 31, 'every table survives');
    const ids = (await db.query('SELECT id FROM tables WHERE restaurant_id=$1', [o.outletId])).rows;
    assert.equal(new Set(ids.map((r) => r.id)).size, 31, 'and none is duplicated');
  });

  it('a settings save only changes the fields it was given; every other outlet column is byte-identical', async () => {
    const o = await tenant('cols', await plan(-1), 3);
    const before = await outletRow(o.outletId);
    const r = await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { gstPercentage: 12, kdsNewOrderAlert: false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await outletRow(o.outletId);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    assert.deepEqual(changed.filter((k) => k !== 'updated_at').sort(), ['gst_percentage', 'kds_new_order_alert']);
    assert.equal(Number(after.gst_percentage), 12);
    assert.equal(after.kds_new_order_alert, false);
    assert.equal(await tableCount(o.outletId), 3);
  });

  it('the response keeps its shape (outlet fields and the tables list) and the operations rules merge section by section', async () => {
    const o = await tenant('shape', await plan(-1), 2);
    const r = await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { operations: { acceptingOrders: false, pausedMessage: 'Back soon' } } });
    assert.equal(r.status, 200);
    assert.equal(r.data.slug, o.slug);
    assert.equal(r.data.operations.acceptingOrders, false);
    assert.ok(Array.isArray(r.data.tables) && r.data.tables.length === 2, 'tables are still returned as before');
    const r2 = await call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { operations: { avgPrepMinutes: 25 } } });
    assert.equal(r2.data.operations.avgPrepMinutes, 25);
    assert.equal(r2.data.operations.acceptingOrders, false, 'the earlier section is preserved');
    assert.equal(r2.data.operations.pausedMessage, 'Back soon');
  });

  it('concurrent saves of different fields all persist (no lost update between two settings saves)', async () => {
    const o = await tenant('multi', await plan(-1));
    const bodies = [{ gstPercentage: 18 }, { serviceChargePercentage: 7 }, { isVegOnly: true }, { orderReadyChime: false }, { outOfStockNotification: false }, { phone: '9000000001' }];
    const res = await Promise.all(bodies.map((b) => call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: b })));
    assert.deepEqual(res.map((r) => r.status), bodies.map(() => 200), JSON.stringify(res.map((r) => r.body?.message)));
    const row = await outletRow(o.outletId);
    assert.equal(Number(row.gst_percentage), 18);
    assert.equal(Number(row.service_charge_percentage), 7);
    assert.equal(row.is_veg_only, true);
    assert.equal(row.order_ready_chime, false);
    assert.equal(row.out_of_stock_notification, false);
    assert.equal(row.phone, '9000000001');
  });

  it('a table created AFTER the settings request loaded the outlet is never overwritten (stale tables list is never written back)', async () => {
    const o = await tenant('stale', await plan(-1), 1);
    // many saves in flight while the floor changes: the table set after the dust settles is exactly the set that was created
    const jobs = [];
    for (let i = 0; i < 15; i++) { jobs.push(call('PATCH', `/restaurants/${o.slug}/settings`, { token: o.token, body: { gstPercentage: 5 + (i % 2) } })); jobs.push(call('POST', '/tables', { token: o.token, body: { restaurantId: o.outletId, tableNumber: `Z${i}` } })); }
    await Promise.all(jobs);
    const nums = (await db.query('SELECT table_number FROM tables WHERE restaurant_id=$1 ORDER BY table_number', [o.outletId])).rows.map((r) => r.table_number);
    for (let i = 0; i < 15; i++) assert.ok(nums.includes(`Z${i}`), `Z${i} is still there`);
    assert.equal(nums.length, 16);
  });

  it('settings still obey roles: a manager cannot change owner-only fields, a cashier cannot save at all', async () => {
    const o = await tenant('roles', await plan(-1));
    const mk = async (role, i) => {
      const email = `${role.toLowerCase()}-${i}-${o.slug}@example.com`;
      assert.equal((await call('POST', `/restaurants/${o.outletId}/staff`, { token: o.token, body: { name: role, email, password: PW, role } })).status, 201);
      const f = await login(email);
      return (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW, newPassword: 'Tulsi-Wada-Pune-42' } })).data.accessToken;
    };
    const mgr = await mk('STORE_MANAGER', 1); const cashier = await mk('CASHIER', 1);
    assert.equal((await call('PATCH', `/restaurants/${o.slug}/settings`, { token: mgr, body: { gstPercentage: 18 } })).status, 403);
    assert.equal((await call('PATCH', `/restaurants/${o.slug}/settings`, { token: mgr, body: { isVegOnly: true } })).status, 200);
    assert.equal((await call('PATCH', `/restaurants/${o.slug}/settings`, { token: cashier, body: { isVegOnly: false } })).status, 403);
  });
});

describe('A limit override leaves a complete audit record', () => {
  it('actor, reason, limit type, current usage, requested usage and the outlet are recorded in both audit trails', async () => {
    const code = await plan(4);
    const o = await tenant('aud', code, 4);
    const reason = 'Wedding party: four extra temporary tables';
    const r = await call('POST', '/tables', { token: ADMIN, body: { restaurantId: o.outletId, tableNumber: 'AUD1', limitOverrideReason: reason } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sub = (await db.query(`SELECT actor, reason, metadata FROM subscription_audit_logs WHERE organization_id=$1 AND action='PLAN_LIMIT_OVERRIDDEN'`, [o.orgId])).rows;
    assert.equal(sub.length, 1);
    assert.match(sub[0].actor, /^ADMIN:root-st-/);
    assert.equal(sub[0].reason, reason);
    assert.deepEqual({ kind: sub[0].metadata.kind, limit: sub[0].metadata.limit, current: sub[0].metadata.current, adding: sub[0].metadata.adding, restaurantId: sub[0].metadata.restaurantId }, { kind: 'tables', limit: 4, current: 4, adding: 1, restaurantId: o.outletId });
    const pa = (await db.query(`SELECT actor_email, actor_role, reason, changes, summary FROM platform_audit_logs WHERE organization_id=$1 AND action='PLAN_LIMIT_OVERRIDDEN'`, [o.orgId])).rows;
    assert.equal(pa.length, 1);
    assert.match(pa[0].actor_email, /^root-st-/);
    assert.equal(pa[0].reason, reason);
    assert.deepEqual({ kind: pa[0].changes.kind, limit: pa[0].changes.limit, current: pa[0].changes.current, adding: pa[0].changes.adding }, { kind: 'tables', limit: 4, current: 4, adding: 1 });
    assert.match(pa[0].summary, /4 in use \+ 1 requested, limit 4/);
  });
  it('an owner cannot send the override field, a within-limit change records nothing', async () => {
    const o = await tenant('own', await plan(3), 1);
    const r = await call('POST', '/tables', { token: o.token, body: { restaurantId: o.outletId, tableNumber: 'X1', limitOverrideReason: 'please let me add this table' } });
    assert.equal(r.status, 403);
    assert.equal(r.code, 'LIMIT_OVERRIDE_FORBIDDEN');
    assert.equal((await call('POST', '/tables', { token: ADMIN, body: { restaurantId: o.outletId, tableNumber: 'OK1', limitOverrideReason: 'within the limit anyway, no exception' } })).status, 201);
    assert.equal((await db.query(`SELECT 1 FROM subscription_audit_logs WHERE organization_id=$1 AND action='PLAN_LIMIT_OVERRIDDEN'`, [o.orgId])).rowCount, 0);
  });
});

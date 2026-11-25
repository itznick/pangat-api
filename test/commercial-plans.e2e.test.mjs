/**
 * Commercial plans, live: a RUNNING API on a THROWAWAY database (never production).
 *
 *   DATABASE_URL=postgres://... THROTTLE_DISABLED=true PLATFORM_BOOTSTRAP_SECRET=bootstrapsecret1234567 \
 *     RAZORPAY_WEBHOOK_SECRET=whsec_test_123 PORT=4000 node dist/main &
 *   npm run test:commercial
 *
 * Proves, against the real stack: the approved four-plan catalogue and its limits/features are what the API enforces; the
 * 14-day trial plan; Inventory deduction STOPS when the Inventory entitlement is lost (downgrade, expiry, platform switch) and
 * resumes when it returns; historical plans and existing subscribers are untouched; sold plans cannot be re-priced in place;
 * Super Admin plan oversight; the billing profile, place of supply and consecutive invoice numbers; and that migration 018
 * is idempotent, never edits an operator-changed row and reverses cleanly.
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
const WH_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'whsec_test_123';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const db = new pg.Client({ connectionString: DB });

async function call(method, p, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, code: json?.code };
}
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });
const idem = () => `idem-${crypto.randomBytes(8).toString('hex')}`;

let ADMIN;
let n = 0;
const settingsTouched = new Set();
const plansMade = [];

async function setSetting(key, value) {
  settingsTouched.add(key);
  const r = await call('PUT', '/admin/settings', { token: ADMIN.token, body: { changes: { [key]: value } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const planRow = async (code) => (await db.query('SELECT * FROM subscription_plans WHERE code = $1', [code])).rows[0];
const setPlan = (orgId, planCode, status = 'ACTIVE') =>
  db.query(
    `UPDATE organization_subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = $2), status = $3, current_period_start = now(),
            current_period_end = now() + interval '30 days', grace_period_ends_at = NULL, cancel_at_period_end = false, trial_ends_at = NULL WHERE organization_id = $1`,
    [orgId, planCode, status],
  );
const onboardBody = (tag, extra = {}) => ({
  brandName: `Brand ${tag}`, ownerFullName: `Owner ${tag}`, mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW,
  outletName: `Outlet ${tag}`, slug: `cp-${tag}-${run}`, upiVpa: 'shop@upi', gstPercentage: 5, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468', ...extra,
});
async function onboard(tag, extra = {}) {
  const r = await call('POST', '/auth/onboard', { body: onboardBody(tag, extra) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug: `cp-${tag}-${run}`, email: `o-${tag}-${run}@example.com`, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}
const orgOn = async (tag, planCode, extra = {}) => { const o = await onboard(tag, { indoorTableCount: 1, outdoorTableCount: 0, ...extra }); await setPlan(o.orgId, planCode); return o; };
/** Put an outlet at exactly `total` tables (direct insert: a trial caps sign-up at 20, so bigger floors are reached by plan change). */
const fillTables = async (o, total) => {
  const have = Number((await db.query('SELECT COUNT(*) FROM tables WHERE restaurant_id = $1', [o.outlet.id])).rows[0].count);
  for (let i = have + 1; i <= total; i++) await db.query("INSERT INTO tables (id, restaurant_id, table_number, status, qr_code_url) VALUES (gen_random_uuid(), $1, $2, 'VACANT', '/x')", [o.outlet.id, `F${i}`]);
};
const entitlements = async (o) => (await call('GET', '/subscriptions/my-subscription', { token: o.token })).data;
const addTable = (o, num) => call('POST', '/tables', { token: o.token, body: { restaurantId: o.outlet.id, tableNumber: num } });
const addStaff = (o, i, role = 'STEWARD') => call('POST', `/restaurants/${o.outlet.id}/staff`, { token: o.token, body: { name: `S${i}`, email: `s${i}-${o.slug}@example.com`, password: PW, role } });
const addOutlet = (o, tag, extra = {}) => call('POST', '/organizations/outlets', { token: o.token, body: { name: tag, slug: `cp-${tag}-${run}`, upiVpa: 'xx@upi', tableCount: 1, ...extra } });
const firstItem = async (slug) => { const i = (await call('GET', `/menu/public/${slug}`)).data.items[0]; return { menuItemId: i.id, name: i.name, price: Number(i.price), quantity: 1 }; };
const placeOrder = (slug, item) => call('POST', '/orders', { headers: { 'x-idempotency-key': idem() }, body: { restaurantSlug: slug, orderType: 'TAKEAWAY', customerName: 'Guest', consentAccepted: true, paymentMethod: 'PAY_AT_COUNTER', items: [item] } });
const stock = async (id) => Number((await db.query('SELECT current_stock FROM ingredients WHERE id = $1', [id])).rows[0].current_stock);
const movements = async (outletId) => Number((await db.query('SELECT COUNT(*) FROM stock_movements WHERE restaurant_id = $1', [outletId])).rows[0].count);
const sign = (raw) => crypto.createHmac('sha256', WH_SECRET).update(raw).digest('hex');
const webhook = (payload) => { const raw = JSON.stringify(payload); return call('POST', '/subscriptions/webhook/razorpay', { raw, headers: { 'x-razorpay-signature': sign(raw) } }); };

before(async () => {
  await db.connect();
  const email = `root-cp-${run}@pangat.test`;
  const { default: bcrypt } = await import('bcrypt');
  await db.query(`INSERT INTO staff (name, email, password_hash, role, is_platform_admin, platform_role) VALUES ('Root CP', $1, $2, 'PLATFORM_SUPER_ADMIN', true, 'OWNER')`, [email, await bcrypt.hash(PW, 10)]);
  ADMIN = { email, token: (await login(email)).data.accessToken };
});
after(async () => {
  for (const k of settingsTouched) await call('PUT', '/admin/settings', { token: ADMIN.token, body: { changes: { [k]: null } } });
  await call('PATCH', '/admin/feature-flags/INVENTORY', { token: ADMIN.token, body: { enabled: true } });
  await db.query('UPDATE subscription_plans SET is_active = false WHERE code = ANY($1)', [plansMade]);
  await db.end();
});

const APPROVED = {
  MINI:       { m: 699,  a: 6990,  outlets: 1, tables: 10,  staff: 3,  features: ['KDS', 'QR_ORDERING'] },
  STARTER:    { m: 1299, a: 12990, outlets: 1, tables: 25,  staff: 8,  features: ['ANALYTICS', 'KDS', 'QR_ORDERING'] },
  GROWTH:     { m: 2499, a: 24990, outlets: 3, tables: 60,  staff: 20, features: ['ANALYTICS', 'INVENTORY', 'KDS', 'MULTI_OUTLET', 'QR_ORDERING'] },
  ENTERPRISE: { m: 4999, a: 49990, outlets: 5, tables: 100, staff: 40, features: ['ANALYTICS', 'INVENTORY', 'KDS', 'MULTI_OUTLET', 'QR_ORDERING'] },
};

describe('The catalogue in the database and on the public API', () => {
  it('every approved plan exists with the approved price, limits and features (monthly and annual)', async () => {
    for (const [k, a] of Object.entries(APPROVED)) {
      for (const [sfx, price, interval] of [['M', a.m, 'MONTHLY'], ['A', a.a, 'YEARLY']]) {
        const r = await planRow(`PANGAT_${k}_${sfx}`);
        assert.ok(r, `PANGAT_${k}_${sfx} exists`);
        assert.equal(Number(r.base_price), price);
        assert.equal(Number(r.base_price_paise), price * 100);
        assert.equal(r.billing_interval, interval);
        assert.deepEqual([r.max_outlets, r.max_tables_per_outlet, r.max_staff_per_outlet], [a.outlets, a.tables, a.staff]);
        assert.deepEqual(String(r.features).split(',').sort(), a.features);
        assert.equal(r.is_public, true);
        assert.equal(r.is_active, true);
      }
    }
  });

  it('GET /subscriptions/plans lists exactly the four plans, monthly and annual, with GST shown separately', async () => {
    const r = await call('GET', '/subscriptions/plans');
    assert.equal(r.status, 200);
    const rows = r.data;
    assert.equal(rows.length, 8, rows.map((p) => p.code).join(','));
    assert.deepEqual(rows.map((p) => p.code).sort(), Object.keys(APPROVED).flatMap((k) => [`PANGAT_${k}_A`, `PANGAT_${k}_M`]).sort());
    for (const p of rows) {
      assert.equal(p.pricing.taxPercentage, 18);
      assert.equal(p.pricing.totalPayable, Math.round(p.pricing.basePrice * 118) / 100);
      assert.ok(!p.features.includes('ADVANCED_REPORTS'));
    }
    const monthly = rows.filter((p) => p.billingInterval === 'MONTHLY').map((p) => p.name);
    assert.deepEqual(monthly, ['Pangat Mini', 'Pangat Starter', 'Pangat Growth', 'Pangat Enterprise'], 'ordered by price');
  });

  it('historical, founding and trial plans are NOT public but still exist', async () => {
    const codes = (await call('GET', '/subscriptions/plans')).data.map((p) => p.code);
    for (const c of ['STARTER', 'GROWTH', 'ENTERPRISE', 'STARTER_ANNUAL', 'PANGAT_TRIAL', 'FOUNDING_MINI_M', 'FOUNDING_GROWTH_A']) {
      assert.ok(!codes.includes(c), `${c} must not be public`);
      assert.ok(await planRow(c), `${c} still exists`);
    }
    const legacy = await planRow('GROWTH');
    assert.equal(legacy.is_active, true, 'historical plans stay active so existing subscribers keep resolving');
  });

  it('Founding 10 rows are exactly 20% below list and are assigned to nobody', async () => {
    for (const [k, a] of Object.entries(APPROVED)) {
      assert.equal(Number((await planRow(`FOUNDING_${k}_M`)).base_price), Math.round(a.m * 80) / 100);
      assert.equal(Number((await planRow(`FOUNDING_${k}_A`)).base_price), Math.round(a.a * 80) / 100);
    }
    const used = (await db.query(`SELECT COUNT(*) FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE p.code LIKE 'FOUNDING\\_%' ESCAPE '\\'`)).rows[0].count;
    assert.equal(Number(used), 0, 'nothing assigns the Founding offer automatically');
  });
});

describe('Trial', () => {
  it('a new restaurant starts a 14-day trial on the non-public trial plan: 1 outlet, 20 tables, 8 staff', async () => {
    const o = await onboard('tr1');
    const sub = await entitlements(o);
    assert.equal(sub.plan.code, 'PANGAT_TRIAL');
    assert.equal(sub.subscription.status, 'TRIAL');
    const days = (new Date(sub.subscription.trialEndsAt) - new Date(sub.subscription.currentPeriodStart)) / 86_400_000;
    assert.ok(Math.abs(days - 14) < 0.01, `trial length ${days}`);
    assert.deepEqual(sub.entitlements.limits, { maxOutlets: 1, maxTablesPerOutlet: 20, maxStaffPerOutlet: 8 });
    for (const f of ['QR_ORDERING', 'KDS', 'ANALYTICS', 'INVENTORY']) assert.equal(sub.entitlements.features[f].allowed, true, f);
    assert.equal(sub.entitlements.features.MULTI_OUTLET.allowed, false);
  });

  it('trial capacity is enforced: the 21st table and a second outlet are refused', async () => {
    const o = await onboard('tr2', { indoorTableCount: 15, outdoorTableCount: 5 }); // 20 tables
    const over = await addTable(o, 'Z21');
    assert.equal(over.status, 403);
    assert.equal(over.code, 'PLAN_LIMIT_REACHED');
    assert.equal(over.body.details.limit, 20);
    const second = await addOutlet(o, 'tr2b');
    assert.ok([402, 403].includes(second.status), `second outlet refused on a trial (${second.status})`);
  });

  it('the trial plan is not purchasable or visible to a restaurant choosing a plan', async () => {
    const o = await onboard('tr3');
    const plans = (await call('GET', '/subscriptions/plans', { token: o.token })).data;
    assert.ok(!plans.some((p) => p.code === 'PANGAT_TRIAL'));
    assert.equal((await call('POST', '/subscriptions/request-change', { token: o.token, body: { planCode: 'PANGAT_TRIAL' } })).status, 200, 'request-change only records a request: nothing is activated');
    assert.equal((await entitlements(o)).plan.code, 'PANGAT_TRIAL', 'a plan request never changes the plan');
  });

  it('trial expiry: grace keeps working, then the account is read-only and re-activation restores it', async () => {
    const o = await onboard('tr4');
    const item = await firstItem(o.slug);
    await db.query("UPDATE organization_subscriptions SET current_period_end = now() - interval '1 day', trial_ends_at = now() - interval '1 day' WHERE organization_id = $1", [o.orgId]);
    await new Promise((r) => setTimeout(r, 21_000)); // the access decision is cached for 20 s
    assert.equal((await entitlements(o)).subscription.status, 'GRACE_PERIOD');
    assert.equal((await placeOrder(o.slug, item)).status, 201, 'inside the 7-day grace the restaurant keeps working');
    await db.query("UPDATE organization_subscriptions SET current_period_end = now() - interval '9 days', trial_ends_at = now() - interval '9 days' WHERE organization_id = $1", [o.orgId]);
    await new Promise((r) => setTimeout(r, 21_000));
    assert.equal((await placeOrder(o.slug, item)).status, 400, 'after grace guest ordering is closed');
    assert.equal((await call('GET', `/orders?restaurantSlug=${o.slug}`, { token: o.token })).status, 200, 'reading still works');
    await setPlan(o.orgId, 'PANGAT_STARTER_M');
    await new Promise((r) => setTimeout(r, 21_000));
    assert.equal((await placeOrder(o.slug, item)).status, 201, 're-activation restores ordering');
  });
});

describe('Each approved plan is enforced by the API', () => {
  it('the entitlement read model shows the approved limits and features for every plan', async () => {
    for (const [k, a] of Object.entries(APPROVED)) {
      const o = await orgOn(`ent-${k.toLowerCase()}`, `PANGAT_${k}_M`);
      const e = (await entitlements(o)).entitlements;
      assert.deepEqual(e.limits, { maxOutlets: a.outlets, maxTablesPerOutlet: a.tables, maxStaffPerOutlet: a.staff }, k);
      const allowed = Object.entries(e.features).filter(([, v]) => v.allowed).map(([f]) => f).sort();
      assert.deepEqual(allowed, a.features, `${k} features`);
    }
  });

  it('Mini: 10 tables and 3 staff are enforced; reports and inventory are locked; multi-outlet is refused', async () => {
    const o = await orgOn('mini', 'PANGAT_MINI_M', { indoorTableCount: 10 });
    const t = await addTable(o, 'M11');
    assert.equal(t.status, 403);
    assert.equal(t.body.details.limit, 10);
    for (let i = 1; i <= 3; i++) assert.equal((await addStaff(o, i)).status, 201, `staff ${i}`);
    const s4 = await addStaff(o, 4);
    assert.equal(s4.status, 403);
    assert.equal(s4.body.details.limit, 3);
    const rep = await call('GET', `/reports/summary?restaurantSlug=${o.slug}`, { token: o.token });
    assert.equal(rep.status, 402, 'reports are not in Mini');
    const inv = await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token });
    assert.equal(inv.status, 402, 'inventory is not in Mini');
    assert.ok([402, 403].includes((await addOutlet(o, 'mini2')).status));
    // KDS and QR ordering are in Mini, and the dashboard's own "today" figures need no entitlement
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } })).status, 200, 'KDS sign-in works on Mini');
    const item = await firstItem(o.slug);
    assert.equal((await placeOrder(o.slug, item)).status, 201, 'QR ordering works on Mini');
  });

  it('Starter: 25 tables, reports available, inventory still locked, single outlet', async () => {
    const o = await orgOn('starter', 'PANGAT_STARTER_M');
    await fillTables(o, 25);
    const t = await addTable(o, 'S26');
    assert.equal(t.status, 403);
    assert.equal(t.body.details.limit, 25);
    assert.equal((await call('GET', `/reports/summary?restaurantSlug=${o.slug}`, { token: o.token })).status, 200);
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token })).status, 402);
    assert.ok([402, 403].includes((await addOutlet(o, 'st2')).status), 'a second outlet needs multi-outlet');
  });

  it('Growth: inventory available; 3 outlets allowed, the 4th refused', async () => {
    const o = await orgOn('growth', 'PANGAT_GROWTH_M');
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token })).status, 200);
    assert.equal((await addOutlet(o, 'gr2')).status, 201);
    assert.equal((await addOutlet(o, 'gr3')).status, 201);
    const fourth = await addOutlet(o, 'gr4');
    assert.equal(fourth.status, 403);
    assert.equal(fourth.code, 'PLAN_LIMIT_REACHED');
    assert.equal(fourth.body.details.limit, 3);
  });

  it('Enterprise: five outlets included and the sixth refused (further outlets are agreed by hand, not billed automatically)', async () => {
    const o = await orgOn('ent', 'PANGAT_ENTERPRISE_M');
    for (const i of [2, 3, 4, 5]) assert.equal((await addOutlet(o, `en${i}`)).status, 201, `outlet ${i}`);
    const sixth = await addOutlet(o, 'en6');
    assert.equal(sixth.status, 403);
    assert.equal(sixth.body.details.limit, 5);
  });

  it('annual rows enforce the same limits as the monthly rows', async () => {
    const o = await orgOn('annual', 'PANGAT_MINI_A', { indoorTableCount: 10 });
    assert.equal((await addTable(o, 'A11')).status, 403);
    assert.deepEqual((await entitlements(o)).entitlements.limits, { maxOutlets: 1, maxTablesPerOutlet: 10, maxStaffPerOutlet: 3 });
  });
});

describe('Inventory stops when the Inventory entitlement is lost', () => {
  async function stocked(tag, planCode) {
    const o = await orgOn(tag, planCode, { indoorTableCount: 2 });
    const item = await firstItem(o.slug);
    const ing = await call('POST', '/inventory/ingredients', { token: o.token, body: { restaurantId: o.outlet.id, name: 'Milk', unit: 'LITRE', openingStock: 10, minimumStock: 1, costPerUnit: 60 } });
    assert.equal(ing.status, 201, JSON.stringify(ing.body));
    const rec = await call('POST', `/inventory/recipes?restaurantId=${o.outlet.id}`, { token: o.token, body: { menuItemId: item.menuItemId, ingredients: [{ ingredientId: ing.data.id, quantity: 1, unit: 'LITRE' }] } });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    return { o, item, ingId: ing.data.id };
  }

  it('deducts while entitled; STOPS after a downgrade; resumes after an upgrade; a pre-downgrade order can still be cancelled and restored', async () => {
    const { o, item, ingId } = await stocked('inv1', 'PANGAT_GROWTH_M');
    const first = await placeOrder(o.slug, item);
    assert.equal(first.status, 201);
    assert.equal(await stock(ingId), 9, 'entitled: deducted');
    const baseline = await movements(o.outlet.id);

    await setPlan(o.orgId, 'PANGAT_STARTER_M'); // downgrade: Inventory is lost
    await new Promise((r) => setTimeout(r, 21_000));
    for (let i = 0; i < 3; i++) assert.equal((await placeOrder(o.slug, item)).status, 201);
    assert.equal(await stock(ingId), 9, 'not entitled: stock is NOT deducted');
    assert.equal(await movements(o.outlet.id), baseline, 'not entitled: no stock movement is written');
    const { rows } = await db.query('SELECT is_available, auto_disabled FROM menu_items WHERE id = $1', [item.menuItemId]);
    assert.equal(rows[0].is_available, true, 'no automatic hiding of dishes while Inventory is locked');

    // the order placed while entitled was really deducted; cancelling it afterwards still puts the stock back (ledger integrity)
    const cancel = await call('POST', `/orders/${first.data.id}/cancel`, { token: o.token, body: { reason: 'guest left' } });
    assert.equal(cancel.status, 201, JSON.stringify(cancel.body));
    assert.equal(await stock(ingId), 10, 'a deduction that really happened is reversed');

    await setPlan(o.orgId, 'PANGAT_GROWTH_M'); // upgrade: Inventory returns
    await new Promise((r) => setTimeout(r, 21_000));
    assert.equal((await placeOrder(o.slug, item)).status, 201);
    assert.equal(await stock(ingId), 9, 'entitled again: deduction resumes');
  });

  it('the platform kill switch and a lapsed subscription also stop deduction', async () => {
    const { o, item, ingId } = await stocked('inv2', 'PANGAT_GROWTH_M');
    assert.equal((await call('PATCH', '/admin/feature-flags/INVENTORY', { token: ADMIN.token, body: { enabled: false } })).status, 200);
    await new Promise((r) => setTimeout(r, 21_000));
    assert.equal((await placeOrder(o.slug, item)).status, 201);
    assert.equal(await stock(ingId), 10, 'feature switched off platform-wide: not deducted');
    assert.equal((await call('PATCH', '/admin/feature-flags/INVENTORY', { token: ADMIN.token, body: { enabled: true } })).status, 200);
    await new Promise((r) => setTimeout(r, 21_000));
    assert.equal((await placeOrder(o.slug, item)).status, 201);
    assert.equal(await stock(ingId), 9, 'switched back on: deducted');
  });

  it('a per-restaurant override that switches Inventory off also stops it', async () => {
    const { o, item, ingId } = await stocked('inv3', 'PANGAT_GROWTH_M');
    const r = await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: ADMIN.token, body: { feature: 'INVENTORY', mode: 'FORCE_OFF', reason: 'testing the entitlement boundary' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await new Promise((r2) => setTimeout(r2, 21_000));
    assert.equal((await placeOrder(o.slug, item)).status, 201);
    assert.equal(await stock(ingId), 10, 'override off: not deducted');
  });
});

describe('Existing subscribers and historical plans are untouched', () => {
  it('an organisation on a historical plan keeps its exact price, limits and features, and does not see itself moved', async () => {
    const o = await orgOn('leg1', 'GROWTH');
    const sub = await entitlements(o);
    assert.equal(sub.plan.code, 'GROWTH');
    assert.equal(Number(sub.plan.basePrice), 2999);
    assert.deepEqual(sub.entitlements.limits, { maxOutlets: 3, maxTablesPerOutlet: 40, maxStaffPerOutlet: 15 });
    for (const f of ['INVENTORY', 'ANALYTICS', 'MULTI_OUTLET', 'KDS', 'QR_ORDERING']) assert.equal(sub.entitlements.features[f].allowed, true, f);
    assert.equal((await addOutlet(o, 'leg1b')).status, 201, 'still can add outlets');
  });

  it('the historical plans\' rows were not edited by the migration (price, limits, features)', async () => {
    const expect = { STARTER: [1499, 1, 15, 5], GROWTH: [2999, 3, 40, 15], ENTERPRISE: [5999, -1, -1, -1] };
    for (const [c, [price, o, t, s]] of Object.entries(expect)) {
      const r = await planRow(c);
      assert.equal(Number(r.base_price), price);
      assert.deepEqual([r.max_outlets, r.max_tables_per_outlet, r.max_staff_per_outlet], [o, t, s]);
    }
  });

  it('a plan that has customers cannot be re-priced in place without an explicit acknowledgement; limits and names stay editable', async () => {
    const code = `CP${run}${n++}`.toUpperCase();
    const mk = await call('POST', '/subscriptions/admin/plans', { token: ADMIN.token, body: { code, name: `Sold ${code}`, billingInterval: 'MONTHLY', basePrice: 500, maxOutlets: 1, maxTablesPerOutlet: 5, maxStaffPerOutlet: 3, features: ['QR_ORDERING', 'KDS'], trialDays: 14, isPublic: false } });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    plansMade.push(code);
    const id = mk.data.id;
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN.token, body: { basePrice: 550 } })).status, 200, 'no subscribers yet: price edit is fine');
    const o = await orgOn('sold', code);
    const blocked = await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN.token, body: { basePrice: 900 } });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.code, 'PLAN_HAS_SUBSCRIBERS');
    assert.equal(Number((await planRow(code)).base_price), 550, 'the price did not change');
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN.token, body: { billingInterval: 'YEARLY' } })).status, 409);
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN.token, body: { taxPercentage: 12 } })).status, 409);
    const rename = await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN.token, body: { name: 'Renamed' } });
    assert.equal(rename.status, 200);
    assert.equal(rename.data.subscriberImpact.currentSubscribers, 1);
    const same = await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN.token, body: { basePrice: 550 } });
    assert.equal(same.status, 200, 'an unchanged price is not a commercial change');
    const ack = await call('PATCH', `/subscriptions/admin/plans/${id}`, { token: ADMIN.token, body: { basePrice: 600, acknowledgeSubscriberImpact: true } });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    const audit = (await db.query(`SELECT summary FROM platform_audit_logs WHERE entity_label = $1 AND action = 'PLAN_UPDATED' ORDER BY created_at DESC LIMIT 1`, [code])).rows[0];
    assert.match(audit.summary, /explicit acknowledgement/);
    assert.ok(o.orgId);
  });

  it('a restaurant cannot change a plan or read Super Admin plan data', async () => {
    const o = await onboard('perm1');
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${(await planRow('GROWTH')).id}`, { token: o.token, body: { basePrice: 1 } })).status, 403);
    for (const p of ['/admin/subscription-plans', '/admin/subscriptions/capacity', '/admin/subscriptions/founding']) assert.equal((await call('GET', p, { token: o.token })).status, 403, p);
    for (const p of ['/admin/subscription-plans', '/admin/subscriptions/capacity', '/admin/subscriptions/founding']) assert.equal((await call('GET', p)).status, 401, p);
  });
});

describe('Super Admin oversight', () => {
  it('the plan listing carries group, family, subscriber counts, over-limit counts and the trial configuration', async () => {
    const r = await call('GET', '/admin/subscription-plans', { token: ADMIN.token });
    assert.equal(r.status, 200);
    const { plans, trial } = r.data;
    const by = Object.fromEntries(plans.map((p) => [p.code, p]));
    assert.equal(by.PANGAT_MINI_M.group, 'COMMERCIAL');
    assert.equal(by.PANGAT_MINI_A.family, 'MINI');
    assert.equal(by.FOUNDING_GROWTH_M.group, 'FOUNDING');
    assert.equal(by.PANGAT_TRIAL.group, 'TRIAL');
    assert.equal(by.GROWTH.group, 'LEGACY');
    assert.ok(by.PANGAT_TRIAL.subscribers.total >= 1, 'trial subscribers are counted');
    assert.ok(by.GROWTH.everSubscribed >= 1);
    assert.equal(by.PANGAT_MINI_M.isPublic, true);
    assert.equal(by.FOUNDING_MINI_M.isPublic, false);
    assert.equal(trial.planCode, 'PANGAT_TRIAL');
    assert.equal(trial.defaultTrialDays, 14);
    assert.equal(trial.graceDays, 7);
    assert.equal(trial.planFound, true);
    assert.equal(trial.plan.max_tables_per_outlet, 20);
  });

  it('the capacity watch lists restaurants at >= 80% of a limit and marks the ones over it', async () => {
    const near = await orgOn('cap1', 'PANGAT_MINI_M', { indoorTableCount: 8 }); // 8 of 10
    const over = await orgOn('cap2', 'PANGAT_MINI_M', { indoorTableCount: 10 });
    await db.query("INSERT INTO tables (id, restaurant_id, table_number, status, qr_code_url) VALUES (gen_random_uuid(), $1, 'EXTRA1', 'VACANT', '/x')", [over.outlet.id]); // 11 of 10, as after a downgrade
    const r = await call('GET', '/admin/subscriptions/capacity', { token: ADMIN.token });
    assert.equal(r.status, 200);
    const a = r.data.find((x) => x.organizationId === near.orgId);
    const b = r.data.find((x) => x.organizationId === over.orgId);
    assert.ok(a && !a.over, 'near the limit, not over');
    assert.ok(b && b.over, 'over the limit');
    const tables = b.flags.find((f) => f.label.startsWith('Tables'));
    assert.equal(tables.used, 11);
    assert.equal(tables.limit, 10);
    assert.ok(!b.flags.some((f) => f.label === 'Outlets'), 'one outlet on a single-outlet plan is normal, not a warning');
    const quiet = await orgOn('cap3', 'PANGAT_MINI_M'); // 1 table of 10, 1 outlet of 1
    assert.ok(!r.data.some((x) => x.organizationId === quiet.orgId), 'a restaurant well inside its limits is not listed');
  });

  it('Founding 10: the programme view counts places and shows who is on a founding plan; assignment is manual and audited', async () => {
    const empty = (await call('GET', '/admin/subscriptions/founding', { token: ADMIN.token })).data;
    assert.equal(empty.slotsTotal, 10);
    const before = empty.slotsUsed;
    const o = await onboard('fnd1');
    const assign = await call('POST', `/admin/restaurants/${o.orgId}/subscription/assign`, { token: ADMIN.token, body: { planCode: 'FOUNDING_STARTER_M', months: 2, note: 'Founding 10 agreement FDR-001 signed' } });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const after2 = (await call('GET', '/admin/subscriptions/founding', { token: ADMIN.token })).data;
    assert.equal(after2.slotsUsed, before + 1);
    const g = after2.grants.find((x) => x.organization_id === o.orgId);
    assert.equal(g.plan_code, 'FOUNDING_STARTER_M');
    assert.equal(g.base_price, 1039.2);
    const sub = await entitlements(o);
    assert.equal(sub.plan.code, 'FOUNDING_STARTER_M');
    assert.deepEqual(sub.entitlements.limits, { maxOutlets: 1, maxTablesPerOutlet: 25, maxStaffPerOutlet: 8 });
    const audit = (await db.query(`SELECT reason FROM platform_audit_logs WHERE organization_id = $1 AND action = 'SUBSCRIPTION_ASSIGNED'`, [o.orgId])).rows;
    assert.ok(audit.some((a2) => /FDR-001/.test(a2.reason || '')), 'the assignment and its reason are in the audit log');
  });
});

describe('Billing profile, place of supply and consecutive invoice numbers', () => {
  const payload = (subId, payId, evt) => ({
    id: `evt_${payId}`, event: 'subscription.charged',
    payload: { subscription: { entity: { id: subId, notes: {} } }, payment: { entity: { id: payId, method: 'upi' } } },
  });
  async function paidOrg(tag, planCode = 'PANGAT_STARTER_M') {
    const o = await orgOn(tag, planCode);
    const subId = `sub_${tag}_${run}`;
    await db.query('UPDATE organization_subscriptions SET razorpay_subscription_id = $2 WHERE organization_id = $1', [o.orgId, subId]);
    return { o, subId };
  }
  const invoiceOf = async (payId) => (await db.query('SELECT * FROM subscription_invoices WHERE razorpay_payment_id = $1', [payId])).rows[0];

  it('only the owner edits billing details; a manager can read; values are validated; another organisation cannot see them', async () => {
    const o = await onboard('bp1');
    assert.equal((await call('PATCH', '/subscriptions/billing-profile', { token: o.token, body: { gstin: 'BAD' } })).status, 400);
    assert.equal((await call('PATCH', '/subscriptions/billing-profile', { token: o.token, body: { stateCode: '29', gstin: '27AAAAA0000A1Z5' } })).status, 400);
    const ok = await call('PATCH', '/subscriptions/billing-profile', { token: o.token, body: { legalName: 'Roast & Toast LLP', address: 'Baner, Pune', gstin: '27AAAAA0000A1Z5' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.stateCode, '27');
    const mgr = await call('POST', `/restaurants/${o.outlet.id}/staff`, { token: o.token, body: { name: 'Mgr', email: `mgr-bp1-${run}@example.com`, password: PW, role: 'STORE_MANAGER' } });
    assert.equal(mgr.status, 201, JSON.stringify(mgr.body));
    const first = await login(`mgr-bp1-${run}@example.com`);
    const mt = (await call('POST', '/auth/change-password', { token: first.data.accessToken, body: { currentPassword: PW, newPassword: 'Tulsi-Wada-Pune-42' } })).data.accessToken;
    assert.equal((await call('GET', '/subscriptions/billing-profile', { token: mt })).status, 200);
    assert.equal((await call('PATCH', '/subscriptions/billing-profile', { token: mt, body: { legalName: 'x' } })).status, 403);
    const other = await onboard('bp2');
    assert.equal((await call('GET', '/subscriptions/billing-profile', { token: other.token })).data.gstin, null);
    assert.equal((await call('GET', '/subscriptions/billing-profile')).status, 401);
  });

  it('a customer in Maharashtra is invoiced CGST+SGST; a customer in Karnataka IGST; both from the billing profile', async () => {
    const mh = await paidOrg('pos1');
    await call('PATCH', '/subscriptions/billing-profile', { token: mh.o.token, body: { stateCode: '27' } });
    const ka = await paidOrg('pos2');
    await call('PATCH', '/subscriptions/billing-profile', { token: ka.o.token, body: { stateCode: '29', gstin: '29AAAAA0000A1Z5' } });
    assert.equal((await webhook(payload(mh.subId, `pay_mh_${run}`))).status, 201);
    assert.equal((await webhook(payload(ka.subId, `pay_ka_${run}`))).status, 201);
    const a = await invoiceOf(`pay_mh_${run}`);
    const b = await invoiceOf(`pay_ka_${run}`);
    assert.equal(Number(a.base_amount_paise), 129900);
    assert.deepEqual([Number(a.cgst_amount_paise), Number(a.sgst_amount_paise), Number(a.igst_amount_paise)], [11691, 11691, 0]);
    assert.deepEqual([Number(b.cgst_amount_paise), Number(b.sgst_amount_paise), Number(b.igst_amount_paise)], [0, 0, 23382]);
    assert.equal(b.buyer_gstin, '29AAAAA0000A1Z5');
    assert.equal(b.state_code, '29');
    assert.equal(Number(b.total_amount_paise), 129900 + 23382);
  });

  it('invoice numbers are consecutive, financial-year scoped and at most 16 characters; a failed attempt takes no serial', async () => {
    const x = await paidOrg('num1');
    const y = await paidOrg('num2');
    await webhook(payload(x.subId, `pay_n1_${run}`));
    const failedBefore = (await db.query('SELECT last_value FROM subscription_invoice_sequences ORDER BY fiscal_year DESC LIMIT 1')).rows[0].last_value;
    const fail = await webhook({ id: `evt_fail_${run}`, event: 'payment.failed', payload: { subscription: { entity: { id: y.subId } }, payment: { entity: { id: `pay_fail_${run}`, error_description: 'card declined' } } } });
    assert.equal(fail.status, 201, JSON.stringify(fail.body));
    assert.equal((await db.query('SELECT last_value FROM subscription_invoice_sequences ORDER BY fiscal_year DESC LIMIT 1')).rows[0].last_value, failedBefore, 'a failed payment consumes no statutory number');
    await webhook(payload(y.subId, `pay_n2_${run}`));
    const i1 = await invoiceOf(`pay_n1_${run}`);
    const i2 = await invoiceOf(`pay_n2_${run}`);
    const m1 = i1.invoice_number.match(/^PGT\/(\d{4})\/(\d{6})$/);
    const m2 = i2.invoice_number.match(/^PGT\/(\d{4})\/(\d{6})$/);
    assert.ok(m1 && m2, `${i1.invoice_number} ${i2.invoice_number}`);
    assert.equal(Number(m2[2]), Number(m1[2]) + 1, 'consecutive');
    assert.ok(i1.invoice_number.length <= 16);
    const failed = await invoiceOf(`pay_fail_${run}`);
    assert.match(failed.invoice_number, /^ATTEMPT-/);
    assert.equal(failed.status, 'FAILED');
  });

  it('an over-long operator prefix cannot push a number past 16 characters', async () => {
    await setSetting('billing.invoicePrefix', 'PANGAT-INV');
    await new Promise((r) => setTimeout(r, 1500));
    const z = await paidOrg('num3');
    await webhook(payload(z.subId, `pay_n3_${run}`));
    const inv = await invoiceOf(`pay_n3_${run}`);
    assert.match(inv.invoice_number, /^PANG\/\d{4}\/\d{6}$/, inv.invoice_number);
    assert.ok(inv.invoice_number.length <= 16);
  });

  it('a duplicate webhook delivery creates no second invoice and no second serial', async () => {
    const z = await paidOrg('num4');
    const p = payload(z.subId, `pay_dup_${run}`);
    await webhook(p);
    const seq = (await db.query('SELECT last_value FROM subscription_invoice_sequences ORDER BY fiscal_year DESC LIMIT 1')).rows[0].last_value;
    await webhook(p);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM subscription_invoices WHERE razorpay_payment_id = $1', [`pay_dup_${run}`])).rows[0].count), 1);
    assert.equal((await db.query('SELECT last_value FROM subscription_invoice_sequences ORDER BY fiscal_year DESC LIMIT 1')).rows[0].last_value, seq);
  });

  it('paid subscription collection is NOT live: no endpoint creates a checkout, and a plan request activates nothing', async () => {
    const o = await onboard('nolive');
    for (const p of ['/subscriptions/checkout', '/subscriptions/subscribe', '/subscriptions/razorpay/create']) {
      const r = await call('POST', p, { token: o.token, body: { planCode: 'PANGAT_MINI_M' } });
      assert.equal(r.status, 404, `${p} must not exist`);
    }
    const rq = await call('POST', '/subscriptions/request-change', { token: o.token, body: { planCode: 'PANGAT_GROWTH_M' } });
    assert.equal(rq.status, 200);
    assert.equal((await entitlements(o)).plan.code, 'PANGAT_TRIAL');
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM subscription_invoices WHERE organization_id = $1', [o.orgId])).rows[0].count), 0);
  });
});

describe('Migration 018 is idempotent, never edits an operator-changed row and reverses cleanly', () => {
  const up = fs.readFileSync(path.join(__dirname, '../src/migrations/018_commercial_plans.sql'), 'utf8');
  const down = fs.readFileSync(path.join(__dirname, '../src/migrations/018_commercial_plans.down.sql'), 'utf8');
  const snapshot = async () => (await db.query('SELECT code, name, base_price, base_price_paise, max_outlets, max_tables_per_outlet, max_staff_per_outlet, features, is_public, is_active, trial_days FROM subscription_plans ORDER BY code')).rows;

  it('re-running it changes nothing, even after an operator edited a new row or republished a historical plan on purpose', async () => {
    const mini = await planRow('PANGAT_MINI_M');
    await db.query("UPDATE subscription_plans SET base_price = 777, base_price_paise = 77700 WHERE code = 'PANGAT_MINI_M'");
    await db.query("UPDATE subscription_plans SET is_public = true WHERE code = 'STARTER'");
    const before = await snapshot();
    await db.query(up);
    await db.query(up);
    assert.deepEqual(await snapshot(), before, 'no row was edited by a re-run');
    assert.equal(Number((await planRow('PANGAT_MINI_M')).base_price), 777, 'an operator edit survives');
    assert.equal((await planRow('STARTER')).is_public, true, 'a deliberate republish is not undone');
    await db.query("UPDATE subscription_plans SET base_price = $1, base_price_paise = $2 WHERE code = 'PANGAT_MINI_M'", [mini.base_price, mini.base_price_paise]);
    await db.query("UPDATE subscription_plans SET is_public = false WHERE code = 'STARTER'");
  });

  it('production rehearsal: legacy plans public before 018 -> up hides them and records it -> down restores them exactly -> up again equals the first up', async () => {
    // Production-shaped starting point: the historical plans exist and are public, and 018 has not hidden them yet
    // (a fresh test database creates them after the migration ran, so this state has to be recreated on purpose)
    await db.query('DROP TABLE IF EXISTS plan_visibility_backfills');
    await db.query("UPDATE subscription_plans SET is_public = true WHERE code IN ('STARTER','STARTER_ANNUAL','GROWTH','GROWTH_ANNUAL','ENTERPRISE','ENTERPRISE_ANNUAL')");
    await db.query(up);
    for (const c of ['STARTER', 'GROWTH', 'ENTERPRISE']) assert.equal((await planRow(c)).is_public, false, `${c} hidden by 018`);
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM plan_visibility_backfills')).rows[0].count), 6, 'previous visibility recorded for all six');
    const before = await snapshot();

    const subscribed = (await db.query("SELECT DISTINCT p.code FROM subscription_plans p JOIN organization_subscriptions s ON s.plan_id = p.id WHERE p.code LIKE 'PANGAT\\_%' ESCAPE '\\' OR p.code LIKE 'FOUNDING\\_%' ESCAPE '\\'")).rows.map((r) => r.code);
    assert.ok(subscribed.includes('PANGAT_TRIAL'), 'customers are on the trial plan in this run');
    await db.query(down);
    const mid = await snapshot();
    for (const c of subscribed) assert.ok(mid.some((r) => r.code === c), `${c} is kept: customers are on it`);
    const unsubscribed = ['PANGAT_ENTERPRISE_A', 'FOUNDING_MINI_A'].filter((c) => !subscribed.includes(c));
    for (const c of unsubscribed) assert.ok(!mid.some((r) => r.code === c), `${c} (nobody on it) is removed by down`);
    for (const c of ['STARTER', 'STARTER_ANNUAL', 'GROWTH', 'GROWTH_ANNUAL', 'ENTERPRISE', 'ENTERPRISE_ANNUAL']) assert.equal(mid.find((r) => r.code === c).is_public, true, `${c} visibility restored`);

    await db.query(up);
    assert.deepEqual(await snapshot(), before, 'down then up lands on exactly the same catalogue');
  });
});

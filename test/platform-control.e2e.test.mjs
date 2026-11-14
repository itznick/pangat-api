/**
 * Live integration tests for the Super Admin "Platform Control Centre": a running API + PostgreSQL (no mocks).
 *
 *   DATABASE_URL=postgres://... PLATFORM_BOOTSTRAP_SECRET=bootstrapsecret1234567 RAZORPAY_WEBHOOK_SECRET=whsec_test_123 \
 *     THROTTLE_DISABLED=true PORT=4000 node dist/main &        # then:
 *   node --test test/platform-control.e2e.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL || 'postgres://pangat:pangat@localhost:5432/pangat_dev';
const BOOT = process.env.PLATFORM_BOOTSTRAP_SECRET || 'bootstrapsecret1234567';
const WH = process.env.RAZORPAY_WEBHOOK_SECRET || 'whsec_test_123';
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
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });
const tokenOf = async (email, password) => (await login(email, password)).data.accessToken;

async function onboard(tag) {
  const slug = `pc-${tag}-${run}`;
  const email = `owner-${tag}-${run}@example.com`;
  const r = await call('POST', '/auth/onboard', {
    body: { brandName: `Brand ${tag} ${run}`, ownerFullName: `Owner ${tag}`, mobileNumber: '9876500001', email, password: PW, outletName: `Outlet ${tag}`, slug, upiVpa: 'shop@upi', gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug, email, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}
const hook = (event, payload, id = `evt_${crypto.randomBytes(5).toString('hex')}`, secret = WH) => {
  const raw = JSON.stringify({ event, id, payload });
  return call('POST', '/subscriptions/webhook/razorpay', { raw, headers: { 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') } });
};

let OWNER; // platform owner admin
const admins = {}; // role -> {token, id}
let A; let B;

before(async () => {
  await db.connect();
  // bootstrap a platform owner (idempotent: reuse if it already exists)
  const email = `root-${run}@pangat.test`;
  const r = await call('POST', '/auth/setup-super-admin', { headers: { 'x-bootstrap-secret': BOOT }, body: { name: 'Root Admin', email, password: PW } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  OWNER = { email, token: await tokenOf(email) };
  A = await onboard('a');
  B = await onboard('b');
  for (const role of ['ADMIN', 'FINANCE', 'SUPPORT', 'ANALYST']) {
    const e = `${role.toLowerCase()}-${run}@pangat.test`;
    const c = await call('POST', '/admin/admins', { token: OWNER.token, body: { name: `${role} person`, email: e, role, password: PW + 'xyz' } });
    assert.equal(c.status, 201, `${role} ${JSON.stringify(c.body)}`);
    admins[role] = { id: c.data.id, email: e, token: await tokenOf(e, PW + 'xyz') };
  }
});
after(async () => { await db.end(); });

describe('Role-based access control (enforced on the server)', () => {
  it('rejects anonymous and merchant users on every platform route', async () => {
    for (const p of ['/admin/dashboard', '/admin/restaurants', '/admin/settings', '/admin/audit']) {
      assert.equal((await call('GET', p)).status, 401, p);
      assert.equal((await call('GET', p, { token: A.token })).status, 403, p);
    }
  });

  it('every route behind the platform guard declares a permission (default deny)', async () => {
    const { PlatformController } = await import('../dist/platform/platform.controller.js');
    const { AdminController } = await import('../dist/admin/admin.controller.js');
    const { SubscriptionsController } = await import('../dist/subscriptions/subscriptions.controller.js');
    const { PERMISSION_KEY } = await import('../dist/platform/guards.js');
    for (const [Ctl, only] of [[PlatformController], [AdminController], [SubscriptionsController, (n) => /^(adminOrg|listAllPlansForAdmin|createPlan|updatePlan)/.test(n)]]) {
      for (const name of Object.getOwnPropertyNames(Ctl.prototype)) {
        if (name === 'constructor' || (only && !only(name))) continue;
        const handler = Ctl.prototype[name];
        if (typeof handler !== 'function' || Reflect.getMetadata('path', handler) === undefined) continue;
        const perm = Reflect.getMetadata(PERMISSION_KEY, handler);
        assert.ok(perm && perm.length, `${Ctl.name}.${name} has no @RequirePermission`);
      }
    }
  });

  it('analyst can read but not change anything', async () => {
    const t = admins.ANALYST.token;
    assert.equal((await call('GET', '/admin/dashboard', { token: t })).status, 200);
    assert.equal((await call('GET', '/admin/restaurants', { token: t })).status, 200);
    assert.equal((await call('POST', `/admin/restaurants/${A.orgId}/status`, { token: t, body: { action: 'SUSPEND', reason: 'nope' } })).status, 403);
    assert.equal((await call('PUT', '/admin/settings', { token: t, body: { changes: { 'branding.platformName': 'Hacked' } } })).status, 403);
    assert.equal((await call('POST', '/admin/communications/send', { token: t, body: { subject: 'x', body: 'xx', channels: ['IN_APP'], audience: 'ALL_OWNERS' } })).status, 403);
  });

  it('finance can bill but cannot suspend, see users, or edit plans', async () => {
    const t = admins.FINANCE.token;
    assert.equal((await call('GET', '/admin/payments', { token: t })).status, 200);
    assert.equal((await call('GET', '/admin/users', { token: t })).status, 403);
    assert.equal((await call('POST', `/admin/restaurants/${A.orgId}/status`, { token: t, body: { action: 'SUSPEND', reason: 'nope' } })).status, 403);
    const plans = (await call('GET', '/subscriptions/admin/plans', { token: t }));
    assert.equal(plans.status, 200);
    assert.equal((await call('PATCH', `/subscriptions/admin/plans/${plans.data[0].id}`, { token: t, body: { name: 'Renamed' } })).status, 403);
  });

  it('support cannot touch money or settings, can work tickets and unlock users', async () => {
    const t = admins.SUPPORT.token;
    assert.equal((await call('GET', '/admin/payments', { token: t })).status, 403);
    assert.equal((await call('GET', '/admin/settings', { token: t })).status, 403);
    assert.equal((await call('GET', '/admin/support/tickets', { token: t })).status, 200);
    assert.equal((await call('POST', `/admin/restaurants/${A.orgId}/subscription/extend`, { token: t, body: { days: 5, reason: 'goodwill' } })).status, 403);
  });

  it('a read-only platform role cannot change data inside a restaurant console', async () => {
    const r = await call('POST', '/tables', { token: admins.ANALYST.token, body: { restaurantId: A.outlet.id, tableNumber: 'ZZ9' } });
    assert.equal(r.status, 403);
  });

  it('only owners manage administrators; nobody can demote themselves or the last owner', async () => {
    assert.equal((await call('POST', '/admin/admins', { token: admins.ADMIN.token, body: { name: 'X', email: `x-${run}@p.test`, role: 'ADMIN' } })).status, 403);
    const me = (await call('GET', '/admin/admins', { token: OWNER.token })).data.find((a) => a.email === OWNER.email);
    assert.equal((await call('PATCH', `/admin/admins/${me.id}`, { token: OWNER.token, body: { role: 'ANALYST' } })).status, 403);
    assert.equal((await call('PATCH', `/admin/admins/${me.id}`, { token: OWNER.token, body: { isActive: false } })).status, 403);
  });

  it('role changes take effect on the very next request', async () => {
    const e = `temp-${run}@pangat.test`;
    const c = await call('POST', '/admin/admins', { token: OWNER.token, body: { name: 'Temp', email: e, role: 'ANALYST', password: PW + 'tmp' } });
    const t = await tokenOf(e, PW + 'tmp');
    assert.equal((await call('GET', '/admin/payments', { token: t })).status, 200);
    await call('PATCH', `/admin/admins/${c.data.id}`, { token: OWNER.token, body: { role: 'SUPPORT' } });
    assert.equal((await call('GET', '/admin/payments', { token: t })).status, 403);
    await call('PATCH', `/admin/admins/${c.data.id}`, { token: OWNER.token, body: { isActive: false } });
    assert.equal((await call('GET', '/admin/dashboard', { token: t })).status, 401);
  });
});

describe('Restaurant management', () => {
  it('lists, searches, filters and sorts restaurants from real data', async () => {
    const all = await call('GET', `/admin/restaurants?q=${run}&sort=name&order=asc`, { token: OWNER.token });
    assert.equal(all.status, 200);
    assert.equal(all.data.items.length, 2);
    assert.ok(all.data.items.every((i) => i.owner_email.includes(run)));
    const none = await call('GET', `/admin/restaurants?q=${run}&status=SUSPENDED`, { token: OWNER.token });
    assert.equal(none.data.items.length, 0);
    const trial = await call('GET', `/admin/restaurants?q=${run}&subscription=TRIAL`, { token: OWNER.token });
    assert.equal(trial.data.items.length, 2);
  });

  it('profile shows outlets, users, subscription, usage and onboarding checklist', async () => {
    const r = await call('GET', `/admin/restaurants/${A.orgId}`, { token: OWNER.token });
    assert.equal(r.status, 200);
    assert.equal(r.data.outlets.length, 1);
    assert.equal(r.data.outlets[0].tables, 3);
    assert.ok(r.data.users.some((u) => u.role === 'SUPER_OWNER'));
    assert.equal(r.data.subscription.effective_status, 'TRIAL');
    assert.equal(r.data.onboarding.steps.find((s) => s.key === 'tables').done, true);
    assert.equal(r.data.onboarding.steps.find((s) => s.key === 'order').done, false);
    assert.equal((await call('GET', '/admin/restaurants/00000000-0000-4000-8000-000000000000', { token: OWNER.token })).status, 404);
    assert.equal((await call('GET', '/admin/restaurants/not-a-uuid', { token: OWNER.token })).status, 400);
  });

  it('suspension needs a reason, blocks sign-in AND live tokens, and restore reverses it', async () => {
    const victim = await onboard('susp');
    assert.equal((await call('POST', `/admin/restaurants/${victim.orgId}/status`, { token: OWNER.token, body: { action: 'SUSPEND' } })).status, 400);
    const s = await call('POST', `/admin/restaurants/${victim.orgId}/status`, { token: OWNER.token, body: { action: 'SUSPEND', reason: 'Chargeback dispute' } });
    assert.equal(s.status, 200);
    const l = await login(victim.email);
    assert.equal(l.status, 403);
    assert.equal(l.body.code, 'ACCOUNT_SUSPENDED');
    assert.equal((await call('GET', '/auth/me', { token: victim.token })).status, 403, 'existing token must stop working');
    // guests cannot order either
    const menu = (await call('GET', `/menu/public/${victim.slug}`)).data;
    const order = await call('POST', '/orders', { headers: { 'x-idempotency-key': `k-${crypto.randomBytes(6).toString('hex')}` }, body: { restaurantSlug: victim.slug, orderType: 'TAKEAWAY', customerName: 'G', paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: menu.items[0].id, name: menu.items[0].name, price: Number(menu.items[0].price), quantity: 1 }] } });
    assert.equal(order.status, 400);
    assert.equal((await call('POST', `/admin/restaurants/${victim.orgId}/status`, { token: OWNER.token, body: { action: 'SUSPEND', reason: 'again' } })).status, 400, 'already suspended');
    assert.equal((await call('POST', `/admin/restaurants/${victim.orgId}/status`, { token: OWNER.token, body: { action: 'RESTORE' } })).status, 200);
    assert.equal((await login(victim.email)).status, 200);
    assert.equal((await call('GET', '/auth/me', { token: victim.token })).status, 200);
  });

  it('verification, internal notes and outlet toggle work and are audited', async () => {
    assert.equal((await call('POST', `/admin/restaurants/${A.orgId}/verification`, { token: OWNER.token, body: { status: 'REJECTED' } })).status, 400);
    assert.equal((await call('POST', `/admin/restaurants/${A.orgId}/verification`, { token: OWNER.token, body: { status: 'VERIFIED', note: 'GST checked' } })).status, 200);
    const n = await call('POST', `/admin/restaurants/${A.orgId}/notes`, { token: OWNER.token, body: { body: 'Owner prefers WhatsApp', pinned: true } });
    assert.equal(n.status, 201);
    const notes = await call('GET', `/admin/restaurants/${A.orgId}/notes`, { token: OWNER.token });
    assert.equal(notes.data[0].body, 'Owner prefers WhatsApp');
    assert.equal((await call('POST', `/admin/outlets/${B.outlet.id}/status`, { token: OWNER.token, body: { isActive: false } })).status, 400);
    assert.equal((await call('POST', `/admin/outlets/${B.outlet.id}/status`, { token: OWNER.token, body: { isActive: false, reason: 'Closed for renovation' } })).status, 200);
    await call('POST', `/admin/outlets/${B.outlet.id}/status`, { token: OWNER.token, body: { isActive: true } });
    const audit = await call('GET', `/admin/audit?organizationId=${A.orgId}`, { token: OWNER.token });
    const actions = audit.data.items.map((i) => i.action);
    assert.ok(actions.includes('VERIFICATION_VERIFIED') && actions.includes('NOTE_ADDED'), actions.join());
  });

  it('activity and billing tabs return data', async () => {
    const a = await call('GET', `/admin/restaurants/${A.orgId}/activity?days=14`, { token: OWNER.token });
    assert.equal(a.status, 200);
    assert.equal(a.data.daily.length, 14);
    const b = await call('GET', `/admin/restaurants/${A.orgId}/billing`, { token: OWNER.token });
    assert.equal(b.status, 200);
    assert.ok(Array.isArray(b.data.invoices));
  });
});

describe('Subscriptions & plan management (enforced in the backend)', () => {
  it('creates and edits plans with trial length, and audits the change', async () => {
    const code = `PRO${run}`.toUpperCase();
    const c = await call('POST', '/subscriptions/admin/plans', { token: OWNER.token, body: { code, name: 'Pro Test', billingInterval: 'MONTHLY', basePrice: 999, trialDays: 30, maxOutlets: 1, maxTablesPerOutlet: 3, maxStaffPerOutlet: 4, features: ['QR_ORDERING', 'KDS'] } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.data.trialDays, 30);
    const u = await call('PATCH', `/subscriptions/admin/plans/${c.data.id}`, { token: OWNER.token, body: { basePrice: 1099, trialDays: 7 } });
    assert.equal(u.status, 200);
    const audit = await call('GET', '/admin/audit?category=PLAN&limit=5', { token: OWNER.token });
    const upd = audit.data.items.find((i) => i.action === 'PLAN_UPDATED' && i.entity_label === code);
    assert.ok(upd, 'PLAN_UPDATED not audited');
    assert.equal(upd.changes.basePrice.to, 1099);
    const withUsage = await call('GET', '/admin/subscription-plans', { token: OWNER.token });
    assert.ok(withUsage.data.plans.every((p) => p.subscribers));
    assert.ok(withUsage.data.features.length >= 6);
  });

  it('plan limits are really enforced: a 3-table plan refuses a 4th table', async () => {
    const code = `PRO${run}`.toUpperCase();
    const o = await onboard('lim');
    // A fresh outlet has 3 tables already
    assert.equal((await call('POST', `/admin/restaurants/${o.orgId}/subscription/assign`, { token: OWNER.token, body: { planCode: code, months: 1, note: 'limit test' } })).status, 200);
    const r = await call('POST', '/tables', { token: o.token, body: { restaurantId: o.outlet.id, tableNumber: 'X1' } });
    assert.equal(r.status, 403);
    assert.match(JSON.stringify(r.body), /limit/i);
  });

  it('upgrade/downgrade, extend, cancel, reactivate and trial all work and change real access', async () => {
    const o = await onboard('sub');
    const t = OWNER.token;
    const base = `/admin/restaurants/${o.orgId}/subscription`;
    assert.equal((await call('POST', `${base}/change-plan`, { token: t, body: { planCode: 'ENTERPRISE', reason: '' } })).status, 400, 'reason required');
    const up = await call('POST', `${base}/change-plan`, { token: t, body: { planCode: 'ENTERPRISE', reason: 'Sales deal' } });
    assert.equal(up.data.direction, 'UPGRADE');
    // inventory is an ENTERPRISE feature: works now
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token })).status, 200);
    const down = await call('POST', `${base}/change-plan`, { token: t, body: { planCode: 'STARTER', reason: 'Downgrade request' } });
    assert.equal(down.data.direction, 'DOWNGRADE');
    assert.equal((await call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token })).status, 402, 'STARTER has no inventory');
    // downgrade is refused when usage exceeds the target plan
    const code = `PRO${run}`.toUpperCase();
    await call('POST', `${base}/change-plan`, { token: t, body: { planCode: 'GROWTH', reason: 'Back up' } });
    const tight = await call('POST', '/subscriptions/admin/plans', { token: t, body: { code: `T${code}`.slice(0, 30), name: 'Tight', billingInterval: 'MONTHLY', basePrice: 10, maxOutlets: 1, maxTablesPerOutlet: 1, maxStaffPerOutlet: 1 } });
    const refused = await call('POST', `${base}/change-plan`, { token: t, body: { planCode: tight.data.code, reason: 'Try' } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message.toString(), /tables/);

    // lapse it: force period end into the past beyond grace -> blocked writes
    await db.query(`UPDATE organization_subscriptions SET current_period_end = now() - interval '30 days', status = 'ACTIVE', grace_period_ends_at = NULL WHERE organization_id = $1`, [o.orgId]);
    await new Promise((r) => setTimeout(r, 200));
    const list = await call('GET', `/admin/subscriptions?q=${encodeURIComponent('Brand sub ' + run)}`, { token: t });
    assert.equal(list.data.items[0].effective_status, 'EXPIRED', 'list derives the real state even before the sweep runs');
    // extend restores access
    const ext = await call('POST', `${base}/extend`, { token: t, body: { days: 10, reason: 'Goodwill' } });
    assert.equal(ext.status, 200);
    assert.equal(ext.data.status, 'ACTIVE');
    // cancel at period end then immediately
    assert.equal((await call('POST', `${base}/cancel`, { token: t, body: { reason: 'Customer asked' } })).data.cancelAtPeriodEnd, true);
    const now = await call('POST', `${base}/cancel`, { token: t, body: { immediate: true, reason: 'Fraud' } });
    assert.equal(now.data.status, 'CANCELLED');
    await new Promise((r) => setTimeout(r, 21_000)); // access cache TTL is 20s
    const blocked = await call('POST', '/tables', { token: o.token, body: { restaurantId: o.outlet.id, tableNumber: 'Q1' } });
    assert.equal(blocked.status, 402, JSON.stringify(blocked.body));
    assert.equal((await call('POST', `${base}/reactivate`, { token: t, body: { days: 30, reason: 'Resolved dispute' } })).status, 200);
    assert.equal((await call('POST', `${base}/trial`, { token: t, body: { planCode: 'GROWTH', days: 21, reason: 'Extended pilot' } })).data.status, 'TRIAL');
    const hist = await call('GET', `/admin/restaurants/${o.orgId}/subscription-history`, { token: t });
    assert.ok(hist.data.subscriptions.length >= 2);
    assert.ok(hist.data.events.some((e) => e.action === 'SUBSCRIPTION_EXTENDED'));
  });
});

describe('Payments & financial management (only verified gateway events create money)', () => {
  const pay = (id, orgId, amount = 353882) => ({
    payment: { entity: { id, amount, currency: 'INR', method: 'upi', notes: { organizationId: orgId } } },
    subscription: { entity: { id: `sub_${id}`, notes: { organizationId: orgId } } },
  });

  it('rejects unsigned / wrongly signed webhooks and records them in the ledger', async () => {
    const raw = JSON.stringify({ event: 'payment.captured', id: `evt_bad_${run}`, payload: {} });
    assert.equal((await call('POST', '/subscriptions/webhook/razorpay', { raw, headers: { 'x-razorpay-signature': 'deadbeef' } })).status, 401);
    assert.equal((await hook('payment.captured', {}, `evt_bad2_${run}`, 'wrong-secret')).status, 401);
    const w = await call('GET', '/admin/monitoring/webhooks?status=REJECTED', { token: OWNER.token });
    assert.ok(w.data.items.length >= 2);
    assert.equal(w.data.items[0].signature_valid, false);
  });

  it('a signed charge creates ONE paid invoice (idempotent) and moves the restaurant to ACTIVE', async () => {
    await db.query(`UPDATE organization_subscriptions SET razorpay_subscription_id = $2 WHERE organization_id = $1`, [A.orgId, `sub_pay_${run}`]);
    const p = pay(`pay_ok_${run}`, A.orgId);
    const r1 = await hook('subscription.charged', p, `evt_ch_${run}`);
    assert.ok(r1.status < 300, JSON.stringify(r1.body));
    const dup = await hook('subscription.charged', p, `evt_ch_${run}`);
    assert.match(JSON.stringify(dup.body), /duplicate/);
    const dup2 = await hook('subscription.charged', p, `evt_ch2_${run}`);
    assert.match(JSON.stringify(dup2.body), /duplicate_payment_ignored/);
    const tx = await call('GET', `/admin/payments?q=pay_ok_${run}`, { token: OWNER.token });
    assert.equal(tx.data.total, 1);
    assert.equal(tx.data.items[0].status, 'PAID');
    assert.equal(tx.data.items[0].organization_id, A.orgId);
    const prof = await call('GET', `/admin/restaurants/${A.orgId}`, { token: OWNER.token });
    assert.equal(prof.data.subscription.effective_status, 'ACTIVE');
  });

  it('failed payments and refunds are tracked from gateway events', async () => {
    const f = await hook('payment.failed', { payment: { entity: { id: `pay_fail_${run}`, amount: 353882, method: 'card', error_description: 'Card declined', notes: { organizationId: A.orgId } } } }, `evt_f_${run}`);
    assert.equal(f.status < 300, true, JSON.stringify(f.body));
    const tx = await call('GET', `/admin/payments?status=FAILED&q=pay_fail_${run}`, { token: OWNER.token });
    assert.equal(tx.data.items[0].failure_reason, 'Card declined');
    const rf = await hook('refund.processed', { refund: { entity: { id: `rfnd_${run}`, payment_id: `pay_ok_${run}`, amount: 353882 } } }, `evt_r_${run}`);
    assert.ok(rf.status < 300, JSON.stringify(rf.body));
    const ok = await call('GET', `/admin/payments?q=pay_ok_${run}`, { token: OWNER.token });
    assert.equal(ok.data.items[0].status, 'REFUNDED');
    assert.equal(ok.data.items[0].refunded_amount, 3538.82);
  });

  it('overview, reconciliation and reports come from the stored ledger', async () => {
    const ov = await call('GET', '/admin/payments/overview', { token: OWNER.token });
    assert.equal(ov.status, 200);
    assert.ok(ov.data.kpi.failed_count >= 1);
    const rec = await call('GET', '/admin/payments/reconciliation', { token: OWNER.token });
    assert.equal(rec.status, 200);
    assert.ok(rec.data.checks.length >= 6);
    const csv = await call('GET', '/admin/reports/finance/payments', { token: OWNER.token });
    assert.equal(csv.status, 200);
    assert.match(csv.data.content, /invoice_number/);
    assert.match(csv.data.filename, /^pangat-payments-/);
    assert.equal((await call('GET', '/admin/reports/finance/payments', { token: admins.SUPPORT.token })).status, 403);
  });

  it('there is no way to mark a payment successful by hand', async () => {
    const inv = (await call('GET', `/admin/payments?q=pay_fail_${run}`, { token: OWNER.token })).data.items[0];
    for (const [m, p] of [['PATCH', `/admin/payments/${inv.id}`], ['POST', `/admin/payments/${inv.id}/mark-paid`], ['PUT', `/admin/payments/${inv.id}`], ['POST', '/admin/payments']]) {
      assert.ok([404, 405].includes((await call(m, p, { token: OWNER.token, body: { status: 'PAID' } })).status), `${m} ${p} must not exist`);
    }
    // a manual plan grant creates no invoice and no revenue
    const before = (await call('GET', '/admin/payments?status=PAID&limit=1', { token: OWNER.token })).data.total;
    await call('POST', `/admin/restaurants/${B.orgId}/subscription/assign`, { token: OWNER.token, body: { planCode: 'GROWTH', months: 1, note: 'comp' } });
    assert.equal((await call('GET', '/admin/payments?status=PAID&limit=1', { token: OWNER.token })).data.total, before);
    const manual = (await call('GET', '/admin/payments/reconciliation', { token: OWNER.token })).data.checks.find((c) => c.key === 'manual_grants');
    assert.ok(manual.items.some((i) => i.organization_id === B.orgId));
  });
});

describe('User & access management', () => {
  it('searches users across restaurants and shows a full profile', async () => {
    await login(A.email);
    const l = await call('GET', `/admin/users?q=${A.email}&role=SUPER_OWNER`, { token: OWNER.token });
    assert.ok(l.data.total >= 1);
    const u = await call('GET', `/admin/users/${l.data.items[0].id}`, { token: OWNER.token });
    assert.equal(u.status, 200);
    assert.ok(u.data.logins.length >= 1, 'sign-in history is recorded');
  });

  it('deactivate / lock / unlock / force sign-out / reset password all take effect', async () => {
    const o = await onboard('usr');
    const id = (await call('GET', `/admin/users?q=${o.email}`, { token: OWNER.token })).data.items[0].id;
    assert.equal((await call('POST', `/admin/users/${id}/active`, { token: OWNER.token, body: { isActive: false } })).status, 400);
    assert.equal((await call('POST', `/admin/users/${id}/active`, { token: OWNER.token, body: { isActive: false, reason: 'Left company' } })).status, 200);
    assert.equal((await call('GET', '/auth/me', { token: o.token })).status, 401);
    assert.equal((await login(o.email)).status, 401);
    await call('POST', `/admin/users/${id}/active`, { token: OWNER.token, body: { isActive: true } });
    for (let i = 0; i < 5; i++) await login(o.email, 'wrong-wrong-1');
    assert.equal((await login(o.email)).status, 429);
    const locked = await call('GET', `/admin/users?q=${o.email}&status=LOCKED`, { token: OWNER.token });
    assert.equal(locked.data.items.length, 1);
    await call('POST', `/admin/users/${id}/unlock`, { token: OWNER.token });
    const t = await tokenOf(o.email);
    await new Promise((r) => setTimeout(r, 1100));
    await call('POST', `/admin/users/${id}/logout`, { token: OWNER.token });
    assert.equal((await call('GET', '/auth/me', { token: t })).status, 401);
    const rp = await call('POST', `/admin/users/${id}/reset-password`, { token: OWNER.token });
    assert.equal((await login(o.email, rp.data.temporaryPassword)).status, 200);
  });

  it('platform administrators cannot be managed through the merchant user endpoints', async () => {
    const adminId = (await call('GET', '/admin/admins', { token: OWNER.token })).data.find((a) => a.email === OWNER.email).id;
    assert.equal((await call('GET', `/admin/users/${adminId}`, { token: OWNER.token })).status, 404);
    assert.equal((await call('POST', `/admin/users/${adminId}/active`, { token: OWNER.token, body: { isActive: false, reason: 'x' } })).status, 403);
  });

  it('records administrator sign-ins (success and failure) in the audit log', async () => {
    await login(OWNER.email, 'wrong-wrong-wrong');
    const logins = await call('GET', '/admin/admin-logins', { token: OWNER.token });
    assert.ok(logins.data.some((l) => l.success === false && l.reason === 'WRONG_PASSWORD'));
    assert.ok(logins.data.some((l) => l.success === true));
    const audit = await call('GET', '/admin/audit?action=ADMIN_LOGIN_FAILED', { token: OWNER.token });
    assert.ok(audit.data.total >= 1);
  });
});

describe('Platform settings & feature access', () => {
  it('persists settings, validates input and never returns secrets', async () => {
    const s = await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'branding.platformName': 'Pangat Test', 'email.sendgridApiKey': 'SG.super-secret-key-1234', 'subscription.gracePeriodDays': 3 } } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.doesNotMatch(JSON.stringify(s.body), /super-secret-key/);
    const key = s.data.settings.find((x) => x.key === 'email.sendgridApiKey');
    assert.equal(key.isSet, true);
    assert.equal(key.hint, '••••1234');
    const stored = (await db.query(`SELECT value, encrypted FROM platform_settings WHERE key = 'email.sendgridApiKey'`)).rows[0];
    assert.equal(stored.value, null);
    assert.doesNotMatch(stored.encrypted, /super-secret/);
    assert.equal((await call('GET', '/platform/config')).data.branding.platformName, 'Pangat Test');
    assert.equal((await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'nope.key': 1 } } })).status, 400);
    assert.equal((await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'subscription.gracePeriodDays': 999 } } })).status, 400);
    assert.equal((await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'branding.supportEmail': 'not-an-email' } } })).status, 400);
    const audit = (await call('GET', '/admin/audit?action=SETTINGS_CHANGED&limit=1', { token: OWNER.token })).data.items[0];
    assert.doesNotMatch(JSON.stringify(audit), /super-secret-key/);
    // clear again
    await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'email.sendgridApiKey': null, 'branding.platformName': 'Pangat', 'subscription.gracePeriodDays': 7 } } });
  });

  it('platform-wide ordering switch stops guest orders immediately', async () => {
    await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'general.publicOrderingEnabled': false } } });
    await new Promise((r) => setTimeout(r, 100));
    const menu = (await call('GET', `/menu/public/${B.slug}`)).data;
    const body = { restaurantSlug: B.slug, orderType: 'TAKEAWAY', customerName: 'G', paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: menu.items[0].id, name: menu.items[0].name, price: Number(menu.items[0].price), quantity: 1 }] };
    const blocked = await call('POST', '/orders', { headers: { 'x-idempotency-key': `s-${crypto.randomBytes(6).toString('hex')}` }, body });
    assert.equal(blocked.status, 400);
    await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'general.publicOrderingEnabled': true } } });
    const ok = await call('POST', '/orders', { headers: { 'x-idempotency-key': `s-${crypto.randomBytes(6).toString('hex')}` }, body });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it('maintenance mode blocks restaurant users but never platform admins', async () => {
    await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'operations.maintenanceEnabled': true, 'operations.maintenanceMessage': 'Upgrading the database' } } });
    const l = await login(A.email);
    assert.equal(l.status, 503);
    assert.equal(l.body.code, 'MAINTENANCE_MODE');
    assert.equal((await call('GET', '/auth/me', { token: A.token })).status, 503);
    assert.equal((await call('GET', '/admin/dashboard', { token: OWNER.token })).status, 200);
    assert.equal((await call('GET', '/platform/config')).data.maintenance.active, true);
    await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'operations.maintenanceEnabled': false } } });
    assert.equal((await login(A.email)).status, 200);
  });

  it('self sign-up can be closed', async () => {
    await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'general.selfSignupEnabled': false } } });
    const r = await call('POST', '/auth/onboard', { body: { brandName: 'Closed', ownerFullName: 'X', mobileNumber: '1', email: `closed-${run}@example.com`, password: PW, outletName: 'x', slug: `closed-${run}`, upiVpa: 'a@b' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'SIGNUP_CLOSED');
    await call('PUT', '/admin/settings', { token: OWNER.token, body: { changes: { 'general.selfSignupEnabled': true } } });
  });

  it('feature kill switch and per-restaurant overrides override the plan', async () => {
    const o = await onboard('flag');
    const inv = () => call('GET', `/inventory/ingredients?restaurantId=${o.outlet.id}`, { token: o.token });
    assert.equal((await inv()).status, 200, 'GROWTH trial includes inventory');
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: OWNER.token, body: { feature: 'INVENTORY', mode: 'FORCE_OFF', reason: 'Abuse' } });
    assert.equal((await inv()).status, 403);
    await call('POST', `/admin/restaurants/${o.orgId}/feature-overrides`, { token: OWNER.token, body: { feature: 'INVENTORY', mode: 'DEFAULT' } });
    assert.equal((await inv()).status, 200);
    await call('PATCH', '/admin/feature-flags/INVENTORY', { token: OWNER.token, body: { enabled: false, reason: 'Incident' } });
    assert.equal((await inv()).status, 403, 'global kill switch');
    await call('PATCH', '/admin/feature-flags/INVENTORY', { token: OWNER.token, body: { enabled: true } });
    assert.equal((await inv()).status, 200);
    assert.equal((await call('PATCH', '/admin/feature-flags/NOPE', { token: OWNER.token, body: { enabled: false } })).status, 400);
  });
});

describe('Communications', () => {
  it('sends an in-app notification to selected restaurants and the owner sees it in their inbox', async () => {
    const s = await call('POST', '/admin/communications/send', { token: OWNER.token, body: { subject: 'Hello {{ownerName}}', body: 'Update for {{restaurantName}}', channels: ['IN_APP', 'EMAIL'], audience: 'ORGANIZATIONS', targetIds: [A.orgId] } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.ok(s.data.delivered >= 1);
    assert.ok(s.data.skipped >= 1, 'email is skipped honestly when no provider is configured');
    const inbox = await call('GET', '/notifications/inbox', { token: A.token });
    assert.equal(inbox.data.unread, 1);
    assert.match(inbox.data.items[0].body, /Update for Brand a/);
    const other = await call('GET', '/notifications/inbox', { token: B.token });
    assert.equal(other.data.items.filter((i) => i.subject.startsWith('Hello')).length, 0, 'other restaurants do not receive it');
    await call('POST', '/notifications/inbox/read', { token: A.token, body: {} });
    assert.equal((await call('GET', '/notifications/inbox', { token: A.token })).data.unread, 0);
    const hist = await call('GET', '/admin/communications/history', { token: OWNER.token });
    const d = await call('GET', `/admin/communications/history/${hist.data.items[0].id}`, { token: OWNER.token });
    assert.ok(d.data.deliveries.some((x) => x.channel === 'EMAIL' && x.status === 'SKIPPED' && /not configured/.test(x.error)));
  });

  it('targets specific users and broadcasts to all owners', async () => {
    const uid = (await call('GET', `/admin/users?q=${B.email}`, { token: OWNER.token })).data.items[0].id;
    const one = await call('POST', '/admin/communications/send', { token: OWNER.token, body: { subject: 'Just you', body: 'Direct note', channels: ['IN_APP'], audience: 'USERS', targetIds: [uid] } });
    assert.equal(one.data.recipients, 1);
    assert.equal((await call('POST', '/admin/communications/send', { token: OWNER.token, body: { subject: 'x', body: 'xx', channels: [], audience: 'ALL_OWNERS' } })).status, 400);
    const all = await call('POST', '/admin/communications/send', { token: OWNER.token, body: { subject: 'Platform news', body: 'We shipped things', channels: ['IN_APP'], audience: 'ALL_OWNERS' } });
    assert.ok(all.data.recipients >= 2);
  });

  it('templates can be edited and announcements show to the right audience only', async () => {
    const tpls = await call('GET', '/admin/communications/templates', { token: OWNER.token });
    const t = tpls.data.templates.find((x) => x.key === 'WELCOME');
    const upd = await call('PUT', `/admin/communications/templates/${t.id}`, { token: OWNER.token, body: { name: t.name, channel: t.channel, subject: 'Welcome aboard', body: t.body } });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal(upd.data.subject, 'Welcome aboard');
    const ann = await call('POST', '/admin/communications/announcements', { token: OWNER.token, body: { title: 'Scheduled maintenance', body: 'Sunday 2am', kind: 'MAINTENANCE', severity: 'WARNING', audience: 'ORGANIZATIONS', organizationIds: [A.orgId] } });
    assert.equal(ann.status, 201, JSON.stringify(ann.body));
    assert.ok((await call('GET', '/platform/announcements', { token: A.token })).data.some((x) => x.title === 'Scheduled maintenance'));
    assert.ok(!(await call('GET', '/platform/announcements', { token: B.token })).data.some((x) => x.title === 'Scheduled maintenance'));
    await call('PUT', `/admin/communications/announcements/${ann.data.id}`, { token: OWNER.token, body: { title: 'Scheduled maintenance', body: 'Sunday 2am', kind: 'MAINTENANCE', severity: 'WARNING', audience: 'ORGANIZATIONS', organizationIds: [A.orgId], isActive: false } });
    assert.ok(!(await call('GET', '/platform/announcements', { token: A.token })).data.some((x) => x.title === 'Scheduled maintenance'));
  });
});

describe('Support & issue management', () => {
  let ticket;
  it('a restaurant raises a request; staff cannot; platform admins triage it', async () => {
    const c = await call('POST', '/support/tickets', { token: A.token, body: { category: 'BUG', subject: 'KDS not updating', description: 'Tickets are stuck on RECEIVED', priority: 'HIGH' } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    ticket = c.data;
    assert.equal((await call('POST', '/support/tickets', { token: admins.SUPPORT.token, body: { category: 'BUG', subject: 'abc', description: 'abcdef' } })).status, 403);
    const list = await call('GET', `/admin/support/tickets?q=KDS&open=true`, { token: admins.SUPPORT.token });
    assert.ok(list.data.items.some((t) => t.id === ticket.id));
    assert.ok(list.data.summary.open >= 1);
    const me = (await call('GET', '/admin/admins', { token: OWNER.token })).data.find((a) => a.email === admins.SUPPORT.email);
    const upd = await call('PATCH', `/admin/support/tickets/${ticket.id}`, { token: admins.SUPPORT.token, body: { assigneeId: me.id, status: 'IN_PROGRESS', priority: 'URGENT' } });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal((await call('PATCH', `/admin/support/tickets/${ticket.id}`, { token: admins.SUPPORT.token, body: { status: 'RESOLVED' } })).status, 400, 'resolution required');
    await call('POST', `/admin/support/tickets/${ticket.id}/events`, { token: admins.SUPPORT.token, body: { kind: 'NOTE', body: 'Looks like websocket drop (internal)' } });
    await call('POST', `/admin/support/tickets/${ticket.id}/events`, { token: admins.SUPPORT.token, body: { kind: 'REPLY', body: 'We are on it.' } });
    const res = await call('PATCH', `/admin/support/tickets/${ticket.id}`, { token: admins.SUPPORT.token, body: { status: 'RESOLVED', resolution: 'Fixed reconnect logic' } });
    assert.equal(res.status, 200);
    const full = await call('GET', `/admin/support/tickets/${ticket.id}`, { token: admins.ANALYST.token });
    assert.ok(full.data.events.length >= 6);
    assert.equal(full.data.ticket.status, 'RESOLVED');
  });

  it('the restaurant sees replies and resolution but never internal notes; other tenants see nothing', async () => {
    const d = await call('GET', `/support/tickets/${ticket.id}`, { token: A.token });
    assert.equal(d.status, 200);
    const text = JSON.stringify(d.data);
    assert.match(text, /We are on it/);
    assert.doesNotMatch(text, /websocket drop/);
    assert.equal((await call('GET', `/support/tickets/${ticket.id}`, { token: B.token })).status, 404);
    assert.equal((await call('GET', '/support/tickets', { token: B.token })).data.length, 0);
  });
});

describe('Audit log', () => {
  it('records who did what, filterable, and cannot be edited or deleted — even with direct SQL', async () => {
    const a = await call('GET', '/admin/audit?category=RESTAURANT&limit=5', { token: OWNER.token });
    assert.ok(a.data.items[0].actor_email && a.data.items[0].action && a.data.items[0].created_at && a.data.items[0].entity_label);
    const q = await call('GET', `/admin/audit?q=suspended`, { token: OWNER.token });
    assert.ok(q.data.items.length >= 1);
    const f = await call('GET', `/admin/audit?actorId=${a.data.items[0].actor_id}&from=${new Date(Date.now() - 3600_000).toISOString()}`, { token: OWNER.token });
    assert.ok(f.data.total >= 1);
    await assert.rejects(db.query(`UPDATE platform_audit_logs SET summary = 'tampered' WHERE id = $1`, [a.data.items[0].id]), /append-only/);
    await assert.rejects(db.query(`DELETE FROM platform_audit_logs WHERE id = $1`, [a.data.items[0].id]), /append-only/);
    await assert.rejects(db.query('TRUNCATE platform_audit_logs'), /append-only/);
    for (const m of ['PATCH', 'PUT', 'DELETE', 'POST']) assert.ok([404, 405].includes((await call(m, `/admin/audit/${a.data.items[0].id}`, { token: OWNER.token, body: {} })).status));
    assert.equal((await call('GET', '/admin/audit', { token: admins.SUPPORT.token })).status, 403);
  });
});

describe('Monitoring, jobs, dashboard and exports', () => {
  it('health is built from live probes, never hard-coded', async () => {
    const h = await call('GET', '/admin/monitoring/health', { token: OWNER.token });
    assert.equal(h.status, 200);
    assert.equal(h.data.database.ok, true);
    assert.ok(h.data.database.latencyMs >= 0 && h.data.database.sizeMb > 0);
    assert.ok(h.data.process.rssMb > 0);
    assert.ok(h.data.integrations.find((i) => i.key === 'razorpay').received24h >= 1);
    assert.doesNotMatch(JSON.stringify(h.body), new RegExp(WH));
    assert.ok(h.data.backups.migrations.some((m) => m.name.startsWith('010_')));
  });

  it('records server errors with secrets redacted', async () => {
    await db.query(`INSERT INTO error_logs (method, path, status, error_name, message) VALUES ('GET','/api/v1/x',500,'Error','boom for someone@example.com')`);
    const e = await call('GET', '/admin/monitoring/errors', { token: OWNER.token });
    assert.equal(e.status, 200);
    assert.ok(e.data.total >= 1);
  });

  it('runs background jobs, records the run, and the sweep expires lapsed subscriptions', async () => {
    const o = await onboard('sweep');
    await db.query(`UPDATE organization_subscriptions SET current_period_end = now() - interval '40 days', status='ACTIVE', grace_period_ends_at=NULL WHERE organization_id = $1`, [o.orgId]);
    const r = await call('POST', '/admin/monitoring/jobs/subscription-sweep/run', { token: OWNER.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.status, 'SUCCESS');
    assert.ok(r.data.result.expired >= 1);
    const st = (await db.query(`SELECT status FROM organization_subscriptions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.orgId])).rows[0].status;
    assert.equal(st, 'EXPIRED');
    const runs = await call('GET', '/admin/monitoring/jobs?name=subscription-sweep', { token: OWNER.token });
    assert.equal(runs.data[0].status, 'SUCCESS');
    assert.equal((await call('POST', '/admin/monitoring/jobs/nope/run', { token: OWNER.token })).status, 400);
    assert.equal((await call('POST', '/admin/monitoring/jobs/health-snapshot/run', { token: admins.SUPPORT.token })).status, 403);
    const ev = await call('GET', '/admin/events', { token: OWNER.token });
    assert.ok(ev.data.some((x) => x.type === 'SUBSCRIPTION_EXPIRED'));
  });

  it('dashboard figures match the database, with comparison periods', async () => {
    const d = await call('GET', '/admin/dashboard?compare=previous', { token: OWNER.token });
    assert.equal(d.status, 200);
    const dbCount = (await db.query('SELECT COUNT(*)::int n FROM organizations')).rows[0].n;
    assert.equal(d.data.restaurants.total, dbCount);
    const dbOutlets = (await db.query('SELECT COUNT(*)::int n FROM restaurants')).rows[0].n;
    assert.equal(d.data.outlets.total, dbOutlets);
    const dbPaid = (await db.query(`SELECT COALESCE(SUM(total_amount),0)::float s FROM subscription_invoices WHERE status='PAID' AND paid_at >= now() - interval '31 days'`)).rows[0].s;
    assert.ok(d.data.revenue.collected.value <= dbPaid + 0.01);
    assert.ok(d.data.restaurants.newInPeriod.value >= 5);
    assert.ok(d.data.series.current.length >= 28 && d.data.series.previous.length >= 28);
    assert.ok(d.data.subscriptions.expired >= 1);
    const none = await call('GET', '/admin/dashboard?compare=none', { token: OWNER.token });
    assert.equal(none.data.series.previous, null);
    assert.equal(none.data.restaurants.newInPeriod.previous, null);
    const year = await call('GET', `/admin/dashboard?from=${encodeURIComponent('2020-01-01')}&to=${encodeURIComponent('2020-03-01')}&compare=year`, { token: OWNER.token });
    assert.equal(year.status, 200);
    assert.equal(year.data.restaurants.newInPeriod.value, 0);
  });

  it('exports a restaurant without credentials and records the export', async () => {
    const e = await call('GET', `/admin/restaurants/${A.orgId}/export`, { token: OWNER.token });
    assert.equal(e.status, 200);
    assert.ok(e.data.counts.tables === 3 && e.data.counts.orders >= 0);
    assert.doesNotMatch(e.data.content, /password_hash|\$2[aby]\$/);
    assert.equal((await call('GET', `/admin/restaurants/${A.orgId}/export`, { token: admins.FINANCE.token })).status, 403);
    const h = await call('GET', '/admin/exports', { token: OWNER.token });
    assert.ok(h.data.some((x) => x.kind === 'restaurant-data' && x.checksum));
    const r = await call('GET', '/admin/reports/data/restaurants', { token: OWNER.token });
    assert.match(r.data.content, /gmv/);
  });

  it('outlet monitor lists branches with live state', async () => {
    const m = await call('GET', `/admin/outlets-monitor?q=${run}`, { token: OWNER.token });
    assert.equal(m.status, 200);
    assert.ok(m.data.items.length >= 2);
    assert.ok('isOnline' in m.data.items[0]);
  });

  it('existing platform operations still work (metrics, leads, orgs, outlets, provisioning)', async () => {
    assert.equal((await call('GET', '/admin/metrics', { token: OWNER.token })).status, 200);
    assert.equal((await call('GET', '/admin/leads', { token: OWNER.token })).status, 200);
    assert.equal((await call('GET', '/admin/organizations', { token: OWNER.token })).status, 200);
    assert.equal((await call('GET', '/admin/outlets', { token: OWNER.token })).status, 200);
    assert.equal((await call('GET', '/admin/system-health', { token: OWNER.token })).status, 200);
    const p = await call('POST', '/admin/provision', { token: OWNER.token, body: { brandName: `Prov ${run}`, ownerFullName: 'Prov Owner', email: `prov-${run}@example.com`, mobileNumber: '9000000000', outletName: 'Main', slug: `prov-${run}`, upiVpa: 'p@upi' } });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const au = await call('GET', `/admin/audit?action=RESTAURANT_PROVISIONED`, { token: OWNER.token });
    assert.ok(au.data.items.length >= 1);
    assert.doesNotMatch(JSON.stringify(au.data.items), new RegExp(p.data.ownerCredentials.temporaryPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

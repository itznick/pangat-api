/**
 * PILOT ACCEPTANCE: the whole journey from a prospect's first message to a settled, refunded and audited order, on a RUNNING API against a
 * THROWAWAY database. Test data only (never run it against production or staging with real people).
 *
 *   node --test --test-concurrency=1 test/pilot-acceptance.e2e.test.mjs            # prints a step table
 *   UAT_REPORT=/path/PILOT_UAT_RESULTS.md node --test ... test/pilot-acceptance.e2e.test.mjs   # also writes it
 *
 * Steps run in order; a failed step makes the later ones that depend on it fail too, which is the point: the report shows exactly where the
 * journey breaks. It is repeatable: every run uses a new restaurant.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const BOOT = process.env.PLATFORM_BOOTSTRAP_SECRET || 'bootstrapsecret1234567';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const SLUG = `uat-${run}`;
const db = new pg.Client({ connectionString: DB });
let seq = 0;

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data };
}
const must = (r, status, what) => assert.ok(Array.isArray(status) ? status.includes(r.status) : r.status === status, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`);

const S = {}; // shared state across steps
const results = [];
function step(n, title, fn) {
  it(`${String(n).padStart(2, '0')} ${title}`, async () => {
    const t0 = Date.now();
    try { await fn(); results.push({ n, title, ok: true, ms: Date.now() - t0 }); }
    catch (e) { results.push({ n, title, ok: false, ms: Date.now() - t0, why: String(e.message).split('\n')[0].slice(0, 200) }); throw e; }
  });
}
const placeOrder = async (extra = {}) => {
  const it0 = S.menu.items.find((i) => i.name === 'Masala Chai') || S.menu.items[0];
  return call('POST', '/orders', { headers: { 'x-idempotency-key': `uat-${run}-${++seq}` }, body: { restaurantSlug: SLUG, orderType: 'DINE_IN', tableNumber: 'T01', paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: it0.id, name: it0.name, price: Number(it0.price), quantity: 1 }], ...extra } });
};

before(async () => {
  await db.connect();
  const email = `root-${run}@pangat.test`;
  const r = await call('POST', '/auth/setup-super-admin', { headers: { 'x-bootstrap-secret': BOOT }, body: { name: 'Root Admin', email, password: PW } });
  if (r.status !== 201) {
    const { default: bcrypt } = await import('bcrypt');
    await db.query(`INSERT INTO staff (name, email, password_hash, role, is_platform_admin, platform_role) VALUES ('Root Admin', $1, $2, 'PLATFORM_SUPER_ADMIN', true, 'OWNER')`, [email, await bcrypt.hash(PW, 10)]);
  }
  S.admin = (await call('POST', '/auth/login', { body: { email, password: PW } })).data.accessToken;
});
after(async () => {
  await db.end();
  const pass = results.filter((r) => r.ok).length;
  const lines = [
    `# Pilot acceptance run (${new Date().toISOString().slice(0, 10)})`, '',
    `Restaurant slug: \`${SLUG}\` (test data on a throwaway database). **${pass} of ${results.length} steps passed.**`, '',
    '| # | Step | Result | Time |', '|---|---|---|---|',
    ...results.sort((a, b) => a.n - b.n).map((r) => `| ${r.n} | ${r.title} | ${r.ok ? 'PASS' : `FAIL: ${r.why}`} | ${r.ms} ms |`),
  ];
  console.log('\n' + lines.join('\n'));
  if (process.env.UAT_REPORT) fs.writeFileSync(process.env.UAT_REPORT, lines.join('\n') + '\n');
});

describe('Pilot acceptance journey', () => {
  step(1, 'A prospect submits the lead form (with consent)', async () => {
    const r = await call('POST', '/leads', { body: { name: 'Rhea Restaurateur', restaurantName: `UAT Cafe ${run}`, phone: '9876500123', city: 'Pune', tableCount: '10-20', consentAccepted: true } });
    must(r, 201, 'lead'); S.lead = r.data;
  });

  step(2, 'The operator sees the lead and an alert event in Super Admin', async () => {
    const leads = await call('GET', '/admin/leads', { token: S.admin }); must(leads, 200, 'leads');
    assert.ok((leads.data.items ?? leads.data).some((l) => l.restaurantName === `UAT Cafe ${run}`), `lead missing: ${JSON.stringify(leads.data).slice(0, 200)}`);
    const ev = await call('GET', '/admin/events?limit=50', { token: S.admin }); must(ev, 200, 'events');
    assert.ok(ev.data.some((e) => e.type === 'NEW_LEAD' && e.title.includes(`UAT Cafe ${run}`)), 'a NEW_LEAD event exists');
  });

  step(3, 'The operator provisions the restaurant from the lead (no UPI ID invented, 14-day trial plan)', async () => {
    const r = await call('POST', '/admin/provision', { token: S.admin, body: { brandName: `UAT Cafe ${run}`, ownerFullName: 'Rhea Restaurateur', email: `owner-${run}@example.com`, mobileNumber: '9876500123', outletName: `UAT Cafe ${run} Main`, slug: SLUG, branchArea: 'Pune', upiVpa: '', gstPercentage: 5, indoorTableCount: 4, outdoorTableCount: 0, menuPreset: 'blank', leadId: S.lead.id } });
    must(r, 201, 'provision'); S.prov = r.data;
    assert.equal(r.data.outlet.upiVpa, '');
    const plan = (await db.query(`SELECT p.code FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.organization_id = $1`, [r.data.organization.id])).rows[0];
    assert.equal(plan.code, 'PANGAT_TRIAL');
    S.orgId = r.data.organization.id; S.outletId = r.data.outlet.id;
  });

  step(4, 'The owner receives credentials and signs in with the temporary password', async () => {
    const tp = S.prov.ownerCredentials.temporaryPassword;
    assert.ok(tp, 'no email provider is configured, so the operator is handed the temporary password to pass on');
    const r = await call('POST', '/auth/login', { body: { email: S.prov.ownerCredentials.email, password: tp } });
    must(r, 200, 'owner login'); S.ownerFirst = r.data; assert.equal(r.data.user.mustChangePassword, true);
  });

  step(5, 'The owner must choose their own password before anything else works', async () => {
    const blocked = await call('GET', `/tables?restaurantId=${S.outletId}`, { token: S.ownerFirst.accessToken });
    assert.ok([401, 403].includes(blocked.status), `work screens must be closed until the password is changed (got ${blocked.status})`);
    const ch = await call('POST', '/auth/change-password', { token: S.ownerFirst.accessToken, body: { currentPassword: S.prov.ownerCredentials.temporaryPassword, newPassword: 'Mango-Tree-Kothrud-31' } });
    must(ch, 200, 'change password');
    must(await call('POST', '/auth/login', { body: { email: S.prov.ownerCredentials.email, password: S.prov.ownerCredentials.temporaryPassword } }), 401, 'old password must stop working');
    const me = await call('POST', '/auth/login', { body: { email: S.prov.ownerCredentials.email, password: 'Mango-Tree-Kothrud-31' } });
    must(me, 200, 'login with own password'); S.owner = me.data.accessToken;
  });

  step(6, 'The owner sets up the restaurant profile (GST) in Settings', async () => {
    const r = await call('PATCH', `/restaurants/${SLUG}/settings`, { token: S.owner, body: { gstin: '27AAPFU0939F1ZV', gstPercentage: 5, phone: '9876500123' } });
    must(r, 200, 'settings');
  });

  step(7, 'The owner imports the menu from a spreadsheet (check first, then import)', async () => {
    const csv = 'category,name,price,description,veg\nBeverages,Masala Chai,20,Strong tea,veg\nBeverages,Cold Coffee,60,,veg\nSnacks,Chicken Roll,90,"Spicy, with onions",non-veg\nMains,Paneer Thali,180,,veg\n';
    const pv = await call('POST', '/menu/import', { token: S.owner, body: { restaurantId: S.outletId, csv } }); must(pv, 201, 'preview');
    assert.equal(pv.data.summary.create, 4);
    const im = await call('POST', '/menu/import', { token: S.owner, body: { restaurantId: S.outletId, csv, dryRun: false } }); must(im, 201, 'import');
    S.menu = (await call('GET', `/menu/public/${SLUG}`)).data; assert.equal(S.menu.items.length, 4);
  });

  step(8, 'The owner adds more tables (within the trial\'s 20-table limit)', async () => {
    for (const t of ['T05', 'T06']) must(await call('POST', '/tables', { token: S.owner, body: { tableNumber: t, restaurantId: S.outletId } }), 201, `table ${t}`);
    const tables = (await call('GET', `/tables?restaurantId=${S.outletId}`, { token: S.owner })).data; assert.ok(tables.length >= 6);
    S.tables = tables;
  });

  step(9, 'A table\'s QR link opens THIS restaurant\'s menu', async () => {
    assert.ok(S.tables.some((t) => t.tableNumber === 'T01'));
    const pub = await call('GET', `/restaurants/${SLUG}`); must(pub, 200, 'public profile');
    assert.equal(pub.data.slug, SLUG);
    assert.equal(S.menu.restaurant.slug, SLUG);
  });

  step(10, 'The owner adds a cashier and a steward, who choose their own passwords', async () => {
    S.staff = {};
    for (const [role, name] of [['CASHIER', 'Kavi Counter'], ['STEWARD', 'Sana Floor'], ['STORE_MANAGER', 'Mira Lead']]) {
      const email = `${role.toLowerCase()}-${run}@example.com`;
      must(await call('POST', `/restaurants/${S.outletId}/staff`, { token: S.owner, body: { name, email, password: 'Lotus-Bell-Pune-77', role } }), 201, `hire ${role}`);
      const first = await call('POST', '/auth/login', { body: { email, password: 'Lotus-Bell-Pune-77' } }); assert.equal(first.data.user.mustChangePassword, true);
      must(await call('POST', '/auth/change-password', { token: first.data.accessToken, body: { currentPassword: 'Lotus-Bell-Pune-77', newPassword: 'Banyan-Leaf-Wada-58' } }), 200, `${role} password`);
      S.staff[role] = (await call('POST', '/auth/login', { body: { email, password: 'Banyan-Leaf-Wada-58' } })).data.accessToken;
    }
  });

  step(11, 'The owner sets the kitchen PIN', async () => {
    must(await call('POST', `/restaurants/${S.outletId}/kitchen-pin`, { token: S.owner, body: { pin: '2468' } }), 201, 'kitchen pin');
    assert.equal((await call('GET', `/restaurants/${S.outletId}/kitchen-pin`, { token: S.owner })).data.configured, true);
  });

  step(12, 'The kitchen device signs in with the restaurant code and PIN', async () => {
    const r = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: SLUG } }); must(r, 200, 'kitchen sign-in');
    S.kitchen = r.data.accessToken;
    must(await call('POST', '/auth/kds-pin-login', { body: { pinCode: '1111', outletSlug: SLUG } }), 401, 'wrong PIN');
  });

  step(13, 'The go-live checklist honestly shows what is still to do', async () => {
    const r = await call('GET', `/restaurants/${S.outletId}/readiness`, { token: S.owner }); must(r, 200, 'readiness');
    const st = (k) => r.data.steps.find((x) => x.key === k).status;
    assert.equal(st('menu'), 'DONE'); assert.equal(st('kitchenPin'), 'DONE'); assert.equal(st('kdsOpened'), 'DONE');
    assert.equal(st('testOrder'), 'TODO', 'no test order yet');
    assert.equal(r.data.ready, false);
  });

  step(14, 'A diner opens the menu; UPI is NOT offered until the owner confirms the ID', async () => {
    S.menu = (await call('GET', `/menu/public/${SLUG}`)).data;
    assert.equal(S.menu.restaurant.upiVpa || '', '');
    const bad = await placeOrder({ paymentMethod: 'UPI_INSTANT' });
    must(bad, 400, 'UPI must be refused while unconfirmed');
  });

  step(15, 'The owner adds and confirms their own UPI ID; guests now see who they are paying', async () => {
    must(await call('PATCH', `/restaurants/${SLUG}/settings`, { token: S.owner, body: { upiVpa: `uatcafe${run}@upi` } }), 200, 'save upi');
    must(await call('POST', `/restaurants/${S.outletId}/upi/confirm`, { token: S.owner, body: { vpa: `uatcafe${run}@upi` } }), 201, 'confirm upi');
    const o = await placeOrder({ paymentMethod: 'UPI_INSTANT' }); must(o, 201, 'upi order');
    const tr = (await call('GET', `/orders/${o.data.id}?token=${o.data.trackingToken}`)).data;
    assert.equal(tr.payee.vpa, `uatcafe${run}@upi`); assert.ok(tr.payee.name);
    must(await call('POST', `/orders/${o.data.id}/cancel`, { token: S.owner, body: { reason: 'test order' } }), [200, 201], 'tidy');
  });

  step(16, 'The diner places an order; a retry with the same key returns the same order', async () => {
    const key = `uat-${run}-main`;
    const body = { restaurantSlug: SLUG, orderType: 'DINE_IN', tableNumber: 'T01', paymentMethod: 'PAY_AT_COUNTER', customerName: 'Guest Gita', customerPhone: '9876500077', consentAccepted: true, items: [{ menuItemId: S.menu.items[0].id, name: S.menu.items[0].name, price: Number(S.menu.items[0].price), quantity: 2 }] };
    const a = await call('POST', '/orders', { headers: { 'x-idempotency-key': key }, body }); must(a, 201, 'order');
    const b = await call('POST', '/orders', { headers: { 'x-idempotency-key': key }, body }); must(b, [200, 201], 'retry');
    assert.equal(b.data.id, a.data.id); S.order = a.data;
  });

  step(17, 'The kitchen sees the order, without money or contact details', async () => {
    const l = await call('GET', `/orders?restaurantSlug=${SLUG}`, { token: S.kitchen }); must(l, 200, 'kitchen list');
    const o = l.data.find((x) => x.id === S.order.id); assert.ok(o);
    for (const f of ['customerPhone', 'totalAmount', 'trackingToken']) assert.equal(o[f], undefined, f);
  });

  step(18, 'The kitchen starts cooking', async () => { must(await call('PATCH', `/orders/${S.order.id}/status`, { token: S.kitchen, body: { status: 'PREPARING' } }), 200, 'preparing'); });
  step(19, 'The kitchen marks the order ready', async () => { must(await call('PATCH', `/orders/${S.order.id}/status`, { token: S.kitchen, body: { status: 'READY' } }), 200, 'ready'); });

  step(20, 'The guest\'s tracking link follows the order', async () => {
    const t = await call('GET', `/orders/${S.order.id}?token=${S.order.trackingToken}`); must(t, 200, 'tracking');
    assert.equal(t.data.orderStatus, 'READY');
  });

  step(21, 'The cashier marks it paid: exactly one GST bill with the tax split', async () => {
    const results2 = await Promise.all([1, 2, 3].map(() => call('PATCH', `/orders/${S.order.id}/mark-paid`, { token: S.staff.CASHIER })));
    assert.ok(results2.every((r) => r.status === 200), JSON.stringify(results2.map((r) => r.status)));
    const billRes = await call('GET', `/orders/${S.order.id}/bill?token=${S.order.trackingToken}`); must(billRes, 200, 'bill');
    const bill = billRes.data;
    assert.match(bill.billNumber, /^[A-Z0-9]+\/\d{2}-?\d{2}?\/?\d*|^.{6,16}$/); assert.equal(bill.status, 'ISSUED');
    assert.equal(Math.round((bill.gst.cgst + bill.gst.sgst) * 100), Math.round(bill.gst.total * 100));
    assert.equal(bill.payment.status, 'PAID');
    const n = (await db.query(`SELECT count(*)::int AS n FROM tax_documents WHERE order_id = $1 AND kind = 'BILL'`, [S.order.id])).rows[0].n;
    assert.equal(n, 1, 'three simultaneous taps, one bill'); S.bill = bill;
  });

  step(22, 'The steward serves it and completes the order', async () => {
    must(await call('PATCH', `/orders/${S.order.id}/status`, { token: S.staff.STEWARD, body: { status: 'COMPLETED' } }), 200, 'complete');
  });

  step(23, 'Reports show the sale and the GST collected', async () => {
    const r = await call('GET', `/reports/summary?restaurantSlug=${SLUG}`, { token: S.owner }); must(r, 200, 'report');
    assert.ok(r.data.totals.paidOrders >= 1); assert.ok(r.data.totals.grossSales >= Number(S.order.totalAmount) - 0.01); assert.ok(r.data.totals.gstCollected > 0);
  });

  step(24, 'A paid order is cancelled and refunded: one credit note, linked to the bill', async () => {
    const o = (await placeOrder()).data;
    must(await call('PATCH', `/orders/${o.id}/mark-paid`, { token: S.staff.CASHIER }), 200, 'pay');
    must(await call('POST', `/orders/${o.id}/cancel`, { token: S.staff.STORE_MANAGER, body: { reason: 'guest changed mind' } }), [200, 201], 'cancel');
    const key = `uat-refund-${run}`;
    const rf = await Promise.all([1, 2, 3].map(() => call('POST', `/orders/${o.id}/refund`, { token: S.staff.STORE_MANAGER, body: { refundMethod: 'COUNTER_CASH', reason: 'guest changed mind', idempotencyKey: key } })));
    assert.ok(rf.every((r) => r.status === 200 || r.status === 201), JSON.stringify(rf.map((r) => r.status)));
    const billRes = await call('GET', `/orders/${o.id}/bill?token=${o.trackingToken}`); must(billRes, 200, 'bill of the refunded order');
    const bill = billRes.data;
    assert.equal(bill.creditNotes.length, 1, 'three taps, one credit note'); assert.ok(bill.refundedAmount > 0);
    S.refunded = o;
  });

  step(25, 'Inventory: a recipe is set and a sale reduces stock', async () => {
    const ing = await call('POST', '/inventory/ingredients', { token: S.owner, body: { restaurantId: S.outletId, name: 'Milk', unit: 'LITRE', openingStock: 10, minimumStock: 1, costPerUnit: 60 } }); must(ing, 201, 'ingredient');
    const chai = S.menu.items.find((i) => i.name === 'Masala Chai');
    must(await call('POST', `/inventory/recipes?restaurantId=${S.outletId}`, { token: S.owner, body: { menuItemId: chai.id, ingredients: [{ ingredientId: ing.data.id, quantity: 0.5, unit: 'LITRE' }] } }), [200, 201], 'recipe');
    const o = (await placeOrder()).data; // one Masala Chai
    must(await call('PATCH', `/orders/${o.id}/mark-paid`, { token: S.staff.CASHIER }), 200, 'pay');
    const after = (await call('GET', `/inventory/ingredients?restaurantId=${S.outletId}`, { token: S.owner })).data.find((i) => i.id === ing.data.id);
    assert.ok(Number(after.currentStock) < 10, `stock should have dropped, is ${after.currentStock}`);
  });

  step(26, 'The kitchen device, after being offline, finds every open order by re-reading the list', async () => {
    const waiting = (await placeOrder()).data; // placed while "the tablet was offline"
    const l = await call('GET', `/orders?restaurantSlug=${SLUG}`, { token: S.kitchen }); must(l, 200, 'resync read');
    assert.ok(l.data.some((o) => o.id === waiting.id), 'a fresh REST read returns the order the socket never delivered');
    must(await call('POST', `/orders/${waiting.id}/cancel`, { token: S.owner, body: { reason: 'tidy' } }), [200, 201], 'tidy');
  });

  step(27, 'Plan enforcement: when the platform switches the kitchen display off, the kitchen is refused; switching it back restores it', async () => {
    must(await call('POST', `/admin/restaurants/${S.orgId}/feature-overrides`, { token: S.admin, body: { feature: 'KDS', mode: 'FORCE_OFF', reason: 'acceptance test' } }), [200, 201], 'switch off');
    const refused = await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: SLUG } });
    assert.ok([402, 403].includes(refused.status), `kitchen sign-in should be refused, got ${refused.status}`);
    must(await call('POST', `/admin/restaurants/${S.orgId}/feature-overrides`, { token: S.admin, body: { feature: 'KDS', mode: 'DEFAULT' } }), [200, 201], 'restore');
    must(await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: SLUG } }), 200, 'kitchen works again');
  });

  step(28, 'After the owner records the physical steps, the go-live checklist is complete', async () => {
    for (const s of ['qrPlaced', 'gstReviewed', 'hoursReviewed']) must(await call('POST', `/restaurants/${S.outletId}/onboarding/confirm`, { token: S.owner, body: { step: s } }), 201, s);
    const r = (await call('GET', `/restaurants/${S.outletId}/readiness`, { token: S.owner })).data;
    assert.equal(r.ready, true, `still blocking: ${JSON.stringify(r.blocking)}`);
  });

  step(29, 'The audit trail recorded the money and setup actions with who did them', async () => {
    const actions = (await db.query(`SELECT action, staff_role FROM audit_logs WHERE restaurant_id = $1`, [S.outletId])).rows.map((r) => r.action);
    for (const a of ['MENU_IMPORTED', 'UPI_VPA_CONFIRMED', 'ORDER_REFUND_SETTLED', 'ONBOARDING_STEP_CONFIRMED']) assert.ok(actions.includes(a), `missing audit action ${a}; have ${[...new Set(actions)].join(',')}`);
    const who = (await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE restaurant_id = $1 AND staff_id IS NULL AND action IN ('UPI_VPA_CONFIRMED','ORDER_REFUND_SETTLED')`, [S.outletId])).rows[0].n;
    assert.equal(who, 0, 'money actions carry the actor');
  });
});

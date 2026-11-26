/**
 * Pilot readiness: operator alerts, go-live checklist, self-signup default. A RUNNING API on a THROWAWAY database (never production).
 *   DATABASE_URL=... THROTTLE_DISABLED=true PLATFORM_BOOTSTRAP_SECRET=bootstrapsecret1234567 PORT=4000 NODE_ENV=development node dist/main &
 *   node --test --test-concurrency=1 test/pilot-ops.e2e.test.mjs
 *
 * Email goes to a fake SMTP server started by this test, so success, rejection and a hung provider are all REAL transport outcomes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import pg from 'pg';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL || 'postgres://postgres:pg@localhost:5432/pangat';
const BOOT = process.env.PLATFORM_BOOTSTRAP_SECRET || 'bootstrapsecret1234567';
const run = crypto.randomBytes(3).toString('hex');
const PW = 'Str0ng-pass-1';
const db = new pg.Client({ connectionString: DB });
const SMTP_PORT = 25250 + Math.floor(Math.random() * 500);

async function call(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data, code: json?.code };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }

// ── fake SMTP: mode 'accept' | 'reject' | 'hang' ───────────────────────────────────────────────
let mode = 'accept';
const inbox = []; // accepted messages: { to, data }
const smtp = net.createServer((sock) => {
  let to = []; let inData = false; let buf = ''; let data = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    if (mode === 'hang') return; // never answers: the client must time out
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; inbox.push({ to: [...to], data }); data = ''; sock.write('250 queued\r\n'); } else data += line + '\n';
        continue;
      }
      const u = line.toUpperCase();
      if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250-fake\r\n250 8BITMIME\r\n');
      else if (u.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
      else if (u.startsWith('RCPT TO')) { if (mode === 'reject') sock.write('550 mailbox unavailable\r\n'); else { to.push(line.slice(line.indexOf('<') + 1, line.indexOf('>')).toLowerCase()); sock.write('250 ok\r\n'); } }
      else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else if (u === 'RSET') { to = []; sock.write('250 ok\r\n'); }
      else sock.write('250 ok\r\n');
    }
  });
});

let OWNER;
const setSettings = (changes) => call('PUT', '/admin/settings', { token: OWNER.token, body: { changes } });
const deliveries = async (status) => (await call('GET', `/admin/alerts/deliveries?limit=200${status ? `&status=${status}` : ''}`, { token: OWNER.token })).data || [];
const T0 = Date.now() - 2000; // only this run's alerts count (the database may hold earlier runs)
const forEvent = async (title) => (await deliveries()).filter((d) => d.title === title && new Date(d.created_at).getTime() >= T0);
const lead = (tag) => call('POST', '/leads', { body: { name: 'Lee Ad', restaurantName: `Lead ${tag} ${run}`, phone: '9876500099', city: 'Pune', consentAccepted: true } });
async function onboard(tag, extra = {}) {
  const slug = `po-${tag}-${run}`; const email = `po-${tag}-${run}@example.com`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `Brand ${tag} ${run}`, ownerFullName: `Owner ${tag}`, mobileNumber: '9876500001', email, password: PW, outletName: `Outlet ${tag}`, branchArea: 'Pune', slug, upiVpa: `po${tag}@upi`, gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug, email, token: r.data.accessToken, outlet: r.data.outlet, orgId: r.data.organization.id };
}

before(async () => {
  await db.connect();
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const email = `root-${run}@pangat.test`;
  const r = await call('POST', '/auth/setup-super-admin', { headers: { 'x-bootstrap-secret': BOOT }, body: { name: 'Root Admin', email, password: PW } });
  if (r.status !== 201) {
    const { default: bcrypt } = await import('bcrypt');
    await db.query(`INSERT INTO staff (name, email, password_hash, role, is_platform_admin, platform_role) VALUES ('Root Admin', $1, $2, 'PLATFORM_SUPER_ADMIN', true, 'OWNER')`, [email, await bcrypt.hash(PW, 10)]);
  }
  OWNER = { email, token: (await call('POST', '/auth/login', { body: { email, password: PW } })).data.accessToken };
});
after(async () => {
  await setSettings({ 'notifications.emailAlerts': false, 'notifications.alertEmails': null, 'email.smtpHost': null, 'email.smtpPort': null, 'general.selfSignupEnabled': true });
  smtp.close(); await db.end();
});

describe('Self-signup is off by default', () => {
  it('a platform with no stored setting refuses public sign-up; turning it on works; the API protections stay', async () => {
    const prior = (await db.query(`SELECT value FROM platform_settings WHERE key = 'general.selfSignupEnabled'`)).rows[0];
    await db.query(`DELETE FROM platform_settings WHERE key = 'general.selfSignupEnabled'`);
    const closed = await until(async () => (await call('GET', '/platform/config')).data?.selfSignupEnabled === false, 25000);
    assert.ok(closed, 'public config must report self-signup off');
    const body = { brandName: 'X', ownerFullName: 'X Y', mobileNumber: '9876500003', email: `ss-${run}@example.com`, password: PW, outletName: 'X', slug: `ss-${run}`, upiVpa: 'xx@upi', gstPercentage: 5, indoorTableCount: 2, outdoorTableCount: 0, menuPreset: 'blank', teamMode: 'solo' };
    const r = await call('POST', '/auth/onboard', { body });
    assert.equal(r.status, 403); assert.equal(r.code, 'SIGNUP_CLOSED');
    // provisioning by a platform admin still works while public sign-up is closed
    const prov = await call('POST', '/admin/provision', { token: OWNER.token, body: { brandName: `Prov ${run}`, ownerFullName: 'Prov Owner', email: `prov-${run}@example.com`, mobileNumber: '9000000000', outletName: 'Main', slug: `prov-${run}`, upiVpa: '' } });
    assert.equal(prov.status, 201, JSON.stringify(prov.body));
    const on = await setSettings({ 'general.selfSignupEnabled': true });
    assert.equal(on.status, 200);
    assert.ok(await until(async () => (await call('GET', '/platform/config')).data?.selfSignupEnabled === true, 25000));
    if (prior) assert.ok(true);
  });
});

describe('Provisioning: no invented UPI, correct trial', () => {
  it('a provisioned outlet has NO UPI ID until the owner adds and confirms one, and starts the 14-day trial plan', async () => {
    const o = (await db.query(`SELECT r.upi_vpa, r.upi_vpa_confirmed_at FROM restaurants r WHERE r.slug = $1`, [`prov-${run}`])).rows[0];
    assert.equal(o.upi_vpa, '');
    assert.equal(o.upi_vpa_confirmed_at, null);
    const t = (await db.query(`SELECT p.code, p.max_tables_per_outlet AS max_tables, p.max_staff_per_outlet AS max_staff, p.max_outlets,
        EXTRACT(day FROM (s.trial_ends_at - s.current_period_start))::int AS days
      FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id JOIN restaurants r ON r.organization_id = s.organization_id
      WHERE r.slug = $1 ORDER BY s.created_at DESC LIMIT 1`, [`prov-${run}`])).rows[0];
    assert.equal(t?.code, 'PANGAT_TRIAL');
    assert.equal(Number(t.max_tables), 20); assert.equal(Number(t.max_staff), 8); assert.equal(Number(t.max_outlets), 1);
    assert.ok(t.days >= 13 && t.days <= 14, `trial length ${t.days}`);
  });
});

describe('Operator alerts: every outcome is recorded and visible', () => {
  it('alerts ON but no email provider configured: the failure is recorded and shown, nothing is discarded', async () => {
    await setSettings({ 'notifications.emailAlerts': true, 'notifications.alertEmails': 'ops1@alerts.test, OPS2@alerts.test', 'email.smtpHost': null });
    const l = await lead('nop'); assert.equal(l.status, 201, JSON.stringify(l.body));
    const rows = await until(async () => { const r = await forEvent(`New lead: Lead nop ${run}`); return r.length === 2 && r.every((x) => x.attempts >= 1 && x.status !== 'SENDING') ? r : null; });
    assert.ok(rows, 'two recipients (de-duplicated, case-insensitive), one row each');
    for (const r of rows) { assert.notEqual(r.status, 'SENT'); assert.match(r.last_error, /not configured/i); }
    const h = (await call('GET', '/admin/alerts/health', { token: OWNER.token })).data;
    assert.equal(h.ok, false); assert.equal(h.emailConfigured, false);
    assert.ok(h.problems.some((p) => /no email provider/i.test(p)));
  });

  it('provider rejects the message: recorded as a failed attempt with the reason, scheduled to retry, never marked sent', async () => {
    mode = 'reject';
    await setSettings({ 'email.smtpHost': '127.0.0.1', 'email.smtpPort': SMTP_PORT });
    const l = await lead('rej'); assert.equal(l.status, 201);
    const rows = await until(async () => { const r = await forEvent(`New lead: Lead rej ${run}`); return r.length === 2 && r.every((x) => x.attempts === 1) ? r : null; });
    assert.ok(rows);
    for (const r of rows) { assert.equal(r.status, 'PENDING'); assert.ok(r.last_error); assert.ok(new Date(r.next_attempt_at) > new Date(), 'back-off, not a hot loop'); }
    assert.equal(inbox.filter((m) => m.data.includes(`Lead rej ${run}`)).length, 0);
  });

  it('a hung provider times out and is recorded as a failure', async () => {
    mode = 'hang';
    const l = await lead('hang'); assert.equal(l.status, 201);
    const t0 = Date.now();
    const rows = await until(async () => { const r = await forEvent(`New lead: Lead hang ${run}`); return r.length === 2 && r.every((x) => x.attempts === 1 && x.status === 'PENDING') ? r : null; }, 45000, 500);
    assert.ok(rows, 'timeout must end in a recorded failure, not hang forever');
    assert.ok(Date.now() - t0 < 45000);
    for (const r of rows) assert.ok(r.last_error);
    // the request that raised the alert was not held up by the slow provider
    mode = 'accept';
  });

  it('manual retry after the provider recovers sends exactly once per recipient; repeating the retry cannot duplicate', async () => {
    mode = 'accept';
    const title = `New lead: Lead rej ${run}`;
    const rows = await forEvent(title);
    // five simultaneous retries of the same delivery
    const results = await Promise.all(rows.flatMap((r) => Array.from({ length: 5 }, () => call('POST', `/admin/alerts/deliveries/${r.id}/retry`, { token: OWNER.token }))));
    assert.ok(results.some((r) => r.status === 200));
    const sent = await until(async () => { const r = await forEvent(title); return r.every((x) => x.status === 'SENT') ? r : null; });
    assert.ok(sent, 'both recipients delivered');
    const got = inbox.filter((m) => m.data.includes(`Lead rej ${run}`));
    assert.equal(got.length, 2, 'exactly one email per recipient despite 10 retry requests');
    assert.deepEqual(got.flatMap((m) => m.to).sort(), ['ops1@alerts.test', 'ops2@alerts.test']);
    // a sent delivery cannot be retried
    assert.equal((await call('POST', `/admin/alerts/deliveries/${sent[0].id}/retry`, { token: OWNER.token })).status, 404);
  });

  it('the background retry job sends what is due', async () => {
    const title = `New lead: Lead hang ${run}`;
    await db.query(`UPDATE platform_event_deliveries d SET next_attempt_at = now() FROM platform_events e WHERE e.id = d.event_id AND e.title = $1`, [title]);
    const mine = () => inbox.filter((m) => m.data.includes(`Lead hang ${run}`)).length;
    const before = mine();
    const j = await call('POST', '/admin/monitoring/jobs/alert-retries/run', { token: OWNER.token });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    const sent = await until(async () => { const r = await forEvent(title); return r.every((x) => x.status === 'SENT') ? r : null; });
    assert.ok(sent);
    assert.equal(mine() - before, 2, 'exactly one email per recipient for this alert');
  });

  it('a delivery that keeps failing ends as FAILED after its attempt budget, and the health view says so', async () => {
    mode = 'reject';
    const l = await lead('exh'); assert.equal(l.status, 201);
    const title = `New lead: Lead exh ${run}`;
    await until(async () => (await forEvent(title)).length === 2, 15000);
    for (let i = 0; i < 6; i++) {
      await db.query(`UPDATE platform_event_deliveries d SET next_attempt_at = now() FROM platform_events e WHERE e.id = d.event_id AND e.title = $1 AND d.status = 'PENDING'`, [title]);
      await call('POST', '/admin/monitoring/jobs/alert-retries/run', { token: OWNER.token });
      await sleep(400);
    }
    const rows = await until(async () => { const r = await forEvent(title); return r.every((x) => x.status === 'FAILED') ? r : null; }, 20000);
    assert.ok(rows, 'terminal FAILED after the attempt budget');
    for (const r of rows) assert.equal(r.attempts, 5);
    const h = (await call('GET', '/admin/alerts/health', { token: OWNER.token })).data;
    assert.ok(h.failed >= 2); assert.ok(h.problems.some((p) => /could not be delivered/i.test(p)));
    const failedList = await deliveries('FAILED');
    assert.ok(failedList.some((d) => d.title === title));
    mode = 'accept';
    const back = await Promise.all(rows.map((r) => call('POST', `/admin/alerts/deliveries/${r.id}/retry`, { token: OWNER.token })));
    assert.ok(back.every((r) => r.status === 200));
    assert.ok(await until(async () => (await forEvent(title)).every((x) => x.status === 'SENT')));
  });

  it('plan-change requests and important support tickets alert; routine tickets do not email', async () => {
    mode = 'accept';
    const o = await onboard('al');
    const plans = (await call('GET', '/subscriptions/plans')).data;
    const plan = plans.find((p) => p.code && !/TRIAL/i.test(p.code));
    const pc = await call('POST', '/subscriptions/request-change', { token: o.token, body: { planCode: plan.code, message: 'we want to grow' } });
    assert.equal(pc.status, 200, JSON.stringify(pc.body));
    assert.ok(await until(async () => (await forEvent(`Plan change requested: ${plan.name}`)).length === 2));
    const mk = (priority, subject) => call('POST', '/support/tickets', { token: o.token, body: { category: 'SUPPORT', subject, description: 'Please look at this soon', priority } });
    assert.equal((await mk('HIGH', `High ${run}`)).status, 201);
    assert.equal((await mk('LOW', `Low ${run}`)).status, 201);
    assert.ok(await until(async () => (await forEvent(`New support: High ${run}`)).length === 2), 'important ticket emailed');
    await sleep(1500);
    assert.equal((await forEvent(`New support: Low ${run}`)).length, 0, 'a routine ticket is stored in the bell but not emailed');
    const events = (await call('GET', '/admin/events?limit=100', { token: OWNER.token })).data;
    assert.ok(events.some((e) => e.title === `New support: Low ${run}`), 'still visible in the Super Admin feed');
  });

  it('alerts switched off: events are still stored, nothing is emailed, and health explains it', async () => {
    await setSettings({ 'notifications.emailAlerts': false });
    const before = inbox.length;
    assert.equal((await lead('off')).status, 201);
    await sleep(1500);
    assert.equal(inbox.length, before);
    assert.equal((await forEvent(`New lead: Lead off ${run}`)).length, 0);
    const events = (await call('GET', '/admin/events?limit=100', { token: OWNER.token })).data;
    assert.ok(events.some((e) => e.title === `New lead: Lead off ${run}`));
    const h = (await call('GET', '/admin/alerts/health', { token: OWNER.token })).data;
    assert.ok(h.problems.some((p) => /switched off/i.test(p)));
  });

  it('alerts on but no recipients: recorded as a failure; once recipients exist the retry delivers', async () => {
    await setSettings({ 'notifications.emailAlerts': true, 'notifications.alertEmails': null });
    assert.equal((await lead('norcpt')).status, 201);
    const title = `New lead: Lead norcpt ${run}`;
    const rows = await until(async () => { const r = await forEvent(title); return r.length === 1 ? r : null; });
    assert.equal(rows[0].status, 'FAILED'); assert.match(rows[0].last_error, /no alert recipients/i);
    await setSettings({ 'notifications.alertEmails': 'late@alerts.test' });
    const r = await call('POST', `/admin/alerts/deliveries/${rows[0].id}/retry`, { token: OWNER.token });
    assert.equal(r.status, 200);
    assert.ok(await until(async () => (await forEvent(title)).some((x) => x.recipient === 'late@alerts.test' && x.status === 'SENT')));
  });

  it('only platform staff can see or retry deliveries', async () => {
    const o = await onboard('perm');
    assert.ok([401, 403].includes((await call('GET', '/admin/alerts/deliveries', { token: o.token })).status));
    assert.ok([401, 403].includes((await call('GET', '/admin/alerts/health', { token: o.token })).status));
    assert.ok([401, 403].includes((await call('POST', `/admin/alerts/deliveries/${crypto.randomUUID()}/retry`, { token: o.token })).status));
  });
});

describe('Go-live checklist reflects real state', () => {
  let o;
  const ready = async (t = o.token, id = o.outlet.id) => call('GET', `/restaurants/${id}/readiness`, { token: t });
  const step = (r, k) => r.data.steps.find((s) => s.key === k);

  it('starts honest: nothing is pre-completed that has not happened', async () => {
    o = await onboard('gl'); // no kitchen PIN given
    const r = await ready();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.ready, false);
    assert.equal(step(r, 'menu').status, 'DONE');
    assert.equal(step(r, 'tables').status, 'DONE');
    assert.equal(step(r, 'kitchenPin').status, 'TODO');
    assert.equal(step(r, 'kdsOpened').status, 'TODO');
    assert.equal(step(r, 'testOrder').status, 'TODO');
    assert.equal(step(r, 'testCompleted').status, 'TODO');
    assert.equal(step(r, 'qr').status, 'TODO');
    assert.equal(step(r, 'payments').status, 'ATTENTION', 'UPI is on with an unconfirmed ID: must not look complete');
    assert.ok(r.data.blocking.includes('kitchenPin'));
  });

  it('kitchen PIN, kitchen sign-in, test order and completion flip their steps only when they really happen', async () => {
    assert.equal((await call('POST', `/restaurants/${o.outlet.id}/kitchen-pin`, { token: o.token, body: { pin: '2468' } })).status, 201);
    assert.equal(step(await ready(), 'kitchenPin').status, 'DONE');
    assert.equal((await call('POST', '/auth/kds-pin-login', { body: { pinCode: '2468', outletSlug: o.slug } })).status, 200);
    assert.equal(step(await ready(), 'kdsOpened').status, 'DONE');
    const menu = (await call('GET', `/menu/public/${o.slug}`)).data; const it = menu.items[0];
    const ord = await call('POST', '/orders', { headers: { 'x-idempotency-key': `gl-${run}` }, body: { restaurantSlug: o.slug, orderType: 'DINE_IN', tableNumber: '01', paymentMethod: 'PAY_AT_COUNTER', items: [{ menuItemId: it.id, name: it.name, price: Number(it.price), quantity: 1 }] } });
    assert.equal(ord.status, 201, JSON.stringify(ord.body));
    assert.equal(step(await ready(), 'testOrder').status, 'DONE');
    assert.equal(step(await ready(), 'testCompleted').status, 'TODO');
    for (const s of ['PREPARING', 'READY', 'COMPLETED']) assert.equal((await call('PATCH', `/orders/${ord.data.id}/status`, { token: o.token, body: { status: s } })).status, 200, s);
    assert.equal(step(await ready(), 'testCompleted').status, 'DONE');
  });

  it('owner-attested steps are recorded with who and when; automatic steps cannot be faked', async () => {
    const r1 = await call('POST', `/restaurants/${o.outlet.id}/onboarding/confirm`, { token: o.token, body: { step: 'qrPlaced' } });
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const qr = step({ data: r1.data }, 'qr'); assert.equal(qr.status, 'DONE'); assert.ok(qr.confirmedAt);
    for (const bad of ['kitchenPin', 'testOrder', 'menu', 'payments', 'kdsOpened', 'nonsense']) {
      const r = await call('POST', `/restaurants/${o.outlet.id}/onboarding/confirm`, { token: o.token, body: { step: bad } });
      assert.equal(r.status, 400, bad);
    }
    const audit = (await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'ONBOARDING_STEP_CONFIRMED'`, [o.outlet.id])).rows[0];
    assert.equal(audit.n, 1);
    const w = await call('POST', `/restaurants/${o.outlet.id}/onboarding/confirm`, { token: o.token, body: { step: 'qrPlaced', done: false } });
    assert.equal(step({ data: w.data }, 'qr').status, 'TODO', 'a step can be withdrawn');
    await call('POST', `/restaurants/${o.outlet.id}/onboarding/confirm`, { token: o.token, body: { step: 'qrPlaced' } });
  });

  it('UPI turns from attention to done only after the owner confirms the ID; the checklist can then be fully ready', async () => {
    assert.equal(step(await ready(), 'payments').status, 'ATTENTION');
    const c = await call('POST', `/restaurants/${o.outlet.id}/upi/confirm`, { token: o.token, body: { vpa: `pogl@upi` } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(step(await ready(), 'payments').status, 'DONE');
    for (const s of ['gstReviewed', 'hoursReviewed', 'soloStaffConfirmed']) await call('POST', `/restaurants/${o.outlet.id}/onboarding/confirm`, { token: o.token, body: { step: s } });
    const r = await ready();
    assert.equal(r.data.ready, true, JSON.stringify(r.data.blocking));
  });

  it('with UPI switched off, payments are complete without a confirmed ID (counter only)', async () => {
    const x = await onboard('gl2');
    await call('PATCH', `/restaurants/${x.slug}/settings`, { token: x.token, body: { operations: { payments: { upi: false } } } });
    assert.equal(step(await ready(x.token, x.outlet.id), 'payments').status, 'DONE');
  });

  it('another restaurant cannot read or change this checklist', async () => {
    const other = await onboard('gl3');
    assert.ok([403, 404].includes((await ready(other.token, o.outlet.id)).status));
    assert.ok([403, 404].includes((await call('POST', `/restaurants/${o.outlet.id}/onboarding/confirm`, { token: other.token, body: { step: 'qrPlaced' } })).status));
  });
});

describe('Migration 021', () => {
  it('is idempotent, and its rules are enforced by the database', async () => {
    const fs = await import('node:fs');
    const sql = fs.readFileSync(new URL('../src/migrations/021_alert_deliveries_onboarding.sql', import.meta.url), 'utf8');
    await db.query(sql); await db.query(sql);
    const ev = (await db.query(`INSERT INTO platform_events (type, severity, title) VALUES ('T','INFO','mig-${run}') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO platform_event_deliveries (event_id, recipient) VALUES ($1,'a@b.test')`, [ev]);
    await assert.rejects(db.query(`INSERT INTO platform_event_deliveries (event_id, recipient) VALUES ($1,'a@b.test')`, [ev]), /uq_event_delivery/);
    await assert.rejects(db.query(`UPDATE platform_event_deliveries SET status = 'WEIRD' WHERE event_id = $1`, [ev]), /chk_delivery_status/);
  });
});

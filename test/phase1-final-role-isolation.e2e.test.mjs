/**
 * Final approval check: all five staff roles stay inside their own outlet and tenant for the table and menu listings,
 * and a settings save never overwrites unrelated settings. Needs a running API on a throwaway database.  npm run test:phase1_final
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
async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data };
}
const login = (email, password = PW) => call('POST', '/auth/login', { body: { email, password } });
async function tenant(tag) {
  const slug = `fr-${tag}-${run}`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `B ${tag}`, ownerFullName: 'O', mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW, outletName: `O ${tag}`, slug, upiVpa: 'shop@upi', gstPercentage: 5, indoorTableCount: 2, outdoorTableCount: 0, menuPreset: 'pune_cafe', teamMode: 'solo', kitchenPin: '2468' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='ENTERPRISE'),status='ACTIVE',current_period_end=now()+interval '30 days' WHERE organization_id=$1`, [r.data.organization.id]);
  return { slug, owner: r.data.accessToken, outletId: r.data.outlet.id, orgId: r.data.organization.id };
}
async function hire(t, outletId, role) {
  const email = `${role.toLowerCase()}-${outletId.slice(0, 6)}@example.com`;
  const c = await call('POST', `/restaurants/${outletId}/staff`, { token: t.owner, body: { name: role, email, password: PW, role } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const f = await login(email);
  return (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
}
const ROLES = ['STORE_MANAGER', 'CHEF', 'STEWARD', 'CASHIER'];
let A; let B; let A2; const a1 = {}; const a2 = {};
before(async () => {
  await db.connect();
  A = await tenant('a'); B = await tenant('b');
  const two = await call('POST', '/organizations/outlets', { token: A.owner, body: { name: 'A second', slug: `fr-a2-${run}`, upiVpa: 'xx@upi', tableCount: 2 } });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  A2 = two.data;
  for (const role of ROLES) { a1[role] = await hire(A, A.outletId, role); a2[role] = await hire(A, A2.id, role); }
});
after(async () => { await db.end(); });

describe('Every staff role is confined to its own outlet', () => {
  const listings = (outletId, slug) => [`/tables?restaurantId=${outletId}`, `/tables?restaurantSlug=${slug}`, `/menu/items?restaurantId=${outletId}`];
  it('each of the five roles reads its own outlet and nothing else (same organisation, other organisation)', async () => {
    const tbl = (id, token) => call('GET', `/tables?restaurantId=${id}`, { token }).then((r) => r.data[0]);
    const tblA1 = await tbl(A.outletId, A.owner); const tblA2 = await tbl(A2.id, A.owner); const tblB = await tbl(B.outletId, B.owner);
    const who = [['OWNER', A.owner, true], ...ROLES.map((r) => [r, a1[r], false])];
    for (const [role, token, spans] of who) {
      for (const path of listings(A.outletId, A.slug)) assert.equal((await call('GET', path, { token })).status, 200, `${role} own outlet ${path}`);
      assert.equal((await call('GET', `/tables/${tblA1.id}`, { token })).status, 200, `${role} own table`);
      // the sibling outlet of the same organisation: only the owner spans it
      for (const path of [...listings(A2.id, `fr-a2-${run}`)]) assert.equal((await call('GET', path, { token })).status, spans ? 200 : 403, `${role} sibling outlet ${path}`);
      assert.equal((await call('GET', `/tables/${tblA2.id}`, { token })).status, spans ? 200 : 403, `${role} sibling table`);
      // another organisation: nobody, owner included
      for (const path of listings(B.outletId, B.slug)) assert.equal((await call('GET', path, { token })).status, 403, `${role} other tenant ${path}`);
      assert.equal((await call('GET', `/tables/${tblB.id}`, { token })).status, 403, `${role} other tenant table`);
    }
  });
  it('staff hired at the second outlet are confined to it in the same way', async () => {
    const tblA1 = (await call('GET', `/tables?restaurantId=${A.outletId}`, { token: A.owner })).data[0];
    for (const role of ROLES) {
      assert.equal((await call('GET', `/tables?restaurantId=${A2.id}`, { token: a2[role] })).status, 200, `${role} at outlet 2 reads outlet 2`);
      assert.equal((await call('GET', `/tables?restaurantId=${A.outletId}`, { token: a2[role] })).status, 403, `${role} at outlet 2 cannot read outlet 1`);
      assert.equal((await call('GET', `/tables/${tblA1.id}`, { token: a2[role] })).status, 403);
      assert.equal((await call('GET', `/menu/items?restaurantId=${A.outletId}`, { token: a2[role] })).status, 403);
    }
  });
  it('a body or query that names another outlet does not widen a role\'s reach', async () => {
    const tblA1 = (await call('GET', `/tables?restaurantId=${A.outletId}`, { token: A.owner })).data[0];
    for (const role of ROLES) {
      assert.equal((await call('GET', `/tables/${tblA1.id}?restaurantId=${B.outletId}`, { token: a1[role] })).status, 403, `${role}: conflicting restaurantId`);
    }
  });
});

describe('A settings save never overwrites unrelated settings', () => {
  it('saving one outlet setting leaves every other outlet column and the tables untouched; sibling outlet unaffected', async () => {
    const row = async (id) => (await db.query('SELECT * FROM restaurants WHERE id=$1', [id])).rows[0];
    const [b1, s1, tcount] = [await row(A.outletId), await row(A2.id), (await db.query('SELECT COUNT(*) FROM tables WHERE restaurant_id=$1', [A.outletId])).rows[0].count];
    const r = await call('PATCH', `/restaurants/${A.slug}/settings`, { token: A.owner, body: { serviceChargePercentage: 4 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [b2, s2] = [await row(A.outletId), await row(A2.id)];
    const changed = Object.keys(b2).filter((k) => JSON.stringify(b2[k]) !== JSON.stringify(b1[k])).filter((k) => k !== 'updated_at');
    assert.deepEqual(changed, ['service_charge_percentage']);
    assert.equal(JSON.stringify(s2), JSON.stringify(s1), 'the sibling outlet is byte-identical');
    assert.equal((await db.query('SELECT COUNT(*) FROM tables WHERE restaurant_id=$1', [A.outletId])).rows[0].count, tcount);
  });
});

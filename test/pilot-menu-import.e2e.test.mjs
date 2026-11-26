/**
 * Pilot readiness: menu CSV import against a RUNNING API on a THROWAWAY database.
 *   node --test --test-concurrency=1 test/pilot-menu-import.e2e.test.mjs
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
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, data: json?.data };
}
async function tenant(tag) {
  const slug = `mi-${tag}-${run}`;
  const r = await call('POST', '/auth/onboard', { body: { brandName: `Menu ${tag}`, ownerFullName: 'Olive Owner', mobileNumber: '9876500001', email: `o-${tag}-${run}@example.com`, password: PW, outletName: `Menu ${tag}`, branchArea: 'Pune', slug, upiVpa: `mi${tag}@upi`, gstPercentage: 5, indoorTableCount: 3, outdoorTableCount: 0, menuPreset: 'blank', teamMode: 'solo' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { slug, token: r.data.accessToken, id: r.data.outlet.id, orgId: r.data.organization.id };
}
async function hire(t, role) {
  const email = `${role.toLowerCase()}-${t.slug}@example.com`;
  const c = await call('POST', `/restaurants/${t.id}/staff`, { token: t.token, body: { name: role, email, password: PW, role } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const f = await call('POST', '/auth/login', { body: { email, password: PW } });
  return (await call('POST', '/auth/change-password', { token: f.data.accessToken, body: { currentPassword: PW, newPassword: PW2 } })).data.accessToken;
}
const counts = async (id) => ({
  items: (await db.query(`SELECT count(*)::int AS n FROM menu_items WHERE restaurant_id = $1 AND deleted_at IS NULL`, [id])).rows[0].n,
  cats: (await db.query(`SELECT count(*)::int AS n FROM menu_categories WHERE restaurant_id = $1`, [id])).rows[0].n,
});
let A; let B;
const FILE = 'category,name,price,description,veg\nBeverages,Masala Chai,20,Strong tea,veg\nBeverages,Cold Coffee,"1,150.50",,veg\nSnacks,Chicken Roll,90,"Spicy, with onions",non-veg\n';
const imp = (t, csv, extra = {}) => call('POST', '/menu/import', { token: t.token, body: { restaurantId: t.id, csv, ...extra } });

before(async () => { await db.connect(); A = await tenant('a'); B = await tenant('b'); });
after(async () => { await db.end(); });

describe('Menu CSV import', () => {
  it('a preview is the default and writes nothing', async () => {
    const before = await counts(A.id);
    const r = await imp(A, FILE);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.dryRun, true);
    assert.deepEqual(r.data.summary, { create: 3, update: 0, skip: 0, errors: 0, newCategories: 2 });
    assert.deepEqual(await counts(A.id), before, 'nothing was written');
  });

  it('the real import creates the dishes and categories, and records who did it', async () => {
    const r = await imp(A, FILE, { dryRun: false });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.dryRun, false);
    const c = await counts(A.id);
    assert.equal(c.items, 3); assert.equal(c.cats, 2);
    const menu = (await call('GET', `/menu/public/${A.slug}`)).data;
    const roll = menu.items.find((i) => i.name === 'Chicken Roll');
    assert.equal(Number(roll.price), 90); assert.equal(roll.isVeg, false); assert.equal(roll.description, 'Spicy, with onions');
    assert.equal(Number(menu.items.find((i) => i.name === 'Cold Coffee').price), 1150.5);
    const a = (await db.query(`SELECT metadata FROM audit_logs WHERE restaurant_id = $1 AND action = 'MENU_IMPORTED'`, [A.id])).rows;
    assert.equal(a.length, 1); assert.equal(a[0].metadata.create, 3);
  });

  it('importing the same file again adds nothing (repeatable)', async () => {
    const before = await counts(A.id);
    const r = await imp(A, FILE, { dryRun: false });
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.summary, { create: 0, update: 0, skip: 3, errors: 0, newCategories: 0 });
    assert.deepEqual(await counts(A.id), before);
  });

  it('ten simultaneous imports of the same new file create each dish exactly once', async () => {
    const csv = 'category,name,price\nSweets,Gulab Jamun,40\nSweets,Jalebi,30\n';
    const rs = await Promise.all(Array.from({ length: 10 }, () => imp(A, csv, { dryRun: false })));
    assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join());
    const n = (await db.query(`SELECT name, count(*)::int AS n FROM menu_items WHERE restaurant_id = $1 AND name IN ('Gulab Jamun','Jalebi') AND deleted_at IS NULL GROUP BY name`, [A.id])).rows;
    assert.deepEqual(n.map((x) => x.n).sort(), [1, 1], `duplicates created: ${JSON.stringify(n)}`);
  });

  it('prices are only changed when asked, and only for dishes that already exist', async () => {
    const csv = 'category,name,price\nBeverages,Masala Chai,25\n';
    const keep = await imp(A, csv, { dryRun: false });
    assert.equal(keep.data.summary.skip, 1);
    assert.equal(Number((await call('GET', `/menu/public/${A.slug}`)).data.items.find((i) => i.name === 'Masala Chai').price), 20);
    const upd = await imp(A, csv, { dryRun: false, updatePrices: true });
    assert.equal(upd.data.summary.update, 1);
    assert.equal(Number((await call('GET', `/menu/public/${A.slug}`)).data.items.find((i) => i.name === 'Masala Chai').price), 25);
  });

  it('one bad row blocks the whole import with every problem listed; nothing is written', async () => {
    const before = await counts(A.id);
    const csv = 'category,name,price\nMains,Thali,150\nMains,Bad Price,12,5\nMains,,10\nMains,Dosa,abc\n';
    const r = await imp(A, csv, { dryRun: false });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'MENU_IMPORT_ROW_ERRORS');
    assert.deepEqual(await counts(A.id), before);
    // the preview of the same file lists the errors by line without failing
    const pv = await imp(A, csv);
    assert.equal(pv.status, 201);
    assert.ok(pv.data.errors.length >= 2); assert.ok(pv.data.errors.every((e) => e.line >= 2));
  });

  it('a file without the required columns, an empty file and an oversized file are refused clearly', async () => {
    for (const csv of ['colour,size\nred,big\n', '', 'x'.repeat(250_000)]) {
      const r = await imp(A, csv);
      assert.ok([400, 413].includes(r.status), `${csv.slice(0, 20)} -> ${r.status}`); // 413: the web server's own body limit refuses it before the app does
    }
  });

  it('only owners and managers import; the cashier, steward, chef and strangers cannot', async () => {
    const mgr = await hire(A, 'STORE_MANAGER');
    assert.equal((await call('POST', '/menu/import', { token: mgr, body: { restaurantId: A.id, csv: FILE } })).status, 201);
    for (const role of ['CASHIER', 'STEWARD', 'CHEF']) {
      const t = await hire(A, role);
      assert.equal((await call('POST', '/menu/import', { token: t, body: { restaurantId: A.id, csv: FILE } })).status, 403, role);
    }
    assert.equal((await call('POST', '/menu/import', { body: { restaurantId: A.id, csv: FILE } })).status, 401);
  });

  it('another restaurant\'s owner cannot import into this one, by id or by slug', async () => {
    const before = await counts(A.id);
    assert.equal((await call('POST', '/menu/import', { token: B.token, body: { restaurantId: A.id, csv: FILE, dryRun: false } })).status, 403);
    assert.equal((await call('POST', '/menu/import', { token: B.token, body: { restaurantSlug: A.slug, csv: FILE, dryRun: false } })).status, 403);
    assert.deepEqual(await counts(A.id), before);
  });
});

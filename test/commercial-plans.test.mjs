/**
 * Commercial plan catalogue: unit tests (no database).
 *
 * Pins the APPROVED Pangat strategy so it cannot drift silently:
 *   Mini ₹699/₹6,990 · Starter ₹1,299/₹12,990 · Growth ₹2,499/₹24,990 · Enterprise ₹4,999/₹49,990 (ex-GST, annual = 10 x monthly)
 * and that the SQL migration that creates the rows in production equals the TypeScript catalogue.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  COMMERCIAL_PLANS, DEFAULT_PLANS, FOUNDING_PLANS, LEGACY_PLANS, LEGACY_PLAN_CODES, TRIAL_PLAN, TRIAL_PLAN_CODE,
  annualSaving, planFamilyOf, planGroupOf,
} from '../dist/subscriptions/default-plans.js';
import { FEATURE_CATALOG } from '../dist/subscriptions/subscription-access.js';
import { SubscriptionsService } from '../dist/subscriptions/subscriptions.service.js';
import { BillingInterval } from '../dist/common/enums/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APPROVED = {
  MINI:       { monthly: 699,  annual: 6990,  outlets: 1, tables: 10,  staff: 3,  saving: 1398 },
  STARTER:    { monthly: 1299, annual: 12990, outlets: 1, tables: 25,  staff: 8,  saving: 2598 },
  GROWTH:     { monthly: 2499, annual: 24990, outlets: 3, tables: 60,  staff: 20, saving: 4998 },
  ENTERPRISE: { monthly: 4999, annual: 49990, outlets: 5, tables: 100, staff: 40, saving: 9998 },
};
const byCode = (code) => DEFAULT_PLANS.find((p) => p.code === code);

describe('Approved commercial catalogue', () => {
  for (const [key, a] of Object.entries(APPROVED)) {
    it(`${key}: prices, limits and annual = 10 x monthly`, () => {
      const m = byCode(`PANGAT_${key}_M`);
      const y = byCode(`PANGAT_${key}_A`);
      assert.ok(m && y, 'monthly and annual rows exist');
      assert.equal(m.basePrice, a.monthly);
      assert.equal(y.basePrice, a.annual);
      assert.equal(y.basePrice, m.basePrice * 10, 'annual is exactly ten times monthly (two months free)');
      assert.equal(m.billingInterval, BillingInterval.MONTHLY);
      assert.equal(y.billingInterval, BillingInterval.YEARLY);
      for (const p of [m, y]) {
        assert.equal(p.maxOutlets, a.outlets);
        assert.equal(p.maxTablesPerOutlet, a.tables);
        assert.equal(p.maxStaffPerOutlet, a.staff);
        assert.equal(p.isPublic, true);
        assert.equal(p.group, 'COMMERCIAL');
      }
    });
    it(`${key}: the annual saving shown to customers is exactly two months`, () => {
      assert.equal(annualSaving(a.monthly), a.saving);
      assert.equal(a.monthly * 12 - a.annual, a.saving);
      // 16.67% versus twelve monthly payments
      assert.equal(Math.round((a.saving / (a.monthly * 12)) * 10000) / 100, 16.67);
    });
  }

  it('exactly four public plan families, monthly and annual, and nothing else is public', () => {
    const publicRows = DEFAULT_PLANS.filter((p) => p.isPublic);
    assert.equal(publicRows.length, 8);
    assert.deepEqual([...new Set(publicRows.map((p) => planFamilyOf(p.code)))].sort(), ['ENTERPRISE', 'GROWTH', 'MINI', 'STARTER']);
    assert.ok(publicRows.every((p) => p.group === 'COMMERCIAL'));
  });

  it('there is no quarterly billing interval anywhere', () => {
    assert.deepEqual(Object.values(BillingInterval).sort(), ['MONTHLY', 'YEARLY']);
    assert.ok(!DEFAULT_PLANS.some((p) => /QUARTER|_Q$/i.test(p.code)));
  });

  it('codes and ids are unique', () => {
    assert.equal(new Set(DEFAULT_PLANS.map((p) => p.code)).size, DEFAULT_PLANS.length);
    assert.equal(new Set(DEFAULT_PLANS.map((p) => p.id)).size, DEFAULT_PLANS.length);
  });
});

describe('Feature allocation matches what the product enforces', () => {
  const feats = (code) => byCode(code).features;
  it('only features that exist are sold; ADVANCED_REPORTS is on no plan', () => {
    for (const p of DEFAULT_PLANS) {
      for (const f of p.features) {
        assert.ok(FEATURE_CATALOG[f], `${p.code}: unknown feature ${f}`);
        assert.equal(FEATURE_CATALOG[f].available, true, `${p.code}: ${f} is not built`);
      }
      assert.ok(!p.features.includes('ADVANCED_REPORTS'));
    }
  });
  it('Mini: QR ordering + kitchen display only (no reports page, no inventory, single outlet)', () => {
    assert.deepEqual([...feats('PANGAT_MINI_M')].sort(), ['KDS', 'QR_ORDERING']);
  });
  it('Starter adds the reports entitlement and nothing else', () => {
    assert.deepEqual([...feats('PANGAT_STARTER_M')].sort(), ['ANALYTICS', 'KDS', 'QR_ORDERING']);
  });
  it('Growth adds inventory and multi-outlet (an outlet limit alone never grants multi-outlet)', () => {
    assert.deepEqual([...feats('PANGAT_GROWTH_M')].sort(), ['ANALYTICS', 'INVENTORY', 'KDS', 'MULTI_OUTLET', 'QR_ORDERING']);
  });
  it('Enterprise has Growth\'s software features: its difference is capacity and service, and no extra feature is invented', () => {
    assert.deepEqual([...feats('PANGAT_ENTERPRISE_M')].sort(), [...feats('PANGAT_GROWTH_M')].sort());
  });
  it('monthly and annual rows of a plan carry identical features and limits', () => {
    for (const k of Object.keys(APPROVED)) {
      const m = byCode(`PANGAT_${k}_M`); const y = byCode(`PANGAT_${k}_A`);
      assert.deepEqual(m.features, y.features);
      assert.deepEqual([m.maxOutlets, m.maxTablesPerOutlet, m.maxStaffPerOutlet], [y.maxOutlets, y.maxTablesPerOutlet, y.maxStaffPerOutlet]);
    }
  });
  it('no unlimited (-1) capacity on any commercial, trial or founding plan', () => {
    for (const p of [...COMMERCIAL_PLANS, ...FOUNDING_PLANS, TRIAL_PLAN]) {
      assert.ok([p.maxOutlets, p.maxTablesPerOutlet, p.maxStaffPerOutlet].every((n) => n > 0), p.code);
    }
  });
});

describe('Trial plan', () => {
  it('14 days, one outlet, 20 tables, 8 staff, not public, not purchasable (price 0)', () => {
    assert.equal(TRIAL_PLAN.code, TRIAL_PLAN_CODE);
    assert.equal(TRIAL_PLAN.trialDays, 14);
    assert.deepEqual([TRIAL_PLAN.maxOutlets, TRIAL_PLAN.maxTablesPerOutlet, TRIAL_PLAN.maxStaffPerOutlet], [1, 20, 8]);
    assert.equal(TRIAL_PLAN.isPublic, false);
    assert.equal(TRIAL_PLAN.basePrice, 0);
  });
  it('trial features are Growth-level but single outlet (no multi-outlet)', () => {
    assert.ok(TRIAL_PLAN.features.includes('INVENTORY') && TRIAL_PLAN.features.includes('ANALYTICS'));
    assert.ok(!TRIAL_PLAN.features.includes('MULTI_OUTLET'));
  });
  it('the platform setting defaults to the trial plan', async () => {
    const { SETTINGS } = await import('../dist/platform/settings.registry.js');
    const s = SETTINGS.find((x) => x.key === 'subscription.defaultTrialPlanCode');
    assert.equal(s.default, 'PANGAT_TRIAL');
    assert.equal(SETTINGS.find((x) => x.key === 'subscription.defaultTrialDays').default, 14);
  });
});

describe('Founding 10 rows', () => {
  it('are non-public, exactly 20% below list, one per approved plan and interval', () => {
    assert.equal(FOUNDING_PLANS.length, 8);
    for (const f of FOUNDING_PLANS) {
      const list = byCode(f.code.replace('FOUNDING_', 'PANGAT_'));
      assert.ok(list, `${f.code} has a list-price counterpart`);
      assert.equal(f.isPublic, false);
      assert.equal(f.basePrice, Math.round(list.basePrice * 80) / 100);
      assert.deepEqual([f.maxOutlets, f.maxTablesPerOutlet, f.maxStaffPerOutlet, f.features], [list.maxOutlets, list.maxTablesPerOutlet, list.maxStaffPerOutlet, list.features]);
      assert.equal(f.group, 'FOUNDING');
      assert.match(f.description, /first 12 paid months/);
    }
  });
  it('no code path assigns them: they are only data rows', () => {
    assert.equal(planGroupOf('FOUNDING_MINI_M'), 'FOUNDING');
  });
});

describe('Historical plans', () => {
  it('stay in the catalogue (hidden) so existing subscribers keep resolving', () => {
    assert.deepEqual([...LEGACY_PLAN_CODES].sort(), ['ENTERPRISE', 'ENTERPRISE_ANNUAL', 'GROWTH', 'GROWTH_ANNUAL', 'STARTER', 'STARTER_ANNUAL']);
    assert.ok(LEGACY_PLANS.every((p) => p.isPublic === false && p.group === 'LEGACY'));
    for (const c of LEGACY_PLAN_CODES) assert.equal(planGroupOf(c), 'LEGACY');
  });
});

describe('Migration 018 equals the TypeScript catalogue', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/018_commercial_plans.sql'), 'utf8');
  // rows look like: ('id', 'code', 'name', 'desc', 'MONTHLY', 699.00, 69900, 'INR', 18.00, 1, 10, 3, 'QR_ORDERING,KDS', NULL, 14, true, NULL, true)
  const rows = [...sql.matchAll(/^\s*\('([0-9a-f-]{36})', '([A-Z_]+)', '((?:[^']|'')*)', '((?:[^']|'')*)', '(MONTHLY|YEARLY)', ([0-9.]+), (\d+), 'INR', 18\.00, (-?\d+), (-?\d+), (-?\d+), '([A-Z_,]*)', NULL, (\d+), (true|false), NULL, true\)/gm)];
  it('creates every non-historical catalogue row, and only those', () => {
    const expected = DEFAULT_PLANS.filter((p) => p.group !== 'LEGACY');
    assert.equal(rows.length, expected.length);
    for (const e of expected) {
      const r = rows.find((x) => x[2] === e.code);
      assert.ok(r, `${e.code} is in the migration`);
      assert.equal(r[1], e.id);
      assert.equal(r[5], e.billingInterval);
      assert.equal(Number(r[6]), e.basePrice);
      assert.equal(Number(r[7]), Math.round(e.basePrice * 100), `${e.code} paise`);
      assert.deepEqual([Number(r[8]), Number(r[9]), Number(r[10])], [e.maxOutlets, e.maxTablesPerOutlet, e.maxStaffPerOutlet]);
      assert.equal(r[11], e.features.join(','));
      assert.equal(Number(r[12]), e.trialDays);
      assert.equal(r[13] === 'true', e.isPublic);
      assert.equal(r[3].replace(/''/g, "'"), e.name);
      assert.equal(r[4].replace(/''/g, "'"), e.description);
    }
  });
  it('never updates or deletes an existing plan row, and only hides the historical ones', () => {
    const body = sql.replace(/--[^\n]*/g, '');
    assert.ok(/ON CONFLICT \(code\) DO NOTHING/.test(body), 'inserts are conflict-safe');
    assert.ok(!/DELETE\s+FROM|DROP\s|TRUNCATE/i.test(body), 'no destructive statement');
    const updates = [...body.matchAll(/UPDATE\s+subscription_plans\s+SET\s+([^;]*?)\s+WHERE/gis)];
    assert.equal(updates.length, 1);
    assert.match(updates[0][1], /^is_public = false, updated_at = now\(\)$/);
    for (const c of LEGACY_PLAN_CODES) assert.ok(body.includes(`'${c}'`));
  });
  it('records previous visibility so the down script restores it exactly', () => {
    assert.match(sql, /plan_visibility_backfills/);
    const down = fs.readFileSync(path.join(__dirname, '../src/migrations/018_commercial_plans.down.sql'), 'utf8');
    assert.match(down, /previous_is_public/);
    assert.match(down, /NOT EXISTS \(SELECT 1 FROM organization_subscriptions/);
  });
});

describe('Subscription invoice numbers (CGST Rule 46)', () => {
  const makeService = (serials) => {
    const ds = { query: async () => [{ last_value: serials.shift() }] };
    return new SubscriptionsService({}, {}, {}, {}, {}, {}, ds);
  };
  it('are consecutive per financial year, at most 16 characters, and replace the old timestamp+random form', async () => {
    const svc = makeService([1, 2, 3]);
    const when = new Date('2026-11-25T10:00:00Z'); // FY 2026-27
    const a = await svc.nextInvoiceNumber(undefined, when);
    const b = await svc.nextInvoiceNumber(undefined, when);
    assert.equal(a, 'PGT/2627/000001');
    assert.equal(b, 'PGT/2627/000002');
    assert.ok(a.length <= 16);
  });
  it('the financial year turns over on 1 April IST', async () => {
    const svc = makeService([1, 1]);
    assert.equal(await svc.nextInvoiceNumber(undefined, new Date('2027-03-31T18:00:00Z')), 'PGT/2627/000001'); // 31 Mar 23:30 IST
    assert.equal(await svc.nextInvoiceNumber(undefined, new Date('2027-03-31T19:00:00Z')), 'PGT/2728/000001'); // 1 Apr 00:30 IST
  });
  it('a failed attempt does not use a statutory number (it carries an ATTEMPT reference, see the webhook handler)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/subscriptions/subscriptions.service.ts'), 'utf8');
    assert.match(src, /invoiceNumber: `ATTEMPT-/);
    assert.ok(!/this\.nextInvoiceNumber\(\)/.test(src), 'no synchronous timestamp-style generator remains');
  });
});

describe('Place of supply', () => {
  const svc = new SubscriptionsService({}, {}, {}, {}, {}, {}, {});
  it('same state as the supplier: CGST + SGST; another state: IGST', () => {
    const intra = svc.calculateTaxes(129900, 18, '27', '27');
    assert.deepEqual([intra.cgstPaise, intra.sgstPaise, intra.igstPaise], [11691, 11691, 0]);
    const inter = svc.calculateTaxes(129900, 18, '29', '27');
    assert.deepEqual([inter.cgstPaise, inter.sgstPaise, inter.igstPaise], [0, 0, 23382]);
    assert.equal(inter.totalPaise, 129900 + 23382);
  });
  it('catalogue prices produce the GST-inclusive totals the pricing page states', () => {
    const t = svc.calculateTaxes(69900, 18, '27', '27');
    assert.equal(t.totalRupees, 824.82); // Mini monthly ₹699 + 18% GST
  });
});

describe('Billing profile validation', () => {
  const make = (org) => {
    const saved = [];
    const orgRepo = { findOne: async () => org, save: async (o) => { saved.push({ ...o }); return o; } };
    const auditRepo = { create: (x) => x, save: async (x) => x };
    return { svc: new SubscriptionsService({}, {}, {}, auditRepo, orgRepo, {}, {}), saved };
  };
  it('accepts a valid profile and derives the state from the GSTIN', async () => {
    const { svc, saved } = make({ id: 'o1' });
    const r = await svc.updateBillingProfile('o1', { legalName: 'Roast & Toast Foods LLP', gstin: '27AAAAA0000A1Z5' }, { email: 'o@x.in' });
    assert.equal(r.gstin, '27AAAAA0000A1Z5');
    assert.equal(r.stateCode, '27');
    assert.equal(saved.length, 1);
  });
  it('rejects a GSTIN whose state does not match the stated state', async () => {
    const { svc } = make({ id: 'o1' });
    await assert.rejects(svc.updateBillingProfile('o1', { stateCode: '29', gstin: '27AAAAA0000A1Z5' }, {}), /does not match the state/);
  });
  it('rejects malformed GSTIN and state codes', async () => {
    const { svc } = make({ id: 'o1' });
    await assert.rejects(svc.updateBillingProfile('o1', { gstin: 'NOTAGSTIN' }, {}), /valid 15-character GSTIN/);
    await assert.rejects(svc.updateBillingProfile('o1', { stateCode: '99X' }, {}), /GST state code/);
    await assert.rejects(svc.updateBillingProfile('o1', { stateCode: '50' }, {}), /GST state code/);
  });
  it('an empty value clears a field', async () => {
    const { svc } = make({ id: 'o1', billingLegalName: 'Old', billingStateCode: '27', billingGstin: null });
    const r = await svc.updateBillingProfile('o1', { legalName: '' }, {});
    assert.equal(r.legalName, null);
  });
});

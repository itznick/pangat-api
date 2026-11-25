// Phase 1: the one implementation of subscription rules (no database needed).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_CATALOG, advertisedFeatures, authoriseLimitOverride, derivedStatus, evaluateAccess, evaluateLimit, isFeatureAvailable, limitFor, planLimitError,
} from '../dist/subscriptions/subscription-access.js';
import { EntitlementService } from '../dist/subscriptions/entitlement.service.js';
import { isSystemAccountEmail, resolveInitialTables, assertInitialTablesFit, assertSeatsFit } from '../dist/subscriptions/capacity.js';
import { FeatureGuard, RequireFeature } from '../dist/common/guards/feature.guard.js';

const DAY = 86_400_000;
const now = new Date('2026-06-15T12:00:00Z');
const at = (days) => new Date(now.getTime() + days * DAY);
const live = () => ({ status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 10 * DAY), gracePeriodEndsAt: null, cancelAtPeriodEnd: false }); // the service reads the real clock
const sub = (o) => ({ status: 'ACTIVE', currentPeriodEnd: at(10), gracePeriodEndsAt: null, cancelAtPeriodEnd: false, ...o });

describe('derivedStatus / evaluateAccess: the single status rule', () => {
  const cases = [
    // [description, subscription, expected derived status, expected blocked]
    ['trial inside its period', sub({ status: 'TRIAL' }), 'TRIAL', false],
    ['active inside its period', sub(), 'ACTIVE', false],
    ['trial just ended -> grace (7 days default)', sub({ status: 'TRIAL', currentPeriodEnd: at(-1) }), 'GRACE_PERIOD', false],
    ['active just ended -> grace', sub({ currentPeriodEnd: at(-3) }), 'GRACE_PERIOD', false],
    ['grace window over -> expired', sub({ currentPeriodEnd: at(-8) }), 'EXPIRED', true],
    ['gateway grace window honoured (still open)', sub({ status: 'GRACE_PERIOD', currentPeriodEnd: at(-20), gracePeriodEndsAt: at(2) }), 'GRACE_PERIOD', false],
    ['gateway grace window closed, period end still in the future -> expired', sub({ status: 'GRACE_PERIOD', currentPeriodEnd: at(5), gracePeriodEndsAt: at(-1) }), 'EXPIRED', true],
    ['PAST_DUE with a closed grace window -> expired', sub({ status: 'PAST_DUE', currentPeriodEnd: at(5), gracePeriodEndsAt: at(-1) }), 'EXPIRED', true],
    ['PAST_DUE inside its period and window stays usable', sub({ status: 'PAST_DUE', gracePeriodEndsAt: at(3) }), 'PAST_DUE', false],
    ['renewal switched off, period ended: no grace', sub({ currentPeriodEnd: at(-1), cancelAtPeriodEnd: true }), 'EXPIRED', true],
    ['renewal switched off, still inside the paid period', sub({ cancelAtPeriodEnd: true }), 'ACTIVE', false],
    ['CANCELLED but paid period still running', sub({ status: 'CANCELLED' }), 'CANCELLED', false],
    ['CANCELLED and period over', sub({ status: 'CANCELLED', currentPeriodEnd: at(-1) }), 'CANCELLED', true],
    ['HALTED is blocked at once', sub({ status: 'HALTED' }), 'HALTED', true],
    ['EXPIRED stays expired and blocked', sub({ status: 'EXPIRED', currentPeriodEnd: at(-30) }), 'EXPIRED', true],
  ];
  for (const [name, s, status, blocked] of cases) {
    it(name, () => {
      assert.equal(derivedStatus(s, now), status);
      assert.equal(evaluateAccess(s, now).blocked, blocked);
      assert.ok(!blocked || evaluateAccess(s, now).reason, 'a blocked state always carries a reason for the UI');
    });
  }
  it('no subscription row is not blocked (a trial is created on first use elsewhere)', () => {
    assert.equal(evaluateAccess(null, now).blocked, false);
  });
  it('derivedStatus never mutates its input', () => {
    const s = sub({ currentPeriodEnd: at(-3) });
    const copy = JSON.stringify(s);
    derivedStatus(s, now);
    evaluateAccess(s, now);
    assert.equal(JSON.stringify(s), copy);
  });
});

describe('EntitlementService is a thin, read-only view over the same rules', () => {
  const plan = { id: 'p', code: 'X', name: 'X', maxOutlets: 2, maxTablesPerOutlet: 5, maxStaffPerOutlet: 3, features: ['QR_ORDERING', 'KDS'] };
  const make = (s) => {
    const saved = [];
    const subRepo = { findOne: async () => (s ? { ...s, plan } : null), save: async (x) => { saved.push(x); return x; } };
    return { svc: new EntitlementService(subRepo, {}), saved };
  };
  it('reading a lapsed subscription does not write to the database', async () => {
    const { svc, saved } = make(sub({ currentPeriodEnd: at(-30) }));
    const eff = await svc.getEffectiveSubscription('org');
    assert.equal(eff.status, 'EXPIRED', 'the effective status is reported');
    assert.equal(saved.length, 0, 'but nothing is persisted by a read');
  });
  it('agrees with evaluateAccess on every state in the matrix', async () => {
    for (const s of [sub(), sub({ status: 'TRIAL' }), sub({ currentPeriodEnd: at(-3) }), sub({ currentPeriodEnd: at(-30) }), sub({ status: 'HALTED' }), sub({ status: 'CANCELLED' }), sub({ cancelAtPeriodEnd: true, currentPeriodEnd: at(-1) })]) {
      const { svc } = make({ ...s, currentPeriodEnd: s.currentPeriodEnd });
      const blocked = evaluateAccess(s).blocked;
      assert.equal((await svc.canAddOutlet('o', 0)).allowed, !blocked, `outlet / ${s.status}`);
      assert.equal((await svc.canAddTable('o', 0)).allowed, !blocked);
      assert.equal((await svc.canAddStaff('o', 0)).allowed, !blocked);
      assert.equal(await svc.isFeatureEntitled('o', 'KDS'), !blocked);
    }
  });
  it('limits use the same arithmetic as the guards (limit is inclusive, -1 unlimited)', async () => {
    const { svc } = make(live());
    assert.equal((await svc.canAddStaff('o', 2)).allowed, true);
    assert.equal((await svc.canAddStaff('o', 3)).allowed, false);
    assert.equal((await svc.canAddTable('o', 4)).allowed, true);
    assert.equal((await svc.canAddTable('o', 5)).allowed, false);
    assert.equal((await svc.canAddOutlet('o', 1)).allowed, true);
    assert.equal((await svc.canAddOutlet('o', 2)).allowed, false);
  });
  it('membership: only listed features, nothing for an organisation without a subscription', async () => {
    const { svc } = make(live());
    assert.equal(await svc.isFeatureEntitled('o', 'KDS'), true);
    assert.equal(await svc.isFeatureEntitled('o', 'INVENTORY'), false);
    assert.equal(await make(null).svc.isFeatureEntitled('o', 'KDS'), false);
    assert.equal((await make(null).svc.canAddTable('o', 0)).allowed, false);
  });
});

describe('limits', () => {
  const plan = { maxOutlets: 2, maxTablesPerOutlet: 10, maxStaffPerOutlet: 4 };
  it('inclusive limit, unlimited, and a missing plan', () => {
    assert.equal(evaluateLimit(plan, 'tables', 9, 1).allowed, true);
    assert.equal(evaluateLimit(plan, 'tables', 10, 1).allowed, false);
    assert.equal(evaluateLimit(plan, 'tables', 5, 6).allowed, false, 'a batch is checked as a whole');
    assert.equal(evaluateLimit({ ...plan, maxTablesPerOutlet: -1 }, 'tables', 9999, 50).allowed, true);
    assert.equal(evaluateLimit(null, 'outlets', 0, 1).allowed, false);
    assert.equal(limitFor({ maxOutlets: 1, maxTablesPerOutlet: 1, maxStaffPerOutlet: null }, 'staff'), -1, 'an unset staff limit predates the column and means unlimited');
  });
  it('an outlet already over its limit cannot add, and the message says so', () => {
    const d = evaluateLimit(plan, 'tables', 14, 1);
    assert.equal(d.allowed, false);
    const e = planLimitError(d);
    assert.equal(e.getStatus(), 403);
    assert.equal(e.getResponse().code, 'PLAN_LIMIT_REACHED');
    assert.deepEqual(e.getResponse().details, { limitKind: 'tables', limit: 10, current: 14, requested: 1 });
    assert.match(e.getResponse().message, /already over/);
  });
  it('a negative limit other than -1 is treated as "nothing allowed" rather than unlimited', () => {
    assert.equal(evaluateLimit({ maxTablesPerOutlet: -5 }, 'tables', 0, 1).allowed, false);
  });
});

describe('initial tables for a new outlet', () => {
  const plan = { maxTablesPerOutlet: 15 };
  it('indoor and outdoor are summed against the limit', () => {
    const r = resolveInitialTables(plan, { indoor: 10, outdoor: 6 }, { indoor: 12, outdoor: 4 });
    assert.equal(r.total, 16);
    assert.equal(r.exceeded, true);
    assert.throws(() => assertInitialTablesFit(r, null), (e) => e.getResponse().code === 'PLAN_LIMIT_REACHED');
    assert.doesNotThrow(() => assertInitialTablesFit(r, { reason: 'authorised exception' }));
  });
  it('an explicit request that fits is kept as asked', () => {
    const r = resolveInitialTables(plan, { indoor: 9, outdoor: 6 }, { indoor: 12, outdoor: 4 });
    assert.deepEqual([r.indoor, r.outdoor, r.exceeded], [9, 6, false]);
  });
  it('defaults are trimmed to the plan instead of failing the sign-up (12 + 4 on a 15-table plan)', () => {
    const r = resolveInitialTables(plan, {}, { indoor: 12, outdoor: 4 });
    assert.deepEqual([r.indoor, r.outdoor, r.total, r.exceeded], [12, 3, 15, false]);
    const tiny = resolveInitialTables({ maxTablesPerOutlet: 6 }, {}, { indoor: 12, outdoor: 4 });
    assert.deepEqual([tiny.indoor, tiny.outdoor], [6, 0]);
  });
  it('unlimited plans keep the defaults and any explicit number', () => {
    assert.equal(resolveInitialTables({ maxTablesPerOutlet: -1 }, {}, { indoor: 12, outdoor: 4 }).total, 16);
    assert.equal(resolveInitialTables({ maxTablesPerOutlet: -1 }, { indoor: 100, outdoor: 50 }, { indoor: 12, outdoor: 4 }).exceeded, false);
  });
  it('a plan with no staff seats refuses a manager but not a solo owner', () => {
    assert.throws(() => assertSeatsFit({ maxStaffPerOutlet: 0 }, 1, null), (e) => e.getResponse().code === 'PLAN_LIMIT_REACHED');
    assert.doesNotThrow(() => assertSeatsFit({ maxStaffPerOutlet: 0 }, 0, null));
    assert.doesNotThrow(() => assertSeatsFit({ maxStaffPerOutlet: 1 }, 1, null));
  });
});

describe('staff seat definition', () => {
  it('system accounts are recognised case-insensitively, people are not', () => {
    assert.equal(isSystemAccountEmail('kitchen.main@stations.pangat.app'), true);
    assert.equal(isSystemAccountEmail('Kitchen.Main@Stations.Pangat.App'), true);
    assert.equal(isSystemAccountEmail('chef@restaurant.com'), false);
    assert.equal(isSystemAccountEmail('x@stations.pangat.app.evil.com'), false);
    assert.equal(isSystemAccountEmail(null), false);
  });
});

describe('Super Admin override authorisation', () => {
  const admin = { id: 'a1', email: 'a@pangat.test', isPlatformAdmin: true, platformPermissions: ['subscriptions.manage', 'merchant.operate'] };
  it('no reason means no override', () => assert.equal(authoriseLimitOverride(admin, '  '), null));
  it('needs a platform administrator with subscriptions.manage', () => {
    assert.throws(() => authoriseLimitOverride({ id: 'u', role: 'SUPER_OWNER' }, 'a perfectly good reason'), (e) => e.getResponse().code === 'LIMIT_OVERRIDE_FORBIDDEN');
    assert.throws(() => authoriseLimitOverride({ ...admin, platformPermissions: ['merchant.operate'] }, 'a perfectly good reason'), (e) => e.getResponse().code === 'LIMIT_OVERRIDE_FORBIDDEN');
    assert.throws(() => authoriseLimitOverride(undefined, 'a perfectly good reason'), (e) => e.getResponse().code === 'LIMIT_OVERRIDE_FORBIDDEN');
  });
  it('needs a real reason', () => {
    assert.throws(() => authoriseLimitOverride(admin, 'short'), (e) => e.getResponse().code === 'LIMIT_OVERRIDE_REASON_REQUIRED');
    assert.equal(authoriseLimitOverride(admin, 'Festival week extra tables').actorEmail, 'a@pangat.test');
  });
});

describe('feature catalogue', () => {
  it('every key sold today exists; ADVANCED_REPORTS is explicitly not available', () => {
    for (const k of ['QR_ORDERING', 'KDS', 'INVENTORY', 'ANALYTICS', 'MULTI_OUTLET']) assert.equal(isFeatureAvailable(k), true, k);
    assert.equal(isFeatureAvailable('ADVANCED_REPORTS'), false);
    assert.equal(isFeatureAvailable('SOMETHING_ELSE'), false);
    assert.ok(FEATURE_CATALOG.ADVANCED_REPORTS.note);
  });
  it('advertised features hide anything that is not built', () => {
    assert.deepEqual(advertisedFeatures(['QR_ORDERING', 'ADVANCED_REPORTS', 'KDS']), ['QR_ORDERING', 'KDS']);
    assert.deepEqual(advertisedFeatures('QR_ORDERING,ADVANCED_REPORTS'), ['QR_ORDERING']);
    assert.ok(!advertisedFeatures(['*']).includes('ADVANCED_REPORTS'));
    assert.ok(advertisedFeatures(['*']).includes('KDS'));
    assert.deepEqual(advertisedFeatures(null), []);
  });
});

describe('FeatureGuard routing rules', () => {
  const ctx = (user, meta) => ({
    getHandler: () => ({}), getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    __meta: meta,
  });
  const reflector = (meta) => ({ getAllAndOverride: () => meta });
  const ds = { getRepository: () => ({ findOne: async () => null }), query: async () => [] };
  it('platform administrators pass, and a role-scoped rule does not touch other roles', async () => {
    const g = new FeatureGuard(reflector({ feature: 'KDS', forRoles: ['CHEF'] }), ds);
    assert.equal(await g.canActivate(ctx({ role: 'STORE_MANAGER', organizationId: 'o' })), true, 'a manager is not subject to the kitchen rule');
    assert.equal(await g.canActivate(ctx({ isPlatformAdmin: true })), true);
    await assert.rejects(() => new FeatureGuard(reflector({ feature: 'KDS' }), ds).canActivate(ctx(null)));
  });
  it('RequireFeature stores the rule under the key the guard reads', () => {
    assert.equal(typeof RequireFeature('KDS', { forRoles: ['CHEF'] }), 'function');
  });
});

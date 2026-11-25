// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/default-plans.ts
//
// The canonical plan catalogue. `ensureDefaultPlans` inserts any row that is MISSING (matched by unique `code`) and never
// modifies an existing one, so databases created by TypeORM `synchronize` get a working catalogue; production gets the same
// rows from migration 018 (a test asserts the two agree to the paisa).
//
// APPROVED COMMERCIAL STRATEGY (prices exclude GST; annual = exactly 10 x monthly = two months free):
//
//   Plan        Monthly   Annual    Outlets  Tables/outlet  Staff/outlet
//   Mini        ₹699      ₹6,990    1        10             3
//   Starter     ₹1,299    ₹12,990   1        25             8
//   Growth      ₹2,499    ₹24,990   3        60             20
//   Enterprise  ₹4,999    ₹49,990   5        100            40      (additional outlets are negotiated manually)
//
// Rules this file enforces by construction:
//  - Features are allocated only if the product enforces them. See PANGAT_PLAN_FEATURE_MATRIX.md.
//  - Commercial rows are NEVER edited once a customer has been on them: new terms are a new row.
//  - Historical rows (STARTER, GROWTH, ENTERPRISE and their annual variants) stay in the catalogue, hidden from the public
//    list, because existing subscribers depend on them. They are not part of the approved commercial catalogue.
//  - Founding 10 rows are non-public; they exist so a founder can assign them by hand. Nothing assigns them automatically.
//  - No quarterly billing.
// ─────────────────────────────────────────────────────────────────────────────

import { BillingInterval } from '../common/enums/index.js';

export type PlanGroup = 'COMMERCIAL' | 'FOUNDING' | 'TRIAL' | 'LEGACY';

export interface DefaultPlan {
  id: string;
  code: string;
  name: string;
  description: string;
  billingInterval: BillingInterval;
  /** INR, excluding GST */
  basePrice: number;
  maxOutlets: number;
  maxTablesPerOutlet: number;
  maxStaffPerOutlet: number;
  features: string[];
  group: PlanGroup;
  isPublic: boolean;
  trialDays: number;
}

const BASE = ['QR_ORDERING', 'KDS'];
/** Reports page (`/reports/*`) is the ANALYTICS entitlement. The dashboard's "today" figures are on every plan. */
const WITH_REPORTS = [...BASE, 'ANALYTICS'];
/** More than one outlet needs MULTI_OUTLET explicitly: an outlet limit alone never grants the feature. */
const WITH_INVENTORY_AND_OUTLETS = [...WITH_REPORTS, 'INVENTORY', 'MULTI_OUTLET'];
/** ADVANCED_REPORTS is deliberately on no plan: nothing is built behind it (see FEATURE_CATALOG). */

interface Tier {
  key: string;
  name: string;
  monthly: number;
  outlets: number;
  tables: number;
  staff: number;
  features: string[];
  description: string;
  /** two-digit suffix of the deterministic ids (monthly = n, annual = n+1) */
  n: number;
}

export const COMMERCIAL_TIERS: Tier[] = [
  {
    key: 'MINI', name: 'Pangat Mini', monthly: 699, outlets: 1, tables: 10, staff: 3, features: BASE, n: 11,
    description: 'For food stalls, small cafés, kiosks and takeaway counters: QR menu and ordering, kitchen display, order history and today\'s sales summary.',
  },
  {
    key: 'STARTER', name: 'Pangat Starter', monthly: 1299, outlets: 1, tables: 25, staff: 8, features: WITH_REPORTS, n: 13,
    description: 'For cafés, bakeries, small restaurants and quick-service outlets: everything in Mini with more tables and staff, plus order and sales reports.',
  },
  {
    key: 'GROWTH', name: 'Pangat Growth', monthly: 2499, outlets: 3, tables: 60, staff: 20, features: WITH_INVENTORY_AND_OUTLETS, n: 15,
    description: 'For established restaurants and small groups: everything in Starter plus inventory, recipes and stock tracking, and up to 3 outlets.',
  },
  {
    key: 'ENTERPRISE', name: 'Pangat Enterprise', monthly: 4999, outlets: 5, tables: 100, staff: 40, features: WITH_INVENTORY_AND_OUTLETS, n: 17,
    description: 'For chains, franchises and larger operations: everything in Growth for up to 5 outlets, with onboarding arranged with our team. Additional outlets by agreement.',
  },
];

const FOUNDING_DISCOUNT = 0.2; // 20% off list for the first 12 paid months (agreement required; applied by moving the customer to this row by hand)
const round2 = (n: number) => Math.round(n * 100) / 100;

function rowsFor(t: Tier, kind: 'COMMERCIAL' | 'FOUNDING'): DefaultPlan[] {
  const founding = kind === 'FOUNDING';
  const idBase = founding ? '33333333-3333-3333-3333-3333333333' : '22222222-2222-2222-2222-2222222222';
  const mk = (interval: BillingInterval, offset: number): DefaultPlan => {
    const list = interval === BillingInterval.MONTHLY ? t.monthly : t.monthly * 10;
    const sfx = interval === BillingInterval.MONTHLY ? 'M' : 'A';
    const label = interval === BillingInterval.MONTHLY ? '' : ' (Annual)';
    return {
      id: `${idBase}${String(t.n + offset).padStart(2, '0')}`,
      code: `${founding ? 'FOUNDING' : 'PANGAT'}_${t.key}_${sfx}`,
      name: founding ? `Founding 10 · ${t.name}${label}` : `${t.name}${label}`,
      description: founding
        ? `Founding 10 offer: 20% off the list price for the first 12 paid months, under a written price-lock agreement. Not public; assigned by a founder only. After 12 paid months the customer moves to the then-current list plan. ${t.description}`
        : t.description,
      billingInterval: interval,
      basePrice: founding ? round2(list * (1 - FOUNDING_DISCOUNT)) : list,
      maxOutlets: t.outlets,
      maxTablesPerOutlet: t.tables,
      maxStaffPerOutlet: t.staff,
      features: t.features,
      group: kind,
      isPublic: !founding,
      trialDays: 14,
    };
  };
  return [mk(BillingInterval.MONTHLY, 0), mk(BillingInterval.YEARLY, 1)];
}

/** The 14-day free trial: not purchasable, never listed. Growth-level features that are supported; capacity capped at one outlet. */
export const TRIAL_PLAN: DefaultPlan = {
  id: '44444444-4444-4444-4444-444444444401',
  code: 'PANGAT_TRIAL',
  name: 'Pangat Trial',
  description: '14-day free trial. One outlet, up to 20 tables and 8 staff accounts. Not a purchasable plan.',
  billingInterval: BillingInterval.MONTHLY,
  basePrice: 0,
  maxOutlets: 1,
  maxTablesPerOutlet: 20,
  maxStaffPerOutlet: 8,
  features: [...WITH_REPORTS, 'INVENTORY'],
  group: 'TRIAL',
  isPublic: false,
  trialDays: 14,
};

/** Historical rows: kept so existing subscribers, tests and invoices keep resolving. Hidden from the public list. */
const LEGACY_FEATURES = ['QR_ORDERING', 'KDS'];
const LEGACY_GROWTH = [...LEGACY_FEATURES, 'INVENTORY', 'ANALYTICS', 'MULTI_OUTLET'];
const legacy = (
  id: string, code: string, name: string, description: string, interval: BillingInterval, price: number,
  outlets: number, tables: number, staff: number, features: string[],
): DefaultPlan => ({
  id, code, name, description, billingInterval: interval, basePrice: price,
  maxOutlets: outlets, maxTablesPerOutlet: tables, maxStaffPerOutlet: staff, features, group: 'LEGACY', isPublic: false, trialDays: 14,
});

export const LEGACY_PLANS: DefaultPlan[] = [
  legacy('11111111-1111-1111-1111-111111111101', 'STARTER', 'Starter Plan', 'Ideal for single-outlet cafes, cloud kitchens, and quick-service diners.', BillingInterval.MONTHLY, 1499, 1, 15, 5, LEGACY_FEATURES),
  legacy('11111111-1111-1111-1111-111111111104', 'STARTER_ANNUAL', 'Starter Plan (Annual)', 'Single-outlet cafe plan billed annually with 20% savings.', BillingInterval.YEARLY, 14390, 1, 15, 5, LEGACY_FEATURES),
  legacy('11111111-1111-1111-1111-111111111102', 'GROWTH', 'Growth Plan', 'For growing full-service restaurants with multiple tables and kitchen inventory.', BillingInterval.MONTHLY, 2999, 3, 40, 15, LEGACY_GROWTH),
  legacy('11111111-1111-1111-1111-111111111105', 'GROWTH_ANNUAL', 'Growth Plan (Annual)', 'Growing multi-table restaurant plan billed annually with 20% savings.', BillingInterval.YEARLY, 28790, 3, 40, 15, LEGACY_GROWTH),
  legacy('11111111-1111-1111-1111-111111111103', 'ENTERPRISE', 'Enterprise Plan', 'For restaurant chains, franchise groups, and high-volume dining networks.', BillingInterval.MONTHLY, 5999, -1, -1, -1, LEGACY_GROWTH),
  legacy('11111111-1111-1111-1111-111111111106', 'ENTERPRISE_ANNUAL', 'Enterprise Plan (Annual)', 'Enterprise restaurant chain plan billed annually with 20% savings.', BillingInterval.YEARLY, 57590, -1, -1, -1, LEGACY_GROWTH),
];

export const COMMERCIAL_PLANS: DefaultPlan[] = COMMERCIAL_TIERS.flatMap((t) => rowsFor(t, 'COMMERCIAL'));
export const FOUNDING_PLANS: DefaultPlan[] = COMMERCIAL_TIERS.flatMap((t) => rowsFor(t, 'FOUNDING'));

/** Everything `ensureDefaultPlans` may insert (missing codes only). */
export const DEFAULT_PLANS: DefaultPlan[] = [...COMMERCIAL_PLANS, TRIAL_PLAN, ...FOUNDING_PLANS, ...LEGACY_PLANS];

/** Codes of the rows that were the public catalogue before the approved strategy was restored. Hidden (never deleted) by migration 018. */
export const LEGACY_PLAN_CODES = LEGACY_PLANS.map((p) => p.code);

/** The plan a new organisation's 14-day trial runs on (platform setting `subscription.defaultTrialPlanCode`). */
export const TRIAL_PLAN_CODE = TRIAL_PLAN.code;

/** Annual saving versus twelve monthly payments, exactly two months of the monthly price. */
export const annualSaving = (monthly: number) => monthly * 12 - monthly * 10;

/** Which part of the catalogue a plan code belongs to (Super Admin groups and labels plans with this). */
export function planGroupOf(code: string): PlanGroup | 'CUSTOM' {
  if (code === TRIAL_PLAN_CODE) return 'TRIAL';
  if (code.startsWith('FOUNDING_')) return 'FOUNDING';
  if (code.startsWith('PANGAT_')) return 'COMMERCIAL';
  if (LEGACY_PLAN_CODES.includes(code)) return 'LEGACY';
  return 'CUSTOM';
}

/** The plan "family" shared by a monthly and an annual row (PANGAT_GROWTH_M and PANGAT_GROWTH_A are both GROWTH). */
export function planFamilyOf(code: string): string {
  return code.replace(/^(PANGAT|FOUNDING)_/, '').replace(/_(M|A|ANNUAL)$/, '');
}

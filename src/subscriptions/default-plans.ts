// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/default-plans.ts
//
// Canonical subscription tiers. These mirror the SQL seed in
// migrations/006_phase2_subscription_enhancements.sql so databases created by TypeORM
// `synchronize` (which never run the SQL migrations) still get a working plan catalogue.
// ─────────────────────────────────────────────────────────────────────────────

import { BillingInterval } from '../common/enums/index.js';

export interface DefaultPlan {
  id: string;
  code: string;
  name: string;
  description: string;
  billingInterval: BillingInterval;
  basePrice: number;
  maxOutlets: number;
  maxTablesPerOutlet: number;
  maxStaffPerOutlet: number;
  features: string[];
}

const BASE = ['QR_ORDERING', 'KDS'];
const GROWTH = [...BASE, 'INVENTORY', 'ANALYTICS'];
const ENTERPRISE = [...GROWTH, 'MULTI_OUTLET', 'ADVANCED_REPORTS'];

export const DEFAULT_PLANS: DefaultPlan[] = [
  {
    id: '11111111-1111-1111-1111-111111111101',
    code: 'STARTER',
    name: 'Starter Plan',
    description: 'Ideal for single-outlet cafes, cloud kitchens, and quick-service diners.',
    billingInterval: BillingInterval.MONTHLY,
    basePrice: 1499,
    maxOutlets: 1,
    maxTablesPerOutlet: 15,
    maxStaffPerOutlet: 5,
    features: BASE,
  },
  {
    id: '11111111-1111-1111-1111-111111111104',
    code: 'STARTER_ANNUAL',
    name: 'Starter Plan (Annual)',
    description: 'Single-outlet cafe plan billed annually with 20% savings.',
    billingInterval: BillingInterval.YEARLY,
    basePrice: 14390,
    maxOutlets: 1,
    maxTablesPerOutlet: 15,
    maxStaffPerOutlet: 5,
    features: BASE,
  },
  {
    id: '11111111-1111-1111-1111-111111111102',
    code: 'GROWTH',
    name: 'Growth Plan',
    description: 'For growing full-service restaurants with multiple tables and kitchen inventory.',
    billingInterval: BillingInterval.MONTHLY,
    basePrice: 2999,
    maxOutlets: 3,
    maxTablesPerOutlet: 40,
    maxStaffPerOutlet: 15,
    features: GROWTH,
  },
  {
    id: '11111111-1111-1111-1111-111111111105',
    code: 'GROWTH_ANNUAL',
    name: 'Growth Plan (Annual)',
    description: 'Growing multi-table restaurant plan billed annually with 20% savings.',
    billingInterval: BillingInterval.YEARLY,
    basePrice: 28790,
    maxOutlets: 3,
    maxTablesPerOutlet: 40,
    maxStaffPerOutlet: 15,
    features: GROWTH,
  },
  {
    id: '11111111-1111-1111-1111-111111111103',
    code: 'ENTERPRISE',
    name: 'Enterprise Plan',
    description: 'For restaurant chains, franchise groups, and high-volume dining networks.',
    billingInterval: BillingInterval.MONTHLY,
    basePrice: 5999,
    maxOutlets: -1,
    maxTablesPerOutlet: -1,
    maxStaffPerOutlet: -1,
    features: ENTERPRISE,
  },
  {
    id: '11111111-1111-1111-1111-111111111106',
    code: 'ENTERPRISE_ANNUAL',
    name: 'Enterprise Plan (Annual)',
    description: 'Enterprise restaurant chain plan billed annually with 20% savings.',
    billingInterval: BillingInterval.YEARLY,
    basePrice: 57590,
    maxOutlets: -1,
    maxTablesPerOutlet: -1,
    maxStaffPerOutlet: -1,
    features: ENTERPRISE,
  },
];

# Pangat — Commercial Strategy Restoration, Subscription Implementation and Landing Page Alignment: Implementation Report

**Scope delivered:** the approved four-plan strategy (Mini, Starter, Growth, Enterprise) implemented in the backend subscription system, Super Admin and the public site; entitlement defects fixed; existing subscribers protected; public claims audited and corrected.
**Not done, by design:** nothing was deployed, no production database was touched, no production migration was run, no environment variable or secret changed, paid subscription collection was **not** enabled. Everything below was verified on a **local throwaway PostgreSQL**, a local API and a local browser only.
**Branch:** development branch `claude/nifty-wright-ith4qq` in both repositories. Phase 1 is merged into `main` and was not reimplemented.

---

## 1. Summary of the existing state (before this work)
- Plan catalogue: `STARTER ₹1,499`, `GROWTH ₹2,999`, `ENTERPRISE ₹5,999` (+ annual rows), Enterprise "unlimited"; trial = `GROWTH` (3 outlets, 40 tables); landing page said ₹699 and a 7-day trial; neither matched the approved strategy. Production rows were not inspected (no production access); the precheck script covers that.
- Entitlement engine, limits, state machine, Super Admin plan editor and audit: sound (Phase 1), kept.
- **Defects found and fixed:** (a) inventory stock deduction, order-edit adjustment and automatic sold-out marking ran for any restaurant regardless of the `INVENTORY` entitlement; (b) a plan row with customers could be re-priced in place, silently changing their terms; (c) Pangat's own subscription invoice numbers were timestamp-random (~27 chars, not consecutive) and every invoice was split CGST+SGST regardless of the customer's state; (d) the "capacity" view I added initially flagged every single-outlet restaurant (caught by my own test, fixed).
- **Landing page:** advertised or implied features that do not exist (daily WhatsApp summary, WhatsApp receipt, "kitchen chimes when paid", instant/direct UPI settlement, "keep 100%", water/bill requests, "every rupee reconciled", unmeasured speed and time-saving claims, fabricated sample reviews presented as quotes, a made-up cafe name).

## 2. Exact files changed

### pangat-api (15 modified, 12 new)
Modified: `package.json`; `src/inventory/inventory.service.ts`; `src/organizations/entities/organization.entity.ts`; `src/platform/platform.controller.ts`; `src/platform/settings.registry.ts`; `src/platform/subscriptions-admin.service.ts`; `src/subscriptions/default-plans.ts` (rewritten); `src/subscriptions/dto/update-plan.dto.ts`; `src/subscriptions/subscription-access.ts`; `src/subscriptions/subscriptions.controller.ts`; `src/subscriptions/subscriptions.service.ts`; tests adapted for deliberate changes: `test/subscriptions.test.mjs` (invoice-counter stub + new assertions), `test/phase1-entitlements.e2e.test.mjs` and `test/phase1-1-verification.e2e.test.mjs` (teardown restores the setting to its default instead of pinning the old `GROWTH`), `test/platform-control.e2e.test.mjs` (a paying customer is put on a priced plan before a charge, because the new trial plan is ₹0).
New: `src/migrations/018_commercial_plans(.down).sql`, `src/migrations/019_billing_profile_invoice_series(.down).sql`, `test/commercial-plans.test.mjs` (36 unit tests), `test/commercial-plans.e2e.test.mjs` (32 live tests), `docs/staging/commercial_plans_precheck.sql`, and the documents `PANGAT_COMMERCIAL_PLAN_STRATEGY.md`, `PANGAT_PLAN_FEATURE_MATRIX.md`, `PANGAT_PRICING_AND_LIMITS.md`, `PANGAT_SUBSCRIPTION_LIFECYCLE_RULES.md`, this report, and edits to the three Phase 2 documents and the Phase 2 revision report.

### pangat-web (20 modified, 3 new)
Landing: `components/{Pricing,Hero,Journey,Statement,Operations,Footer,Navbar,RoiCalculator,PilotModal,LiveDemoModal,ProductScreens,AdminScreens}.tsx`, `pages/LandingPage.tsx`, new `plans.ts`; `index.html` (title, description, Open Graph, minimal Organization JSON-LD; the CSP-hashed theme script is untouched).
Subscription and Super Admin: `src/features/subscriptions/pages/AdminSubscriptionPage.tsx`, new `components/BillingProfileCard.tsx`, `src/features/super-admin/pages/SubscriptionsPage.tsx`, `src/features/super-admin/api.ts`, `src/lib/api.ts`, `src/types/domain.ts`.
Tests: new `test/commercial-landing.test.mjs` (31 tests); `package.json` runs it.

## 3. Database migrations created (not applied anywhere shared)
| File | Purpose | Safety |
|---|---|---|
| `018_commercial_plans.sql` | Inserts 17 plan rows if their code is missing: four plans × monthly/annual, `PANGAT_TRIAL`, eight Founding rows. Hides the six historical public plans **once** (`is_public=false`), recording prior visibility in `plan_visibility_backfills` | Additive and idempotent; **no existing plan row's price, limits, features or tax is edited**; nothing deleted; no organisation moved; nothing assigned. Down restores visibility and removes only unsubscribed new rows. Tested: re-run changes nothing, an operator edit survives, down→up lands on the identical catalogue |
| `019_billing_profile_invoice_series.sql` | Four nullable billing columns on `organizations`; `subscription_invoice_sequences` | Additive. Down never drops columns; drops the counter table only if empty |
Auto-apply at API boot (`AUTO_MIGRATE`); see rollout (§15). The values in 018 are generated from `default-plans.ts` and a test fails if they ever differ.

## 4. Final plan configuration (as implemented and tested)
| Plan | Monthly | Annual | Outlets | Tables | Staff | Entitlements |
|---|---:|---:|---:|---:|---:|---|
| Pangat Mini (`PANGAT_MINI_M/A`) | ₹699 | ₹6,990 | 1 | 10 | 3 | QR ordering, KDS |
| Pangat Starter | ₹1,299 | ₹12,990 | 1 | 25 | 8 | + Reports |
| Pangat Growth | ₹2,499 | ₹24,990 | 3 | 60 | 20 | + Inventory, multi-outlet |
| Pangat Enterprise | ₹4,999 | ₹49,990 | 5 | 100 | 40 | same as Growth |
| `PANGAT_TRIAL` (non-public) | – | – | 1 | 20 | 8 | QR, KDS, reports, inventory; 14 days |
| `FOUNDING_*` (non-public) | 80% of list | 80% of list | as list | as list | as list | as list |
Public: exactly eight rows (four plans × two intervals). Annual = 10 × monthly. No quarterly. Prices exclude 18% GST. Display order is by price within the family, monthly first.

## 5. Feature entitlement matrix and 6. Features excluded from launch claims
Full classification (four categories) in `PANGAT_PLAN_FEATURE_MATRIX.md`. In short:
- **Enforced:** QR ordering, KDS access, Reports page (`ANALYTICS`), Inventory (`INVENTORY`, now including deduction), multi-outlet, the three limits.
- **Present on every plan, not separately enforced:** order management and status tracking, table management, staff roles, restaurant-side order history, dashboard "today" summary, GST bills, feedback. Consequently these are **not** presented as Starter upgrades (the brief listed several as Starter items). The honest Mini→Starter difference is tables, staff and Reports.
- **Excluded from claims:** KDS screen caps (no device registration or counting), advanced vs basic analytics (one Reports feature), consolidated reporting, outlet comparison, central menu management, staff performance reports, purchase management, customer accounts or customer-owned history, API integrations, add-ons, WhatsApp, online-payment claims, "unlimited".
- **Enterprise honesty:** Enterprise has no additional software entitlement over Growth; its distinction is capacity (5 outlets, 100 tables, 40 staff) plus service.
- **Service commitments shown (founder to confirm):** "Standard support" (Mini, Starter), "Priority support" (Growth), "Priority support and a dedicated Pangat contact" and "Onboarding arranged with our team" (Enterprise).

## 7. Landing page changes
- **Pricing:** four cards (Mini, Starter, Growth, "Starting at" Enterprise) from one constants file; accessible monthly/annual switch (`aria-pressed`); annual prices ₹6,990 / ₹12,990 / ₹24,990 / ₹49,990 and savings ₹1,398 / ₹2,598 / ₹4,998 / ₹9,998; limits per card; clear GST qualification ("the amount you pay is higher than the price displayed"); 14-day no-card trial note; Enterprise "Talk to us" opens the **existing** lead form with an enterprise intent that is saved in the lead's notes; no add-ons or screen caps shown.
- **Positioning and claims:** hero, statement, journey, operations, footer, ROI note, lead modal, live demo and the sample-product mock-ups rewritten to describe what exists (QR ordering, order management, kitchen display, table and staff management, inventory from Growth, reports from Starter); the nightly WhatsApp summary, payment-settlement and instant-UPI claims, water/bill requests, unmeasured numbers, "7-day" trial and fabricated sample quotes removed; mock screens labelled sample data and the made-up cafe renamed "Sample Cafe". The ROI calculator is now explicitly an illustrative model, not a guarantee.
- **Founding 10:** the full section exists in code and is covered by tests, but is **not published** (`FOUNDING_10_PUBLISHED = false` in `plans.ts`). No countdown, scarcity or lifetime promise.
- **SEO:** title, meta description, Open Graph and Twitter tags, minimal Organization JSON-LD; single H1 with a sectioned H2 hierarchy. **Not added, because the facts are unknown:** canonical URL, `og:image` (needs an absolute URL), address, phone, reviews. The domain is inconsistent in the codebase (`pangat.app` in the footer email, `pangat.in` in a mock), so please confirm it.
- A claims-guard test fails the build if any banned claim returns (verified by deliberately reintroducing one).

## 8. Super Admin changes
Plan families grouped (Approved, Founding 10, Trial, Custom, Historical) with Monthly/Annual and Public/Hidden/Retired labels; subscribers by status, ever-subscribed and over-limit counts per plan; **trial configuration** panel; **Close to or over their limits** panel (≥ 80% or over); **Founding 10** panel (places used, who is on a founding row); the editor warns when a plan has customers, locks price/interval/GST behind a typed acknowledgement and explains "create a new plan". Backend: `GET /admin/subscription-plans` extended, `GET /admin/subscriptions/capacity`, `GET /admin/subscriptions/founding`; all behind `subscriptions.view`; edits behind `plans.manage`; audit logging unchanged and extended with subscriber counts. Historical plans remain visible (grouped as hidden) and no subscription record is touched.
Owner side: plan cards come from the API; staff row added to the comparison; a note for restaurants on a plan no longer offered; an "Invoice details" card (billing profile); the previous "stay exportable" claim reworded. "Request this plan" only records a request.

## 9. Existing subscribers: protection and compatibility
Tested: an organisation on historical `GROWTH` keeps ₹2,999, 3/40/15 limits and all features and can still add outlets; historical rows are unedited by the migration; the migration never updates commercial fields; re-running it after an operator edit or deliberate republish changes nothing. **Read-only precheck for production:** `docs/staging/commercial_plans_precheck.sql` (plans and subscribers, any paid subscriptions or invoices, active trials, organisations over each new plan's limits, collisions, stored settings that override the new trial default, existing invoice numbers). It runs cleanly on a local database; **it has not been run on production**.
A caution: a stored `subscription.defaultTrialPlanCode` setting in production overrides the new default; section 9 of the precheck shows it.

## 10. Founding 10 implementation status
Non-public plan rows, hand-assigned, audited, visible in a read-only Super Admin panel; **not activated for anyone, no automation**. Rules (period starts at the first paid month; monthly and annual both; plan change; after 12 months list price applies; recording) are in Lifecycle §6. **Gaps needing founder decisions:** no automatic 12-month end date or reminder (a small grants table and job is recommended); whether upgrades keep the discount; how free onboarding and QR design are fulfilled; the written agreement itself. The public section stays unpublished until you approve.

## 11. Trial configuration
`PANGAT_TRIAL`: 14 days, no card, 1 outlet, 20 tables, 8 staff, supported Growth-level features (reports, inventory; no multi-outlet), non-public and unpurchasable. The default setting now points at it; existing trials unchanged. Existing grace (7 days) and expiry are unchanged and tested (trial creation, expiry, grace working, read-only after, reactivation). Operator note: provisioning a restaurant with more than 20 tables now needs the audited limit override or a plan assignment first.

## 12. Billing and GST readiness
**Done and tested:** consecutive per-financial-year invoice numbers within 16 characters, written atomically with the invoice (`PGT/2627/000001`); no serial consumed by failed attempts; place of supply from the customer's billing profile (CGST+SGST vs IGST); owner-editable billing profile with GSTIN/state validation; duplicate-webhook safety.
**Not done / pending CA and founders:** SAC value and GST confirmation; PDF tax invoice; invoices for manual or offline payments; credit notes for subscription refunds; registration/e-invoicing status; the Razorpay subscription integration itself. **Paid subscription collection remains disabled and unbuilt**; a test proves no checkout endpoint exists and that a plan request changes nothing. Restaurant food-order payment gateway work is separate and untouched.

## 13. Tests executed (all local, fresh throwaway PostgreSQL 16)
RESULTS_PLACEHOLDER

## 14. Browser responsive results (Chromium via Playwright, built app, local API)
- **Landing page at 360, 390, 768, 1024 and 1440 px:** no horizontal overflow at any width; four plan cards present, laid out in 1 / 1 / 2 / 2 / 4 columns, all inside the viewport; monthly prices ₹699 / ₹1,299 / ₹2,499 / ₹4,999 and annual prices ₹6,990 / ₹12,990 / ₹24,990 / ₹49,990 with the exact savings after switching; GST note visible; Enterprise "Talk to us" opens the lead form with "Talk to us about Enterprise"; Founding 10 not rendered; no console errors and no failed requests. Screenshots at 1440 and 360 were inspected; an alignment flaw in the Enterprise price row was found and fixed.
- **Super Admin (1440 and 390 px) and owner Subscription page (1440 and 390 px):** all sections present, eight plans visible, no overflow, no console errors, no failed API calls; the plan editor warns and locks price changes on a sold plan until acknowledged; owner plans tab shows all four plans, the staff row, and only "Request this plan" (no checkout).
- **Not tested:** 768 and 1024 px for the two logged-in screens, real phones/tablets, Safari, performance (Lighthouse), accessibility audit with assistive technology.

## 15. Production rollout instructions (nothing has been done)
1. **Staging first.** Restore a copy of production into a Neon branch or a disposable `*_verify` database (`docs/staging/backup_restore_check.sh`, `_guard.sh`).
2. Run `docs/staging/commercial_plans_precheck.sql` on staging and production (read-only); review all ten sections. Decide what to do about any organisation over a new plan's limits, any stored trial-plan setting, and whether paid subscriptions already exist (expected none).
3. On staging, deploy the API (**API before web**, with the direct, non-pooled Neon endpoint for the first boot, as in Phase 1). It applies 018 and 019. Re-run the precheck: expect 17 new rows, the six historical plans hidden and unchanged, subscribers unchanged.
4. Verify on staging: public plans list, Super Admin plans screen, a new trial restricted to 1 outlet / 20 tables / 8 staff, an existing historical-plan restaurant unchanged, order placement, inventory behaviour on a downgrade.
5. Deploy the web app (Netlify) after the API.
6. Production: take a verified backup, repeat 3–5. Migrations auto-apply on first boot; set `AUTO_MIGRATE=false` only if you prefer to run the two SQL files by hand.
7. **Rollback:** code rollback needs no database change (older code ignores the new rows and columns); to reverse the data, run `019…down.sql` then `018…down.sql` (restores visibility; removes only unsubscribed new rows).
8. Do **not** enable paid collection, publish Founding 10, or change contact details until the approvals in §16.

## 16. Changes requiring founder approval, and remaining items
1. Service commitments displayed: priority support, dedicated contact, arranged onboarding (deliverability).
2. Publishing the Founding 10 section and the process behind it (agreement, tracking of 12 paid months, onboarding and QR design fulfilment, whether upgrades keep the discount).
3. Adopting the **default trial change** in production and the 20-table provisioning cap (operator impact).
4. Whether to also make the Reports page available on Mini (currently not: Mini has the dashboard summary only) and whether Enterprise should get any software distinction later.
5. SAC/GST treatment, PDF invoices, credit notes, manual-payment invoices and the Razorpay subscription build, with the CA, before any paid collection.
6. Site facts: domain, `hello@pangat.app`, the WhatsApp number (`919890000000` looks like a placeholder and is still used in several places), absolute `og:image`.
7. Production plan data and rollout schedule (after the precheck).

**Known issues / not verified:** the Phase 2 payment and kitchen defects found earlier (the hardcoded UPI destination, non-atomic refunds, kitchen reconnect and wake-lock) are **not** part of this task and remain open in the Phase 2 roadmap; the hardcoded UPI payee remains reachable from the diner screen, so the landing page now makes no payment claims. The web lint debt (69 errors, not gated in CI) is unchanged and no new errors were added. No production verification of any kind was performed.

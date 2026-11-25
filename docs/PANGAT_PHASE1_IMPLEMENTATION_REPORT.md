# Pangat — Phase 1 Implementation Report
Critical subscription enforcement and limit remediation

Branch `claude/backend-plan-details-mismatch-gfi47m` in both repositories (api at `1f03dbf`, web at `e895e11` when work started; nothing else was uncommitted). Pricing and landing-page copy were **not** touched. Nothing was run against production or Neon: every test below ran on a throwaway local PostgreSQL 16 started inside the session.

**Verdict:** the Phase 1 completion criteria are met in code and verified by tests, with the points in §9 needing your decision. Nothing was verified on a staging environment (none was available to me): see §5 and §8.

---

## 1. Issues fixed (with file paths)

### 1.1 Table limits (every creation path)
| Path | Before | Now | Files |
|---|---|---|---|
| `POST /tables` | count, then insert (race) | limit checked **under a row lock on the outlet, in the same transaction as the insert**; an outlet already over its limit cannot add | `src/tables/tables.service.ts`, `src/subscriptions/capacity.ts` |
| Self-service onboarding `POST /auth/onboard` | up to 100 + 50 tables, no plan check | indoor + outdoor are summed and checked against the trial plan before anything is written; explicit over-limit → `403 PLAN_LIMIT_REACHED`; when no number is asked for, the default (12 + 4) is trimmed to the plan | `src/auth/auth.service.ts`, `capacity.ts` (`resolveInitialTables`) |
| Super Admin provisioning `POST /admin/provision` | unbounded count, no plan check | same check; DTO now capped at 100 / 50; audited override available (§1.6) | `src/admin/admin.service.ts`, `admin.controller.ts`, `dto/provision-restaurant.dto.ts` |
| New outlet `POST /organizations/outlets` | up to 50 tables regardless of plan | starting tables validated per outlet against the plan (explicit over-limit refused, default trimmed); each outlet counts on its own | `src/organizations/organizations.service.ts` |
| Plan limit lowered | silently left orgs over | nothing is deleted; adding is refused while over; the plan edit response lists organisations now over (`overLimitOrganisations`) and the console shows it | `subscriptions.service.ts` (`organisationsOverPlanLimits`), `subscriptions.controller.ts`, web `SubscriptionsPage.tsx` |

I searched for every site that inserts tables (`create(Table`, `save(Table`, `INTO tables`): the four above are all of them.

### 1.2 Staff seats
**Definition (one place, `src/subscriptions/capacity.ts`):** a seat is an **active** staff account that belongs to the outlet and is a real person.
- Consumes a seat: STORE_MANAGER, CHEF (personal), STEWARD, CASHIER at that outlet, including a manager created at sign-up.
- Does **not**: system accounts (the shared kitchen-station login, e-mail domain `@stations.pangat.app`), the organisation owner (SUPER_OWNER has no outlet), platform administrators.
- The e-mail domain is now **reserved**: creating a person with it is refused (otherwise it would be a way to hide from the seat count).

Enforced in `createStaff`, re-activation (`updateStaff`), and sign-up (a manager must fit the trial plan's seats), under the outlet row lock. The plan-change over-limit check (`platform/subscriptions-admin.service.ts` `usage()`) now counts seats the same way. Files: `restaurants/restaurants.service.ts`, `auth/auth.service.ts`, `capacity.ts`, `platform/subscriptions-admin.service.ts`.

### 1.3 Feature enforcement
| Feature | Enforced at | Files |
|---|---|---|
| `QR_ORDERING` | guest `POST /orders` (plan + kill switch + override); the public menu stays readable but reports `ordering.accepting=false` (also when the subscription has lapsed) | `orders/orders.service.ts`, `menu/menu.service.ts` |
| `KDS` | `POST /auth/kds-pin-login` (after the PIN is verified, so nothing leaks to guessers); socket `join:kds`; the kitchen role (CHEF): `GET /orders`, `PATCH /orders/:id/status`, `PATCH /orders/:id/regress-status`, `PATCH /menu/items/:id/availability`. Owners/managers/cashiers keep using the orders screen | `auth/auth.service.ts`, `events/events.gateway.ts`, `orders/orders.controller.ts`, `menu/menu.controller.ts`, `common/guards/feature.guard.ts` |
| `MULTI_OUTLET` | second and later outlet (`POST /organizations/outlets`); the numeric limit still applies on top | `organizations/organizations.service.ts` |
| `INVENTORY`, `ANALYTICS` | unchanged (`@RequireFeature`), now through the same resolver | `inventory.controller.ts`, `reports.controller.ts` |
| `ADVANCED_REPORTS` | **Not built → not sellable**: cannot be added to a plan (400), hidden from public plan lists and the owner's plan view, shown in the console as "not built yet", excluded from per-restaurant overrides. Plans that already carry it keep working (nothing is deleted) | `subscription-access.ts` (`FEATURE_CATALOG`), `subscriptions.service.ts`, `platform.controller.ts`, web console pages |

### 1.4 One authoritative implementation
All rules live in `src/subscriptions/subscription-access.ts`: `derivedStatus`, `evaluateAccess`, `evaluateLimit`, `decideFeature`, `getEntitlements`, `FEATURE_CATALOG`.
- `EntitlementService` is now a thin read-only facade over the same pure functions (it no longer has its own grace/limit logic and **no longer writes on read**).
- `FeatureGuard` and every enforcement point call `decideFeature` (plan + platform kill switch + per-organisation override via `platform/features.ts`).
- The hourly sweep (`platform/jobs.service.ts`) uses `derivedStatus`, so it persists exactly what the guards already enforce.
- The SQL used by the platform lists (`effectiveStatusSql`) is a documented twin; a live test compares it with `derivedStatus` for 168 combinations.
- The API returns the final decision to the console: `GET /subscriptions/my-subscription` now includes `entitlements` (features with reason, limits, access). The web app renders from it and hardcodes no plan, price or limit.

### 1.5 Multi-outlet
A plan without `MULTI_OUTLET` cannot add an outlet even if `maxOutlets` is 3 (402 `FEATURE_NOT_IN_PLAN`); with the feature the limit still applies (403 `PLAN_LIMIT_REACHED`). Concurrent outlet creation is serialised by a lock on the organisation row. Existing extra outlets keep working; only creation is gated.

### 1.6 Super Admin override (explicit, permissioned, audited)
Table limit at `POST /tables` (`limitOverrideReason`) and at provisioning (`limitOverrideReason`): needs a platform administrator with **`subscriptions.manage`** (plus `merchant.operate` for the console route / `restaurants.provision` for provisioning), a reason of at least 10 characters, and writes a `PLAN_LIMIT_OVERRIDDEN` row to `subscription_audit_logs` (actor, reason, kind, limit, current, requested). Anyone else who sends the field gets `403 LIMIT_OVERRIDE_FORBIDDEN` (never silently ignored). The usual alternative for exceptions remains plan change / per-restaurant `FORCE_ON`.

### 1.7 Smaller fixes found on the way
- Error responses now carry structured `details` (`limitKind`, `limit`, `current`, `requested`, or `feature`) next to `code` (`common/filters/http-exception.filter.ts`); previously the filter dropped everything except `code`.
- Plan limits reject values below -1 (`-1` = unlimited) in the create/update DTOs.
- A pool-exhaustion hazard was removed during development: plan/access are read **before** a transaction takes its connection and lock (`loadCapacityContext`); a 40-request burst against a 15-connection pool is tested.

---

## 2. Design decisions and entitlement behaviour

**Status rules (`derivedStatus`; the same for guards, services and the sweep)**

| Stored status | Condition | Effective status | Access |
|---|---|---|---|
| TRIAL / ACTIVE | period not ended | unchanged | full |
| TRIAL / ACTIVE / PAST_DUE / GRACE_PERIOD | period ended, inside grace (setting, default 7 days; gateway `gracePeriodEndsAt` wins) | GRACE_PERIOD | full |
| same | period ended, grace over | EXPIRED | blocked |
| same | period ended and `cancelAtPeriodEnd` | EXPIRED (no grace) | blocked |
| GRACE_PERIOD / PAST_DUE | gateway grace window closed, even if the period end is later | EXPIRED | blocked |
| CANCELLED | paid period still running / over | CANCELLED | full / blocked |
| HALTED, EXPIRED | – | unchanged | blocked |

"Blocked" = all non-GET staff calls return 402 `SUBSCRIPTION_INACTIVE`, except what closes live service (order status/payment/cancel/refund, table status); guest ordering is refused; data stays readable; the owner can still reach billing. This is the behaviour that existed; it is now implemented once.

**Behaviour changes versus before (please read):**
1. A GRACE_PERIOD/PAST_DUE subscription whose gateway grace window has closed is now blocked even if `currentPeriodEnd` is still in the future (before it stayed usable indefinitely until the period ended).
2. `cancelAtPeriodEnd` subscriptions past their period end are persisted as EXPIRED by the sweep (before: the sweep wrote GRACE_PERIOD while the guard was already blocking them).
3. Reads no longer mutate subscription rows (`EntitlementService`).
4. The public menu reports ordering as closed when the plan lacks `QR_ORDERING` or the subscription lapsed (previously the checkout simply failed).
5. Sign-up/provisioning table defaults (12 + 4) are trimmed to the plan; before they were never checked.

**Deliberate differences kept (operational):** the access decision is cached 20 s (invalidated by every admin/billing operation); feature decisions read the plan live (no plan cache) and the platform flag/override cache is 15 s, invalidated by the console; the public menu has a 3 s cache cleared on any write; limits are *per outlet* for tables and staff, *per organisation* for outlets; a trial gets the same 7-day grace as a paid period (as before).

**HTTP codes:** missing plan feature → `402 FEATURE_NOT_IN_PLAN`; feature switched off by the platform or an override → `403 FEATURE_DISABLED`; numeric limit → `403 PLAN_LIMIT_REACHED` (kept as 403 for compatibility; see §9); lapsed subscription → `402 SUBSCRIPTION_INACTIVE`.

**Frontend:** upgrade messages via the existing `UpgradeNotice`; sidebar shows a lock on Reports, Inventory and the Kitchen KDS link when the API says they are unavailable; the KDS page shows the notice instead of an empty board; "Add outlet" shows the reason and disables the button; table count in that dialog is capped by the API-provided limit; the plan editor disables features that are not built and reports who is over a lowered limit.

---

## 3. Database migrations

**`src/migrations/017_plan_feature_enforcement.sql`** (+ `.down.sql`) — additive, idempotent, transactional (auto-applied on boot like 009–016).
Until now `QR_ORDERING`, `KDS` and `MULTI_OUTLET` were never enforced, so every restaurant effectively had them. To keep **existing restaurants from losing access**, the migration adds:
- `QR_ORDERING` and `KDS` to every plan that does not list them (and has no `*`);
- `MULTI_OUTLET` to every plan whose `max_outlets <> 1` and that lacks it (this is what keeps the default **Growth** plan's three outlets working).
Every addition is recorded in new table `plan_feature_backfills`; the down script removes exactly those additions and drops the table. `ADVANCED_REPORTS` is untouched. **No data is deleted, no column added or dropped.** Not run against Neon.

Code defaults: `default-plans.ts` Growth now lists `MULTI_OUTLET`; the default Enterprise no longer lists the unbuilt `ADVANCED_REPORTS`. These affect only newly seeded databases (seeding never updates existing rows).

---

## 4. Tests added and exact results (all on an isolated local PostgreSQL 16, API started from `dist/` in development mode)

| Command | Result |
|---|---|
| `npm test` (API unit, no DB) | **266 tests, 266 pass, 0 fail** (229 existing + 37 new in `test/phase1-logic.test.mjs`; one existing mock in `test/qa-remediation.test.mjs` was updated because kitchen sign-in now asks the subscription layer) |
| `npm run test:phase1` (**new**, live) | **36 tests, 36 pass, 0 fail** |
| `npm run test:integration` (existing, live) | 53 / 53 pass |
| `npm run test:platform` (existing, live) | 43 / 43 pass |
| `npm run test:compliance` (existing, live) | 14 / 14 pass |
| web `npm test` | 44 / 44 pass |
| web `tsc -b` and `npm run build` | succeed |
| API `nest build`, `npm run lint` (oxlint) | build succeeds; lint reports warnings only (same kinds as before) |
| web `eslint` | 67 errors on the whole tree **both before and after** my change; the files I changed have the same 10 problems as before (none new) |

**What `test:phase1` covers** (`test/phase1-entitlements.e2e.test.mjs`): table limits via `POST /tables`, onboarding (indoor+outdoor together, default trimming, 150-table attempt), provisioning (limit, short reason, permitted override + audit row, finance role refused), new-outlet tables per outlet, concurrent table creation (8 parallel; and 40 parallel vs a 15-connection pool), limit lowering (no deletion, adds blocked, over-limit report, recovery after removal), override authorisation; staff seats (station excluded, owner excluded, manager at sign-up counted, zero-seat plan, re-activation, 8 concurrent creations, per-outlet seats, IDOR, reserved e-mail domain); each feature through the API: `QR_ORDERING` (plan, kill switch, `FORCE_OFF`, `FORCE_ON`, public-menu flag), `KDS` (PIN sign-in, kitchen role feed, socket, kill switch beating `FORCE_ON`), `INVENTORY`/`ANALYTICS` direct calls, `ADVANCED_REPORTS` (cannot be added, hidden, legacy plan editable), entitlement payload; multi-outlet (feature without limit, limit with feature, 6 concurrent creations, `FORCE_ON`, kill switch, manager and other tenant refused); trial / active / grace / expired / extended / cancel-at-period-end / immediate cancel; sweep vs guards agree; SQL twin vs `derivedStatus` (168 combinations); migration 017 up, idempotent, down (inside a rolled-back transaction); regression of the whole order flow (guest order → kitchen PIN → status → pay → report), a legacy organisation with no subscription row, tenant isolation, and unknown body fields rejected.

**Existing-test coverage** that still passes and exercises order operations, KDS, tenants, billing, audit, privacy and platform control: the three existing live suites above and the 229 existing unit tests.

---

## 5. Tests not executed (and why)

- **`npm run test:uat` (web UI end-to-end, `pangat-web/test/e2e/uat.e2e.test.mjs`)** — needs a browser-driven UAT environment; not run. The UI changes are therefore verified by type-check, build, unit tests and reading, **not by clicking through them**.
- **`test/security-integration.test.ts`** — a TypeScript test that is not part of any npm script; not run.
- **Nothing on Neon or a staging deployment** — none available to me, and production credentials were off-limits.
- **No automated test of the web console changes** (lock icons, `AddOutletModal`, `KDSPage` notice, plan editor); they are type-checked and built only.
- Razorpay webhook behaviour was not re-tested beyond the existing suites; this phase did not change the webhook.

---

## 6. Security and tenant-isolation verification

Verified by tests (above) unless marked *review*.
- **Tenant isolation / IDOR:** another tenant cannot add tables or staff to this outlet (403); cross-tenant override attempt refused (403); `TenantGuard` untouched.
- **Privilege escalation via body/query:** unknown body fields (`maxTablesPerOutlet`, `planCode`) rejected (400); `limitOverrideReason` from an owner → 403 `LIMIT_OVERRIDE_FORBIDDEN`; from a platform role without `subscriptions.manage`/`merchant.operate` → 403; the plan in force is always the one in the database.
- **Plan-limit bypass via alternative routes:** all four table-creation sites and both staff-creation sites covered (grep-verified); reserved system e-mail domain closed.
- **Race conditions:** row locks + same-transaction insert; tested with 8 and 40 parallel requests, exact counts held. Locks are taken on `restaurants`/`organizations` rows only; I did not exhaustively audit every other transaction for lock ordering, so treat deadlock freedom under mixed workloads as unproven beyond the tested bursts.
- **Status codes:** see §2; the earlier inconsistency (limit errors carried no numbers) is fixed.
- **Cache after plan change:** plan reads are uncached; access decisions refresh via `invalidateOrgAccess` on every admin/billing operation; flag/override cache invalidated by the console; public menu cache cleared on writes. **Not covered:** editing `organization_subscriptions` directly in SQL does not invalidate the 20 s access cache (the tests wait it out).
- **Super Admin permission bypass:** override requires an explicit permission and reason and is audited; platform finance role cannot reach restaurant consoles or provisioning.
- **Existing ordering/KDS interruptions:** a restaurant on a plan with all features ran the whole flow (guest order, kitchen PIN, status, payment, report). Expired organisations still settle in-flight orders. *Review:* existing restaurants keep `KDS`/`QR_ORDERING` through migration 017; a plan created by the platform that lacks them *and* is assigned after migration would be blocked by design.
- **Pre-existing items noticed, not changed (outside Phase 1):** `GET /tables` and `GET /menu/items?restaurantId=` are public by design (diner lookup) and list table numbers / menu without authentication; `FeatureGuard` lets a user with no organisation through (legacy accounts).

---

## 7. Remaining limitations

1. **No override path for outlets or staff seats**: the outlet route is owner-only (a platform administrator has no organisation context there) and staff routes are owner-only; exceptions are made by changing the plan or `FORCE_ON`. Table limits and provisioning have the audited override.
2. **Station detection is a convention** (`@stations.pangat.app`), not a database column; it is centralised and protected (reserved domain), but a column would be sturdier.
3. **Screens are not metered**: `KDS` is on/off. A cap on simultaneous kitchen screens (planned for packaging) is not implemented.
4. **Existing over-limit organisations** are reported only when a plan is edited, and in the plan-change check; there is no standing report.
5. `FeatureGuard` and `KDS` for a CHEF-role caller rely on the role; a manager can still use the orders screen when KDS is off (intended).
6. `ADVANCED_REPORTS` remains in `feature_flags` and on legacy plan rows; it is hidden and unsellable, not deleted.
7. Web console changes are unverified in a browser (§5).
8. HTTP 403 for plan limits (not 402) means the global "subscription" toast does not fire for them; the form shows the message and `details`.

---

## 8. Manual staging verification steps

1. Back up the staging database. Deploy API + web from this branch. Confirm the log shows `Applying migration 017_plan_feature_enforcement.sql`.
2. **Before** deploying, run on staging: `SELECT code, max_outlets, features FROM subscription_plans;` and after: confirm every plan now lists `QR_ORDERING`, `KDS` and that plans with `max_outlets <> 1` list `MULTI_OUTLET`; `SELECT * FROM plan_feature_backfills;` shows exactly what was added.
3. Sign in as an existing restaurant owner (a real staging tenant): place a guest order from the QR page, sign in to KDS with the kitchen PIN, advance the order, mark it paid, open Reports (on a plan with Analytics). Everything should behave as before.
4. In Super Admin → Subscriptions: create a test plan with 5 tables, no KDS. Assign it to a test restaurant. Check: 6th table refused with a clear message; kitchen PIN sign-in says the plan lacks the kitchen display; the KDS page shows the notice; guest menu shows "not taking orders".
5. Lower that plan's table limit to 3: the save shows the "N restaurants now above this plan's limits" notice; the restaurant keeps its 5 tables, cannot add.
6. Remove `MULTI_OUTLET` from a plan with several outlets: owner sees the add-outlet reason; existing outlets remain usable; add via Super Admin `Force on` and retry.
7. Provision a restaurant with more tables than the trial plan allows: refused; repeat with an override reason as an OWNER/ADMIN-role admin: succeeds and the subscription history shows `PLAN_LIMIT_OVERRIDDEN`.
8. Open a sign-up/provisioning with the kitchen PIN, add staff until the seat limit: the kitchen station account must not count; the seat error shows the numbers.
9. Let one disposable subscription lapse (or use "extend" to restore) and confirm editing is blocked, in-flight orders can still be paid, and restoring works at once.
10. Rollback rehearsal: run `017_plan_feature_enforcement.down.sql` on a staging **copy** only and confirm the plan rows return to their previous feature lists.
11. Click through the web changes listed in §2 in a real browser (not covered by automation).

---

## 9. Decisions that need your approval before proceeding

1. **Migration 017 grants `QR_ORDERING`, `KDS` (all plans) and `MULTI_OUTLET` (plans with outlet limit ≠ 1) to existing plans.** It is what keeps current restaurants running; it also means plans you later want to *withhold* these from must be edited on purpose afterwards. Without it, Starter/Growth-style plans would lose features today. Please confirm.
2. **Default plan rows in code:** Growth now carries `MULTI_OUTLET`; Enterprise no longer lists `ADVANCED_REPORTS`. Live rows are unaffected (the migration handles those). Confirm this is the product intent for Phase 2 packaging.
3. **Limit errors as HTTP 403** (vs 402). I kept 403 for compatibility; switching to 402 would trigger the global upgrade toast but changes the status clients may rely on.
4. **Trial default is still `GROWTH`**, and a sign-up is now checked against *that* plan's limits. If you change the trial plan to a smaller one, new sign-ups get proportionally fewer default tables.
5. **Outlet/staff overrides:** do you want a Super Admin route to create outlets or add staff beyond limits, or are plan changes / `FORCE_ON` enough?
6. The two pre-existing public listings in §6 (tables, menu items): leave as is, or restrict in a follow-up?

---

## Appendix — files changed

API: `src/subscriptions/{subscription-access,capacity (new),entitlement.service,default-plans,subscriptions.service,subscriptions.controller}.ts`, `subscriptions/dto/{create,update}-plan.dto.ts`, `common/guards/feature.guard.ts`, `common/filters/http-exception.filter.ts`, `tables/{tables.service,dto/create-table.dto}.ts`, `organizations/organizations.service.ts`, `restaurants/restaurants.service.ts`, `auth/auth.service.ts`, `admin/{admin.service,admin.controller,dto/provision-restaurant.dto}.ts`, `orders/{orders.service,orders.controller}.ts`, `menu/{menu.service,menu.controller}.ts`, `events/events.gateway.ts`, `platform/{jobs.service,platform.controller,subscriptions-admin.service}.ts`, `migrations/017_*.sql`, tests `test/phase1-logic.test.mjs`, `test/phase1-entitlements.e2e.test.mjs`, `test/qa-remediation.test.mjs`, `package.json`.
Web: `src/lib/api.ts`, `src/types/domain.ts`, `src/features/subscriptions/billing.ts`, `src/features/admin/{AdminLayout.tsx,components/AddOutletModal.tsx}`, `src/features/kds/KDSPage.tsx`, `src/features/super-admin/pages/{SubscriptionsPage,SettingsPage,RestaurantProfilePage}.tsx`.

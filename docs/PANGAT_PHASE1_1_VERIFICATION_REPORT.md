# Pangat — Phase 1.1 Independent Verification Report

Scope: independent verification of Phase 1 (API `7dda8b0`, web `9f3b9f8`, both on `claude/backend-plan-details-mismatch-gfi47m`). Phase 2, pricing, packaging and landing-page copy were not touched. Everything ran on a **disposable local PostgreSQL 16, a local API and a local Vite server**; nothing touched Neon or production, and no migration was run anywhere else.

---

## 1. Executive verdict: **PASS WITH CONDITIONS**

Phase 1's design holds, and I re-verified every journey in a real browser (37/37 checks). But the independent review found **two serious defects that the Phase 1 tests did not catch**, one of them introduced by Phase 1 itself:

| # | Severity | Defect | Origin | Status |
|---|---|---|---|---|
| V1 | **High** | **Database deadlocks under mixed load**: the Phase 1 capacity lock (`SELECT … FOR UPDATE` on the outlet row) deadlocked with the foreign-key locks taken by orders, audit rows and settings saves (14 deadlock errors, HTTP 500s on `POST /tables`, `POST /orders`, `PATCH …/settings`). | **Phase 1** | **Fixed** (`FOR NO KEY UPDATE`); 28/28 repeated stress runs clean, DB deadlock counter asserted |
| V2 | **High** | **Saving outlet settings can silently delete (or re-insert) tables created at the same moment.** Reproduced: 25 concurrent table adds + 25 settings saves left **13 of 26** tables. | **Pre-existing** (the settings code is unchanged), but it makes Phase 1's "exact limit" guarantee untrue under concurrency | **Fixed** in `restaurants.service.ts` `updateSettings`; **needs your explicit review (outside Phase 1 scope)** |
| V3 | Medium | A kitchen-role (CHEF) token could join the **admin** socket room: a way around the KDS gate, and it receives the unredacted order feed (customer details, amounts) the kitchen is meant never to see. | Pre-existing (PII), Phase 1 gate bypass | **Fixed** (admin room refused for the kitchen role) |
| V4 | Medium | Migration 017 was **not safe to run twice**: after an operator deliberately removed a key a plan originally had, a re-run granted it back. | Phase 1 | **Fixed** (guarded one-time backfill) |
| V5 | Low | A limit override was in the subscription trail but **not in the platform Audit log page**. | Phase 1 | **Fixed** |
| V6 | Low | Feature error text said "does not include kds". | Phase 1 | **Fixed** ("live kitchen display") |
| V7 | Low–Medium | Two public endpoints expose more than a diner needs (§5) and `GET /tables?restaurantId=<malformed>` returns HTTP 500. | Pre-existing | **Not changed: awaiting your approval** |
| V8 | Low (UX) | On plans without Inventory, every console page shows an "upgrade to unlock inventory" error toast (a background inventory fetch gets a 402). | Pre-existing | Not changed |

The conditions for merging are in §11.

---

## 2. Git diff and scope review

- Branches: both repos on `claude/backend-plan-details-mismatch-gfi47m`, tracking origin, clean before this audit. API commits: `7dda8b0` (Phase 1) + `3e9b91c` (this phase's fixes). Web: `9f3b9f8`, unchanged in 1.1.
- Phase 1 diff vs the starting commits: API 33 files (+1,891/−254), web 9 files (+112/−21). I read the diff, not just the report.
- **Scope:** all changes serve Phase 1 (limits, seats, feature enforcement, entitlement consolidation, migration 017, the console surfaces for them, tests, report). No pricing, packaging, landing copy or unrelated features were modified. One Phase 1 change goes slightly beyond the brief but is documented: `default-plans.ts` (Growth carries `MULTI_OUTLET`; default Enterprise drops the unbuilt `ADVANCED_REPORTS`).
- **No secrets, debug code or shortcuts:** grep of the diff for `console.log`, `debugger`, `TODO`, keys/passwords found only the pre-existing placeholder bootstrap secret in a test header comment (same value the existing suites use). No `THROTTLE_DISABLED`-style bypass was added to production code.
- **No hardcoded plan limits in the web:** the only price/limit literals outside the landing page are none; the console reads `entitlements` from the API (checked by grep).
- **No duplicated entitlement logic:** all rules are in `subscription-access.ts`. Remaining parallel copy is the documented SQL twin `effectiveStatusSql`, compared with the code by a live test over 168 combinations (passes). Note `EntitlementService` is still injected into `RestaurantsService`/`OrganizationsService` but no longer called there (dead injection, harmless); it is used by `SubscriptionsService`.

**Does the Phase 1 report match the code?** Mostly yes; corrections:
1. "Nothing else takes locks in the opposite order… unproven" — **disproved**: V1 shows the lock mode itself deadlocked. The report's claim that the table limit was "tested with 8 and 40 parallel requests" was true but only for the table-creation path in isolation.
2. "Migration 017 … idempotent" — **only partly true** until V4 was fixed.
3. "Public listings … by design" — the evidence (§5) shows the web app does not use them for diners.
4. "Pre-existing items noticed" omitted V2/V3, which only appeared under mixed-load testing.
All other claims I spot-checked (limit definitions, seat definition, error codes and shapes, enforcement points, status table) match the code.

---

## 3. Independent code review findings

**Transactions and locks.** All four table-creation sites and both staff-creation sites take their lock and count inside the writing transaction (`capacity.ts`); outlet creation locks the organisation row. Subscription facts are loaded *before* the transaction (no second pool connection while holding a lock). Verified by reading and by bursts of 8 and 40 parallel requests against a pool of 15.
- **V1 (found, fixed):** lock mode. `FOR UPDATE` conflicts with the `FOR KEY SHARE` that Postgres takes on a parent row for every child insert (orders, audit rows, tables, staff). Under mixed load this produced cycles such as *settings save ↔ table insert ↔ audit insert ↔ capacity lock*. `FOR NO KEY UPDATE` still serialises capacity checks and row updates but not child inserts. After the fix: 0 new deadlocks in the Postgres log, `pg_stat_database.deadlocks` unchanged across the stress test (now asserted), 28/28 repeated runs of the mixed test green (previously ≈ 50 % red).
- **Lock ordering:** table/staff transactions lock one `restaurants` row; outlet creation locks one `organizations` row then inserts a new `restaurants` row. I found no path that takes the organisation lock while holding an outlet lock, or the reverse. This is review plus stress evidence, not a proof.
- **V2 (found, fixed):** `RestaurantsService.updateSettings` loads the outlet *with* its `tables` (cascading relation) and saves the entity back. If a table was created between load and save, TypeORM's relation diff issued `DELETE FROM tables …` or re-inserted rows (PK violations). Reproduced without the fix: **19 failures / 13 of 26 tables remaining**; with the fix: pass. Fix: the list is detached for the save and re-attached to the response (same shape as before). This is a behaviour-preserving fix but it is in code Phase 1 did not own: please review.
- **V3 (found, fixed):** `EventsGateway.joinOutletRoom('admin')` accepted any signed-in staff of the outlet. A CHEF could therefore bypass the KDS gate and read the unredacted admin feed. Admin room now refuses the kitchen role. The web admin console never joins it as a chef (checked).

**Paths that could bypass a limit.** Grep-verified: tables are inserted only in `tables.service.create`, `auth.service.onboard`, `admin.service.provisionRestaurant`, `organizations.service.createOutlet`; staff only in `restaurants.service.createStaff`/`updateStaff` (reactivation) and `auth.service.onboard` (manager). All enforce. The reserved `@stations.pangat.app` domain cannot be used for a person (400, tested).

**Platform administrators.** Override needs `subscriptions.manage` *and* a route the role may reach. Tested with ANALYST, SUPPORT and FINANCE (all 403 on override, plan edit and feature override) and ADMIN (succeeds, audited under its identity). One observation: `RolesGuard` lets any platform admin with `merchant.operate` call owner-only routes (e.g. create staff); those remain subject to the plan limit (no override path), and this is the existing design.

**Plan changes and caches.** Plan membership is read live (no cache), so a console plan change reaches exactly that organisation at once; editing a shared plan reaches all its subscribers at once (tested). The access decision is cached 20 s and invalidated by every admin/billing operation (extend, cancel, assign, change plan, webhook); flag/override cache 15 s invalidated by the console; public menu cache 3 s cleared by any write. **Gaps:** editing subscription rows directly in SQL does not invalidate the 20 s cache; a socket already joined to the kitchen room keeps receiving until it reconnects (code review, **not tested**).

**Super Admin override.** Tested: no reason → limit applies; short reason → 400; wrong role → 403; correct role → success with rows in `subscription_audit_logs` and (after V5 fix) `platform_audit_logs`. The console has **no control** for it (API only) and no override exists for outlets/staff (by decision, §9 of the Phase 1 report).

---

## 4. Migration 017 review and SQL snapshots

I read both files and exercised them on a disposable database (`pangat_mig`) with production-like legacy rows: the six default plans as seeded by migrations 005/006, a custom reports-only plan, a custom 2-outlet plan, an empty-features plan, a wildcard plan, and a retired plan (script: `/tmp/mig_scenario.sh`, output saved; the same scenario is also a live test).

Verified:
- **Safe to run more than once** — *after the V4 fix*. Before it, a third run re-granted `KDS` to `STARTER` after an operator had removed it. The file is now one guarded `DO` block: if `plan_feature_backfills` exists it does nothing.
- **Does not overwrite plan configuration:** prices, limits and every other column are untouched; features are only appended.
- **Adds only the intended features:** `QR_ORDERING` and `KDS` where missing; `MULTI_OUTLET` where `max_outlets <> 1`; wildcard (`*`) plans untouched; `ADVANCED_REPORTS` never added or removed.
- **Every addition recorded** in `plan_feature_backfills` (10 rows in the scenario: 4 KDS, 3 QR_ORDERING, 3 MULTI_OUTLET).
- **Down removes only recorded additions**, keeps pre-existing features and an operator's later edits, drops the record table, and is a harmless no-op when 017 is not applied.
- **Plan edited after up:** operator edits survive both a re-run and the rollback (S3→S4 identical).
- **Entitlements/access:** it widens, never narrows; because QR/KDS were never enforced before Phase 1, no restaurant loses access from the migration. Operators who want to *withhold* a key must now do so on purpose.

Snapshots (plan code | outlet limit | active | features):

```
-- S0: before (production-like legacy state)
CUSTOM_CHAIN       | outlets=2 | active=true | QR_ORDERING
CUSTOM_REPORTS     | outlets=1 | active=true | ANALYTICS
ENTERPRISE         | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
ENTERPRISE_ANNUAL  | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
GROWTH             | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS
GROWTH_ANNUAL      | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS
LEGACY_EMPTY       | outlets=1 | active=true | 
RETIRED_OLD        | outlets=1 | active=false | INVENTORY
STARTER            | outlets=1 | active=true | QR_ORDERING,KDS
STARTER_ANNUAL     | outlets=1 | active=true | QR_ORDERING,KDS
WILDCARD           | outlets=5 | active=true | *

-- S1: after 017 (up)
CUSTOM_CHAIN       | outlets=2 | active=true | QR_ORDERING,KDS,MULTI_OUTLET
CUSTOM_REPORTS     | outlets=1 | active=true | ANALYTICS,QR_ORDERING,KDS
ENTERPRISE         | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
ENTERPRISE_ANNUAL  | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
GROWTH             | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET
GROWTH_ANNUAL      | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET
LEGACY_EMPTY       | outlets=1 | active=true | QR_ORDERING,KDS
RETIRED_OLD        | outlets=1 | active=false | INVENTORY,QR_ORDERING,KDS
STARTER            | outlets=1 | active=true | QR_ORDERING,KDS
STARTER_ANNUAL     | outlets=1 | active=true | QR_ORDERING,KDS
WILDCARD           | outlets=5 | active=true | *

-- S2: after running 017 a second time: IDENTICAL to S1

-- S3: operator then edits on purpose: STARTER loses KDS, CUSTOM_CHAIN gains INVENTORY, GROWTH loses MULTI_OUTLET
CUSTOM_CHAIN       | outlets=2 | active=true | QR_ORDERING,KDS,MULTI_OUTLET,INVENTORY
CUSTOM_REPORTS     | outlets=1 | active=true | ANALYTICS,QR_ORDERING,KDS
ENTERPRISE         | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
ENTERPRISE_ANNUAL  | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
GROWTH             | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS
GROWTH_ANNUAL      | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET
LEGACY_EMPTY       | outlets=1 | active=true | QR_ORDERING,KDS
RETIRED_OLD        | outlets=1 | active=false | INVENTORY,QR_ORDERING,KDS
STARTER            | outlets=1 | active=true | QR_ORDERING
STARTER_ANNUAL     | outlets=1 | active=true | QR_ORDERING,KDS
WILDCARD           | outlets=5 | active=true | *

-- S4: 017 run a third time: IDENTICAL to S3 (nothing re-granted, STARTER stays without KDS)

-- S5: after the down script (diff S3 -> S5: only what 017 recorded is removed)
CUSTOM_CHAIN       | outlets=2 | active=true | QR_ORDERING,INVENTORY
CUSTOM_REPORTS     | outlets=1 | active=true | ANALYTICS
ENTERPRISE         | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
ENTERPRISE_ANNUAL  | outlets=-1 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS
GROWTH             | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS
GROWTH_ANNUAL      | outlets=3 | active=true | QR_ORDERING,KDS,INVENTORY,ANALYTICS
LEGACY_EMPTY       | outlets=1 | active=true | 
RETIRED_OLD        | outlets=1 | active=false | INVENTORY
STARTER            | outlets=1 | active=true | QR_ORDERING
STARTER_ANNUAL     | outlets=1 | active=true | QR_ORDERING,KDS
WILDCARD           | outlets=5 | active=true | *
```

Diff S5 vs S3: only the keys 017 recorded were removed (`CUSTOM_CHAIN` keeps the operator's `INVENTORY`; `STARTER` stays without `KDS` because the operator removed it). Diff S5 vs S0: only the operator's two own edits remain.

Not done: it was not run against any real copy of production data (none available to me). The runner applies it automatically on boot in production (`AUTO_MIGRATE`), so take a snapshot first (§12).

---

## 5. Public endpoint security assessment

Measured on the local API with a real tenant; responses shown are from `curl`-equivalent calls without authentication.

**`GET /tables?restaurantId=<uuid>` or `?restaurantSlug=<slug>`; `GET /tables/:id`**
- Authentication: **none**.
- Tenant isolation: none needed by design; whoever knows a slug (printed on every QR) or restaurant id gets that outlet's list. No cross-tenant listing: with neither parameter it returns `[]`.
- Fields: `id, restaurantId, tableNumber, qrCodeUrl, status, createdAt, updatedAt`.
- Sensitive: **live occupancy** (`status` VACANT / OCCUPIED / PREPPING / SERVED, per table, in real time) is operational data a competitor or a scraper can poll; internal table ids; `restaurantId`. No customer or staff data.
- Does a diner need it? **No.** The diner pages use `GET /menu/public/:slug` and `POST /orders`; `api.tables.list/get` are called only from the staff admin store (grep). The existing integration test uses the unauthenticated call only to fetch a table id.
- Enumeration: slugs are guessable; ids are UUIDs but are disclosed by `GET /menu/public/:slug` (`restaurant.id`). Throttle verified **on**: 140 requests/min from one IP → 20 × HTTP 429 (limit 120/min/IP). A slow scraper can still poll one outlet's occupancy.
- Extra defect (V7): `?restaurantId=not-a-uuid` → **HTTP 500** (unhandled database cast; message is generic, no leak, but it is an error path).

**`GET /menu/items?restaurantId=<uuid>`**
- Authentication: **none**. Requires `restaurantId` (else 400), which any visitor obtains from the public menu.
- Fields (full entity): `id, restaurantId, categoryId, category{id,restaurantId,name,sortOrder}, name, description, price, isVeg, isAvailable, isPopular, imageUrl, modifiers[], autoDisabled, deletedAt, createdAt, updatedAt`.
- Compared with the public menu it adds `restaurantId`, `autoDisabled` (reveals that inventory switched a dish off), `deletedAt`, timestamps. No costs, stock levels or customer/staff data.
- Does a diner need it? **No** (the public menu endpoint is the diner's source; this one is called by the KDS and admin stores with a token).
- Enumeration: same throttle; exposure is low (the same content is public by design).

**Assessment:** no customer, staff or financial data leaks; the genuine (low–medium) issues are real-time table occupancy and internal fields on anonymous endpoints that nothing public needs, plus the malformed-id 500. **Smallest safe fix (not applied, awaiting approval):** require the normal staff guards (`JwtAuthGuard + RolesGuard + TenantGuard`) on `GET /tables`, `GET /tables/:id` and `GET /menu/items`, add `ParseUUIDPipe` for the id parameters, and change the one integration-test call that fetches a table id to use an owner token. The public QR menu, ordering and order tracking are unaffected (they use `/menu/public`, `/orders`, `/restaurants/:slug`).

---

## 6. Browser UAT results (real Chromium; local API, DB and Vite; separate tenants and accounts)

Environment: Playwright 1.x Chromium driving `http://127.0.0.1:5173` against the local API. Reproducible scripts: `pangat-api/test/uat/*` (README included). Screenshots: `/home/user/uat-screenshots/` (names below). Final run after all fixes: **37 PASS, 0 FAIL**.

| Journey | Checks (all PASS) | Evidence |
|---|---|---|
| **A. Owner** (plan: 4 tables / 2 staff / 1 outlet; QR+KDS only) | sign-in; billing page shows plan, usage 2 / 4 tables, only the two included features; lock icons on Reports, Inventory; add tables to 4 of 4; 5th refused with "Plan limit reached (4 tables per outlet)" and DB still 4; add 2 staff (kitchen account not counted) then 3rd refused ("2 staff seats per outlet"); Add-an-outlet dialog shows "plan does not include multiple outlets" and Create is disabled; Reports and Inventory show the upgrade notice | A02–A11 |
| **B. Kitchen** | PIN sign-in opens KDS; ticket visible; **new guest order appears live without reload**; Start Prep → Mark Ready persisted (READY count +1); with KDS removed from the plan the KDS shows the upgrade notice; a fresh PIN sign-in is refused with "Your current plan does not include live kitchen display" | B01–B05 |
| **C. Diner** | public QR menu opens without login; normal order placed through the UI (order row created, tracking page opens); with QR_ORDERING off the menu still opens but says "This outlet is not taking orders right now. Please ask a staff member."; direct API order → HTTP 400 | C01–C04 |
| **D. Super Admin** | opens subscription management; feature matrix marks Advanced reports "not built yet"; plan editor shows it as a disabled option; lowering a limit to 3 (usage 6) shows "1 restaurant is now above this plan's limits…"; nothing deleted (6 tables remain); the owner is then told "already over the 3 tables…"; authorised override succeeds (API) and appears in the restaurant's *Billing events* as "Plan Limit Overridden" with actor and reason; Support-role admin gets 403 and sees no Edit / New plan controls; provisioning 150 tables without override → 403 `PLAN_LIMIT_REACHED` | D01–D06 |
| **E. Expired** | owner still signs in and reaches billing (state "Cancelled"); adding a table is refused with the subscription message; an in-flight order is settled from the Orders page (DB `PAID`); extending the subscription restores access at once | E01–E05 |

Limits of this UAT, stated plainly:
- Journey B's "ticket visible" check only asserts the New Orders column exists; the strong live-update check is B3.
- The authorised override has **no UI** (API only), so D7 was done through the API and its audit trail was then checked in the console.
- Desktop viewport (and one 420 px viewport for the diner); no cross-browser or accessibility run; no payment-gateway flows; no real e-mail.
- The app's own `test:uat` suite (`pangat-web/test/e2e/uat.e2e.test.mjs`) was **not run** (see §7).

---

## 7. Test execution results (exact commands; all on the disposable database)

| Command | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| `npm test` (API unit, 17 files) | 266 | 266 | 0 | 0 |
| `npm run test:phase1` (live) | 36 | 36 | 0 | 0 |
| `npm run test:phase1_1` (**new**, live) | 7 | 7 | 0 | 0 |
| `npm run test:integration` (live) | 53 | 53 | 0 | 0 |
| `npm run test:platform` (live) | 43 | 43 | 0 | 0 |
| `npm run test:compliance` (live) | 14 | 14 | 0 | 0 |
| web `npm test` | 44 | 44 | 0 | 0 |
| web `tsc -b`, `npm run build`; API `nest build` | succeed | – | – | – |
| Browser UAT (`test/uat/*`) | 37 checks | 37 | 0 | – |
| Repeated stress: mixed-operation test | 28 runs | 28 | 0 | – |

Notes:
- `test/security-integration.test.ts` **can** be run (`node --experimental-strip-types --test …`): 17 tests, **12 pass, 5 fail**. The same file at the **original** commit `1f03dbf` gives the identical 5 failures (verified in a temporary worktree): it is a stale duplicate of `security-integration.test.mjs` (whose mocks no longer match the code) and is not part of any npm script. The `.mjs` sibling runs in `npm test` and passes. Not caused by Phase 1.
- Web `npm run test:uat` was **not executed**: it expects its own UAT stack; I used my own Playwright journeys instead and do not count them as that suite.
- Web `eslint`: 67 errors on the whole tree before and after Phase 1; the files Phase 1 changed have identical problem counts before and after.
- A first full run after the fixes showed 2 red tests; both were test bugs I introduced (an expectation in the rewritten migration test, and the flaky mixed test that exposed V1/V2). Both were corrected; the table above is the final state.

---

## 8. Confirmed vulnerabilities or regressions

- **V1 deadlock (Phase 1 regression):** confirmed in the Postgres log (`deadlock detected`, cycles of 5–6 processes involving `SELECT … FOR UPDATE`, `DELETE FROM tables`, `INSERT INTO audit_logs`, `INSERT INTO orders`). Fixed.
- **V2 table loss on settings save (pre-existing):** confirmed, reproducible, data loss. Fixed; regression test added.
- **V3 kitchen role reads the admin feed:** confirmed (test red before fix). Fixed.
- **V4 migration re-run re-grant:** confirmed in the snapshot scenario. Fixed.
- **V7 public occupancy / internal fields / malformed id → 500:** confirmed. Not changed.
- **V8 toast noise:** confirmed in screenshots A03/E02.

Checked and **not** vulnerable: cross-tenant table/staff creation (403), owner-vs-manager outlet creation (403), body mass-assignment (unknown fields rejected by the validation pipe), override by unprivileged roles (403), feature-override precedence (kill switch > FORCE_ON > plan; FORCE_OFF blocks), error bodies (no stack/SQL/table names; limit errors carry only `limitKind, limit, current, requested`).

---

## 9. Required fixes, ranked

1. **(done) V1 deadlock** — verify on staging under realistic load (§12).
2. **(done, needs your review) V2 settings/tables race.**
3. **(done) V3 kitchen role / admin room.**
4. **(done) V4 migration guard.**
5. **(open, needs approval) V7:** authenticate `GET /tables`, `GET /tables/:id`, `GET /menu/items`; `ParseUUIDPipe` on ids.
6. **(open, optional) V8:** skip the background inventory fetch when the API reports Inventory as locked, so plans without Inventory do not see an error toast on every page.
7. **(open, optional)** surface the limit override in the console (a field on provisioning and on add-table for authorised admins) so it is not API-only.
8. **(open, optional)** add a Playwright suite to CI from `test/uat/` and delete or fix the stale `security-integration.test.ts`.

---

## 10. Remaining risks and unverified areas

- **Never run against Neon/staging**; only a local Postgres 16. Neon pooling, latency and `statement_timeout` could change lock behaviour: run the stress test (`test:phase1_1`) on staging.
- Lock-ordering safety is established by review and stress, not proof. The 28-run stress covers tables, staff, outlets, guest orders, status changes, settings saves and billing reads on one organisation; it does not cover inventory deduction, refunds or privacy jobs at the same time.
- Sockets already joined keep their feed after a plan change until reconnect (not tested).
- Multi-instance deployment (two API processes) was not tested: the access cache (20 s) and flag cache (15 s) are per process, and Socket.IO has no shared adapter.
- Payment gateway, e-mail and WhatsApp paths were out of scope and not exercised.
- Browser UAT covered Chromium desktop only; mobile layouts of the changed console screens were not reviewed.
- `Date`/clock-based tests (grace, expiry) were driven through the API and database, not by waiting for real days.

---

## 11. Is Phase 1 safe to approve and merge?

**Yes, with conditions**, and only the corrected code: merge **`3e9b91c` (API)** together with `9f3b9f8` (web), not the earlier Phase 1 head `7dda8b0` alone (it contains the deadlock).
Conditions:
1. You review and accept the settings-save fix (V2) and the admin-room change (V3), which touch code outside Phase 1's original scope.
2. Take a database snapshot before deploying (migration 017 auto-applies) and run `npm run test:phase1_1` plus the §12 checks against a staging copy.
3. Decide on V7 (public endpoints) before or immediately after launch; it is not a customer-data leak but is exposure with no product need.
4. Confirm the four Phase 1 decisions still open from the earlier report (migration grants, default-plan rows, 403 vs 402, outlet/staff overrides).

---

## 12. Exact next steps before Phase 2

1. Review this report and the diff of `3e9b91c` (settings fix, lock mode, gateway, migration guard, audit insert).
2. Answer the open approvals: V7 fix (yes/no), V8 toast fix (yes/no), override control in the console (yes/no), and the four earlier Phase 1 decisions.
3. On staging: snapshot DB → deploy → check `SELECT * FROM plan_feature_backfills;` and plan feature lists → run `test:phase1_1` against the staging API (disposable tenants only) → repeat the UAT checklist in `test/uat/README.md` against the staging web app → keep an eye on the Postgres deadlock counter (`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();`) during a real service hour.
4. If staging is clean, merge the API and web branches (no PR was opened by me).
5. Only then start Phase 2. **I have not started it and will wait for your explicit approval.**

---

### Appendix — files changed in this phase (API `3e9b91c`)
`src/subscriptions/subscription-access.ts` (lock mode, platform audit insert, feature label), `src/restaurants/restaurants.service.ts` (settings save), `src/events/events.gateway.ts` (admin room), `src/migrations/017_*.sql` and `.down.sql`, `test/phase1-1-verification.e2e.test.mjs` (new), `test/phase1-entitlements.e2e.test.mjs` (migration test rewritten, sweep test restored, platform-audit assertion), `test/uat/*` (browser journeys), `package.json` (`test:phase1_1`). Screenshots and UAT output are outside the repos in `/home/user/uat-screenshots/` and `/home/user/uat/`.

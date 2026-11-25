# Pangat — Phase 1 Final Approval Report

Approved for staging preparation: **API `9e45f25`**, **web `6457ec1`**. Everything below ran on a disposable local PostgreSQL 16, a local API and a local Vite server. Nothing touched Neon or production. **Nothing was merged to `main` (`origin/main` is still API `1f03dbf` / web `e895e11`), nothing was deployed, Phase 2 was not started.** The additions after the approved commits are test-only and documentation-only (proved below).

## Verdict: **PASS WITH CONDITIONS**

The approved runtime code is complete, reviewed again, and fully tested. The conditions are all about *proving it on real staging*, which I could not do: (1) run the staging checklist end to end on a staging copy; (2) run the platform-control suite on a fresh database (§8, item 1); (3) your go-ahead for the merge.

---

## 1. Final commit hashes and ancestry

| Repo | Commit | Content |
|---|---|---|
| API | `1f03dbf` | original base = `origin/main` (unchanged) |
| API | `7dda8b0` | Phase 1 (contains the deadlock lock mode; never deploy alone) |
| API | `3e9b91c` | Phase 1.1 fixes (lock mode, settings tables race, migration guard, admin-room refusal) |
| API | `028caff`, `4657472` | Phase 1.1 report |
| API | **`9e45f25`** | **Phase 1.2: approved runtime code** |
| API | `43a9f3a`, `8767dd2` | Phase 1.2 report (docs only) |
| API | `f95ddc9` | **separate change:** repair of `security-integration.test.ts` (test only) |
| API | `d7d2082` | five-role isolation + settings-overwrite test (test only) |
| API | **`8f592ab`** | docs only: staging checklist and scripts; **branch HEAD** |
| Web | `e895e11` | original base = `origin/main` (unchanged) |
| Web | `9f3b9f8` | Phase 1 |
| Web | **`6457ec1`** | **Phase 1.2: approved; branch HEAD** (no web change after it) |

Verified: `git merge-base --is-ancestor 9e45f25 HEAD` (API) and `6457ec1 == HEAD` (web). `git diff 9e45f25 HEAD -- src` is **empty**: the API runtime code at HEAD is byte-identical to the approved `9e45f25`; the nine files changed after it are two tests, `package.json` (test scripts), and docs. The security-test repair is its own commit (`f95ddc9`), not mixed into any Phase 1.2 commit. To merge only the approved runtime change, `9e45f25` and its ancestors are sufficient; the three later commits can ride along or be dropped.

## 2. A. Final code review (done on the real diffs)

- **Scope.** Base→`9e45f25`: API 54 files (+3,637/−271), web 17 files (+383/−33), all within Phase 1/1.1/1.2 (limits, seats, feature enforcement, entitlement consolidation, migration 017, console surfaces, kitchen-feed revocation, staff-only listings, tests, UAT scripts). No pricing, packaging, landing-page or unrelated feature changes.
- **Approved content present at the approved commits** (checked by searching the commit trees): `UuidInputGuard`, kitchen-socket tracking and `access:revoked`, `FOR NO KEY UPDATE`, `definedOnly` settings merge, entitlement-change signal, CHEF admin/order-room refusal; web `LimitOverrideDialog`, `silentPlanGate`, `onAccessRevoked`, entitlements.
- **No secrets or debug code in production source.** Scan of every added line in `src/` (both repos): no `console.*`, `debugger`, TODO/FIXME or credentials (the only hit was a variable named `todo`). `console.log` and local paths/URLs appear **only in `test/uat/*` Playwright scripts** (tooling; they contain the local throwaway DB URL and `/tmp` paths, no secrets). Test-only values such as `Str0ng-pass-1` and `whsec_test_123` are the existing suites' fixtures. `THROTTLE_DISABLED` is pre-existing and used only by test runs; the new `SOCKET_REVALIDATE_MS` is optional with a safe default.
- **Settings-save fix does not overwrite unrelated settings** — verified three ways: (a) TypeORM writes only changed columns once the stale `tables` list is detached; (b) the `operations` merge now spreads only fields that were actually sent (`definedOnly`); (c) executed tests: a save of `serviceChargePercentage` changed exactly one outlet column (`service_charge_percentage`; every other column compared before/after, `updated_at` aside), a sibling outlet of the same organisation was byte-identical, tables untouched; six concurrent saves of six different fields all persisted; 15 saves racing 15 table creations lost nothing; a partial `operations` update no longer resets the pause switch or opening hours.
- **All five staff roles stay inside their authorised outlets** — new executed test (`test:phase1_final`, 4/4): for the owner and each of manager, kitchen, steward and cashier — own outlet readable (tables by id and slug, single table, menu items); a sibling outlet of the same organisation refused for the four non-owner roles (the owner spans it); another organisation refused for all five including the owner; staff hired at the *second* outlet are confined to *that* outlet in the same way; a conflicting `restaurantId` cannot widen reach. Anonymous callers get 401 (Phase 1.2 suite).

## 3. B. Security test remediation (`test/security-integration.test.ts`) — separate commit `f95ddc9`

All 17 tests inspected. **12 already passed and were not touched. The five failing tests were failing identically at the original commit `1f03dbf`** (stale mocks); no overlap with Phase 1.2 code. Result now: **17 / 17 pass** (`node --experimental-strip-types --test test/security-integration.test.ts`). The `.mjs` sibling (22 tests, already repaired in an earlier commit) was used as the reference for the mock shapes; it was not modified.

| # | Test | Why it failed | Repair | Security intent |
|---|---|---|---|---|
| 1 | login does not automatically promote @pangat.in emails to PLATFORM_SUPER_ADMIN | mock repo lacked `createQueryBuilder` (current `AuthService.login`); the old `update()` mock threw on *any* write, but login legitimately records `lastLoginAt` | added the query-builder mock; `update` now throws only if the patch contains `role` or `isPlatformAdmin` | **Preserved**: the result must still be CHEF and not platform admin, and any write to the role or platform flag still fails the test |
| 2 | ignores client-supplied prices and calculates total strictly from DB | `orderRepo` mock lacked `findOne` (idempotency lookup) | added `findOne → null` | Preserved: 700 / 35 / 735 asserted unchanged |
| 3 | rejects order with cross-restaurant menu items | order repo argument was `{}` (same missing lookup), so a `TypeError` replaced the expected 400 | first constructor argument is now an order repo with `findOne → null` | Preserved: must still reject with 400 "does not belong to restaurant" |
| 4 | rejects order with out-of-stock items | same | same | Preserved: 400 "unavailable (out of stock)" |
| 5 | returns neutral public response … without leaking email | mock lacked `createQueryBuilder` / `manager.transaction`; **and the old assertion was itself stale**: it required the response to *contain* `delivered: true` and `deliveryProvider: 'sendgrid'`, which a later deliberate hardening (commit `c3a8b95`, mirrored in the `.mjs` file) removed because exposing delivery state reveals whether an account exists | mocks fixed; the two assertions were **inverted** (`'delivered' in response === false`, same for `deliveryProvider`) and a new check added: an unknown email returns an identical response | Preserved and **stronger**: no account enumeration |

**Tests that could not be repaired safely: none.** The only intent change is #5, documented above and in a comment in the file.

**Proof the repaired tests still bite** (mutation checks on a throw-away copy of `dist/`, 3 mutations): exposing delivery state in the reset response → test 5 fails; accepting a cross-restaurant menu item → test 3 fails; removing the tenant-conflict check → two tenant-isolation tests fail. (Two further mutations — trusting client prices, role promotion — were not run.)

## 4. Full test results (all executed in this task; final state)

| Command | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| `npm test` (API unit, 17 files) | 266 | 266 | 0 | 0 |
| `node --experimental-strip-types --test test/security-integration.test.ts` | 17 | 17 | 0 | 0 |
| `npm run test:phase1` | 36 | 36 | 0 | 0 |
| `npm run test:phase1_1` | 7 | 7 | 0 | 0 |
| `npm run test:phase1_2` (public endpoints 11, socket revocation 9, settings/override 8; run with `SOCKET_REVALIDATE_MS=1500`) | 28 | 28 | 0 | 0 |
| `npm run test:phase1_final` (new) | 4 | 4 | 0 | 0 |
| `npm run test:integration` | 53 | 53 | 0 | 0 |
| `npm run test:compliance` | 14 | 14 | 0 | 0 |
| `npm run test:platform` on the long-lived dev database | 43 | **42** | **1** | 0 |
| `npm run test:platform` on a **fresh** database | 43 | **43** | 0 | 0 |
| web `npm test` | 51 | 51 | 0 | 0 |
| API `nest build`; web `tsc -b` and `npm run build` | succeed | – | – | – |

The one red result is a **test-data artifact, not a code regression**: the platform-control test "there is no way to mark a payment successful by hand" asserts that a manual grant appears in the reconciliation list, but that list is capped (`LIMIT 20`, `finance.service.ts`) and my long-lived development database had accumulated 47 active manual grants from earlier test and UAT runs. On a fresh database the whole suite is 43/43. It failed identically in three consecutive reruns, so it is deterministic for that data volume. Recommendation: run the platform suite on a fresh database in staging/CI.

Browser UAT was **not re-run** in this task (no web or runtime change since the last full run: regression journeys 37/37, new journeys 17 + 5 + 5, all executed in Phase 1.2 against the same runtime code). The web repo's own `test:uat` suite has still never been run.

## 5. C. Staging preparation (delivered in `pangat-api/docs/staging/`)

- `STAGING_CHECKLIST.md`: preconditions, backup/restore, entitlement audit before and after, migration rehearsal, configuration table, deployment order (API first, then web, with the reason), existing-tenant verification, role-by-role journeys (owner, manager, kitchen, steward, cashier with must-work/must-be-refused), diner QR ordering, socket revocation and reconnection steps on a real tablet, Super Admin override and audit, subscription expiry and restoration, concurrent table/settings updates, rollback table, go/no-go.
- `backup_restore_check.sh`: dumps a source database (read-only), restores into a disposable `*_verify` database, compares row counts for 13 core tables, lists restored migrations.
- `migration_017_check.sh`: down → snapshot → up → up again → down on a disposable copy, asserting no feature is ever removed by up and that down restores the exact pre-017 state; prints the before→after plan diff.
- `entitlement_audit.sql`: read-only checks for existing tenants (plans lacking QR/KDS in use, multi-outlet organisations without the feature, outlets above table/seat limits, organisations without a subscription, stale statuses, `ADVANCED_REPORTS`, station accounts that are not CHEF).
- `_guard.sh`: refuses any target whose database name does not end in `_verify`, and managed-database hosts (Neon, Render, AWS) unless explicitly allowed.

**What I actually executed (locally):** `backup_restore_check.sh` → every line PASS (13 tables equal, 2.1 MB dump, `BACKUP/RESTORE VERIFIED`); `migration_017_check.sh` on the restored copy → `MIGRATION 017 REHEARSAL PASSED` (including the pre-017 → post-017 diff); the guard refused a non-`_verify` target and a Neon-looking URL; `entitlement_audit.sql` ran on the copy (returned rows only for synthetic test tenants). **What I could not do:** run any of it on a real staging environment or real production-shaped data; the role/diner/socket/override/expiry journeys in the checklist are the ones I already executed in the browser locally (Phase 1.2), not on staging.

## 6. Database migration risks

1. **Auto-apply at boot.** Migration 017 applies on first start with `AUTO_MIGRATE`. Mitigation: verified backup (§1 of the checklist), rehearsal on a copy, guarded one-time design (re-running changes nothing), and a down script that removes only what 017 recorded.
2. **It widens entitlements, never narrows.** It adds `QR_ORDERING`/`KDS` to plans lacking them and `MULTI_OUTLET` to plans with an outlet limit other than 1. A plan the platform had deliberately configured *without* those keys (relying on them not being enforced) will gain them; review the before→after diff and `entitlement_audit.sql` query 1–2 on staging.
3. **Operator edits and down.** Down removes a recorded feature even if an operator re-added the same key later (restoring the original); operator removals are never undone by a re-run.
4. **Pooled connections.** The migration runner takes a Postgres advisory lock; a transaction-pooling endpoint (e.g. Neon's pooled URL) does not honour session locks. Use the direct endpoint for the first boot after deploy (this pattern predates this release).
5. **Over-limit tenants.** Outlets already above their table/seat limit keep their data; they simply cannot add more (checklist query 3–4 lists them so account managers can talk to them before customers notice).
6. **Rollback is code-only in the normal case:** old code ignores the extra feature keys and the record table.
7. **Not rehearsed on real data.** My rehearsal used a copy of a synthetic development database (601 plans from tests), not production-shaped data.

## 7. Verified facts that changed nothing (for completeness)

The five product decisions (migration 017 guarded backfill, default plans, HTTP 403 for limit errors, no outlet/staff override) were left exactly as approved. All five staff roles keep table and menu listing. The settings fix and its regression tests are retained.

## 8. Remaining issues (all open items, none blocking staging)

1. **Platform suite depends on database volume** (`LIMIT 20` manual-grant list): run it on a fresh database; optionally make the test pick a larger limit or the check query filter by organisation (not done: touching that test/code was out of scope).
2. **Staging not exercised.** Everything is verified locally; the checklist is the bridge.
3. **Web `test:uat` suite never run;** browser coverage is my Playwright journeys (desktop Chromium). Two assertions are weak and flagged in the UAT notes (B2 "ticket visible", H3 owner screen).
4. **UAT scripts contain local paths and `console.log`** (test tooling only); parameterise before reusing outside the sandbox.
5. **Socket re-check is per API process** and no load test of hundreds of kitchen sockets was done (design is per organisation, not per socket).
6. **Two mutation probes** for the repaired security tests were not run (price trust, role promotion).
7. Pre-existing and unchanged: stale-status rows are only persisted by the hourly sweep (access already follows the clock); kitchen-role REST reads after a lapse remain allowed (read-only) while the live feed is cut; `GET /restaurants/:slug` stays public for diners.

## 9. Staging deployment readiness

Ready to stage: the code is final, a rollback point and rehearsal scripts exist, the order of deployment and the configuration checks are documented, and the verification suites can be pointed at a disposable staging database (`UAT_API`, `DATABASE_URL`). Required from you: a staging environment (ideally a Neon branch of production), permission to run the suites against its disposable copy, and a decision on how long to observe before merging.

## 10. Recommendation and next steps

**PASS WITH CONDITIONS.** Deploy API `9e45f25`-equivalent HEAD (`8f592ab`, identical runtime code) and web `6457ec1` to staging in that order, run `docs/staging/STAGING_CHECKLIST.md` top to bottom with an observer, run the platform suite on a fresh database, and return the results. **I have not merged, deployed or started Phase 2 and will wait for your explicit approval.**

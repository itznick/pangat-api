# Pangat — Pilot readiness: test report

**Date:** 2026-11-26 · **Branch:** `claude/nifty-wright-ith4qq` (API and web) · **Where everything ran:** a throwaway local PostgreSQL 16, an API started locally on that database, a local Vite server and headless Chromium (Playwright 1.63). **Nothing ran against staging or production. No claim here is a staging or production verification.**
**How the final run was done:** a fresh database for the API suites (through `scripts/ci/run-live-suites.sh`, the same script the CI job uses), then a second fresh database for the browser suites, against the final built API. Rate limiting was switched off for the test API (`THROTTLE_DISABLED=true`), so per-IP throttles are not exercised by these tests; account lockout is.

## 1. Results
| Layer | Suite | Result |
|---|---|---|
| API unit | `npm test` (20 files) | **323 / 323** |
| API live | `test:integration` | 53 / 53 |
| | `test:phase1`, `phase1_1`, `phase1_2`, `phase1_final` (entitlements, verification, public endpoints, role isolation) | 36, 7, 25, 4 = 72 / 72 |
| | `test:platform` (Super Admin) | 43 / 43 |
| | `test:compliance` | 14 / 14 |
| | `test:commercial` (plans, trial, billing profile, invoices) | 32 / 32 |
| | `test:pilot-payments` (atomic money, idempotency, UPI) | 30 / 30 |
| | `test:pilot-ops` (alerts, go-live checklist, self sign-up, migration 021) | 19 / 19 |
| | `test:pilot-roles` (28 actions x 8 callers) | 32 / 32 |
| | `test:pilot-menu` (CSV import) | 9 / 9 |
| | `test:pilot-security` | 14 / 14 |
| | `test:pilot-acceptance` (29-step journey) | **29 / 29** |
| | migrations idempotent across an API restart on the same database | pass |
| | **API total** | **670 / 670** |
| Web unit | `npm test` | **111 / 111** |
| Web static | `tsc -b`, `eslint .` (0 errors; 48 pre-existing warnings), production build | pass |
| Browser | `uat.e2e` (owner, kitchen, guest, team, account, three-screen realtime journeys) | 39 / 39 |
| | `kds-reliability.e2e` (incl. a genuinely cut websocket) | 10 / 10 |
| | `roles.e2e` (what each role sees, walk-in dialog) | 11 / 11 |
| | `menu-import.e2e` | 4 / 4 |
| | `responsive.e2e` (15 screens x 360, 390, 768, 1024, 1440 px; light and dark for the kitchen and dashboard) | 5 / 5 |
| Schema | `scripts/ci/check-baseline.sh` (empty DB, baseline, production-mode boot) | pass (earlier run this phase; not repeated in the final run) |

Per-step results of the acceptance journey are in `docs/uat/PILOT_UAT_RESULTS.md`.

## 2. What the tests prove, and how strongly
- **Concurrency claims were mutation-checked.** I deliberately removed the order row lock (4 tests failed), allowed cashiers to refund (2 failed), disabled the kitchen resync (2 failed), removed the menu-import lock (1 failed), and made the error filter log the raw URL (2 failed). Each was restored and the suites passed again. A test that cannot fail proves nothing; these can.
- **Real transport outcomes.** Alert email was tested against a real SMTP server started by the test that could accept, reject or hang, not a mock.
- **A real websocket cut.** Playwright's offline switch does not close an open websocket, so the kitchen test cuts it explicitly and checks the order placed during the gap appears once after reconnect.

## 3. Defects the testing found (all fixed)
1. The guest's bill link returned a **500** (found by the acceptance journey; staff bills worked).
2. A **NUL byte** in a URL or body caused a 500 (security suite).
3. Ten **simultaneous menu imports duplicated dishes** (fixed with a per-restaurant lock).
4. A price typed `12,5` was **read as 125** (fixed; refused).
5. The go-live checklist and kitchen banners were **unreadable in the default light theme**, and the **table delete button was invisible on touch devices** (found by looking at screenshots; a contrast check now guards it).
6. Stale test fixtures from earlier phases (forced password change, name-based passwords, one-character UPI IDs, a UPI order without owner confirmation).

## 4. What was NOT tested (be honest about this)
- **Staging and production.** Neither exists in these results. Production configuration, plan rows, email setup and duplicate bills in production data were never inspected.
- **GitHub Actions.** The CI jobs were written and their runner script passed locally; no workflow run has happened. The browser job is off by default.
- **Real devices.** No real phone, tablet or kitchen display. Screen-stays-on, real audio rules, and real Wi-Fi loss are untested on hardware. Headless Chromium cannot prove them.
- **A real email provider** and **a real UPI payment** (the ₹1 check).
- **Load and performance.** No load test of any kind. A single restaurant is expected to be fine; this is unproven.
- **Backup and restore** were not re-run in this phase (the Phase 1 scripts exist).
- **Human design review.** I read a sample of screenshots myself (diner menu and tracker, kitchen display in both themes, dashboard, settings); the automated checks cover overflow, errors, tap-target size and text contrast only. A person should look at every screen on a real phone.
- **Rate limiting under real traffic**, external penetration testing, and legal or accounting review.
- **Safari and Firefox.** Only Chromium was used.

## 5. Known flakiness
The API unit suite failed once (1 of about 7 runs) with a test I could not identify and could not reproduce in 5 further runs; the final run was clean (323/323). Treat as unresolved.

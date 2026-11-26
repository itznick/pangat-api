# Pangat — Pilot go / no-go report

**Recommendation: READY FOR STAGING.** Not yet "ready for a controlled pilot", and not for general availability.

The reasons are plain. The software behaves correctly in every automated check I could run (670 API tests, 111 web unit tests, 69 real-browser checks and a 29-step end-to-end journey, all on disposable local databases). But **none of it has run on staging, on a real phone or tablet, with a real email provider, or with a real UPI payment**, and two inputs only the founders can give are missing. A pilot restaurant should not be the first to find out what staging would have shown.

This report is deliberately conservative. Source documents: `PANGAT_PILOT_READINESS_STATUS.md` (every finding, one status each), `PANGAT_PILOT_TEST_REPORT.md` (numbers and what was not tested), `PANGAT_PILOT_IMPLEMENTATION_REPORT.md`, `PANGAT_STAGING_DEPLOYMENT_CHECKLIST.md`, `PANGAT_RAZORPAY_TECHNICAL_READINESS.md`.

## Scale used
PASS (proved locally, on a disposable database) · FAIL · NOT TESTED · BLOCKED BY EXTERNAL DEPENDENCY · REQUIRES FOUNDER APPROVAL. "PASS" never means staging or production was checked.

## Critical issues
| # | Critical issue | Result | Detail |
|---|---|---|---|
| 1 | Diner UPI pays the restaurant's own, owner-confirmed ID, never a default | **PASS** (local) | No hardcoded or invented ID anywhere; unconfirmed or invalid means no UPI offered |
| 1b | A real ₹1 UPI payment reaches the restaurant's own account | **NOT TESTED** | The founders' check on staging (checklist §8) |
| 1c | Who owns the old `pangat@icici` ID | **BLOCKED BY EXTERNAL DEPENDENCY** | Needs the founders' bank/UPI statements; never investigated |
| 2 | No duplicate orders on retry or double tap | **PASS** | Server-side keys, 409 on a changed request, parallel tests |
| 3 | One bill per order, one credit note per refund, no over-refund, under concurrency | **PASS** (local, mutation-checked) | Row lock, unique constraints, 30 live tests |
| 3b | Production data has no duplicate bills (the unique index is skipped if it does) | **NOT TESTED** | Needs a read-only query by someone with production access |
| 4 | Kitchen display recovers after a connection gap with no missing or duplicate tickets | **PASS** (real browser, real websocket cut) | |
| 4b | Screen stays on, real tablet audio, real Wi-Fi loss | **NOT TESTED** | Needs a real tablet (checklist §9) |
| 5 | Provisioning: no invented UPI, correct 14-day trial plan, honest go-live checklist, kitchen PIN step | **PASS** | |
| 6 | Operator alerts: outcome recorded, retried, failures visible, duplicates impossible | **PASS** (against a real SMTP server I started) | |
| 6b | Alerts through a real email provider | **BLOCKED BY EXTERNAL DEPENDENCY** | Needs a provider key and recipients configured in staging |
| 7 | Public self sign-up off by default | **PASS** | |
| 8 | Roles: each role can do exactly what it should, nothing more | **PASS** (28 actions x 8 callers, mutation-checked) | |
| 9 | Tenant isolation (another restaurant cannot read or change anything) | **PASS** | Plus the earlier-phase isolation suites |
| 10 | Credentials never reach logs, error records or error bodies | **PASS** (mutation-checked; the live API log showed `token=[redacted]`) | |
| 11 | Security behaviours (mass assignment, forged tokens, lockout, enumeration, headers) | **PASS** | An external penetration test has **not** been done |
| 12 | The full journey lead to refund and audit | **PASS** (29/29, disposable database) | It found and fixed a real bug (guest bill 500) |
| 13 | Responsive and readable on five widths, light and dark | **PASS** (automated; 15 screens) | A person must still look at every screen on a real phone |
| 14 | CI runs the live suites on a fresh Postgres | **NOT TESTED** | The runner script passed locally; no GitHub Actions run yet |
| 15 | A database can be rebuilt from the repository | **PASS** (local baseline rebuild in production mode) | |
| 15b | Production's schema matches the repository | **BLOCKED BY EXTERNAL DEPENDENCY** | Needs read access to production |
| 16 | Web lint clean without weakening any rule | **PASS** (0 errors) | |
| 17 | Support contact shown to restaurants is real | **REQUIRES FOUNDER APPROVAL** | The WhatsApp number in four places looks like a placeholder (F-14) |
| 18 | API hosting is always-on (no cold starts, background jobs keep running) | **REQUIRES FOUNDER APPROVAL** | Hosting tier unknown (F-22). A sleeping instance delays the first guest order and pauses alert retries |
| 19 | Delivery at the pilot (the fee is a fixed ₹30) | **REQUIRES FOUNDER APPROVAL** | Disable delivery for the pilot or accept the fixed fee |
| 20 | Charging for subscriptions | **REQUIRES FOUNDER APPROVAL** | Not enabled. Needs a chartered accountant (invoice format, SAC) before anyone is charged |
| 21 | Online payments (Razorpay) | **BLOCKED BY EXTERNAL DEPENDENCY** | Not built, by instruction. Needs Partner Dashboard access and Razorpay's answers. The counter and owner-confirmed UPI paths work without it |
| 22 | Load and performance | **NOT TESTED** | No load testing of any kind |
| 23 | Backup and restore for the pilot database | **NOT TESTED** | Scripts exist from an earlier phase; not re-run |
| 24 | Production configuration (secrets, CORS origin, email, rate limits on) | **NOT TESTED** | Never inspected |

## What must happen, in order, before a controlled pilot
1. **Founders answer three things:** the real support number (F-14), the hosting tier and a decision to use an always-on one (F-22), and delivery on or off for the pilot (F-16).
2. **Stand up staging** (founder approval for any cost; a free tier is acceptable for the rehearsal but note its sleeping behaviour) and run `PANGAT_STAGING_DEPLOYMENT_CHECKLIST.md` end to end. Record results.
3. **Someone with production access** runs the read-only duplicate-bill query and takes the schema dump, then the drift comparison.
4. **Founders do the real-device and real-money checks:** the ₹1 UPI payment, a kitchen tablet left alone for ten minutes, Wi-Fi switched off and on, and a real email through the chosen provider.
5. **Push the branch and watch the first GitHub Actions runs**; fix what a clean machine exposes.
6. A human looks at every screen on a real phone.
Only then is "ready for a controlled pilot" an honest statement. Even then: one restaurant, a founder on call, and the counter payment path as the fallback.

## Risks that remain even after all of the above
- A single developer, a single API process and an unknown hosting tier.
- Concurrency is proven on one database instance; two API instances at once were not tested.
- In-process background jobs stop when the API sleeps.
- The unit suite showed one unreproduced failure in about seven runs.
- No external security test, no load test, no legal review of the privacy and terms text.

## What I did not do (restated)
No deployment, no production access, no migration against any real database, no change to production data, secrets or environment, no real payment, no merge to main, no push to main, no new paid service, no Razorpay or WhatsApp code.

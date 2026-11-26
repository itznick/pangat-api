# Pangat — Pilot readiness: implementation report

Branch `claude/nifty-wright-ith4qq` in `pangat-api` and `pangat-web`. **Not merged, not deployed, no production database, secret, environment variable or customer record touched.** Everything below was built and tested on disposable local databases. For every item: root cause, files, before and after, tests added and run, and the limits. The per-finding register is `PANGAT_PILOT_READINESS_STATUS.md`; test numbers are in `PANGAT_PILOT_TEST_REPORT.md`.

## Commits (in order)
| Repo | Commit | Content |
|---|---|---|
| API | `98c6b0b`, `0cd26f5` | Commercial plans, entitlements, billing profile (earlier phase) |
| Web | `e24d367` | Landing, pricing and Super Admin alignment (earlier phase) |
| API | `157fead` / Web `45a9e6c` | **Phase B** money safety |
| Web | `8688000` | **Phase C** kitchen reliability |
| API | `b7fc102` / Web `eac6665` | **Phase D** operations (alerts, go-live checklist, self sign-up) |
| API | `e05b15a` / Web `1e30284` | **Phase E** CI, schema baseline, web lint |
| API | `6db5bfe` / Web `8e5c329` | **Phase F** roles, walk-in dialog, menu CSV import |
| both | this commit | **Phase G** log redaction, security suite, acceptance journey, responsive/readability fixes, final documents |

---
## Phase B: money safety
**Root cause.** Payment actions read an order, then wrote it, with no lock; the diner screen sent money to a hardcoded ID; keys were regenerated on every tap.
**What changed.**
- `orders.service.ts`: `markPaid`, `cancelOrder` and `processRefund` each run in one transaction that locks the order row (`FOR NO KEY UPDATE`), re-reads it, and decides on the locked row. Same key and same request returns the original result; same key and a different request is a 409 (`orders.request_hash`, table `order_refunds` with `UNIQUE (order_id, idempotency_key)`).
- Migration `020`: one BILL per order (partial unique index; **skipped if production already has duplicates**, which a human must check), refund cannot exceed the total (`CHECK … NOT VALID`), UPI confirmation columns. Down script included.
- UPI: guests are offered UPI only when the outlet has it on, the ID is valid in shape **and the owner confirmed it** (`POST /restaurants/:id/upi/confirm`); changing the ID clears the confirmation; no fallback destination exists anywhere. Provisioning and sign-up never invent an ID (blank is allowed).
- Web: `features/diner/upi.ts`, owner confirmation card, stable idempotency keys (`lib/idempotency.ts`), the fake `@icici` prefill and the `'pangat'` fallback slugs removed, false "WhatsApp receipt" copy removed, refund wording no longer implies automatic money movement.
**Before / after.** Ten simultaneous identical orders or taps produced several orders, bills or credit notes; now exactly one. Verified by 30 live concurrency tests; removing the row lock made 4 fail (mutation-checked).
**Limits.** Staging was not touched; the ₹1 real-phone UPI check is a founders' step. Whether `pangat@icici` belongs to anyone was **not** investigated. Razorpay refunds are not implemented (by instruction).

## Phase C: kitchen reliability
**Root cause.** The socket was treated as the source of truth; a gap meant missing orders. The wake lock was a decorative toggle; the chime was silent after a reload.
**What changed.** `lib/connection.ts` (honest Connected / Synchronising / Reconnecting / Offline), `lib/kdsMerge.ts` (server list wins, no duplicates, stale events ignored), resync on reconnect, network return, wake and a 45 s poll for both the kitchen display and the owner order board; a failed refresh keeps the board; `lib/wakeLock.ts` (real API, re-acquire, honest unsupported/blocked); "Enable kitchen sound" step.
**Tests.** 20 unit; 10 real-browser including a **genuinely cut websocket** (Playwright's offline switch does not drop an open socket, so the test cuts it); mutation-checked.
**Limits.** Headless Chromium cannot prove the screen stays on or real tablet audio rules. Staging checklist §9 covers a real tablet.

## Phase D: provisioning, go-live, alerts
**What changed.** Migration `021`; `GET /restaurants/:id/readiness` derives the go-live checklist from real data (menu, tables, kitchen PIN, kitchen sign-in, a test order, a completed test order, confirmed UPI); physical steps (QR placed, GST reviewed, hours reviewed, staff) can only be attested by the owner and are audited; the kitchen PIN is a required step (no plaintext PIN anywhere). Operator alerts: new leads, plan-change requests, important tickets and critical events are emailed when alerts are on; every attempt is recorded, retried with back-off, manually retryable, visible in Super Admin > Monitoring > Alert delivery; duplicates are impossible (claim plus unique key). Self sign-up now defaults **off**.
**Tests.** 19 live tests with a real fake mail server (success, rejection, hung provider, exhaustion, concurrent retries = one email, no provider, no recipients, alerts off).
**Limits.** A real email provider was not used. A free-tier API that sleeps would pause the retry job (founders must confirm hosting; F-22).

## Phase E: safety net
CI `live-suites` on a fresh Postgres service container; `baseline-rebuild`; informational schema drift; web lint gate and an optional browser job. `scripts/ci/run-live-suites.sh` refuses any non-local database. **Web lint: 70 errors fixed to 0 with no rule weakened and no `any`** (derived state instead of effect-driven state; two small hooks `useOnChange` and `useQuery`; typed catches; impure clock reads moved out of render). Schema baseline tooling and a reference schema; a rebuild in production mode passed locally. Staging checklist written.
**Limits.** No GitHub Actions run has happened. Production's schema has not been compared.

## Phase F: staff workflows
**Roles.** `test:pilot-roles`: 28 actions against owner, manager, chef, steward, cashier, kitchen station, platform admin and anonymous (32 tests); mutation-checked. Real rules found and encoded (a steward cannot start cooking or settle a bill; a chef cannot complete an order; platform admins reach restaurant routes on purpose and the owner sees each access).
**Walk-in dialog.** Errors shown, form kept, no double submit, same key on retry (browser tests). The silent 12-dish cut-off is gone; search added.
**Menu CSV import.** `POST /menu/import`: preview by default, one transaction, per-restaurant lock (ten simultaneous imports cannot duplicate dishes; mutation-checked), repeatable, never deletes or renames, owners and managers only, audited. Strict parsing (a price "12,5" is refused, never read as 125). Web dialog. 11 unit, 9 live, 4 browser tests.
**Limits.** Photos and modifiers are not importable; the walk-in dialog cannot choose modifiers.

## Phase G: security and final readiness
**Log redaction.** `common/log-redaction.ts` masks credential query values, bearer tokens and key=value / JSON credentials in the process log, the error-log table and the echoed error path. The live API log now shows `?token=[redacted]`. 10 tests; mutation-checked.
**Security suite** (`test:pilot-security`, 14 live): unknown fields refused; guests cannot choose a price; sign-up and staff creation cannot grant platform roles; forged, tampered and `alg:none` tokens refused; account lockout; no account enumeration; weak and name-based passwords refused; tracking token required per order; hardening headers present; no stack traces. **Found and fixed:** a NUL byte in a URL or body caused a 500 (global guard, `no-null-bytes.guard.ts`).
**Acceptance journey** (`test:pilot-acceptance`, 29 steps; results in `docs/uat/PILOT_UAT_RESULTS.md`): lead to provisioning, owner setup, menu import, tables, staff, kitchen PIN, UPI confirmation, diner order and retry, kitchen progress, guest tracking, payment with GST bill, report, refund and credit note, inventory deduction, kitchen resync, plan enforcement, go-live, audit. **It found a real, pre-existing bug: the guest's bill link returned a 500** (staff bills worked, so earlier suites missed it). Fixed in `orders.service.ts` `getBill`.
**Responsive and readability.** Fifteen screens at 360, 390, 768, 1024 and 1440 px: no horizontal overflow, no runtime errors. Looking at the screenshots found what the automated checks could not: **the go-live checklist and the kitchen banners were designed for the dark theme and were nearly unreadable in the default light theme.** Fixed with theme-aware colours, and a contrast check (light and dark) was added to the test so it cannot recur. Also fixed: the table delete button was hover-only and therefore invisible on touch devices; small footer and refresh targets.

## What was deliberately not done
No deployment, no production access or migration, no real payment, no Razorpay code, no WhatsApp, no new paid service, no merge to main.

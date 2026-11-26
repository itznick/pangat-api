# Pangat — Pilot readiness status register

**What this is:** every historical finding (F-01 to F-40 from the Phase 2 audit and its revisions, plus defects found while fixing them) with **one** status, checked **in the code on branch `claude/nifty-wright-ith4qq`**, not copied from earlier documents.
**Date of verification:** 2026-11-26. **Environment of every test cited:** a throwaway local PostgreSQL 16, a locally started API and (for browser tests) a local Vite server and headless Chromium. **Nothing has been run against staging or production; nothing has been deployed.**

## Status definitions
| # | Status | Meaning |
|---|---|---|
| 1 | RESOLVED AND TESTED | Fixed in code and an automated test (named) proves it, locally, on a disposable database |
| 2 | IMPLEMENTED BUT NOT STAGING-VERIFIED | Fixed in code and tested locally, but something only a real environment, real provider or real device can prove is still unproven |
| 3 | OPEN, BLOCKS PILOT | Not fixed and the pilot should not start without it |
| 4 | OPEN, ACCEPTABLE FOR PILOT | Known, understood, low risk for one restaurant, with a stated reason |
| 5 | DEFERRED ROADMAP | Not needed for a controlled pilot; planned later |
| 6 | NEEDS FOUNDER DECISION | Cannot be settled by engineering |

Test names refer to `pangat-api/test/*` (API, live against a running API) and `pangat-web/test/*` (web unit and real-browser). "Mutation-checked" means the code was deliberately broken and the named test failed, then the code was restored.

---
## A. Money and payment safety
| ID | Original problem | Evidence now (file) | Tests | More needed | Action | Sev | Blocks pilot | Status |
|---|---|---|---|---|---|---|---|---|
| F-01 | Diner UPI link used a hardcoded payee `pangat@icici` | Removed from `OrderTrackingView.tsx`; payee comes only from the server (`orders.service.ts` `getPublicTrackingProjection`, `restaurants/operations.ts` `upiOffered`) | `pilot-payment-integrity` (UPI cases, "no hardcoded VPA in src"), web `pilot-money-safety` (no `pangat@icici` anywhere in `src`) | The **₹1 real-phone check** on staging (`PANGAT_STAGING_DEPLOYMENT_CHECKLIST.md` §8). The question "who owns `pangat@icici`" is **not investigated** and needs the founders' bank statements | Run the staging ₹1 test; investigate the old ID | Critical | No (fixed) | **2** |
| F-02 | Provisioning invented `<slug>@icici`; API accepted any VPA string | Fake prefill removed (`ProvisionRestaurantModal.tsx`, `OnboardingPage.tsx`); VPA optional and shape-validated in all three DTOs; **blank means no UPI** | `pilot-ops` (provisioned outlet has no UPI), `pilot-payment-integrity` (invalid VPA refused everywhere), web source scan | None | None | High | No | **1** |
| F-03 | Idempotency key regenerated on each submit | Stable keys: `lib/idempotency.ts` used by diner order, walk-in and refund; server enforces independently (`orders.service.ts` `requestHashOf`, `replayOrConflict`) | `pilot-payment-integrity` (10 parallel identical orders = 1; same key + different payload = 409), web `pilot-money-safety`, browser `roles.e2e` (retry reuses the key; double click = 1 request) | None | None | High | No | **1** |
| F-06 | "Instant UPI" was not verified and the screens implied it was | Copy now says payment is confirmed by the restaurant; paying never marks an order paid (`OrderTrackingView.tsx`) | UAT journeys (UPI path), acceptance step 15 | None | None | High | No | **1** |
| F-17 | Refund option "Verified Provider Gateway Refund" implied money moves automatically | Relabelled "Returned by UPI or bank transfer (you send it yourself)" plus a plain note (`AdminOrdersPage.tsx`) | web `pilot-money-safety` (old label absent) | Razorpay refunds are **not implemented** (by instruction) | Keep manual until P1 Razorpay | Medium | No | **1** |
| F-36 | Refund and mark-paid were not atomic (duplicate credit notes or bills possible) | One transaction per money action: row lock, re-read under lock, `order_refunds` unique `(order_id, key)`, one BILL per order index, refund `CHECK` (`orders.service.ts` `lockOrder`, `markPaid`, `processRefund`; migration `020`) | `pilot-payment-integrity` (30 live concurrency tests); **mutation-checked** (removing the row lock failed 4 tests); acceptance steps 21 and 24 (3 simultaneous taps = 1 bill / 1 credit note) | Production data may already hold duplicate bills (the index is skipped if so). A human must run the read-only query in the staging checklist §3 | Run that query before migrating production | High | No (once the query is run) | **2** |
| F-18 | Order creation not one transaction (crash between save and stock deduction) | Unchanged | Retry safety now comes from idempotency (F-03) | Crash-injection test | Accept for one outlet; revisit before scale | Low-Med | No | **4** |
| F-15 | Anyone with the table URL can send orders from anywhere | Unchanged; throttled (60 per outlet / 6 per table per 5 min) | `pilot-security` (validation), existing flood tests | A staff-accept step would be a product decision | Accept for the pilot; watch the first week | Medium | No | **4** |
| F-16 | Delivery fee is a constant ₹30 | `orders.service.ts` constant; delivery is **on by default** for new outlets | none | Decision | Founders: disable delivery for the pilot or accept ₹30 | Medium | No | **6** |
| F-11 | Subscription billing is entirely manual | Unchanged; paid checkout deliberately **not** enabled | `commercial-plans` (no checkout endpoint exists) | n/a | Free pilot first | Medium | No | **5** |
| F-40 | Pangat's own subscription invoices not compliant | Invoice numbers ≤16 chars, consecutive per fiscal year, place of supply from a billing profile (migration `019`) | `commercial-plans.e2e` (CGST+SGST vs IGST, consecutive numbers, duplicate webhook = no second invoice) | PDF, credit notes for subscription refunds, SAC and CA sign-off | Needs a chartered accountant before charging anyone | High for paid billing | No (free pilot) | **6** |
| F-39 | Plan edits silently re-priced every subscriber | In-place re-pricing refused without acknowledgement; historical plans kept (migration `018`) | `commercial-plans.e2e` ("Existing subscribers and historical plans are untouched") | Production plan rows were never inspected | Run the read-only precheck on staging | Medium | No | **1** |
| N-01 | Inventory kept deducting after the plan lost the feature | `inventory.service.ts` `isInventoryEntitled` | `commercial-plans.e2e` (stops after downgrade, resumes after upgrade) | None | None | Medium | No | **1** |

## B. Kitchen and order reliability
| ID | Original problem | Evidence now | Tests | More needed | Action | Sev | Blocks | Status |
|---|---|---|---|---|---|---|---|---|
| F-04 | KDS and order board never resynced after a socket reconnect | REST resync on reconnect, network return, wake, 45 s poll (`lib/connection.ts`, `stores/useKdsStore.ts` `resync`, `useAdminStore.resyncOrders`); a failed refresh never empties the board; no duplicates, stale events ignored (`lib/kdsMerge.ts`) | `kds-reliability.test` (20 unit), `kds-reliability.e2e` (10 real-browser incl. a genuinely cut websocket); **mutation-checked** (resync off = 2 tests fail); acceptance step 26 | A real tablet on real Wi-Fi | Staging checklist §9 | High | No | **1** |
| F-05 | Wake Lock was a UI toggle that did nothing | Real Screen Wake Lock with re-acquire and honest `unsupported/blocked` states (`lib/wakeLock.ts`, `KDSTopBar.tsx`) | `kds-reliability.test` + `.e2e` (with a stubbed browser API: granted, refused, dropped and re-acquired) | **A real tablet left alone for 10 minutes** (headless Chromium cannot prove the screen stays on) | Staging checklist §9 | High | No | **2** |
| F-35 | Chime silent after a reload until someone taps | "Enable kitchen sound" banner and button; audio never pretends to be on (`lib/sound.ts`, `KDSPage.tsx`) | `kds-reliability.e2e` (banner and unlock) | Real tablet browsers differ on autoplay | Staging checklist §9 | Medium | No | **2** |
| F-07 | Walk-in dialog swallowed errors and closed | Shows the error, keeps the form, blocks double submit, closes only on success, no fallback outlet slug (`AdminDashboardPage.tsx`) | `roles.e2e` (refused order, retry key, double click, all dishes reachable) | Items that need a modifier choice cannot be added in the dialog (the server refuses and the error shows) | Add modifier picking after the pilot if staff ask | High | No | **1** |
| N-05 | Walk-in dialog silently showed only the first 12 dishes | Removed the cut-off; added search and larger touch targets | `roles.e2e` ("every available dish can be found") | None | None | Medium | No | **1** |
| F-37 | Tracking tokens logged in URLs and error records | `common/log-redaction.ts` applied in the exception filter, error log and echoed error path | `log-redaction.test` (10); **mutation-checked**; `pilot-security` (token not echoed); the live API log showed `token=[redacted]` | Tokens are still in the browser URL by design (Referrer-Policy limits leakage) | Accept | Medium | No | **1** |

## C. Onboarding, operations and delivery
| ID | Original problem | Evidence now | Tests | More needed | Action | Sev | Blocks | Status |
|---|---|---|---|---|---|---|---|---|
| F-08 | Provisioned restaurants had no kitchen PIN and no checklist | Go-live checklist from real state (`restaurants.service.ts` `readiness`, `GoLiveChecklist.tsx`); kitchen PIN is a required step; no plaintext PIN anywhere. Provisioning itself still does not set a PIN (a secure one-time flow would be new scope) | `pilot-ops` (checklist honest, attestations audited, cannot fake automatic steps), acceptance steps 11 to 13 and 28 | None | None | High | No | **1** |
| F-09 | New leads and plan-change requests alerted nobody | `NEW_LEAD`, `PLAN_CHANGE_REQUESTED`, important tickets, critical events are emailed when alerts are on | `pilot-ops` (19 live tests with a fake mail server) | **A real email provider** | Staging checklist §10 | Medium | No | **2** |
| F-38 | Alert delivery failures silently discarded | Every attempt recorded; retry with back-off; manual Retry; health view (`platform/events.service.ts`, migration `021`, Super Admin > Monitoring > Alert delivery) | `pilot-ops` (success, rejection, hung provider, exhaustion, duplicate retry = one email, no provider, no recipients) | Real provider | Same | Medium | No | **2** |
| F-10 | Self sign-up defaulted ON with no web page behind it | Default OFF (`settings.registry.ts`); API protections kept | `pilot-ops` (default off; provisioning still works) | None | Turn on only deliberately | Medium | No | **1** |
| F-14 | Support WhatsApp number looks like a placeholder, hardcoded in four places | `wa.me/919890000000` still in 4 web files | none | The real number | Founders supply the number | Medium | **Yes** (a wrong support number sends restaurants to a stranger) | **6** |
| F-22 | API hosting tier unknown (sleeping instance = slow first order, lost background jobs) | Unverified, not inspected | none | Which tier | Founders confirm an always-on tier before the pilot | High | **Yes, until confirmed** | **6** |
| F-24 | Menu entry was the biggest onboarding labour | CSV import: preview, one transaction, repeatable, per-restaurant lock; owners/managers only (`menu/menu-import.ts`, `POST /menu/import`, `MenuImportDialog.tsx`) | `menu-import.test` (11), `pilot-menu-import` (9 live incl. 10 simultaneous imports; **mutation-checked**), `menu-import.e2e` (browser), acceptance step 7 | Photos and modifiers are not importable; Excel files must be saved as CSV | Photos later | Medium | No | **1** |
| N-06 | A price "12,5" would have been read as 125 | Commas accepted only as thousands separators | `menu-import.test` | None | None | High | No | **1** |
| N-07 | Concurrent menu imports duplicated dishes | Advisory lock and in-transaction planning | `pilot-menu-import` (**mutation-checked**) | None | None | Medium | No | **1** |
| F-12/13 | Landing page prices and claims did not match the product | Rewritten to the four approved plans; unsupported claims removed | web `commercial-landing.test` (31) | Founding 10 section is unpublished until the offer can be fulfilled | None | High | No | **1** |
| F-28 | `my-subscription` starts a trial as a side effect | Unchanged | none | n/a | Accept | Low | No | **4** |
| F-27 | Public outlet profile includes live table statuses | Unchanged | none | n/a | Accept | Low | No | **4** |

## D. Engineering safety net
| ID | Original problem | Evidence now | Tests | More needed | Action | Sev | Blocks | Status |
|---|---|---|---|---|---|---|---|---|
| F-21 | Integration suites were manual; CI had no database | `live-suites` job on a fresh Postgres service container, `baseline-rebuild` job, web lint gate (`.github/workflows/ci.yml`, `scripts/ci/run-live-suites.sh`) | The same runner script passed end to end locally (12 suites plus a restart idempotency check) | **No GitHub Actions run has happened**; the browser job needs a repository variable and token | Push, watch the first runs | High | No | **2** |
| F-20 | No `CREATE TABLE` migration for core tables | Tooling and a reference schema (`scripts/schema/*`, `docs/schema/`); rebuild from the baseline verified in production mode on a disposable DB (`scripts/ci/check-baseline.sh`) | local run of `check-baseline.sh`; compare tool tested on equal and changed schemas | **Production's schema was never compared** (needs read access) | `docs/SCHEMA_BASELINE_STRATEGY.md` steps 1 to 4 | High | No | **2** |
| F-31 | Dead onboarding page; 69 lint errors hiding real issues | Lint: **0 errors** (70 fixed, no rule weakened, no `any`); `OnboardingPage` remains as unreachable code now that self sign-up is off | eslint, tsc, 110 unit + browser regression runs | Delete the dead page later | Later cleanup | Low | No | **4** |
| F-19 | TenantGuard issues several queries per write | Unchanged | n/a | n/a | Performance only | Low | No | **4** |
| F-30 | Production API host is a hardcoded web fallback | Unchanged (`lib/socket.ts`, `lib/api.ts`) | n/a | A staging web build **without** `VITE_API_URL` would talk to production | Staging checklist §4 requires `VITE_API_URL`; consider removing the fallback | Medium | No | **4** |
| F-29 | JWTs in `localStorage` | Unchanged; CSP present (`netlify.toml`) | n/a | n/a | Accept | Low | No | **4** |

## E. Deferred product ideas
| ID | Item | Status |
|---|---|---|
| F-25 | Reports: CSV export, shift close-out, multi-outlet | **5** |
| F-26 | Notifications outside an open browser tab | **5** |

## F. Defects found while doing this work (all fixed unless stated)
| ID | Problem | Found by | Status |
|---|---|---|---|
| N-02 | **The guest's bill link returned a 500** (`getBill` received the restricted tracking projection). Staff bills worked, so earlier suites missed it | the 29-step acceptance journey | **1** (`pilot-acceptance` step 21) |
| N-03 | A NUL byte in a URL or body caused a 500 | `pilot-security` | **1** (global guard + `log-redaction.test`) |
| N-04 | Table delete button was invisible and unreachable on touch devices (hover-only) | responsive check | **1** (visible on touch, 36 px, labelled) |
| N-11 | **The go-live checklist, UPI confirmation card and kitchen banners were unreadable in the default light theme** (dark-theme colours only) | looking at the screenshots (automated checks missed it) | **1** (theme-aware colours; the responsive test now checks text contrast in light and dark) |
| N-08 | Several UAT and test fixtures were stale (forced password change, name-based passwords, one-character UPI IDs) | full regression | **1** |
| N-09 | Route allows a steward to mark paid, but the service refuses it | role matrix | **4** (the service rule is authoritative and tested; the route list is merely wider) |
| N-10 | Wrong kitchen-PIN attempts are limited per outlet as well as per device, so an attacker could briefly lock a kitchen out of PIN sign-in | security review | **4** (the owner can still work; accepted trade-off) |

## G. Identifiers in the original numbering with no row in the audit register
F-23 and F-32 to F-34 were referenced as a range in the original numbering but have no finding text in the audit's register; they are **not** treated as findings here. If you know what they referred to, tell me and I will add them.

## Totals
46 items: Status 1: **21** · Status 2: **8** · Status 3: **0** · Status 4: **10** · Status 5: **3** · Status 6: **4** (F-14 support number, F-16 delivery fee, F-22 hosting tier, F-40 subscription invoices).
**Two of those four block the pilot until answered:** F-14 (the support WhatsApp number) and F-22 (the API hosting tier). No item is classed as an engineering blocker (status 3).

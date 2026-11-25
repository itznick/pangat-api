# Pangat — Phase 2 Roadmap (Pilot Readiness)

**Status:** proposal for approval. Nothing here has been started.
**Based on:** `PANGAT_PHASE2_PRODUCT_READINESS_AUDIT.md` (finding IDs `F-nn` refer to it) at API `977c93a` / web `0beb1c8`.
**Constraints honoured:** two founders, one developer, near-zero budget. Every item below uses the existing stack (Neon, Render, Netlify, Brevo) and free tiers. The only possible spend is called out explicitly in §6.
**No dates.** Complexity is relative (Low = a focused change in a few files; Medium = multi-file feature with tests; High = new subsystem or touches core order/payment flow). I have not estimated calendar time, as requested.

Reading guide: *Regression risk* is the chance that the change breaks something that works today (orders, auth, entitlements, KDS). Items marked **[G1]** depend on a founder decision in §1.

---

## 1. Decisions needed before coding (PR-0, no code)

| ID | Decision | Options | My recommendation |
|---|---|---|---|
| **G1** | Must pilots take **online payment** (card/UPI via gateway) from day one? | (a) No: counter + staff-confirmed UPI. (b) Yes. | **(a)** for the first 1–2 pilots. Start Razorpay in parallel; do not gate the pilot on partner approval |
| **G2** | Single public price story | Align landing ↔ plans ↔ trial length | Pick the real pilot terms (free pilot? ₹699?) and make plans, trial and landing say the same thing |
| **G3** | Delivery in the pilot? | on / off | **Off** unless a pilot needs it (setting already exists); avoids F-16 |
| **G4** | Self-service sign-up | keep API on / off | **Off** for the pilot (settings flip); decide later whether to re-route the existing page with email OTP |
| **G5** | Hosting: is the Render API always-on? | verify / upgrade | If it sleeps, upgrade the API instance (the single justified spend, §6) |
| **G6** | Kitchen release rule for online payments | model A (fire first) / B (pay first) | **B for the new Razorpay method only**, behind an outlet setting (audit §6.3) |
| **G7** | Who enters each pilot's menu? | founders / restaurant | Founders for pilot 1–2 (use P1-3 CSV import to make it cheap) |
| **G8** | Send Razorpay's partner reply | share text | Needed to freeze P1-1 design |

Also collect: real support WhatsApp number, whether `pangat@icici` is real (F-01), production plan prices/trial days, email provider status.

---

## 2. P0 — required before the first pilot

P0 = things that would cause wrong money, lost orders, an un-onboardable restaurant, or an unrecoverable mistake. None of them adds a new product surface; they make what exists correct and operable.

### P0-1 · Correct UPI payee and UPI-ID integrity (F-01, F-02)
| | |
|---|---|
| **Business justification** | Pangat's promise is that money goes straight to the restaurant. Today the diner is shown a fixed ID that is not the restaurant's. One wrong payment is a trust-ending incident. |
| **Current status** | 🎭 Hardcoded `"pangat@icici"` in `OrderTrackingView.tsx:180`; restaurant `upiVpa` exists and is public via `/menu/public/:slug`. Provisioning pre-fills a fake `<slug>@icici`; API accepts any string on provision/onboard. |
| **Frontend** | Build the UPI URI from the outlet's own `upiVpa`; payee name = restaurant name (not slug); add a transaction note with the order reference; hide the UPI option when no valid ID is set; remove the fake prefill and require the operator to type the ID; show the ID that will be paid before the QR. |
| **Backend** | Return `payee {vpa,name}` in the order-tracking payload (or let the page use the public menu response); add the same UPI regex used by settings to the provision and onboard DTOs. |
| **Database** | None. |
| **Dependencies** | Founders confirm what `pangat@icici` is (if it is a live Pangat account, check whether any diner has paid it). |
| **Testing** | Unit: URI builder (amount, encoding, payee). API e2e: tracking payload has the outlet's VPA, never another outlet's; DTO rejects `abc`. Manual: one ₹1 real UPI payment from a phone to a pilot-like VPA. |
| **Complexity** | **Low** |
| **Regression risk** | **Low** (isolated to payment-screen and two DTOs) |

### P0-2 · Stable idempotency keys on every money/ordering action (F-03, part of F-32)
| | |
|---|---|
| **Business justification** | Restaurant Wi-Fi is flaky. A retry must never create a second kitchen ticket or a second refund. |
| **Current status** | 🔧 Server idempotency is correct (unique key, replay returns original, cross-outlet reuse refused). Clients mint a new key on every attempt. |
| **Frontend** | Create the key once per checkout session (store in the cart store, cleared only on success or when the cart changes); same for walk-in orders and refund dialogs (key per dialog open). |
| **Backend** | None required. Optional hardening: take a row lock when reading the refund audit (makes the existing refund idempotency check atomic). |
| **Database** | None. |
| **Dependencies** | None. |
| **Testing** | Unit: key is stable across retries, changes after success. E2E: submit twice with the same key → one order; simulated timeout then retry → one order. |
| **Complexity** | **Low** |
| **Regression risk** | **Low** (client only) |

### P0-3 · Kitchen and live-screen reliability (F-04, F-05, F-35)
| | |
|---|---|
| **Business justification** | A missed or silent order is the fastest way to lose a restaurant. |
| **Current status** | 🔧/🎭 No refetch on reconnect; no polling for orders; wake-lock is a fake toggle; audio can be suspended after a reload; no connection indicator. |
| **Frontend** | On socket `connect`, tab `visibilitychange` and browser `online`: refetch tickets (KDS) and orders (admin). Safety-net poll every 30–60 s while the tab is visible. Real `navigator.wakeLock.request('screen')` with re-acquire on visibility; graceful message where unsupported (older iOS). "Tap to enable sound" gate that unlocks the `AudioContext`. A visible Live / Reconnecting / Offline pill with "last updated" time on KDS. De-duplicate by order id on merge. |
| **Backend** | None. (Optional later: `?updatedSince=` filter to make polling cheaper.) |
| **Database** | None. |
| **Dependencies** | A real tablet to test (Android Chrome and an iPad). |
| **Testing** | Unit: merge/de-dupe logic. Browser (Playwright) test: drop and restore the socket, assert missed order appears. Manual on tablets: screen stays on 60 min; chime after cold reload; airplane-mode blip. |
| **Complexity** | **Medium** |
| **Regression risk** | **Low–Medium** (touches the KDS/admin stores; no API change) |

### P0-4 · Staff order entry that never fails silently (F-07)
| | |
|---|---|
| **Business justification** | Many diners will not scan; counter/steward entry is the fallback and must be trustworthy. |
| **Current status** | 🔧 Errors swallowed; dine-in/counter only; no modifiers/notes; fallback slug `'pangat'`; counts against the public per-table limit. |
| **Frontend** | Show server errors and keep the dialog open; remove the slug fallback; support takeaway and payment method choice; **minimum**: error handling + stable key (P0-2). **Full**: reuse the diner `CustomizationDrawer` for modifiers/notes. |
| **Backend** | Optional: staff-authenticated order endpoint that bypasses the *public* flood limiter and records the staff member (audit) instead of using the anonymous route. |
| **Database** | None (staff attribution would reuse the audit table). |
| **Dependencies** | P0-2. |
| **Testing** | Unit + e2e: failure path keeps dialog open and shows message; duplicate submit → one order; limiter not consumed by staff. |
| **Complexity** | Low (minimum) / Medium (full) |
| **Regression risk** | Low (minimum) / Medium (if a new staff endpoint is added, since it duplicates order-create validation; reuse the service method, do not fork it) |

### P0-5 · Pilot onboarding completeness and operator alerts (F-08, F-09, F-10, F-14, F-02)
| | |
|---|---|
| **Business justification** | The founders *are* the onboarding team. Every step that relies on memory will be forgotten under pilot pressure, and nobody will know a lead or a plan request arrived. |
| **Current status** | 🔧 Provisioning excellent but incomplete; no checklist; alerts missing; self-signup on; support number looks like a placeholder. |
| **Frontend** | (1) Optional kitchen PIN field in the Provision modal. (2) **Go-live checklist card** on the owner dashboard, computed from existing data: ≥1 menu item · tables exist · valid UPI ID · kitchen PIN set · staff added · first test order placed · QR kit opened. (3) Support number read from platform config instead of four hardcoded copies. |
| **Backend** | (1) `kitchenPin` optional on provision (reuse `setKitchenPin`). (2) `GET /restaurants/:id/readiness` returning checklist booleans. (3) Emit a platform event **and email** (via the existing email service and `notifications.alertEmails`) on: new lead, owner plan-change request, new support ticket of any priority. (4) Expose `support.whatsapp` in `/platform/config` + a registry entry. (5) **Config, not code:** switch off `general.selfSignupEnabled` for the pilot. |
| **Database** | None required. (Optional: `restaurants.qr_kit_opened_at timestamptz` to make the checklist step durable; otherwise omit that step.) |
| **Dependencies** | A configured email provider (Brevo). G4. |
| **Testing** | API: readiness endpoint per state; lead/ticket creates an event and attempts an email (stub the provider); provision with PIN → KDS PIN login works. Manual: provision a dummy restaurant on staging end-to-end in < 10 minutes with the checklist. |
| **Complexity** | **Medium** |
| **Regression risk** | **Low–Medium** (provisioning is a high-value path: keep the new fields optional and add a regression test for the current payload) |

### P0-6 · Truthful pricing and claims (F-12, F-13)
| | |
|---|---|
| **Business justification** | Mismatched price and non-existent features are the most avoidable pilot-ending conversation, and creates consumer-protection exposure. |
| **Current status** | 🔧 Detailed table in audit §7. |
| **Frontend** | Landing/login/checkout copy changes only: remove "daily WhatsApp summary" (or mark "coming soon"), fix "kitchen chimes when paid", fix "WhatsApp receipt", settle price/trial wording per G2, soften "keep 100%/instant" wording until Razorpay is live. |
| **Backend** | None. Production plan rows/trial days adjusted through Super Admin (data, not code). |
| **Database** | None (data edits only, audited by the console). |
| **Dependencies** | G2. |
| **Testing** | Content review checklist; confirm landing price equals what the Subscription page shows to a new trial owner on staging. |
| **Complexity** | **Low** |
| **Regression risk** | **Low** (copy) |

### P0-7 · Delivery safety net: baseline schema, DB-backed CI, staging, hosting check (F-20, F-21, F-22)
| | |
|---|---|
| **Business justification** | One developer shipping changes to a system that handles money needs automated proof and a place to rehearse. Without a rebuildable schema there is no real staging and no disaster-recovery story beyond Neon's own backups. |
| **Current status** | 🔧/⛔ Core tables have no migration; CI skips all DB-backed suites; no staging; deploy settings only in dashboards. |
| **Frontend** | None. (Add the web `lint` job in warn-only mode now; gate later, see P1-13.) |
| **Backend / ops** | (1) Produce `000_baseline.sql` from a schema-only dump of *production* (`pg_dump --schema-only`, reviewed and sanitised) and a CI check that a fresh DB built from 000+migrations equals the entity-synchronised schema (catches drift). (2) GitHub Actions job using a free `postgres` **service container**: build API, start it with throttling off and test secrets, run `test:integration`, `test:phase1*`, `test:compliance`, `test:platform` on a *fresh* database every run (the Phase 1 suite-order caveat). (3) Staging: a **Neon branch** of production (free) + a second Render service (or a preview deploy) + a Netlify branch deploy; seed with test data. (4) Verify Neon/Render tiers (G5), set an external **uptime ping** (free) to `/health`, confirm Neon point-in-time/backup window, repeat the documented restore drill once. (5) Add a `render.yaml` to record deploy settings. |
| **Database** | New `000_baseline` (documentation/rebuild artefact; **never run on production**; the runner already skips ≤ 008 and records applied files). |
| **Dependencies** | Someone with production DB access for the dump (founder/developer, run by a person, not by me). |
| **Testing** | The deliverable *is* the testing: CI green on a fresh database; staging checklist from Phase 1 (`docs/staging/STAGING_CHECKLIST.md`) executed. |
| **Complexity** | **Medium** |
| **Regression risk** | **None to product code**; moderate risk of flaky CI — mitigate by running suites serially on a fresh DB. |

### P0-8 · Honest manual-UPI flow and refund labels (F-06, F-17)
| | |
|---|---|
| **Business justification** | Until a gateway exists, UPI is a hand-confirmed payment. Make that flow smooth and truthful instead of promising "instant". |
| **Current status** | 🎭 "UPI Instant" copy; diner cannot say "I've paid"; cashier gets no signal; refund option mislabelled. |
| **Frontend** | Rename to "Pay by UPI (cashier confirms)"; after returning from the UPI app the diner taps **"I've paid"** → tracking shows "Waiting for cashier to confirm"; admin orders list highlights *claimed* orders first with a one-tap *Confirm received* (existing mark-paid); rename refund method to "Refunded manually (UPI/bank/cash)". |
| **Backend** | `POST /orders/:id/payment-claimed?token=` (rate-limited, tracking-token authenticated, idempotent) sets `payment_claimed_at` and emits `order:updated` to the admin room. No change to who may mark paid. |
| **Database** | `orders.payment_claimed_at timestamptz NULL` (additive, nullable, safe). |
| **Dependencies** | P0-1. **[G1]** If Razorpay checkout will exist before the pilot starts, skip this item. |
| **Testing** | API: token required, only own order, idempotent, cannot claim a PAID/cancelled order, does **not** change `payment_status`. Browser: claim → badge appears on the cashier screen without reload. |
| **Complexity** | **Medium** |
| **Regression risk** | **Low–Medium** (new nullable column, new endpoint; does not alter pay/bill logic) |

### P0-9 · Staging UAT on real devices (verification, not a feature)
| | |
|---|---|
| **Business justification** | Phase 1's approval was conditioned on proof on staging and real tablets; neither has happened. |
| **Current status** | 🧪 Phase 1 browser UAT: desktop Chromium, local only. Web `test:uat` never run. |
| **Work** | Run the Phase 1 staging checklist; add three real-device passes (Android Chrome phone, iPhone Safari, a kitchen tablet) for the diner and KDS journeys; print a QR standee and scan it in low light; a real ₹1 UPI payment; kitchen runs 2 hours with screen-lock and Wi-Fi drops; parameterise or retire the UAT scripts with local paths. |
| **Dependencies** | P0-1…P0-8 on staging; devices. |
| **Testing** | Signed-off checklist and a short results note, as Phase 1 did. |
| **Complexity** | **Medium** · **Regression risk** None (verification) |

**P0 exit criteria (go / no-go for the first pilot):** CI green incl. DB suites; staging checklist passed; ₹1 live UPI payment reached the right account; kitchen tablet runs a full service without a missed order; founders can provision a dummy restaurant from a lead in one sitting using the checklist; claims reviewed.

---

## 3. P1 — important after (and alongside) the first pilot

| ID | Item | Why | Status | Frontend | Backend | DB | Depends on | Tests | Complexity | Regression risk |
|---|---|---|---|---|---|---|---|---|---|---|
| **P1-1** | **Razorpay restaurant payments** (split A–D below) | Pay-before-serve, fewer cash mistakes, reconciled refunds; the top commercial feature | ⛔ (audit §6) | Connect card in Settings; Standard Checkout on tracking/checkout; "paying…/failed/retry" states | OAuth connect + token lifecycle; create Razorpay order from server total; verify by fetching payment; webhook endpoint; refund API; reconciliation job | `restaurant_payment_accounts`, `order_payments`, `order_refunds` (see dependencies doc) | G1, G6, G8, Razorpay partner approval + sandbox, P0-7 CI | Signed-fixture webhook tests, sandbox end-to-end, replay/duplicate, amount tamper, wrong account id, expired token; reconciliation | **High** | **High** (touches order release, inventory, KDS, reports) — mitigated by new-method-only gating |
| **P1-2** | **Pangat subscription billing** | Revenue; removes manual invoicing | 🟡 | Upgrade/Pay button, status after payment, invoice download | Create Razorpay Subscription or Payment Link from `razorpay_plan_id`; persist ids; dunning emails; GST invoice PDF | Optional `subscription_invoices.pdf_key`; none otherwise | Pangat Razorpay keys, plan mapping, CA on invoice format, P0-6 | Sandbox: authenticate → charge → fail → halt; webhook ledger entries | Medium–High | Low–Medium (webhook consumer already ledgered) |
| **P1-3** | **Menu CSV import + photos** | Cuts onboarding time most; photos lift conversion | 🔧 (emoji, manual) | Import wizard with preview/errors; image picker | Validated bulk create (categories, items, modifiers) in one transaction, plan-limit aware; image upload to free object storage with size/type limits | Widen `menu_items.image_url`; optional `image_key` | Free storage (e.g. Cloudflare R2 / Cloudinary free tier — choose when needed) | Import fixtures incl. malformed rows; image type/size rejection; tenant isolation | Medium | Low–Medium |
| **P1-4** | **Operational notifications** | Orders when the tab is closed; replaces the WhatsApp-summary claim | ⛔ | Opt-in Web Push (service worker); daily summary settings | VAPID web-push sender; **daily summary email** via Brevo (free tier 300/day is enough for pilots); diner "order ready" push where granted | `push_subscriptions` table; summary opt-in flag | P1-6 (service worker), email provider | Delivery stubs, unsubscribe, quiet hours | Medium | Low |
| **P1-5** | **Reports v2** | Owners judge the product by end-of-day numbers | 🟡 | Date presets, CSV, payment-method / cashier close-out, multi-outlet roll-up | Add endpoints reusing the audited money rules; export streaming | None (reads) | Entitlement for `ANALYTICS` | Golden-data tests for totals, refunds, cancelled | Medium | Low (read-only) |
| **P1-6** | **PWA + kiosk hardening** | Installable KDS, offline banner, faster loads | ⛔ | Manifest, icons, shell-caching service worker, offline state | None | None | Netlify headers (CSP allows `'self'` workers) | Lighthouse PWA, offline shell, update flow | Low–Medium | Low–Medium (stale-cache risk: version the shell) |
| **P1-7** | **Order-abuse controls** | Public QR + fire-before-pay is prank-prone | 🔧 | Table-session code on QR or a "staff must accept" outlet toggle | Per-table rotating session token or accept-first mode; stricter limits when abusive | `tables.session_secret` (if token approach) | G6, printing new QR kits | Replay, stale token, two phones one table | Medium | Medium (QR re-print for token approach; accept-first is Low) |
| **P1-8** | **Delivery configuration** | Only if a pilot delivers | 🟡 | Fee/min-order/area settings | Replace ₹30 constant with outlet config | `restaurants.operations` JSON extension (no new column) | G3 | Totals with/without fee; limits | Low–Medium | Medium (touches total calculation) |
| **P1-9** | **Plan change → support ticket** | A request must create work, not an audit row | 🎭 | Confirm message | Create ticket (source `PLAN_REQUEST`) + alert | None | P0-5 alerts | Ticket created once, deduped | Low | Low |
| **P1-10** | **Order create hardening and guard performance** | Correctness under load/crash | 🔧 | None | Single transaction for order + stock; batch menu fetch; cache classification in `TenantGuard` | None | P0-7 CI; pilot metrics showing need | Concurrency, rollback-on-stock-failure, p95 latency | Medium | **High** (core path) — do only with strong tests |
| **P1-11** | **Observability** | Founders learn about outages before restaurants | 🟡 | None | `/health` that checks DB; error tracking (free tier) with request ids; uptime pager to a phone; Brevo/Neon quota alerts | None | G5 | Induced failures page the founders | Low–Medium | Low |
| **P1-12** | **Browser E2E in CI** (4 journeys: provision → order → KDS → pay/bill) | Catches UI regressions | 🧪 | Test ids where needed | None | None | P0-7, Playwright is free | The journeys themselves | Medium | None to product |
| **P1-13** | **Web hygiene** | Lint gate, dead code | 🔧 | Fix or deliberately configure the 69 lint errors (check the 7 `react-hooks/purity` for real bugs); delete orphan `OnboardingPage` or re-route it with email OTP (G4) | None | None | — | Lint gate in CI | Low–Medium | Low |
| **P1-14** | **Hygiene bundle** | Small correctness items | 🔧 | — | GET `my-subscription` no longer writes; trim public table status; remove hardcoded API host fallback | None | — | Targeted tests | Low | Low |

### P1-1 split (each independently reviewable and releasable behind a feature flag)
- **1A Connect:** OAuth start/callback, encrypted token store, refresh, status UI, revoke handling. No customer-visible change. Sandbox only.
- **1B Pay:** create order, checkout, verify, webhook, `order_payments`, order-release rule (model B) for the new method only. Test mode only.
- **1C Refund:** gateway refunds + `refund.processed`, partial refunds, credit-note linkage (reuse `issueCreditNote`).
- **1D Reconcile:** stuck-payment sweeper, daily tie-out report, Super Admin visibility, runbook.
- **1E Live:** one pilot, ₹ small amounts, daily manual tie-out for two weeks, then widen.

---

## 4. P2 — later (not needed to validate the idea)
Advanced reports key (cohorts, item margins), item-level tax/HSN and discounts/coupons, split bills and tips, call-waiter / request-bill, order-ahead / scheduled pickup, reservations, Hindi/Marathi menus, loyalty/CRM, Zomato/Swiggy and accounting (Tally) exports, thermal KOT/receipt printers, recipe costing and supplier POs, native apps, WhatsApp Business API (paid), multi-instance scale-out (Redis for limiters/cache and a Socket.IO adapter, jobs on a leader), SSO for platform admins, JWT in httpOnly cookies, accessibility audit, lawyer/CA sign-off on privacy and tax documents (do this before scale, not before the pilot, but do not forget it).

---

## 5. Recommended implementation sequence

Small, independently reviewable and releasable PRs. Each PR is one concern, has its own tests, and is deployable alone (the web and API halves are listed together but ship API-first where both change, as in Phase 1). Re-prioritise after each PR; do not batch.

| Phase | Contents | Repo(s) | Gate to proceed |
|---|---|---|---|
| **PR-0** | Decisions G1–G8; collect facts (VPA ownership, prod prices, tiers, support number); Razorpay questions sent | none | Founder answers |
| **PR-1 Money hotfix** | P0-1 (payee + DTO regex) and P0-2 (stable keys) as **two** small PRs | web (+ API DTO) | Unit + e2e green; ₹1 UPI test on a dev outlet |
| **PR-2 Safety net** | P0-7: baseline schema + drift check, DB-backed CI job, `render.yaml`, staging (Neon branch + Render/Netlify previews), hosting/uptime/backup verification | API (+ ops) | CI green on a fresh DB; staging boots from the baseline |
| **PR-3 Kitchen reliability** | P0-3 | web | Tablet soak test passes |
| **PR-4 Staff entry** | P0-4 (minimum first, full modifiers as a follow-up PR) | web (+ optional API) | E2E passes |
| **PR-5 Manual UPI flow** | P0-8 (skip if G1 = Razorpay before pilot) | API + web | Migration rehearsed on staging copy |
| **PR-6 Pilot ops** | P0-5: provisioning PIN, readiness endpoint + checklist, alerts, support number, signup off | API + web | Dummy restaurant provisioned end-to-end using only the checklist |
| **PR-7 Honest copy** | P0-6 | web | Founder sign-off |
| **PR-8 Staging UAT + go/no-go** | P0-9 | none | **Pilot go/no-go** |
| *Pilot starts (1–2 restaurants).* In parallel, in this order: | | | |
| **PR-9** | P1-9 + P1-14 hygiene (small) | API | — |
| **PR-10** | P1-3 CSV import (then photos) | API + web | Used for pilot 2's menu |
| **PR-11 … 15** | P1-1A → 1B → 1C → 1D → 1E (Razorpay), each behind a flag; 1A can start as soon as partner credentials exist, even during PR-3…PR-8 | API + web | Partner approval; sandbox |
| **PR-16** | P1-2 subscription billing | API + web | After pilot pricing is settled |
| **PR-17+** | P1-5 reports, P1-4 notifications + P1-6 PWA, P1-7 abuse controls, P1-11 observability, P1-12 browser E2E, P1-13 hygiene, P1-10 hardening (only if metrics demand) | — | Driven by pilot feedback |

**Why this order:** (1) money-wrong bugs first because they are cheap and the most damaging; (2) the safety net second so every later change is protected by DB-backed CI and a staging rehearsal (this is the highest-leverage item for a one-person team); (3) kitchen and staff reliability next, because a restaurant forgives a missing feature but not a lost order; (4) pilot operations and honesty before any new capability; (5) Razorpay as soon as access exists but never blocking the first pilot unless G1 says so.

---

## 6. Spend

| Item | Needed? | Justification |
|---|---|---|
| Render API instance that does not sleep | **Only if G5 shows it sleeps** | The kitchen needs the API awake and background jobs running; this is the single spend I would justify at the pilot stage. A free uptime ping is a stop-gap, not a fix, for a service that must hold sockets and run timers. (Confirm current Render pricing and free-tier behaviour.) |
| Neon branch for staging | No (free) | Branching is a free-tier feature; check branch/storage limits |
| GitHub Actions + Postgres service container | No | Free minutes are ample for these suites |
| Brevo | No | Free daily quota is enough for pilot volumes; verify sender/domain authentication |
| Object storage for photos | Later, probably free | Pick a free tier when P1-3 photos start |
| Web push | No | VAPID is free |
| WhatsApp Business API, SMS | **Defer** | Per-message costs; replace the WhatsApp promise with email/push |
| Razorpay | Transaction fees only | Confirm fee schedule before changing "keep 100%" wording |

---

## 7. Explicitly *not* recommended now
Rebuilding Super Admin (already broader than needed); a second payment provider; native apps; microservices or Redis; replacing TypeORM; a redesign. The code is sound; the gaps are correctness details, reliability, process and honesty.

## 8. Approval requested
Please confirm: (a) the P0 list and sequence (or remove/reorder items); (b) answers to G1–G8; (c) permission to start with **PR-1** (two small web PRs plus one DTO change). I will not start until you approve. When you do, I recommend each PR carries a short results note like the Phase 1 reports, and that merging stays your decision.

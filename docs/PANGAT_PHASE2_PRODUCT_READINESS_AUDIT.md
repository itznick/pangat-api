# Pangat — Phase 2 Product Readiness Audit

**Type:** read-only discovery. No source was modified, nothing was committed, merged, deployed or migrated, and no database was touched.
**Date:** 2026-11-25
**Baseline audited:** `itznick/pangat-api` `main` @ `977c93a` and `itznick/pangat-web` `main` @ `0beb1c8` (both equal to `origin/main` at audit time; Phase 1 is merged).
**Companion documents:** `PANGAT_PHASE2_ROADMAP.md` (what to build, in what order) and `PANGAT_PHASE2_TECHNICAL_DEPENDENCIES.md` (how the pieces depend on each other, proposed schema, external dependencies, test strategy).

> Naming note: the existing migrations `002`–`007` and some old commits are called "phase2_*". They refer to an *earlier* internal milestone (order lifecycle, inventory, subscriptions), not this document. To avoid confusion the roadmap calls the new work **Pilot Readiness (PR-n)**.

---

## 0. How this audit was done, and its limits

**Done**
- Read the architecture end to end: backend modules, entities, all 17 migrations, guards, the order/payment/subscription/webhook code paths, the Socket.IO gateway; the web routes, stores, KDS, diner, admin, Super Admin and landing code; both CI workflows; the Phase 1 reports and staging checklist.
- Ran, on a clean checkout, what can run without a database: `npm ci`, `nest build`, API unit tests, web `tsc -b` + `vite build`, web unit tests, both linters.

| Check | Result |
|---|---|
| API `npm run build` | passes |
| API `npm test` (unit, no DB) | **266 / 266 pass** (matches the Phase 1 report) |
| API `npm run lint` | warnings only (unused vars, `GET` with body in tests) |
| Web `npm run build` (`tsc -b` + vite) | passes. Diner route is light (react 69 kB gz + shared index 47 kB gz); admin 49 kB gz; super-admin 58 kB gz |
| Web `npm test` | **51 / 51 pass** |
| Web `npm run lint` | **fails: 69 errors, 49 warnings** (34 `react-hooks/set-state-in-effect`, 21 `no-explicit-any`, 7 `react-hooks/purity`). **Not gated in web CI** (`ci.yml` runs build, test and audit only) |

**Not possible here, so *not* verified by me**
- Any behaviour against a real database: the ~300 integration / e2e / platform / compliance tests need Postgres and are **not run in CI** (§7). I rely on the Phase 1 reports (which executed them locally) and mark every such claim "verified in Phase 1".
- Browser behaviour, mobile layouts, real tablets, audio, wake-lock, QR scanning from print. Phase 1 browser UAT was **desktop Chromium only**; the web repo's own `test:uat` has never been run.
- Production/staging configuration: which Render/Neon tiers are in use, which plan prices and trial length are configured in production, whether `pangat@icici` is a real VPA and who owns it, whether `919890000000` is a real support number, whether an email provider is configured.
- **The Razorpay Technology Partner response.** It is not in either repository and I was not given its text. §6 is therefore based on the code and on general knowledge of Razorpay's OAuth/partner model; every Razorpay-specific assumption is marked **[verify with Razorpay]** and collected as questions in the dependencies document.

**Status legend:** ✅ Complete and verified · 🔧 Implemented, needs improvement · 🟡 Partially implemented · 🎭 UI-only / placeholder · ⛔ Not implemented · 🧪 Implemented but insufficiently tested.
"Verified" always names its evidence (Phase 1 executed suites vs. re-run today).

---

## 1. Executive summary

**Verdict.** The platform is far more complete than a pre-pilot product usually is: tenancy, entitlements, audit, GST bills and credit notes, privacy, two-factor, kitchen sign-in, inventory with recipe deduction, a broad Super Admin console and a documented backup/restore drill all exist and were exercised in Phase 1. The risks to a first pilot are **not missing big features**; they are a small number of **money-correctness, kitchen-reliability and operations gaps**, plus a **public-claims gap** (the landing page promises things the product does not do).

**There is no diner-side online payment at all.** The only Razorpay code is the *subscription* webhook consumer. "UPI Instant" is a deep link/QR to a UPI ID that a cashier must confirm by hand. Pilots can run on that, **but only once the bugs below are fixed**.

### Top findings (full register in §4)

| # | Finding | Why it matters | Roadmap |
|---|---|---|---|
| F-01 | **Diner UPI payment link uses a hardcoded payee `pangat@icici`**, not the restaurant's own UPI ID (`OrderTrackingView.tsx:180`). The restaurant's `upiVpa` is stored and even returned by the public menu API, but the diner payment screen ignores it. | Diners' money would go to a fixed ID that is not the restaurant. Critical for trust and "keep 100%". | P0-1 |
| F-03 | **The diner's idempotency key is regenerated on every submit** (`DinerMenuPage.tsx:184`), so the server's duplicate protection never engages on a retry. Same pattern for walk-in orders and refunds. | A flaky Wi-Fi retry creates a second kitchen ticket / second refund. | P0-2 |
| F-04 | **KDS and admin order views never resync after a socket reconnect** and have no polling fallback for orders. | A tablet that sleeps or loses Wi-Fi for 30 s silently misses orders until someone reloads. | P0-3 |
| F-05 | **KDS "Screen Wake Lock" is a UI-only toggle** (`KDSTopBar.tsx:139`): nothing calls the Wake Lock API anywhere. | Kitchen tablets will dim and sleep. | P0-3 |
| F-06 | "Instant UPI" is not verified: the order stays PENDING until staff taps *Mark paid*, and the diner still sees "UPI Payment Pending" after paying. | Counter friction; contradicts "Instant UPI payments". | P0-8 |
| F-07 | The staff **walk-in order dialog swallows errors** (`AdminDashboardPage.tsx:159`) and closes as if it worked. | Staff believe an order was placed that was not. | P0-4 |
| F-08/09 | Operator-provisioned restaurants (the pilot path) get **no kitchen PIN** and **no go-live checklist**; **new leads and plan-change requests alert nobody**. | Onboarding depends on founders remembering steps. | P0-5 |
| F-12/13 | **Pricing and feature claims on the landing page do not match the product** (₹699 flat vs plans from ₹1,499; "daily WhatsApp summary" does not exist). | Trust and potential consumer-claims exposure. | P0-6 |
| F-20/21/22 | **Delivery safety net is thin:** core tables have no `CREATE TABLE` migration; integration tests are not in CI; no staging environment; hosting tier unknown. | One developer, real money: regressions would reach production unseen. | P0-7 |
| F-11 | **Subscription billing is entirely manual** (no way to create a Razorpay subscription; "request plan change" only writes an audit row). | Fine for free pilots; blocks paid conversion. | P1-2 |

**What is genuinely strong (do not rebuild):** server-side price/modifier/availability verification on every order; per-outlet role isolation (5 roles × sibling-outlet and cross-org tests, Phase 1); single entitlement resolver with live revocation of kitchen sockets; append-only audit tables; GST bill numbering and credit notes; privacy consent and retention; HMAC-verified, idempotent, ledgered Razorpay webhook handling; flood limits on public ordering; operator-led provisioning with a welcome-link email (no password shared in the clear when email is configured).

---

## 2. Architecture snapshot

### 2.1 Backend (NestJS + TypeORM + Postgres; ~18.5k lines of TypeScript, ~1.6k of SQL migrations, ~9.5k lines of tests)

| Module | Responsibility | Notes |
|---|---|---|
| `auth` | login, KDS PIN login, password reset, signup OTP, 2FA (TOTP), onboarding, platform-admin bootstrap | 1,029-line service. JWT 7d (admins 8h; PIN station 16h). bcrypt. Per-IP/identity limiters in memory |
| `common/guards` | `TenantGuard`, `RolesGuard`, `FeatureGuard`, `UuidInputGuard`, `IdempotencyGuard` | `TenantGuard` resolves `:id` by trying up to 7 tables in sequence (§4 F-19) |
| `organizations`, `restaurants`, `tables`, `menu` | tenant hierarchy: Organization → Outlets(Restaurant) → Tables / Menu / Staff | Menu image = emoji string (`varchar(20)`) |
| `orders` (1,287 lines) | create (public), status machine, edit items, cancel, mark paid, refund (ledger), bills, feedback | Order fires to kitchen **before** payment |
| `events` | Socket.IO gateway: rooms per outlet (`kds`, `admin`) and per order (tracking token); periodic revalidation + `access:revoked` | Single-process |
| `inventory` | ingredients, stock movements, recipes, auto-deduction on order, low-stock alerts, auto-86 of items | Plan-gated (`INVENTORY`) |
| `reports` | one endpoint: sales summary per outlet (IST), plan-gated (`ANALYTICS`) | No export |
| `subscriptions` | plans, trial/grace/expiry state machine, entitlements, Razorpay **webhook consumer**, owner self-service (cancel/resume/request-change) | No outbound Razorpay calls |
| `platform` | Super Admin: dashboard, restaurants, subscriptions, payments ledger, users, audit, settings (encrypted secrets), feature flags, comms, monitoring, support tickets, exports, background jobs | 26 permissions, 6 roles |
| `admin` | operator provisioning (org + owner + outlet + tables + seed menu + welcome link), leads | |
| `audit`, `privacy`, `leads`, `billing/document-numbers` | append-only audit, DPDP requests/retention, lead capture, bill & credit-note series | |

**Database.** Production `synchronize:false`; `src/migrations/*.sql`; files ≥ 009 auto-apply at boot under an advisory lock, each in one transaction, recorded in `schema_migrations`. **Gap:** none of the 17 files creates the core tables (`organizations`, `restaurants`, `staff`, `tables`, `menu_*`, `orders`, `order_items`, `leads`); 001–008 "were applied by hand" and are skipped by the runner (`migration-runner.service.ts:7`). Indexes for hot paths exist (orders by restaurant+created/status/payment, items, menu, staff, tables, audit). Integrity constraints exist for unique lower(email), unique (restaurant, upper(table_number)), unique tracking token, unique invoice payment id, append-only audit triggers.

### 2.2 Frontend (React 19, Vite 8, Tailwind 4, Zustand, TanStack Query, socket.io-client; ~37k lines)

Routes (`src/routes/index.tsx`): `/` landing; `/login` (password + Kitchen-PIN tab + 2FA); `/change-password`; `/account/security`; `/r/:slug/t/:tableId` diner menu; `/r/:slug/order/:orderId` tracking; `/kds/:slug`; `/admin/*` (dashboard, tables, menu, orders, inventory, support, subscription, reports, feedback, settings), role-guarded client-side *and* server-side; `/super-admin/*` (14 permission-gated pages). **`/signup` and `/onboarding` redirect to the landing page** (the 1,203-line `OnboardingPage` is orphaned dead code).

State: Zustand stores (`useAuthStore`, `useAdminStore`, `useKdsStore`, `useCartStore` + tracking store persisted to `localStorage`). Token in `localStorage` (CSP in `netlify.toml` mitigates XSS). Live data: one Socket.IO connection; REST for initial loads.

### 2.3 Auth, roles and tenancy
Roles: `PLATFORM_SUPER_ADMIN`, `SUPER_OWNER` (organisation-wide), `STORE_MANAGER`, `CHEF`, `STEWARD`, `CASHIER` (outlet-bound). `TenantGuard` fails closed, resolves the target outlet from the *resource* (not the client's claim) and rejects conflicting `restaurantId`/slug. Phase 1 executed tests prove five roles × own / sibling / foreign outlet. Platform admins can see tenants but a read-only platform role cannot mutate (`merchant.operate`). Kitchen tablets use a per-outlet PIN → CHEF "Kitchen Station" account; PINs are bcrypt-hashed with IP and outlet lockouts. **Verdict ✅.**

### 2.4 Subscription plans and entitlements
Features: `QR_ORDERING`, `KDS`, `INVENTORY`, `ANALYTICS`, `MULTI_OUTLET` (+ `ADVANCED_REPORTS`, deliberately unavailable and hidden). One resolver (`decideFeature` / `getOrgAccess`) is used by guards, services, sockets and the web console; plan + platform kill switch + per-restaurant override. State machine TRIAL → ACTIVE → PAST_DUE/GRACE → EXPIRED/HALTED/CANCELLED is a pure function used by request guards and the hourly sweep. **Verdict ✅ (Phase 1 executed suites: entitlements 36, final 4, public endpoints 11, socket revocation 9, settings 8).**

### 2.5 Infrastructure (as stated by the founders; not verifiable from the repo)
Neon Postgres, Render API, Netlify web, Brevo email. The repo has **no `render.yaml`/Dockerfile**, so deployment settings live only in dashboards. State held **in the API process**: rate limiters, public-menu cache, login/PIN lockouts, Socket.IO rooms, background job timers. That is correct for one instance and wrong for two, and it means a sleeping/restarting instance loses timers and sockets.

---

## 3. Feature status matrix

| Area | Status | Evidence and notes |
|---|---|---|
| Staff login, password reset, 2FA, forced password change | ✅ | Phase 1 suites (compliance 14/14, totp, otp-email); unit tests re-run today |
| Kitchen PIN sign-in | ✅ (API) / 🔧 (setup) | API verified; **PIN not created at provisioning** (F-08) |
| Multi-tenancy / outlet isolation | ✅ | Phase 1 `phase1_final` 4/4 plus integration; perf note F-19 |
| Plan limits and feature entitlements | ✅ | Phase 1; migration 017 rehearsed on a copy, **never on real data** |
| Subscription state machine, trial, grace, expiry sweep | ✅ | Phase 1 + unit tests |
| **Subscription payment collection (Razorpay)** | 🟡 | Consumer of signed webhooks only. Nothing creates a Razorpay subscription/payment link; `razorpay_subscription_id` is never written by code; never exercised against Razorpay's sandbox |
| Subscription invoices (GST) | 🟡 | Rows exist only when a webhook arrives; manual grants create none; **no PDF** ("Request PDF" opens WhatsApp) |
| Plan change by owner | 🎭 | `request-change` writes an audit row only (`subscriptions.service.ts:782`); nobody is alerted |
| Restaurant dashboard | 🔧 | Live tables/orders/KPIs work; walk-in dialog flaws (F-07); no go-live checklist |
| Orders (staff): status, edit, cancel, mark paid | ✅ / 🔧 | Rules enforced server-side; edit only in RECEIVED; UX issues in F-07/F-17 |
| **Diner QR ordering** | 🔧 | Server-authoritative pricing, modifiers, availability, hours/pause, per-outlet/table flood limits; retry duplicates (F-03); wrong payee (F-01) |
| Diner order tracking | 🔧 | Live via socket + 5 s polling while pending; localStorage persistence; no push/SMS |
| **UPI payment (diner)** | 🎭/🟡 | Deep link + QR to a UPI ID; no verification; hardcoded payee (F-01) |
| **Gateway checkout (cards/UPI via Razorpay), server verification, refunds-to-source** | ⛔ | Not implemented (§6) |
| Counter payment, GST bill numbering, credit notes | ✅ | Phase 1 compliance suite; bill issued in the same transaction as payment |
| Refunds | 🟡 | Ledger + credit note + audit only. "Verified Provider Gateway Refund" option is a label (F-17) |
| Kitchen Display System | 🔧 | Board, mobile stage tabs, send-back with reason, 86-list, chime, per-chef PIN audit. **No resync** (F-04), **wake lock fake** (F-05), audio may be silent after a hard reload until first tap |
| Tables and QR kit | ✅ | Batch create, limits, status sync, printable standees. QR is deterministic (`/r/<slug>/t/T01`) |
| Menu management | 🔧 | CRUD, modifiers, availability, price; **emoji instead of photos, no CSV import, no copy-to-outlet** (F-24) |
| Inventory and recipes | ✅ (API) / 🧪 (UI) | 521+666 lines of API tests; deduction on order, reversal on cancel, auto-86; UI only unit-tested |
| Reports (restaurant) | 🟡 | One summary endpoint with correct money rules; no export, no multi-outlet rollup, no cashier/shift close (F-25) |
| Customer feedback | ✅ | Token-gated diner review; staff-only read |
| Email (Brevo/SMTP/Resend/SendGrid) | ✅ infra / 🧪 live | Templates, OTP, welcome/reset links, trial reminders, critical alerts. Whether a provider is configured in production is unknown |
| Restaurant-facing event notifications (new order when tab closed, daily summary) | ⛔ | Socket-only. WhatsApp: ⛔ entirely |
| Super Admin console | ✅ (API, Phase 1 platform suite 43/43 on a fresh DB) / 🧪 (browser) | Broad; arguably more than a 2-founder team can operate. Alerts email only for CRITICAL events |
| Support tickets (restaurant ↔ platform) | ✅ | Web + API; in-app only |
| Lead capture (landing → Super Admin → one-click Provision) | 🟡 | Works; **no alert** (F-09) |
| Self-service sign-up | 🟡 | API live and **on by default**; UI unrouted (F-10) |
| Privacy (consent, DSAR, retention, grievance) | ✅ | Needs lawyer/CA review (per `COMPLIANCE.md` open questions) |
| Monitoring | 🟡 | Health snapshots, error log, webhook ledger in Super Admin; no external uptime/alerting to a phone |
| Mobile responsiveness | 🧪 | Mobile-first diner, stage tabs on KDS, responsive admin. Not browser-verified in this audit; Phase 1 UAT desktop only |
| PWA / installability / offline | ⛔ | No manifest, no service worker |
| Delivery orders | 🟡 | Address/phone/COD; fee hardcoded ₹30 (F-16); no area, partner or tracking |
| Hindi/Marathi, accessibility audit | ⛔ | 78 `aria-*` attributes in admin/diner/KDS; no formal pass |

---

## 4. Findings register

Severity: **C** critical (money / safety), **H** high (breaks a pilot workflow), **M** medium, **L** low. Each is tagged with the roadmap item that resolves it.

### 4.1 Money and payments
| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| F-01 | **C** | Diner UPI link/QR/copy-VPA use a literal `"pangat@icici"`. Restaurant `upiVpa` (returned by `GET /menu/public/:slug`, `menu.service.ts:73`) is not used. Payee name is the URL slug. | `OrderTrackingView.tsx:180-181` | P0-1 |
| F-02 | H | Provisioning pre-fills a **made-up** VPA `<slug>@icici`; the API accepts any non-empty string for `upiVpa` on provision/onboard (the settings endpoint has a regex, these two do not). A forgotten edit stores a wrong ID, and F-01's fix would then faithfully route money to it. | `ProvisionRestaurantModal.tsx:142,158`; `provision-restaurant.dto.ts:49`; `onboard.dto.ts:78` vs `update-settings.dto.ts:76` | P0-1 |
| F-03 | H | Idempotency key built inside the submit handler (`Date.now()+random`): each retry/tap is a *new* order. Walk-in (`idemp-walkin-${Date.now()}`, `AdminDashboardPage.tsx:154`) and refund (`refund_${id}_${Date.now()}`, `AdminOrdersPage.tsx:1154`) repeat the pattern. The server design (unique key, replay returns the winner, same-outlet check) is correct and unused. | `DinerMenuPage.tsx:184` | P0-2 |
| F-06 | H | UPI orders stay `PENDING` until staff presses *Mark paid*; no payment reference is captured; after paying, the diner still reads "UPI Payment Pending". | `orders.service.ts` (payment is always `PENDING` at create); `OrderTrackingView.tsx:758-780` | P0-8 |
| F-17 | M | Refund method "Verified Provider Gateway Refund" implies money is returned automatically. It only records a ledger entry/credit note; staff must refund by hand. | `AdminOrdersPage.tsx:1127`; `orders.service.ts:1098-1182`; refund idempotency is read-then-write without a lock | P0-8 (label), P1-1 (real) |
| F-16 | M | Delivery fee is a constant ₹30 with a comment claiming it can be configured. | `orders.service.ts:319` | P1-8 (or disable delivery per outlet today; setting exists) |
| F-18 | L→M | Order create is not one transaction: save order → deduct stock → on failure delete order. A crash between steps leaves an orphan or double-deducted stock. Per-line menu lookups are sequential (N+1). Fine at pilot volume. | `orders.service.ts:355-380` | P1-10 |

### 4.2 Kitchen and live operations
| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| F-04 | H | After socket reconnect the client only re-joins rooms; it does not refetch tickets. KDS fetches once on mount; the admin orders store has no poll. Missed `order:new` events are lost until reload. | `lib/socket.ts` connect handler; `useKdsStore.ts` (no `connect` listener); `useAdminStore.ts:223+` | P0-3 |
| F-05 | H | "Wake Lock" is `setWakeLockActive(!x)` on a store flag; no `navigator.wakeLock` call exists. | `KDSTopBar.tsx:139`; repo-wide grep | P0-3 |
| F-35 | M | The chime relies on an `AudioContext` created at first chime; after a hard reload of `/kds/:slug` with no tap, browsers keep it suspended, so the first order is silent. No "tap to enable sound" gate. No visible connection indicator on KDS. | `lib/sound.ts` | P0-3 |
| F-07 | H | Walk-in dialog: `catch → console.error`, then closes. Only DINE_IN + PAY_AT_COUNTER, no modifiers/notes, fallback slug `'pangat'`. Also counts against the *public* per-table flood limit (6 / 5 min). | `AdminDashboardPage.tsx:129-163` | P0-4 |
| F-15 | M | Order-then-pay with a deterministic public table URL: anyone with `/r/<slug>/t/T01` can fire tickets to the kitchen from anywhere. Throttled (60 per outlet / 6 per table per 5 min) but there is no staff-accept step or table-presence proof. | `orders.service.ts:45-46,92-94` | P1-7 |

### 4.3 Onboarding, operations and support
| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| F-08 | H | Provisioning does not create the kitchen PIN (no field in DTO/modal). The KDS cannot be opened with a PIN until the owner finds Settings → Kitchen. No go-live checklist; the "zero state" card only appears for accounts with no outlet. | `provision-restaurant.dto.ts`; `AdminSettingsPage.tsx:410-460`; `ZeroStateCard.tsx` | P0-5 |
| F-09 | M | New leads, owner plan-change requests and non-urgent support tickets raise **no alert** (events only email for CRITICAL severity, and leads emit no event). The landing promises "WhatsApp within 4 hours". | `leads.service.ts`; `subscriptions.service.ts:782`; `events.service.ts:33` | P0-5 |
| F-10 | M | `general.selfSignupEnabled` defaults to **true**, so `POST /auth/onboard` (5/min/IP) lets anyone create organisations with a 14-day trial, while the web page that would use it redirects to the landing page. Pure attack surface for a pilot. | `settings.registry.ts:35`; `routes/index.tsx:117,142` | P0-5 (config) |
| F-14 | M | Support WhatsApp `wa.me/919890000000` is hardcoded in four places and looks like a placeholder. | `AdminLayout.tsx:77`, `billing.ts:27`, `SuperAdminLayout.tsx:24`, `Footer.tsx:24` | P0-5 |
| F-11 | M | Subscription billing is manual end-to-end (see §3, §6.7). Payment method text is hardcoded "Invoice / UPI transfer". | `AdminSubscriptionPage.tsx:213,324` | P1-2 |
| F-28 | L | `GET /subscriptions/my-subscription` starts a trial as a side effect. | `subscriptions.service.ts:288-300` | P1 hygiene |
| F-24 | M | Menu entry is the largest onboarding labour: no CSV/Excel import, no photos (emoji only, `varchar(20)`), no copy between outlets. | `menu-item.entity.ts:63`; `AdminMenuPage.tsx` | P1-3 |
| F-25 | M | Reports: single-outlet only, no CSV, no cash-vs-UPI close-out by cashier/shift, no multi-outlet roll-up; `ADVANCED_REPORTS` is a stub. | `reports.service.ts`, `FEATURE_CATALOG` | P1-5 |
| F-26 | M | No operational notifications outside an open browser tab; diner has no "ready" alert off-screen. | grep: no push/SMS/WhatsApp code | P1-4 |

### 4.4 Platform, data and delivery process
| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| F-20 | M→H | No `CREATE TABLE` for core tables in any migration; a database cannot be rebuilt from the repo alone (staging, disaster recovery, new developer). Dev/test uses TypeORM `synchronize`, so entity edits can silently diverge from production. | `migrations/*`; `app.module.ts` (`synchronize: !isProd`) | P0-7 |
| F-21 | M→H | CI runs build + unit tests + lint + `npm audit` + gitleaks. The integration, entitlements, platform, compliance and UAT suites (the bulk of real verification) are manual. Phase 1 itself found a suite that depends on DB volume. Web lint fails and is not gated. | `.github/workflows/ci.yml` (both repos); Phase 1 report §8 | P0-7, P1-12 |
| F-22 | H (unverified) | If the API runs on a sleeping/spun-down plan: cold starts on the first diner order, lost background jobs (subscription sweep, trial reminders), dropped sockets. In-process state breaks if a second instance is added. `/health` checks no dependency. | `main.ts`, `jobs.service.ts`, `app.controller.ts` | P0-7 (verify), P1-11 |
| F-19 | L | `TenantGuard` runs up to 7 sequential single-row queries to classify a `:id` plus subscription lookups on every write. Correct, slightly wasteful. | `tenant.guard.ts:60-125` | P1-10 |
| F-27 | L | Public outlet profile includes live table statuses. | `restaurants.service.ts` `toPublic` | P1 hygiene |
| F-29 | L | JWTs in `localStorage`; accepted given CSP, but an XSS would expose sessions. | `lib/socket.ts`, `useAuthStore.ts` | P2 |
| F-30 | L | Production API host is a hardcoded fallback in the web bundle. | `lib/socket.ts:30` | P1 hygiene |
| F-31 | L | Dead code: `OnboardingPage` (1,203 lines) and its `/onboarding` fallback links; web lint debt (69 errors) hides real issues (`react-hooks/purity` may flag render-time `Date.now()`). | `features/onboarding`, lint output | P1-13 |

### 4.5 Public claims versus the product (see also §7)
F-12 pricing mismatch; F-13 unimplemented claims. Detailed in §7.

---

## 5. User journeys (walk-throughs)

Legend: ✅ works as designed · ⚠ works with friction or a defect · ❌ blocked/absent.

### 5.1 Restaurant owner
| Step | State | Notes |
|---|---|---|
| Discovers Pangat | ✅ | Landing, ROI calculator, demo modal (a client-side simulation, clearly labelled "Simulate") |
| Requests onboarding | ⚠ | "Start your free trial" → lead form. Lead is stored; **founders are not alerted** (F-09) |
| Gets an account | ✅ | Founder clicks *Onboard* on the lead → Provision modal pre-fills from the lead → org, owner, outlet, tables, seed menu; welcome link emailed if email is configured, else a temporary password is shown once. **Pre-filled UPI ID is fake** (F-02) |
| Sets up restaurant details | ✅ | Settings: GST, service charge, FSSAI, hours, pause, accepted order types and payment methods, prep time, receipt footer |
| Creates menu | ⚠ | One item at a time, emoji icons; the seed preset must be edited. Biggest time sink (F-24) |
| Creates tables / QR kit | ✅ | Batch generation, printable standees. Only table limits apply |
| Configures staff and KDS | ⚠ | Staff CRUD with seat limits and per-chef PINs work; **kitchen PIN is not created automatically and nothing tells the owner** (F-08) |
| Activates QR ordering | ⚠ | It is "on" by plan; there is no test-order helper or checklist; first real proof is a real diner |
| Manages subscription | ⚠ | Sees plan, trial, limits, invoices. Cannot pay or change plans in-product (WhatsApp/request-change) (F-11) |

### 5.2 Restaurant staff
| Role | State | Notes |
|---|---|---|
| Login | ✅ | Per-role landing screen (cashier→orders, steward→tables). Temporary-password change flow works |
| Kitchen (PIN, `/kds/:slug`) | ⚠ | Board/columns/mobile tabs/send-back/86 list OK; **no resync, fake wake lock, possibly silent first chime** (F-04/05/35) |
| Steward | ⚠ | Floor view, table status, edit items while RECEIVED, cancel with reason. Walk-in dialog defects (F-07) |
| Cashier | ⚠ | Orders list, mark paid (issues the legal bill in the same transaction), print bill. **Must verify UPI in their own bank app** (F-06) |
| Manager/owner | ✅ | Refund (manual), reports, feedback, inventory, audit view |
| Outlet permissions | ✅ | Server-enforced; verified (Phase 1) |

### 5.3 Diner
| Step | State | Notes |
|---|---|---|
| Scans QR | ✅ | Static code to `/r/<slug>/t/<table>`; works only if the printed code survives (no short link, no fallback) |
| Opens menu | ✅ | Mobile-first, category nav, veg filter, closed/paused banner, expected prep time |
| Selects items | ✅ | Modifiers, notes, quantity; cart persisted locally |
| Places order | ⚠ | Server re-prices everything; **retry may duplicate** (F-03) |
| Tracks order | ✅/⚠ | Live status, ETA steps, add more items, feedback after payment. No off-screen alert |
| Pays | ⚠/❌ | Pay at counter ✅ (cashier). UPI: **wrong payee** (F-01), then unverified (F-06). Card/online checkout ❌ |
| Receipt | ⚠ | Printable GST bill via token link; checkout text says "digital WhatsApp receipt" but none is sent (F-13) |

### 5.4 Platform Super Admin (the founders)
| Duty | State | Notes |
|---|---|---|
| Provision restaurants | ✅ | Lead → Onboard in one flow; presets; audited |
| Manage subscriptions/plans | ✅ ops / ❌ self-serve | Plans, grant/extend/cancel/trial are audited and never fake revenue; no billing automation (F-11) |
| Platform settings | ✅ | Encrypted secrets (AES-256-GCM), kill switches, maintenance, email provider |
| Support and monitoring | ⚠ | Ticket queue, health snapshots, webhook ledger, error log. Alerts are in-app; email only for CRITICAL; no phone alerting (F-09, F-22) |
| Audit and tenant status | ✅ | Append-only platform and restaurant audit; suspend/restore with enforcement hooks |
| Compliance | ✅ | Privacy requests queue, exports, retention jobs |

---

## 6. Payment readiness

> **Source caveat.** I did not receive the Razorpay Technology Partner reply. Below, *Implemented* is what the code does today (certain). *Proposed* is design work (not started). Razorpay-specific mechanics marked **[verify]** come from general knowledge of Razorpay's OAuth/partner program and must be confirmed against the reply and current docs before design is frozen.

### 6.1 What exists today (implemented)
- **Subscription webhook receiver** `POST /api/v1/subscriptions/webhook/razorpay`: raw-body HMAC-SHA256 with constant-time compare; 503 if no secret; secret from encrypted Super Admin setting or env; every delivery (accepted, rejected, duplicate, failed) written to `webhook_events` with outcome, latency and payment id; idempotent via `subscription_audit_logs.idempotency_key`; handles `subscription.authenticated/charged/halted/cancelled/pending`, `payment.captured/failed`, `refund.processed`; unique invoice per `razorpay_payment_id`; GST fields on invoices; grace period on failure; Super Admin payments page, reconciliation (manual grants flagged, never revenue), CSV exports. **Fixture-tested with signed payloads only, never against Razorpay.**
- **Fields reserved:** `subscription_plans.razorpay_plan_id`, `organization_subscriptions.razorpay_subscription_id/customer_id` (no code populates the latter two).
- **Diner payments:** `payment_method ∈ {UPI_INSTANT, PAY_AT_COUNTER, COD}`, `payment_status ∈ {PENDING, PAID, FAILED, REFUND_PENDING, PARTIALLY_REFUNDED, REFUNDED}`. Payment is always created `PENDING`; only staff `mark-paid` sets `PAID` and issues the bill number; real-time `order:paid` is emitted to diner/admin. **No gateway call exists in the order path.**
- **Refunds:** staff-recorded; credit note numbered in its own series; audit-logged; amount capped at remaining.
- **Per-outlet UPI ID** stored; used for nothing on the diner side except (incorrectly) not at all (F-01).

### 6.2 Assessment by capability
| Capability | Status | What is needed (proposed) | Complexity / regression risk |
|---|---|---|---|
| **Pure Platform OAuth** (restaurant authorises Pangat to act on its own Razorpay account; funds settle directly to the restaurant) | ⛔ | Register the partner app; `GET /payments/connect/start` (signed `state`, owner-only) → redirect; `GET /payments/connect/callback` exchanges the code, stores **encrypted** access/refresh tokens and the merchant/account id and public key; refresh-token job and on-401 refresh; handle revocation; Super Admin visibility. Reuse existing AES-GCM secret store pattern. **[verify: scopes, token lifetimes, refresh rotation, test-mode OAuth, revocation event]** | Medium–High / **Low** (additive; no existing path changes) |
| **Restaurant Razorpay account connection (UX)** | ⛔ | Settings → Payments card: status (Not connected / Connected (test|live) / Needs reconnect), Connect, Disconnect; Super Admin read-only status; KYC/activation is the restaurant's job on Razorpay. | Medium / Low |
| **Restaurant checkout** | ⛔ | New `POST /orders/:id/pay` creates a Razorpay *Order* on the merchant's account using the server-computed `totalAmount` (never client amount); returns key + order id; web loads Razorpay Standard Checkout; success callback only triggers a *verify* call. Needs the **order-release decision** (below). | High / **High** |
| **Server-side payment verification** | ⛔ | Never trust the browser. On callback and on webhook: fetch the payment from Razorpay with the merchant token and require `status=captured`, matching `order_id`, `amount`, `currency`; also check the signature **[verify: how signature verification works for OAuth-connected accounts, since Pangat will not hold the merchant's key secret]**; then in one transaction mark `PAID`, issue the bill number, write audit, emit `order:paid`. | Medium / Medium |
| **Webhook processing** | 🟡→⛔ | Extend the existing ledger/idempotency pattern to a *second* endpoint for order payments (`payment.captured/failed`, `refund.processed/failed`, and the partner "authorization revoked" event if offered), mapping `account_id` → restaurant. Unknown account ids are recorded and ignored. **[verify: partner-level vs per-merchant webhook registration and secrets]** | Medium / Low–Medium |
| **Refunds and reconciliation** | ⛔ | Refund via Razorpay API for gateway-paid orders (amount ≤ captured − refunded, idempotent via Razorpay's receipt/notes + our key); status from `refund.processed`; nightly + on-demand reconciliation job that lists `order_payments` stuck in `CREATED/AUTHORIZED` and pulls their true state; outlet-level daily "gateway vs counter" tie-out in reports. Keep manual/cash refunds exactly as they are. | High / Medium |
| **Pangat subscription billing (Pangat's own merchant account)** | 🟡 | Webhook consumer exists. Missing: create Razorpay Subscription (or Payment Link for first cycle) from the owner's *Upgrade* button using `razorpay_plan_id`; persist `razorpay_subscription_id/customer_id`; success page; failed-payment dunning emails (templates exist); **GST invoice PDF** (Pangat's GSTIN, SAC from `sacCode`); sandbox end-to-end test; decide tax/E-invoice obligations with the CA. Uses Pangat's key id/secret (a different credential model from restaurant OAuth). | Medium–High / Low–Medium |

### 6.3 The one design decision that drives risk: when does the kitchen see an online-paid order?
Today an order is created, inventory is deducted, the table flips to PREPPING and the ticket hits the KDS **at creation**, before any payment. For gateway payments there are two models:
- **A. Fire first, pay after** (current behaviour; "UPI/online pending" badge on the ticket). Simple, no kitchen change; risk: kitchen makes food for unpaid abandoned checkouts and stock is already deducted.
- **B. Pay first, release on capture** (recommended for *online* method only): create the order as *awaiting payment* (hidden from KDS, no stock deduction, not counted in reports) and release it on verified capture; abandon after a TTL. Correct commercially, but touches `create`, inventory deduction, table status, KDS/admin listings, reports and cancellation. **High regression risk; needs a founder decision and a staging bake.**

Recommendation: ship **A** for pay-at-counter and manual UPI (unchanged), and implement **B** only for the new Razorpay method, behind a per-outlet setting, so existing flows are untouched.

### 6.4 Honest readiness statement
- Pilots **can** run without Razorpay, on counter + staff-confirmed UPI, after P0-1/P0-2/P0-8 are done.
- Razorpay restaurant checkout is **not** a small feature: it adds three tables, ~6 endpoints, a token lifecycle, a webhook, a reconciliation job and a kitchen-release policy, and its biggest dependency (partner approval, credentials, sandbox) is outside the code. It should start as soon as access exists, but it should not gate the first pilot unless the pilots demand online payment.
- Marketing: with a gateway, merchants may bear Razorpay's fees, which conflicts with "keep 100% of every bill" **[verify current fee schedule]**. Decide the wording before this ships.

---

## 7. Public claims versus implemented product

| Where | Claim | Reality | Action |
|---|---|---|---|
| Landing Pricing (`Pricing.tsx:39-42`) | ₹699/month, everything included, 7-day trial | Default plans: Starter ₹1,499, Growth ₹2,999, Enterprise ₹5,999 (+18% GST); default trial 14 days (`default-plans.ts`, `settings.registry.ts:38`). Production values unknown | Founders choose one truth; align plans/trial/copy (P0-6) |
| Pricing list | "Daily WhatsApp closing summary" | No WhatsApp or summary code exists. Same promise on the login page (`LoginPage.tsx:214`) | Remove, or deliver an *email* daily summary (P1-4) |
| Checkout (`CheckoutDrawer.tsx:587`) | "For digital WhatsApp receipt" | No receipt is sent | Reword to "so staff can reach you" |
| Pricing list / `index.html` | "Direct UPI settlement — keep 100%", "Instant UPI payments" | Payment goes to a UPI ID and is confirmed by hand; with a gateway, fees may apply | Reword now; revisit at Razorpay launch |
| Login page | "Kitchen chimes the moment an order is **paid**" | Chime fires at order **placement** (unpaid) | Reword |
| Pricing list | "Free on-site standee setup in Pune", "Direct WhatsApp line" | Operational promises, not product | Founders confirm they can honour them |
| Leads | "WhatsApp within 4 hours" | Nothing alerts anyone | Alerts (P0-5) |
| Plans | `ADVANCED_REPORTS` | Correctly hidden | Keep hidden |

---

## 8. Verification posture
- **Strong:** the existing suites are meaningful (they assert tenant refusals, entitlements, revocation, compliance, ledgers, idempotency) and were executed in Phase 1; unit suites re-run green today.
- **Gaps:** no CI for DB-backed tests; no browser E2E in CI; web `test:uat` never executed; Phase 1 UAT desktop-only; staging checklist not yet run on a real staging environment (Phase 1's own condition); the Razorpay webhook path has only synthetic signed fixtures; migration 017 rehearsed only on a synthetic copy; web lint red.

## 9. Questions only the founders can answer
1. Is `pangat@icici` a real UPI ID, and whose? Is `919890000000` the real support number?
2. Which plan prices and trial length are configured in **production** today (Super Admin → Subscriptions)? Which does the landing page reflect?
3. Which Render and Neon tiers are in use (sleep behaviour, connection and storage limits)? Is an email provider configured in production?
4. Do the first pilots require **online payment**, or are counter + staff-confirmed UPI acceptable? Will pilots use **delivery**?
5. Will pilot restaurants pay at all in the pilot period?
6. May the Razorpay Technology Partner reply be shared (OAuth scopes, token lifetime, webhook model, sandbox, fees)?
7. Who owns the menu data entry for each pilot (founders, or the restaurant)?

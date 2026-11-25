# Pangat — Phase 2 Roadmap (Pilot Readiness) — Revision 2

**Status:** proposal for founder approval for the P0/P1 engineering items below. **Revision 3 update:** the commercial workstream (PR-0B) has since been **implemented against the founders' approved four-plan strategy (Mini / Starter / Growth / Enterprise)**; it replaces the Starter/Growth/Group proposal that appeared in earlier drafts. See `PANGAT_COMMERCIAL_IMPLEMENTATION_REPORT.md`. The Phase 2 safety, payment and kitchen items (P0-1 … P0-10, P1-1 …) remain **proposals, not started**.
**Based on:** `PANGAT_PHASE2_PRODUCT_READINESS_AUDIT.md` (finding IDs `F-nn`), API `977c93a` / web `0beb1c8`.
**Commercial workstream (PR-0B):** `PANGAT_COMMERCIAL_PLAN_STRATEGY.md`, `PANGAT_PLAN_FEATURE_MATRIX.md`, `PANGAT_PRICING_AND_LIMITS.md`, `PANGAT_SUBSCRIPTION_LIFECYCLE_RULES.md`.
**Constraints honoured:** two founders, one developer, near-zero budget; existing stack only; no redesign of the entitlement engine, tenancy, Super Admin or subscription state machine without a demonstrated defect.
**No calendar estimates.** Complexity is relative (Low / Medium / High). *Regression risk* = chance of breaking something that works today.

### What changed in Revision 2 (summary)
1. New **PR-0B** commercial workstream, gating pricing claims and subscription billing.
2. Razorpay section corrected: the partner response **was received**; confirmed facts and open questions are separated (§3.1, G8).
3. **Sequencing contradiction resolved:** the minimum DB-backed CI and staging safety net (P0-7a) now comes **before** any change to order, payment or schema paths; an explicit interim mitigation covers the UPI risk meanwhile (§3).
4. **Refunds (and mark-paid) made atomic on the server**, with concurrency tests (new P0-10); stable client keys are no longer the only protection.
5. **Manual UPI claim** endpoint specified tightly (P0-8).
6. **UPI validation** reframed: format ≠ ownership; owner confirmation, clear destination display, controlled ₹1 verification, and an investigation of the hardcoded ID (P0-1).
7. **Alert notification policy** with recorded delivery attempts and failure visibility (P0-5).

---

## 1. Decisions needed (PR-0, no code)

| ID | Decision / fact | Recommendation |
|---|---|---|
| **G1** | Must pilots take **online payment** from day one? | **No**: counter + staff-confirmed UPI first. The quoted 2% + GST makes small-ticket adoption partial; Razorpay proceeds in parallel and does not gate the pilot |
| **G2** | One price story | Resolved by **PR-0B** (below). Interim: no new price published |
| **G3** | Delivery in the pilot? | Off unless a pilot needs it |
| **G4** | Self-service sign-up | Off for the pilot (setting) |
| **G5** | Is the Render API always-on? | Verify; upgrade only if it sleeps |
| **G6** | Kitchen release rule for online payments | Model B (pay first, release on verified capture) for the Razorpay method only, behind an outlet setting |
| **G7** | Who enters each pilot's menu? | Founders for pilots 1–2 |
| **G8** | **Razorpay partner response — RECEIVED.** Confirms the model (merchant of record, OAuth, direct settlement, no Route, own KYC, Partner Dashboard for test OAuth, 2% + GST, T+2). **Outstanding:** technical clarification (scopes, token lifetime/refresh, verification under OAuth, webhook model, fee detail, refunds, disputes, sandbox behaviour) and **Partner Dashboard / sandbox access**. Independent CA/legal confirmation is separate and still required | Send the open-questions list (Audit §6.0) and request Partner Dashboard access now |
| **G9** | Facts to establish | Does `pangat@icici` exist and who owns it? Has it received any payment? (P0-1 investigation) · real support number · production plan rows/trial length · Render/Neon tiers · email provider status |
| **G10** | PR-0B decisions C1–C15 | See §2 and the commercial documents |

---

## 2. PR-0B — Commercial plans (STATUS: implemented, awaiting founder approvals)

The approved structure (Mini ₹699/₹6,990, Starter ₹1,299/₹12,990, Growth ₹2,499/₹24,990, Enterprise from ₹4,999/₹49,990; limits 1/10/3, 1/25/8, 3/60/20, 5/100/40; 14-day trial; Founding 10) is built into the plan catalogue, migrations 018–019, Super Admin and the public site, with tests. Documents: `PANGAT_COMMERCIAL_PLAN_STRATEGY.md`, `PANGAT_PLAN_FEATURE_MATRIX.md`, `PANGAT_PRICING_AND_LIMITS.md`, `PANGAT_SUBSCRIPTION_LIFECYCLE_RULES.md`, `PANGAT_COMMERCIAL_IMPLEMENTATION_REPORT.md`.

**Still gated:** paid subscription collection (P1-2) until the CA reviews SAC/GST treatment, PDF invoices and credit notes and the Razorpay subscription integration is built; publication of the Founding 10 section; service commitments (priority support, dedicated contact, onboarding); production rollout (migrations auto-apply at boot, so staging rehearsal and the read-only pre-check come first).
**Already done (removed from this roadmap):** P0-6b final pricing copy (prices, GST wording, 14-day trial), P1-15 plan-management guards (sold-plan guard, subscriber counts), the Inventory-entitlement defect, sequential subscription invoice numbering, billing profile and place of supply. **Dropped:** P1-16 quarterly billing (not offered).

---|---|
| Target segments and positioning | Strategy §3 |
| Plan names and structure; is the current Starter/Growth/Enterprise sensible? | Strategy §2, §4 (verdict: not as published; Enterprise has no distinguishing feature; entry price too high versus the market and the landing page) |
| Monthly, quarterly, annual pricing | Pricing §1 (quarterly needs a small enum change) |
| Feature allocation (only what exists) | Feature Matrix §2, §4 |
| Outlet, table, staff, KDS limits | Pricing §2; Matrix §1 (no KDS-device limit exists or is proposed) |
| Add-ons and extra usage | Pricing §5 (none at launch; engine has no line items) |
| Trial duration and restrictions | Pricing §3, Lifecycle §2 |
| Upgrade/downgrade | Lifecycle §5 |
| Discounts, pilot pricing, promotions | Pricing §4, §6; Strategy §6 |
| Existing customers, grandfathering | Strategy §7; Lifecycle §8 (plan rows with subscribers are immutable) |
| GST presentation and invoice requirements | Pricing §8; Lifecycle §7 (today's invoice numbering and GST split are non-compliant; **gate for paid billing**) |
| Super Admin controls | Strategy §8; Pricing §9 (existing controls suffice; three optional small guards) |

**Gate (binding):** *Subscription billing (P1-2) and any published final price/plan claim require written founder approval of PR-0B.* P0-6 splits accordingly (interim removal of false claims now; final pricing copy only after approval).
**Does not change the architecture:** the matrix maps to existing plan keys, the three limits and plan rows. Features not built are not sold.
**Parallel:** PR-0B runs alongside PR-1…PR-8; it blocks only P0-6 (final copy) and P1-2.

---

## 3. Interim mitigation for the UPI destination (until P0-1 is verified)

**Fact (Audit F-01):** the diner UPI screen pays a hardcoded `pangat@icici`, reachable from **three** places (pending cards for pay-at-counter, COD and UPI orders). Turning off `payments.upi` in outlet settings only stops *new UPI_INSTANT orders*; it does **not** hide the other two entry points. The ID has been in the web code since 2026-10-27. Whether any real diner ever paid it is unknown.

| Step | Action | Code? | Applies when |
|---|---|---|---|
| **M1 (immediate, operational)** | No outlet with real diners is provisioned or demoed to the public until P0-1 is verified. For any outlet already visible to diners, set `payments.upi = false` and instruct staff to use counter payment. Founders check the investigation below | None | Now |
| **M2 (single permitted pre-safety-net hotfix; only if any real-diner exposure exists or cannot be ruled out)** | A minimal web-only change that **removes the three UPI-pay buttons and the QR dialog** behind one constant, leaving pay-at-counter intact. No API, no schema, no order/payment logic. Verified by a unit test and a manual check on a deployed preview. This is a *removal*, not a payment change, which is why it is allowed to precede P0-7a | Yes (tiny, web) | Only on founder decision |
| **Removal of the mitigation** | After P0-1 ships and the controlled verification passes for that outlet (below), UPI is enabled **per outlet** | — | Per outlet |

**Investigation of `pangat@icici` (read-only; to be done by a founder/DBA; I have not done it):**
1. Ask the issuing bank/UPI app of the Pangat business account whether this VPA exists and who holds it, and pull its statement from 2026-10-27 onward for credits carrying transaction references beginning `ORD-`.
2. Read-only database query on production: count orders with `payment_method = 'UPI_INSTANT'` or any order whose tracking page could have shown the UPI dialog (`payment_status = 'PENDING'`), by outlet and date, to size the exposure.
3. Check Netlify deploy history to see which builds containing the literal were live and when.
4. If any real customer payment reached a Pangat-held account, treat it as a customer-funds incident: reconcile, refund via the restaurant, and record it. If the ID is held by someone else, treat as a potential third-party payment incident and seek advice.
Do **not** assume ownership either way.

---

## 4. P0 — required before the first pilot

### P0-7a · Minimum viable safety net (FIRST; replaces the previous ordering)
| | |
|---|---|
| **Why first** | One developer changing money paths needs automated DB-backed proof and a rehearsal environment. The dependency document already required this; the old roadmap contradicted it |
| **Scope (MVP only)** | (1) **GitHub Actions job with a free Postgres service container**, building the API and running the existing DB-backed suites (`test:integration`, `test:phase1*`, `test:compliance`, `test:platform`) against a **freshly created database per run**, serially, with throttling off and test secrets (the suites already work this way locally; the schema is created by TypeORM sync plus migrations ≥ 009, exactly as in Phase 1). (2) **Staging**: a Neon branch of production (free), a second Render service or preview, a Netlify branch deploy. (3) Verify Render/Neon tiers, add an external uptime ping on `/health`, confirm Neon backup/PITR window, run the documented restore drill once. (4) A written rule: **every new migration is rehearsed up/down/up on a staging copy before merge** (`docs/staging/migration_017_check.sh` pattern) |
| **Not in MVP** | Baseline schema file and drift check (P0-7b), browser E2E in CI (P1-12), web lint gate |
| **Frontend / Backend / DB** | None to product code. CI and ops only |
| **Dependencies** | Someone with Neon access; GitHub Actions minutes (free) |
| **Testing** | CI green on a fresh DB; staging boots and passes the Phase 1 staging checklist's smoke steps |
| **Complexity / risk** | Medium / none to product (flaky-CI risk mitigated by serial runs on fresh DBs) |
| **Gate** | **No change to order, payment or schema paths merges until P0-7a is green** (the single exception is M2 above) |

### P0-10 · Atomic payment-state transitions and server-side idempotency (F-36) — NEW
| | |
|---|---|
| **Business justification** | Money and legal documents must not be duplicated by double-clicks, retries, two cashiers, or (later) a webhook racing a cashier. The UI cannot be the only defence |
| **Current status** | 🔧 By code reading: `processRefund` and `markPaid` read the order before the transaction, take no lock, and the refund idempotency lookup is outside the transaction. Two simultaneous identical requests can both pass |
| **Backend design** | **(a) Lock then decide.** In one transaction, first lock the order row (`SELECT … FROM orders WHERE id=$1 FOR NO KEY UPDATE`, a plain query, because the eager-loaded `items` outer join cannot be locked, and consistent with the lock mode already used in Phase 1), then re-read the order *under the lock* and apply every rule (status, remaining refundable amount, already paid) to the locked state. **(b) Idempotency as a database constraint, not a lookup.** New table `order_refunds` with `UNIQUE (order_id, idempotency_key)`; the first statement inside the transaction inserts the refund row with `ON CONFLICT DO NOTHING`; if it conflicts, return the stored result (replay) and write nothing else. Store a hash of the request so the **same key with a different amount/method/reason returns a 409**, not a silent replay. **(c) One bill per order enforced by the database:** partial unique index `ON tax_documents(order_id) WHERE kind='BILL'` (after a read-only check that no duplicates exist in production), and `mark-paid` re-reads under the lock so the second caller sees `PAID` and returns the first result. **(d) Credit note and bill issuance stay in the same transaction** as the state change and audit record (as today), so a rolled-back request consumes no serial. **(e)** A `CHECK (refund_amount <= total_amount)` on `orders` as a last line of defence |
| **Frontend** | Unchanged beyond P0-2 (stable key per dialog open). Show "already processed" results as success |
| **Database** | `order_refunds` (one row per refund; `order_payment_id` nullable so manual refunds and later gateway refunds share it), unique indexes above. Additive, rehearsed on staging; existing refunds need no backfill (the audit trail remains the historical record) |
| **Dependencies** | **P0-7a** (needs a real Postgres to test concurrency) |
| **Concurrency tests (mandatory, run against Postgres in CI)** | (1) **N=10 identical refund requests in parallel (`Promise.all`)** → exactly **1** `order_refunds` row, **1** credit note, **1** audit row, `refund_amount` increased once, every caller gets the same successful result. (2) Same key, **different amount** → one succeeds, the rest get 409. (3) **10 different keys** each refunding more than a tenth of the total → the **sum never exceeds the total**; later ones are rejected. (4) Refund racing a second refund on a different outlet's order → independent. (5) **10 parallel `mark-paid`** → one `BILL` document, one serial consumed, one `order:paid` event. (6) `mark-paid` racing `cancel` → one consistent outcome. (7) A transaction that fails after issuing a number consumes no serial (rollback test). (8) Mutation check: remove the lock or the unique constraint on a throw-away copy and prove tests 1, 3 and 5 fail |
| **Complexity / risk** | Medium / **Medium** (touches `orders.service` money paths; mitigated by P0-7a, tests above and a staging bake) |

### P0-1 · Correct UPI payee, VPA ownership confirmation and controlled verification (F-01, F-02)
| | |
|---|---|
| **Business justification** | Money must reach the restaurant. A format check is not proof of ownership |
| **Current status** | 🎭 Hardcoded `pangat@icici`; three entry points; provisioning prefills a fake `<slug>@icici`; DTOs accept any string |
| **Frontend** | Use the **outlet's own** `upiVpa` and name; **show the destination clearly** to the diner before the QR ("Pay to: *Restaurant name*, `vpa@bank`"; tell them to check the name their UPI app shows matches); add the order reference as the transaction note; hide every UPI payment surface unless the outlet has a **confirmed** VPA; remove the fake prefill; owner Settings gets a **"I confirm this UPI ID belongs to my business and receives my payments"** step |
| **Backend** | Apply the same UPI format validator to provision and onboard DTOs; return `{vpa, payeeName, confirmed}` in the tracking payload; **refuse UPI_INSTANT orders unless the VPA is owner-confirmed** (server-enforced, like the existing `payments.upi` switch); changing the VPA clears the confirmation; confirmation is owner-only and audited |
| **Database** | `restaurants.upi_vpa_confirmed_at timestamptz NULL`, `upi_vpa_confirmed_by uuid NULL` (additive). Existing outlets start **unconfirmed** |
| **Validation honesty** | The regex proves shape only. Ownership is established by (1) owner attestation, (2) **a controlled verification in pilot UAT per outlet:** a ₹1 payment from a founder's phone to that outlet's VPA, owner confirms the credit and the transaction reference in their own UPI/bank app, result recorded on the UAT checklist **before UPI is enabled for that outlet**; the ₹1 is returned manually |
| **Dependencies** | P0-7a; the investigation in §3; for the migration, a staging rehearsal |
| **Testing** | Unit: URI builder (payee, amount, note, encoding), no UI when unconfirmed. API: DTO rejects malformed; UPI_INSTANT refused when unconfirmed; tracking payload shows only the order's own outlet VPA; VPA change resets confirmation. Manual: the controlled payment |
| **Complexity / risk** | Low–Medium / Low–Medium |

### P0-2 · Stable client idempotency keys (F-03)
Create the key once per checkout session, reuse until success or cart change; same for walk-in orders and per refund-dialog open. **Defence in depth only:** server atomicity is P0-10 (refunds, mark-paid) and the existing unique key on orders. Tests: unit (stable across retry, new after success); e2e (timeout then retry → one order). Complexity Low · Risk Low. Depends on P0-7a (merge gate).

### P0-3 · Kitchen and live-screen reliability (F-04, F-05, F-35)
Unchanged in scope: refetch on socket reconnect / visibility / online; 30–60 s safety poll; **real** Screen Wake Lock with re-acquire; "tap to enable sound"; Live/Reconnecting/Offline indicator; merge by order id. No backend change. Tests: unit (merge), Playwright (drop and restore socket), real tablets. Complexity Medium · Risk Low–Medium.

### P0-4 · Staff order entry that never fails silently (F-07)
Minimum: surface server errors, keep the dialog open, remove the `'pangat'` slug fallback, stable key, takeaway and payment-method choice. Full: modifiers/notes by reusing the diner customization drawer; optional staff-authenticated order route that reuses `OrdersService.create` (never a second copy of the validation) and does not consume the public flood limiter. Complexity Low→Medium · Risk Low→Medium.

### P0-5 · Pilot onboarding completeness and **alert policy** (F-08, F-09, F-10, F-14, F-38)
| | |
|---|---|
| **Onboarding** | Optional `kitchenPin` on provision; `GET /restaurants/:id/readiness` and an owner **go-live checklist** (menu item, tables, **confirmed UPI ID**, kitchen PIN, staff, test order); support number from a platform setting; `selfSignupEnabled=false` for the pilot (setting) |
| **Notification policy** | See table below |
| **Database** | `platform_event_deliveries` (below) |
| **Dependencies** | P0-7a; an email provider (Brevo); founders' alert addresses |
| **Testing** | Event created once per trigger; duplicate suppression within the window; provider failure recorded with attempts and error; retry succeeds on recovery; digest after the burst threshold; Super Admin shows failures; no provider → in-app only plus visible warning; provisioning with and without PIN (old payload still works) |
| **Complexity / risk** | Medium / Low–Medium |

**Alert policy (leads, support tickets, plan-change requests)**

| Event | Trigger | Severity | Channels | Recipients | De-duplication | Reminder |
|---|---|---|---|---|---|---|
| `LEAD_CREATED` | Landing form saved | INFO (action needed) | In-app + email | `notifications.alertEmails` | Same phone or restaurant name within 24 h = update the existing event, no second email | One reminder if not acknowledged after 4 hours (the landing page promises contact within 4 hours) |
| `SUPPORT_TICKET` | Merchant ticket created | by ticket priority (URGENT → CRITICAL) | In-app + email for **all** priorities | Alert emails | One email per ticket; replies by the restaurant on an open ticket batched per 15 min | URGENT: reminder after 1 hour unacknowledged |
| `PLAN_CHANGE_REQUESTED` | Owner requests a plan (also creates a support ticket, P1-9) | INFO | In-app + email | Alert emails | One per organisation per 6 hours | Included in the ticket reminders |
| Burst protection | More than 5 alert emails in 10 minutes to one recipient | — | One digest email, individual items stay in-app | — | — | — |

**Recording and visibility (no silent discards).** Every email attempt writes a row to `platform_event_deliveries` (event, channel, recipient, status `SENT`/`FAILED`/`SKIPPED_NO_PROVIDER`, attempt count, last error, provider message id, timestamps). Failed attempts are **retried up to 3 times with back-off** (1 min, 5 min, 30 min) by the existing in-process job runner (which already records runs). After the final failure the event is marked **delivery-failed**; the Super Admin bell and the Monitoring page show a **red "Alert emails failing" indicator** with the error and a **Retry** button; and if no email provider is configured the console shows a persistent banner instead of pretending alerts are being sent. Rate cap per recipient per hour prevents floods. In-app events are always stored regardless of email outcome.

### P0-8 · Honest manual-UPI flow and the **payment-claimed** endpoint (F-06, F-17, F-37)
**Principle: a diner's "I've paid" is a *claim*, not proof of payment.** It only tells the cashier where to look. Only staff pressing *Mark paid* (existing, now atomic by P0-10) changes `payment_status`.

| Requirement | Specification |
|---|---|
| Credential | Requires the **order's tracking token**, compared in constant time. The token is sent in the **request body**, never in the query string or path, so it is not written to access logs, and **no CORS header change** is needed. Missing/incorrect token → 404 (no existence leak) |
| Rate limiting | Per-IP throttle (e.g. 10/min) **and** a per-order cap (one claim per order, ever, plus at most a few attempts) |
| Idempotent | Repeating the call returns the same result with the original `payment_claimed_at`; no second event, no second audit row |
| Eligible orders only | Order exists and belongs to the token; `payment_method = UPI_INSTANT` (and COD/counter excluded); `payment_status = PENDING`; not cancelled; not completed; created within the last N hours; outlet UPI confirmed |
| Never confirms payment | Does **not** set `PAID`, does **not** set `settled_at`, does **not** issue a bill number or call `markPaid`/`issueBillNumber`, does **not** emit `order:paid`, does not touch inventory, table status or reports |
| Staff notification | Sets `orders.payment_claimed_at` and emits `order:updated` to the **admin room** for that outlet only (and the diner's own order room). The kitchen room receives the **redacted** view and `paymentClaimedAt` must be added to the kitchen redaction list (`KITCHEN_HIDDEN`, a deny-list, so a new money-adjacent field would otherwise leak to the kitchen tablet) |
| Audit | One `PAYMENT_CLAIMED` audit row with no staff actor (the audit table allows a null actor), recording IP and request id |
| Logging hygiene | Redact `token` query parameters in the error filter, `reportServerError` and request logs (**prerequisite**, small, covers the existing GET routes too); the claim route has nothing sensitive in the URL |
| UI wording | Diner: "Tell the cashier you've paid. They will confirm once the money reaches the restaurant." Admin: a distinct badge **"Customer says paid (unverified)"** with a one-tap *Confirm received* that is the existing mark-paid; never green/"Paid" until confirmed |
| Database | `orders.payment_claimed_at timestamptz NULL` (additive) |
| Tests | Wrong/missing token; another order's token; ineligible states (PAID, cancelled, COD); idempotent repeat; throttle; **assert `payment_status`, `bill_number`, `settled_at` unchanged**; no `order:paid` emitted; admin room receives the update and the kitchen room does not expose the field; token never appears in captured logs |
| Dependencies | P0-7a, P0-1, P0-10, log redaction. Skipped entirely if Razorpay checkout is in place before the pilot (G1) |
| Complexity / risk | Medium / Low–Medium |
Also in this item: rename "UPI Instant" to "Pay by UPI (cashier confirms)" and the refund option "Verified Provider Gateway Refund" to "Refunded manually (UPI/bank/cash)".

### P0-6 · Truthful claims (split) (F-12, F-13)
- **P0-6a (now, interim):** remove or soften claims that are false today (WhatsApp summary/receipt, "kitchen chimes when paid", "instant UPI", "keep 100%"), reword to "0% commission from Pangat; Razorpay's standard charges apply to online payments" **only when online payment exists**. Do **not** state any new price.
- **P0-6b (after PR-0B approval):** final price/plan/trial copy generated from `PANGAT_PRICING_AND_LIMITS.md`, with GST wording; plan rows configured in Super Admin (data). Complexity Low · Risk Low.

### P0-7b · Baseline schema and drift check (F-20)
Schema-only dump of production reviewed into `000_baseline.sql` (documentation/rebuild artefact; never run on production), plus a CI check that a database built from the baseline and migrations equals the entity-synchronised schema. Needs a person with production access. Complexity Medium · Risk none to product. Not a blocker for P0-10 (migrations are rehearsed on a staging copy) but required before the pilot.

### P0-9 · Staging UAT on real devices (go/no-go)
 run the Phase 1 staging checklist; Android Chrome, iPhone Safari, a kitchen tablet; print and scan a QR in low light; **controlled ₹1 UPI verification per outlet (P0-1)**; two-hour kitchen soak with screen lock and Wi-Fi drops; claim flow end to end; concurrency suite green in CI; alert delivery including a forced email failure; **P0 exit criteria** below.

**P0 exit criteria:** CI (incl. DB suites and concurrency tests) green; staging checklist passed; per-outlet VPA ownership verified with a real ₹1 payment; kitchen soak without a missed order; founders provision a dummy restaurant from a lead using only the checklist; alerts demonstrably delivered and failure visible; claims reviewed; **PR-0B decided** (at least the pilot terms and what is advertised).

---

## 5. P1 — after (and alongside) the first pilot

| ID | Item | Gate / dependency | Complexity | Regression risk |
|---|---|---|---|---|
| **P1-1** | **Razorpay for restaurants** (OAuth connect → pay → refund → reconcile → live pilot; 1A–1E) | Partner Dashboard access and the **[Open]** answers (Audit §6.0); P0-7a, P0-10; G6. Merchant-of-record model, direct settlement, 2% + GST borne by the restaurant. Pangat takes no cut unless founders decide otherwise | **High** | **High**, mitigated by new-method-only gating |
| **P1-2** | **Pangat subscription billing** on Pangat's own Razorpay merchant account (separate integration) | **PR-0B approved**; fix **F-40** first (sequential invoice numbers within the statutory limit, buyer state/GSTIN billing profile, PDF, manual-payment invoices, credit notes); CA input; sandbox | Medium–High | Low–Medium |
| P1-3 | Menu CSV import, then photos | G7 | Medium | Low–Medium |
| P1-4 | Notifications (web push; daily summary **email**) | P1-6 | Medium | Low |
| P1-5 | Reports v2 (CSV, cashier close-out, multi-outlet roll-up) | PR-0B allocation | Medium | Low |
| P1-6 | PWA / kiosk hardening | — | Low–Medium | Low–Medium |
| P1-7 | Order-abuse controls | G6 | Medium | Medium |
| P1-8 | Delivery configuration | G3 | Low–Medium | Medium |
| P1-9 | Plan-change request → support ticket (alert policy already in P0-5) | P0-5 | Low | Low |
| P1-10 | Order-create hardening and guard performance | metrics | Medium | **High** |
| P1-11 | Observability (DB health, error tracking, phone alerting) | G5 | Low–Medium | Low |
| P1-12 | Browser E2E in CI | P0-7a | Medium | none |
| P1-13 | Web hygiene (lint gate, dead `OnboardingPage`) | — | Low–Medium | Low |
| P1-14 | Hygiene bundle (GET writes, public table status, API host fallback) | — | Low | Low |
| **P1-15** | **Optional plan-management guards** (subscriber count and warning; duplicate plan; block price/limit edits on sold plans) | PR-0B approval | Low | Low |
| **P1-16** | **Quarterly interval** (enum value + period arithmetic) | PR-0B decision C15; ships with P1-2 | Low–Medium | Low–Medium |
| **P1-17** | **Move tracking token off URLs** (header or body for GET-equivalent reads) | P0-8 redaction done first | Medium | Medium |

P1-1 splits (each behind a flag, releasable alone): **1A Connect** (OAuth start/callback, encrypted tokens via the existing AES-GCM store, refresh, revocation, status) → **1B Pay** (order create from server total, verify by fetching the payment, webhook, `order_payments`, release rule) → **1C Refund** (reuses `order_refunds` and credit-note logic) → **1D Reconcile** → **1E Live** (one pilot, small amounts, daily tie-out).

## 6. P2 — later
As before: advanced reports, item-level tax/discounts/coupons, split bills and tips, call-waiter, order-ahead, reservations, Hindi/Marathi, loyalty, aggregator and Tally integrations, thermal printing, recipe costing and supplier POs, native apps, WhatsApp Business API (paid), multi-instance scale-out, SSO, cookie-based sessions, accessibility audit, lawyer/CA sign-offs before scale, add-ons and metered billing (needs a line-item engine).

---

## 7. Recommended implementation sequence (revised)

Rule: **P0-7a first.** No change to order, payment or schema paths merges before it, except M2.

| Phase | Contents | Repo(s) | Gate |
|---|---|---|---|
| **PR-0** | Decisions G1–G10; investigation of `pangat@icici` (§3); send Razorpay open questions; request Partner Dashboard access | none | Founder answers |
| **PR-0B** | Commercial workstream: founders review the four commercial documents, validate with 8–10 prospects, approve or amend (runs in parallel with PR-1…) | docs | Written approval (blocks P0-6b, P1-2, any published price) |
| **M1 / M2** | Interim UPI mitigation (§3) | none / tiny web | M2 only on founder decision |
| **PR-1** | **P0-7a safety net MVP** | CI + ops | CI green on a fresh DB; staging up |
| **PR-2** | **P0-10 atomic refund / mark-paid + concurrency tests** (migration 018) | API | Concurrency tests and mutation checks pass; staging rehearsal of the migration |
| **PR-3** | **P0-1 UPI correction + VPA confirmation** (migration 019) and **P0-2 stable keys**, plus **P0-6a interim copy** (three small PRs) | web + API | Unit/e2e green; M1/M2 lifted per outlet only after the ₹1 verification |
| **PR-4** | **P0-3 kitchen reliability** | web | Tablet soak passes |
| **PR-5** | **P0-4 staff entry** (minimum, then full) | web (+ API route) | E2E passes |
| **PR-6** | **Log redaction, then P0-8 manual UPI claim** (migration 020) | API + web | Claim tests incl. unchanged `payment_status` and token-not-in-logs |
| **PR-7** | **P0-5 onboarding completeness + alert policy** (migration 021) | API + web | Dummy restaurant provisioned from a lead via the checklist; forced email failure visible and retried |
| **PR-8** | **P0-7b baseline + drift check**; **P0-6b final copy** (needs PR-0B approval) | API + web | Fresh DB equals synchronised schema |
| **PR-9** | **P0-9 staging UAT and go/no-go** | none | **Pilot go/no-go** |
| *Pilot (1–2 restaurants).* Then, in this order: | | | |
| **PR-10** | P1-9, P1-14, P1-15 (small) | API + web | — |
| **PR-11** | P1-3 CSV import | API + web | — |
| **PR-12…16** | P1-1A → 1B → 1C → 1D → 1E (as soon as Partner Dashboard access and answers exist; 1A may begin during PR-4…PR-9 in a flag-gated branch **only after PR-2**) | API + web | Sandbox end to end |
| **PR-17** | **Fix F-40, then P1-2 (+ P1-16) subscription billing** | API + web | PR-0B approved; CA review of the invoice |
| **PR-18+** | P1-5, P1-4 + P1-6, P1-7, P1-11, P1-12, P1-13, P1-17, P1-10 | — | Pilot feedback |

**Why this order:** safety net first (it protects everything after it); the legal-document and money atomicity fix next (it underlies refunds, manual UPI and later gateway payments); then the correctness of the payment destination; then kitchen and staff reliability; then the claim flow and operations; then truth in public copy; then proof on real devices.

---

## 8. Spend
Unchanged: only a non-sleeping Render instance is justified, and only if G5 shows the current one sleeps. CI, staging branch, email, push and storage use free tiers. Razorpay's 2% + GST is paid by restaurants, not by Pangat.

## 9. Not recommended now
Rebuilding Super Admin, the entitlement engine or tenancy; coupons/add-on engine; a second gateway; native apps; microservices; a redesign.

## 10. Approval requested
Please confirm: (a) the PR-0B documents (or amend them); (b) G1–G10, especially M2 yes/no; (c) the revised P0 list and sequence; (d) permission to start **PR-1 only**. I will not begin implementation until you approve.

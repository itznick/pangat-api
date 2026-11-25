# Pangat — Phase 2 Technical Dependencies — Revision 2

**Status:** proposal, with one update. **Revision 3:** migrations **018** (commercial plan catalogue) and **019** (billing profile, invoice series) now exist in the API repository and are tested locally, but are **not applied to any shared or production database**. Because the commercial work took migration numbers 018 and 019, the Phase 2 proposals below that were numbered 018–021 shift to **020 and later**. Everything else marked *proposed* is design only.
**Companions:** Audit (`F-nn`), Roadmap (`P0-n`, `P1-n`, phases `PR-n`), and the PR-0B commercial documents.
**Baseline:** API `977c93a`, web `0beb1c8`.

---

## 1. Dependency map (corrected)

```
PR-0 decisions, investigation of pangat@icici, Razorpay open questions + Partner Dashboard access
PR-0B commercial approval  (parallel; blocks P0-6b, P1-2, any published price)

M1 operational mitigation (now)      M2 tiny web-only UPI-button removal (only if real-diner exposure possible)
                                │
                                ▼
 P0-7a  SAFETY NET MVP (CI with Postgres + staging)   ◄── GATE: nothing below merges before this is green
                                │
          ┌─────────────────────┼───────────────────────────────┐
          ▼                     ▼                               ▼
 P0-10 atomic refund /     P0-3 kitchen reliability       P0-5 onboarding + alert policy
 mark-paid + concurrency   (web only)                      (needs email provider)
 (migration 018)
          │
          ├─► P0-1 UPI payee + VPA confirmation (migration 019) ─► P0-8 claim endpoint (migration 020, log redaction first)
          ├─► P0-2 stable keys (web)  ─► P0-4 staff entry
          │
          ▼
 P0-7b baseline + drift check ─► P0-6b final copy (needs PR-0B) ─► P0-9 STAGING UAT ─► PILOT GO / NO-GO

Razorpay for restaurants (P1-1) — needs: P0-7a, P0-10, G6, Partner Dashboard access, [Open] answers
   1A Connect ─► 1B Pay ─► 1C Refund ─► 1D Reconcile ─► 1E Live pilot
Pangat subscription billing (P1-2) — needs: PR-0B approval, F-40 fixes, CA input, Pangat's own Razorpay account
   (separate integration from restaurant OAuth; different credentials, different webhook)
P1-6 PWA ─► P1-4 push ;  P0-5 ─► P1-9 ;  G7 ─► P1-3 ;  P0-8 redaction ─► P1-17
```
**Hard rules**
1. **P0-7a precedes every change to order, payment or schema paths.** The only exception is M2: a removal of UI buttons, no API/schema/logic, verified on a preview.
2. P0-10 precedes P0-8 (claims rely on atomic mark-paid) and any gateway work (a webhook will race a cashier).
3. Every migration is rehearsed **up/down/up on a staging copy of production** before merge (the `docs/staging/migration_017_check.sh` pattern).
4. P1-2 does not start before PR-0B approval **and** the F-40 invoice fixes are designed.

---

## 2. External dependencies

| Dependency | Needed for | Status | Notes |
|---|---|---|---|
| **Razorpay Technology Partner response** | P1-1 design | **Received.** Confirms model (§8.1) | Technical answers still **[Open]** (§8.2) |
| **Razorpay Partner Dashboard access** | Building and testing OAuth in test mode | **Outstanding (required)** | Without it P1-1 cannot be built or verified |
| Razorpay sandbox behaviour for orders, payments, refunds, webhooks via OAuth | P1-1B…1D | **[Open]** | Partner Dashboard access is confirmed as required for the OAuth test flow; the rest is unconfirmed |
| Restaurants' own active Razorpay accounts, KYC and activation | P1-1E | Restaurant's responsibility **[Confirmed]** | A pilot restaurant may not be ready; counter/UPI path remains |
| Pangat's own Razorpay merchant account, plan ids, webhook | P1-2 | Separate integration **[Confirmed]** | Different credentials and webhook from restaurant OAuth |
| CA: GST registration, SAC, invoice format, place of supply, refund/credit-note policy | P1-2, PR-0B | Pending | Also confirms any regulatory obligations; the Razorpay model does not by itself remove them |
| Legal: terms with restaurants, privacy for payment data, advertising/pricing claims | Before P0-6b and P1-1E | Pending | |
| Brevo or SMTP: verified sender (ideally SPF/DKIM) | P0-5 alerts, welcome links, OTP | Production status unknown | Alerts are only as reliable as this; failure must be visible (P0-5) |
| Render API tier (always-on) | P0-7a, jobs, sockets, retries of alerts | Unknown (G5) | Alert retries and sweeps run in-process |
| Neon plan limits, branching, PITR | P0-7a staging, backups | Unknown | |
| GitHub Actions with a Postgres service container | P0-7a | Free | |
| Real devices (Android, iPhone, kitchen tablet) | P0-3, P0-9 | Founders' hardware | |
| A person with production DB access | P0-7b dump; read-only exposure queries (§3 of roadmap); duplicate-bill check before the unique index | Founder/DBA | I have not accessed any database |
| Founders' bank/UPI statements | `pangat@icici` investigation | Founders | Do not assume ownership |

---

## 3. Proposed database changes (none applied)

Rules: numbered, additive, idempotent, one transaction, auto-applied from 009+ under the advisory lock, `.down.sql` that never drops data-bearing columns, rehearsed on staging. Next number is **018**. Order below follows the roadmap sequence.

| # | Migration | Change | Roadmap | Safety notes |
|---|---|---|---|---|
| — | `000_baseline.sql` (documentation/rebuild artefact; **never run on production**; runner starts at 009) | Reviewed schema-only dump of core tables | P0-7b | CI drift check |
| **018** | `018_atomic_refunds.sql` | `order_refunds` table; `UNIQUE (order_id, idempotency_key)`; partial unique index `uq_tax_documents_bill_per_order ON tax_documents(order_id) WHERE kind='BILL'`; `CHECK (refund_amount <= total_amount)` on `orders` | P0-10 | **Pre-check (read-only, human):** no existing duplicate BILL rows per order and no order violating the CHECK; the migration must be written to fail safely (not create the index) and report if duplicates exist. Existing refunds are not backfilled |
| **019** | `019_upi_vpa_confirmation.sql` | `restaurants.upi_vpa_confirmed_at timestamptz`, `upi_vpa_confirmed_by uuid` | P0-1 | Existing outlets default **unconfirmed** (UPI stays off for them until confirmed: intended) |
| **020** | `020_payment_claim.sql` | `orders.payment_claimed_at timestamptz` | P0-8 | Nullable, no default; add to kitchen redaction list in code |
| **021** | `021_alert_deliveries.sql` | `platform_event_deliveries` (below); optional `platform_events.ack_reminder_sent_at` | P0-5 | Retention via the existing log-retention job |
| (opt.) | `022_go_live.sql` | `restaurants.qr_kit_opened_at timestamptz` | P0-5 | Only if the checklist should remember it |

**Proposed DDL, P0-10 (sketch)**
```sql
CREATE TABLE IF NOT EXISTS order_refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           varchar(20) NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_payment_id   uuid NULL,                         -- NULL for manual (cash/UPI/bank) refunds; set for gateway refunds later (FK added with P1-1)
  idempotency_key    varchar(100) NOT NULL,
  request_hash       char(64) NOT NULL,                 -- same key + different payload => 409, never a silent replay
  method             varchar(20) NOT NULL,              -- COUNTER_CASH | MANUAL | GATEWAY
  amount             numeric(10,2) NOT NULL CHECK (amount > 0),
  reason             text NOT NULL,
  credit_note_number varchar(32),
  provider_refund_id varchar(100) UNIQUE,               -- gateway refunds
  status             varchar(20) NOT NULL DEFAULT 'SETTLED',  -- SETTLED | PENDING | FAILED
  requested_by       uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, idempotency_key)
);
```
**Proposed DDL, P0-5 alert deliveries (sketch)**
```sql
CREATE TABLE IF NOT EXISTS platform_event_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES platform_events(id) ON DELETE CASCADE,
  channel         varchar(10) NOT NULL DEFAULT 'EMAIL',
  recipient       varchar(180) NOT NULL,
  status          varchar(24) NOT NULL,   -- PENDING | SENT | FAILED | SKIPPED_NO_PROVIDER | SUPPRESSED_DUPLICATE | DIGESTED
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  provider_message_id varchar(150),
  next_retry_at   timestamptz,
  last_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ped_pending ON platform_event_deliveries (status, next_retry_at) WHERE status IN ('PENDING','FAILED');
```

### 3.1 Razorpay for restaurants (P1-1; refined after the open answers)
`restaurant_payment_accounts` (encrypted OAuth tokens, merchant/account id, mode, status), `order_payments` (many attempts per order; integer paise; unique provider order and payment ids; `verified_at` set only after server-side verification), and `order_refunds.order_payment_id` foreign key. `orders.released_to_kitchen boolean NOT NULL DEFAULT true` (preferred over a new status value) for model B. Webhook ledger reuses `webhook_events`. DDL as in Revision 1 of this document, adjusted so `order_refunds` is the one refund table for manual **and** gateway refunds.

### 3.2 Commercial / billing changes (implemented in Revision 3; see Implementation Report)
| Change | State |
|---|---|
| `018_commercial_plans.sql` (+ down): 17 new plan rows (4 plans × monthly/annual, `PANGAT_TRIAL`, 8 Founding rows); hides the six historical public plans once, recording previous visibility in `plan_visibility_backfills` | Implemented, tested, **not applied to production** |
| `019_billing_profile_invoice_series.sql` (+ down): four nullable billing columns on `organizations`; `subscription_invoice_sequences` | Implemented, tested, **not applied to production** |
| Quarterly interval | **Dropped** (not offered) |
| Subscription invoice PDF, credit notes for subscription refunds, SAC value | Pending (CA / build) |
| `menu_items.image_url` widen; `push_subscriptions`; `tables.session_secret` | Later |

---|---|---|
| Plan **data** rows (public Starter/Growth/Group, `TRIAL`, founding rows), `subscription.defaultTrialPlanCode`, trial days | Commercial plan | PR-0B (data, no migration) |
| Allow a `QUARTERLY` interval: code enum change, plus DDL **only if** the production column is a Postgres enum. Migration 005 created `billing_interval` as `VARCHAR(20)`, while TypeORM-synchronised databases get an enum; **check the real production column type first** | Quarterly pricing | P1-16 |
| Billing profile on `organizations`: legal name, address, `billing_state_code`, `billing_gstin` | Place of supply and invoice recipient | P1-2 / F-40 |
| `subscription_invoice_sequences(fiscal_year PK, last_value)` and an invoice-number function replacing the timestamp-random generator; character limit 16 | Consecutive serials (F-40) | P1-2 |
| `subscription_invoices.pdf_key` (optional) and subscription credit notes | Documents | P1-2 |
| `menu_items.image_url` widen; `push_subscriptions`; `tables.session_secret` | P1-3 / P1-4 / P1-7 | later |

---

## 4. Proposed API surface (not implemented)

| Endpoint | Auth | Item |
|---|---|---|
| `POST /orders/:id/refund` (existing) | owner/manager | **Re-implemented atomically** in P0-10 (lock, unique key, replay, 409 on payload mismatch) |
| `PATCH /orders/:id/mark-paid` (existing) | cashier+ | Atomic re-read under lock; one bill per order |
| `POST /restaurants/:id/upi/confirm` | owner | P0-1 |
| `POST /orders/:id/payment-claimed` body `{ token }` (token never in URL), throttled, idempotent, eligible orders only, never marks paid | tracking token | P0-8 |
| `GET /restaurants/:id/readiness` | owner/manager | P0-5 |
| `POST /admin/provision` + optional `kitchenPin` | platform admin | P0-5 |
| Super Admin: alert deliveries list, retry, failure indicator | platform admin | P0-5 |
| `GET/POST /payments/connect/*`, `POST /orders/:id/pay`, `POST /orders/:id/pay/verify`, `POST /payments/webhook/razorpay` | per P1-1 | P1-1 |
| `POST /subscriptions/checkout` (Pangat's own account) | owner | P1-2 |

Payment endpoint rules (all): amount recomputed from the stored order; payment verified by fetching it from Razorpay with the merchant's token (and signature where applicable) **before** any state change; state change + bill number + audit + socket emit in **one** transaction; credentials never in URLs or logs.

---

## 5. Configuration and secrets (proposed)

| Name | Where | Item |
|---|---|---|
| `notifications.emailAlerts=true`, `notifications.alertEmails`, event toggles (`notifications.event.<TYPE>`) | Super Admin settings | P0-5 |
| New: alert burst threshold, retry schedule, reminder hours, hourly email cap | settings registry | P0-5 |
| `general.selfSignupEnabled=false` | setting | P0-5 |
| `support.whatsapp` | setting | P0-5 |
| Outlet `payments.upi` (existing), **UPI confirmation** (new column) | outlet | P0-1 |
| `subscription.defaultTrialDays`, `subscription.defaultTrialPlanCode`, `subscription.gracePeriodDays`, `billing.supplierStateCode`, `billing.invoicePrefix` | settings (existing) | PR-0B |
| Partner OAuth client id/secret, redirect URI; partner/merchant webhook secret | encrypted platform settings | P1-1 |
| `PLATFORM_SETTINGS_KEY` set explicitly **before** storing OAuth tokens | env | P1-1A |
| Pangat's own Razorpay key id/secret and webhook secret | encrypted platform settings | P1-2 |
| VAPID keys | env | P1-4 |

---

## 6. Test strategy and regression map

### 6.1 Protection today
Tenancy/roles: `authorization`, `phase1-final-role-isolation`, `integration.e2e`, `security-integration.test.ts` (17). Entitlements and revocation: `phase1-entitlements.e2e` (36), `phase1-1-*`, `phase1-2-*` (28), `subscriptions.test`. Orders and inventory: `order-lifecycle`, `order-types`, `inventory`, `recipes-deductions`, `qa-remediation`. Compliance: `compliance.e2e` (14), `billing`, `privacy`, `audit`. Platform: `platform-control.e2e` (43, fresh DB). Web: 51 unit tests. **Only the unit suites currently run in CI** (re-run for this audit: API 266/266, web 51/51).

### 6.2 New tests per phase
| Phase | Tests |
|---|---|
| PR-1 | CI job itself: DB suites on a fresh database each run, serial; staging smoke |
| **PR-2 (P0-10)** | **Concurrency suite (Postgres):** 10 identical parallel refunds → 1 refund / 1 credit note / 1 audit; same key different payload → 409; 10 distinct keys cannot exceed the total; 10 parallel mark-paid → 1 bill document and one serial; mark-paid vs cancel; rollback consumes no serial; **mutation checks** (drop the lock/unique constraint → tests fail) |
| PR-3 | UPI URI builder; VPA validator; unconfirmed outlet cannot take UPI; tracking payload shows only its own outlet's destination; VPA change resets confirmation; stable-key helper |
| PR-4 | Reconnect/visibility refetch and merge (unit + Playwright); wake-lock fallback |
| PR-5 | Staff entry error path; stable key; limiter not consumed by staff |
| **PR-6 (claim)** | Wrong/missing/foreign token; ineligible states; idempotent repeat; throttling; **`payment_status`, `bill_number`, `settled_at` unchanged and no `order:paid`**; admin room updated, kitchen room redacted; tokens absent from captured logs |
| **PR-7 (alerts)** | Event created once per trigger; duplicate suppression; provider failure recorded and retried; recovery marks SENT; digest on burst; no provider → SKIPPED and banner; Super Admin shows failures and Retry |
| P1-1 | Signed webhook fixtures (captured/failed/refunded/unknown-account/duplicate/out-of-order), tamper tests, token refresh/revocation, reconciliation of a lost webhook, sandbox end to end, mutation checks; **gateway refund concurrency reuses the P0-10 suite** |
| P1-2 | Sequential invoice numbers under concurrency; place-of-supply split (intra/inter-state); buyer GSTIN; sandbox charge/fail/halt; credit note |

### 6.3 Regression hot-spots
`orders.service.ts` (create, markPaid, cancel, processRefund, syncTableStatus): add behaviour as **new methods or thin wrappers**, change money paths only in P0-10 with the full suite; `tenant.guard.ts`/`subscription-access.ts` (every write); `events.gateway.ts` and the kitchen redaction **deny-list** (every new order field needs a decision); KDS/admin stores; provisioning and onboarding (keep new fields optional, keep the old payload tested); migrations (one concern per file); reports money rules (golden-data tests); `PlatformEventsService` (alerts must never break the originating request: failures are recorded, not thrown).

### 6.4 CI wiring (P0-7a)
Postgres service container → build API → start with `THROTTLE_DISABLED=true`, a test `PLATFORM_BOOTSTRAP_SECRET`, `RAZORPAY_WEBHOOK_SECRET=whsec_test_123` and a **fresh database per job** → run suites serially. Web: add lint warn-only; Playwright journeys in P1-12.

---

## 7. Operational dependencies and failure modes
| Concern | Today | Needed |
|---|---|---|
| Single API process holds sockets, limiters, caches, jobs, **alert retries** | Fine for one instance | No second instance without Redis/adapter and a job leader (P2) |
| Sleeping API | Unknown (G5) | Verify; always-on if needed. A sleeping API also pauses alert retries |
| Email provider down | Failure currently invisible | **Recorded, retried, shown in Super Admin** (P0-5) |
| Webhook missed | Ledgered (subscription path) | Reconciliation for order payments (P1-1D) |
| Secrets rotation | `JWT_SECRET` fallback for settings key | Set `PLATFORM_SETTINGS_KEY` explicitly before OAuth tokens |
| Logs contain tokens | Query strings logged on errors | Redact (P0-8 prerequisite) |

---

## 8. Razorpay

### 8.1 Confirmed (from the partner response)
Technology Partner / Pure Platform model with OAuth · restaurants are merchants of record · restaurants connect **their own active Razorpay accounts** · settlements go **directly to the restaurant's registered bank account** · **Razorpay Route is not required** · each restaurant handles its **own KYC and activation** · **Partner Dashboard access is required** for the test-mode OAuth flow · standard pricing **2% plus GST**, **T+2 working-day settlement subject to the restaurant's approved settlement schedule** · Pangat's own SaaS collection is a **separate integration using Pangat's own merchant account**.

### 8.2 Open technical questions (do not design around guesses)
1. OAuth scopes for create order, fetch payment, refund; access-token lifetime; refresh rotation; revocation behaviour and event.
2. Sandbox: does test-mode via the Partner Dashboard cover orders, payments, refunds and **webhooks** end to end?
3. Verification of a checkout payment for an OAuth-connected merchant (signature scheme and key vs API fetch with the merchant token); which checkout key to use.
4. Webhooks: partner-level or per-merchant registration; merchant identification (`account_id`); signing secret.
5. Does 2% apply to UPI as well as cards? Any partner share or fee payable to Pangat? GST on fees?
6. Refund API under the merchant token; idempotency; timelines; failure events.
7. Disputes/chargebacks: notifications, merchant-of-record responsibilities.
8. Partner terms on advertising payments, token storage and data handling.
9. For Pangat's own account: Subscriptions vs Payment Links, UPI AutoPay/card mandates, trial-then-charge, invoice responsibilities.

### 8.3 Regulatory caution
The model is described as merchant-of-record with direct settlement; **that does not automatically remove all of Pangat's regulatory obligations.** Independent CA and legal confirmation is a dependency of P1-1E and P1-2, not an assumption.

---

## 9. Open items summary
Founder decisions G1–G10 and C1–C15; `pangat@icici` investigation; Partner Dashboard access and Razorpay technical answers; CA/legal confirmation; production facts (plan rows, tiers, email provider, support number); a human to run the read-only production checks and take the schema dump. I have run none of these and will not without your approval.

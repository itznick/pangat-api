# Pangat — Phase 2 Technical Dependencies

**Status:** proposal. Everything marked *proposed* below is design only; no schema, endpoint or configuration has been created.
**Companion documents:** `PANGAT_PHASE2_PRODUCT_READINESS_AUDIT.md` (findings, `F-nn`) and `PANGAT_PHASE2_ROADMAP.md` (items, `P0-n` / `P1-n`, phases `PR-n`).
**Baseline:** API `977c93a`, web `0beb1c8`.

---

## 1. Dependency map between roadmap items

```
PR-0 decisions (G1..G8, facts)
   │
   ├─► P0-1 UPI payee + DTO regex ─────────────┐
   ├─► P0-2 stable idempotency keys ───────────┤
   │        └─► P0-4 staff entry ──────────────┤
   │                                           ▼
   ├─► P0-7 safety net (baseline, CI+DB, staging, hosting) ──► every later PR is tested here
   │                                           │
   ├─► P0-3 kitchen reliability                │
   ├─► P0-8 manual-UPI claim (needs P0-1) [skip if G1=online first]
   ├─► P0-5 pilot ops (alerts need email provider; G4)
   ├─► P0-6 truthful copy (needs G2)
   └─► P0-9 staging UAT ◄── all of the above ──► PILOT GO / NO-GO

Razorpay track (starts when partner access exists; never blocks the pilot unless G1=yes)
   Partner approval + sandbox creds + answers (G8)
        └─► P1-1A Connect ─► P1-1B Pay ─► P1-1C Refund ─► P1-1D Reconcile ─► P1-1E Live pilot
                               ▲ needs G6 (release rule) and P0-7 (CI/staging)
   Pangat's own Razorpay keys + plan mapping + CA input ─► P1-2 subscription billing (needs G2 settled)

P1-6 PWA/service worker ─► P1-4 push notifications
P0-5 alerts ─► P1-9 plan change → ticket
P1-3 CSV import ◄── G7 ;  P1-10 order hardening ◄── P0-7 + pilot metrics
```
Hard sequencing rules: P0-7 before anything that changes order, payment or schema paths; P0-1/P0-2 before P0-4 and P0-8; P1-1A before 1B; 1B before 1C/1D; G6 before 1B starts.

---

## 2. External dependencies

| Dependency | Needed for | Status / unknown | Risk if late |
|---|---|---|---|
| **Razorpay Technology Partner approval**, OAuth client id/secret, redirect URI registration, **sandbox/test-mode partner access** | P1-1 | The partner reply was not available to this audit (G8) | The whole restaurant-payments track waits; code can be built against fixtures but not proven |
| Razorpay merchant onboarding by each restaurant (KYC, activation, settlement account) | P1-1E | Restaurant's responsibility; lead time unknown | A pilot restaurant may not be able to take online payment immediately; keep counter/UPI path |
| Pangat's own Razorpay live account + plan ids | P1-2 | Plans carry `razorpay_plan_id` fields but values unknown | Subscription billing blocked; manual invoicing continues |
| Pangat GST registration and invoice format (SAC, e-invoicing applicability) via CA | P1-2 invoice PDF | `sacCode` exists on plans; legal format not reviewed | Invoices not compliant |
| Brevo (or any SMTP/API provider): verified sender, ideally domain authentication (SPF/DKIM) | P0-5 alerts, welcome links, OTP, P1-4 summaries | Provider configured in production? unknown | Mail lands in spam or is not sent; alerts silently skipped |
| Render API tier / always-on | P0-7, jobs, sockets | Unknown (G5) | Cold starts on first order; lost sweeps |
| Neon: plan limits, autosuspend, branch quota, PITR window | P0-7 staging, backups | Unknown | Staging branch unavailable; cold-start latency |
| Netlify branch/preview deploys | staging web | Likely available | — |
| GitHub Actions minutes + Postgres service container | P0-7, P1-12 | Free tier sufficient | — |
| Free object storage | P1-3 photos | Choose later | Photos deferred; emoji stays |
| Real devices (Android phone, iPhone, kitchen tablet) | P0-3, P0-9 | Founders' hardware | Reliability claims unproven |
| Lawyer/CA sign-off (`docs/COMPLIANCE.md` open questions) | before scale | Pending | Not a pilot blocker, but a scale blocker |

---

## 3. Proposed database changes (none applied)

All new migrations follow the existing rules: numbered, additive, idempotent, one transaction, auto-applied from 009+ with the advisory lock, a matching `.down.sql` that never drops data-bearing columns, and rehearsed with the existing `docs/staging/*` scripts on a copy first. Next number is **018**.

### 3.1 Phase 0 / P0
| Migration | Change | Item | Notes |
|---|---|---|---|
| `000_baseline.sql` (docs/rebuild artefact, **not auto-applied**: the runner starts at 009) | Schema-only dump of production's core tables (`organizations`, `restaurants`, `staff`, `tables`, `menu_categories`, `menu_items`, `modifiers`, `orders`, `order_items`, `leads`, …) | P0-7 | Reviewed by a human; sanitised; CI builds a fresh DB from `000` + `009…` and diffs it with the entity-synchronised schema |
| `018_order_payment_claim.sql` | `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_claimed_at timestamptz;` | P0-8 | Nullable, no default, no backfill, no index needed |
| (optional) `019_restaurant_golive.sql` | `ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS qr_kit_opened_at timestamptz;` | P0-5 | Only if the checklist should remember "QR kit opened"; otherwise skip |

### 3.2 P1 — Razorpay for restaurants (proposed DDL, to be refined after the partner reply)
```sql
-- One row per connected restaurant (outlet) or organisation; tokens encrypted with the existing AES-256-GCM helper
CREATE TABLE IF NOT EXISTS restaurant_payment_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  restaurant_id      uuid REFERENCES restaurants(id) ON DELETE RESTRICT,   -- NULL = organisation-wide
  provider           varchar(20) NOT NULL DEFAULT 'razorpay',
  provider_account_id varchar(100) NOT NULL,                              -- Razorpay merchant/account id
  public_key         varchar(100),                                         -- checkout key for that merchant [verify]
  access_token_enc   text NOT NULL,
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  scopes             text[],
  mode               varchar(10) NOT NULL DEFAULT 'test',                 -- test | live
  status             varchar(20) NOT NULL DEFAULT 'CONNECTED',            -- CONNECTED | NEEDS_RECONNECT | REVOKED
  connected_by       uuid REFERENCES staff(id),
  connected_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  UNIQUE (provider, provider_account_id)
);

-- Many attempts per order; the order keeps its existing payment_status as the summary
CREATE TABLE IF NOT EXISTS order_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            varchar(20) NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  payment_account_id  uuid NOT NULL REFERENCES restaurant_payment_accounts(id),
  provider_order_id   varchar(100) NOT NULL,
  provider_payment_id varchar(100),
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),   -- from the SERVER-computed order total
  currency            char(3) NOT NULL DEFAULT 'INR',
  status              varchar(20) NOT NULL DEFAULT 'CREATED',     -- CREATED | AUTHORIZED | CAPTURED | FAILED | EXPIRED
  method              varchar(20),
  failure_reason      text,
  verified_at         timestamptz,                                 -- set only after server-side fetch/verification
  captured_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_order_id),
  UNIQUE (provider_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments (order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_pending ON order_payments (status, created_at) WHERE status IN ('CREATED','AUTHORIZED');

CREATE TABLE IF NOT EXISTS order_refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_payment_id   uuid NOT NULL REFERENCES order_payments(id) ON DELETE RESTRICT,
  provider_refund_id varchar(100) UNIQUE,
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  status             varchar(20) NOT NULL DEFAULT 'PENDING',     -- PENDING | PROCESSED | FAILED
  reason             text NOT NULL,
  idempotency_key    varchar(100) NOT NULL UNIQUE,
  credit_note_number varchar(32),
  requested_by       uuid REFERENCES staff(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
```
- **Orders:** if G6 = model B, either (i) a new `orders.order_status` value `AWAITING_PAYMENT` (enum change; every status switch in KDS/admin/reports must be audited), or (ii) preferably a boolean `orders.released_to_kitchen boolean NOT NULL DEFAULT true`, so that all existing rows and the existing flows are unchanged and only gateway-checkout orders are created with `false`. Option (ii) is the lower-risk migration.
- **Webhook ledger:** reuse the existing `webhook_events` table (it already has `provider`, `event_id`, `status`, `signature_valid`, `payment_id`, `organization_id`) rather than a new one; add `account_id` if needed.
- **Money type:** new tables use integer paise; `orders` keeps `decimal(10,2)`. Convert at one boundary function and unit-test it (rounding at ₹0.005).

### 3.3 P1 — other
| Item | Change |
|---|---|
| P1-2 | `subscription_invoices.pdf_key varchar(200)` (optional; PDFs can also be generated on demand). Existing columns already hold `razorpay_subscription_id/customer_id/payment_id/invoice_id`. |
| P1-3 | `menu_items.image_url varchar(20)` → `varchar(500)` (widening is a safe, metadata-only change in Postgres); optionally `image_key`. |
| P1-4 | `push_subscriptions(id, staff_id, restaurant_id, endpoint, p256dh, auth, created_at)`; summary opt-in on outlet `operations` JSON. |
| P1-7 | `tables.session_secret` (only if the rotating-QR approach is chosen). |
| P1-8 | Extend `restaurants.operations` JSON; no DDL. |

---

## 4. Proposed API surface (not implemented)

| Endpoint | Auth | Item |
|---|---|---|
| `GET /restaurants/:id/readiness` | owner/manager | P0-5 |
| `POST /orders/:id/payment-claimed?token=` | tracking token, throttled | P0-8 |
| `POST /admin/provision` + optional `kitchenPin` | platform admin | P0-5 |
| `GET /payments/connect/start` → 302 to Razorpay with signed `state` | owner | P1-1A |
| `GET /payments/connect/callback` | Razorpay redirect, `state`-verified | P1-1A |
| `POST /payments/connect/disconnect`, `GET /payments/account` | owner | P1-1A |
| `POST /orders/:id/pay` (creates Razorpay order on the merchant's account) | tracking token | P1-1B |
| `POST /orders/:id/pay/verify` | tracking token | P1-1B |
| `POST /payments/webhook/razorpay` (separate from the subscription webhook; maps `account_id` → restaurant) | HMAC | P1-1B |
| `POST /orders/:id/refund` (gateway path: extends existing endpoint) | owner/manager | P1-1C |
| Job: `payments-reconcile` (in `jobs.service.ts`) | system | P1-1D |
| `POST /subscriptions/checkout` (create subscription / link) | owner | P1-2 |

Rule for all payment endpoints: the amount is **always** recomputed from the stored order; the client may send an order id, never an amount; the payment is **verified by fetching it from Razorpay with the merchant's token** (and signature where applicable) before any state change; state change + bill number + audit + socket emit happen in **one transaction** (as `markPaid` already does).

---

## 5. Configuration and secrets (proposed)

| Name | Where | Item |
|---|---|---|
| `RAZORPAY_PARTNER_CLIENT_ID`, `RAZORPAY_PARTNER_CLIENT_SECRET`, `RAZORPAY_OAUTH_REDIRECT_URI` | env or encrypted platform setting (preferred: same store as `gateway.razorpayWebhookSecret`) | P1-1A |
| `RAZORPAY_PARTNER_WEBHOOK_SECRET` (order-payment webhook) | encrypted platform setting | P1-1B |
| `PLATFORM_SETTINGS_KEY` | **must be set explicitly** before storing OAuth tokens, so that rotating `JWT_SECRET` can never make stored tokens unreadable (already advised in `.env.example`) | P1-1A |
| Pangat's own `RAZORPAY_KEY_ID/KEY_SECRET` and webhook secret | encrypted platform setting | P1-2 |
| `support.whatsapp` (platform setting) | registry | P0-5 |
| `general.selfSignupEnabled=false` | Super Admin setting | P0-5 |
| `notifications.emailAlerts=true`, `notifications.alertEmails=<founders>` | Super Admin setting | P0-5 |
| `VAPID_PUBLIC_KEY/PRIVATE_KEY` | env | P1-4 |
| Per-outlet payment mode flag (`operations.payments.gateway`, default false) | outlet settings | P1-1B |

Secrets are never put in the repo or in PR text; OAuth tokens are encrypted at rest with the existing AES-256-GCM helper and never returned by any API.

---

## 6. Test strategy and regression map

### 6.1 What protects what today
| Area | Existing protection |
|---|---|
| Tenancy / roles | `authorization.test.mjs`, `phase1-final-role-isolation`, `integration.e2e`, `security-integration.test.ts` (17) |
| Entitlements, revocation | `phase1-entitlements.e2e` (36), `phase1-1-verification` (7), `phase1-2-*` (28), `subscriptions.test` |
| Orders and inventory | `order-lifecycle`, `order-types`, `inventory`, `recipes-deductions`, `qa-remediation` |
| Compliance and bills | `compliance.e2e` (14), `billing.test`, `privacy.test`, `audit.test` |
| Platform console | `platform-control.e2e` (43; needs a **fresh** DB) |
| Web | 51 unit tests; Playwright UAT scripts (local, desktop) |

### 6.2 What each phase must add
| Phase | New tests |
|---|---|
| PR-1 | Unit: UPI URI builder; stable-key helper. E2E: DTO regex; duplicate submit → one order |
| PR-2 | The CI job itself; schema-drift check; staging smoke |
| PR-3 | Unit: ticket merge/de-dupe; Playwright: socket drop/restore shows missed order; wake-lock fallback |
| PR-4/5 | E2E: staff-entry failure path; `payment-claimed` auth/idempotency; no change to `payment_status` |
| PR-6 | E2E: provision with and without `kitchenPin` (existing payload must still work); readiness booleans; event + email stub on lead/ticket/plan request |
| P1-1 | Signed webhook fixtures (follow the existing `whsec_test_*` pattern) for captured/failed/refunded/unknown-account/duplicate/out-of-order; amount-tamper and cross-restaurant order id rejected; token refresh and revocation; reconciliation on a "lost webhook"; sandbox end-to-end; **mutation checks** on verification (remove the amount check → a test must fail), as Phase 1 did |
| P1-2 | Sandbox: authenticate → charge → fail → grace → halt; invoice number sequence; duplicate event |

### 6.3 Regression hot-spots (touch with care, one concern per PR)
1. `orders.service.ts` (1,287 lines): `create`, `markPaid`, `cancelOrder`, `processRefund`, `syncTableStatus`. Online payment must be added as a *new method path*, not by editing these in place.
2. `tenant.guard.ts` and `subscription-access.ts`: any change affects every write endpoint.
3. `events.gateway.ts`: rooms and revocation; new events must be emitted to the same rooms.
4. `useKdsStore` / `useAdminStore`: reconnect logic changes touch live ordering for every restaurant.
5. `provisioning` (`admin.service.ts`) and `auth.onboard`: operator-critical; keep every new field optional.
6. Migrations: one change per file, rehearsed on a staging copy with `migration_017_check.sh`-style up/down/up scripts.
7. Reports money rules: change only with golden-data tests.

### 6.4 CI wiring (P0-7)
Postgres service container → build API → start with `THROTTLE_DISABLED=true`, a test `PLATFORM_BOOTSTRAP_SECRET`, `RAZORPAY_WEBHOOK_SECRET=whsec_test_123` and a **freshly created database per job** → run suites serially → upload results. `npm audit` and gitleaks stay as they are. Web: add `lint` (warn-only first), then Playwright journeys (P1-12).

---

## 7. Operational dependencies and failure modes

| Concern | Today | Needed |
|---|---|---|
| Single API process holds sockets, limiters, caches, jobs | Fine for one instance | Never scale to two instances without Redis/adapter and a job leader (P2) |
| Sleeping API | Unknown | Verify (G5); uptime ping + always-on if needed |
| Neon cold start / connection limits | Pool `max: 15`, idle 30 s | Verify plan limits; use the direct (non-pooled) endpoint for migrations (documented in Phase 1) |
| Email down | Welcome link falls back to showing a temporary password once; OTP only enforced when a provider exists | Alert when provider fails (P1-11) |
| Webhook missed or out of order | Ledgered; subscription path idempotent | Reconciliation job for order payments (P1-1D) |
| Backups | Neon-side; restore drill documented | Run the drill once for real before pilot (P0-7) |
| Secrets rotation | `JWT_SECRET` fallback for settings key | Set `PLATFORM_SETTINGS_KEY` explicitly before storing OAuth tokens |

---

## 8. Questions to put to Razorpay (answers freeze the P1-1 design)

1. **OAuth:** authorisation URL, required scopes for *create order, fetch payment, refund, read settlements*, code → token exchange, access-token lifetime, refresh-token rotation, behaviour on revocation, and the event sent when a merchant disconnects the app.
2. **Test mode:** is there a sandbox for the *partner/OAuth* flow, and can webhooks be exercised there?
3. **Verification:** with an OAuth-connected merchant (Pangat holds no key secret), what is the supported way to verify a checkout payment: signature scheme and key, or API fetch with the merchant token? What is the checkout `key` to use?
4. **Webhooks:** are they registered once per partner application or per merchant? How is the originating merchant identified (`account_id`)? Signing secret model?
5. **Orders/refunds:** can Pangat create orders and issue refunds with the merchant's token? Refund speed/partial refunds/idempotency (receipt, notes).
6. **Settlement and fees:** funds settle directly to the restaurant (the "pure platform" model); who bears MDR on UPI and cards; any partner fee; GST on fees. (This decides whether "keep 100%" can remain on the landing page.)
7. **Regulatory:** confirm the pure-platform model leaves Pangat outside payment-aggregator scope and what Razorpay requires of Pangat (terms, data handling, PCI scope for hosted checkout). Confirm independently with the CA/lawyer.
8. **Subscriptions for Pangat itself:** Subscriptions vs Payment Links for the first cycle, mandate flow for UPI AutoPay/cards, trial-then-charge support, GST invoice generation by Razorpay or by Pangat.

---

## 9. Open items summary
Facts needed from founders (VPA ownership, production plan prices, hosting tiers, support number, email provider status), decisions G1–G8 in the roadmap, the Razorpay partner reply, and a human to take the production schema-only dump for `000_baseline.sql`. I have not attempted any of these and will not without your approval.

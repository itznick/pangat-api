# Pangat — Razorpay technical readiness (restaurant online payments)

**Status:** preparation only. **No Razorpay code has been written, no collection is enabled, and no Razorpay API was called.** This document records what is confirmed, what is not, and the design that follows from the confirmed part. Anything marked **[Open]** is a question for Razorpay, not an assumption to build on. I have **not** invented any Razorpay API behaviour: where a detail is unknown it says so.

## 1. Confirmed facts (from the Razorpay Technology Partner response the founders received)
1. Pangat would act as a **Technology Partner (Pure Platform) using OAuth**.
2. The **restaurant is the merchant of record**; each restaurant connects **its own active Razorpay account**.
3. Settlement goes **directly to the restaurant's registered bank account**.
4. **Razorpay Route is not required.**
5. Each restaurant completes **its own KYC and account activation**.
6. A **Partner Dashboard** (access to be provided) is required to build and test the OAuth flow in test mode.
7. Standard pricing is **2% plus GST** on payments; settlement is **T+2 working days, subject to the restaurant's approved settlement schedule**.
8. Pangat's own SaaS subscription collection is a **separate integration with Pangat's own merchant account** (separate credentials, separate webhook).

**Regulatory caution.** Merchant-of-record with direct settlement **does not by itself remove all of Pangat's regulatory obligations** (GST on its own fees, payment-related duties, advertising). A chartered accountant and a lawyer must confirm this. It is a dependency, not an assumption.

## 2. Open questions for Razorpay [Open]
1. OAuth scopes needed for create order, fetch payment and refund; access-token lifetime; whether refresh tokens rotate; what revocation looks like and whether an event is sent.
2. Does test mode through the Partner Dashboard cover **orders, payments, refunds and webhooks** end to end?
3. How a checkout payment is verified for an OAuth-connected merchant: signature scheme and which key, versus fetching the payment with the merchant's token. Which public key the checkout script uses.
4. Webhooks: registered at partner level or per merchant; how the merchant is identified in the payload; which secret signs it.
5. Does the 2% apply to UPI as well as cards? Is there any partner fee or revenue share? Is GST charged on the fee, and who invoices it?
6. Refund API under the merchant token: idempotency support, timelines, failure events.
7. Disputes and chargebacks: who is notified; the merchant-of-record's responsibilities.
8. Partner terms on token storage, data handling and advertising payments.
9. For Pangat's own account: Subscriptions vs Payment Links, UPI AutoPay and card mandates, trial-then-charge, invoice responsibilities.

## 3. Architecture (what the confirmed facts imply)
- **Per-restaurant connection.** The owner presses "Connect Razorpay"; the browser goes to Razorpay's OAuth consent; the API receives the authorisation `code` on a callback, exchanges it **server-side** for tokens, stores them **encrypted**, and records the connected merchant account id. The web app never sees a token.
- **Payment flow (per order).**
  1. Diner chooses "Pay online". The API **recomputes the amount from the stored order** (never from the client), creates a Razorpay order with the restaurant's token, stores an `order_payments` row in state CREATED.
  2. The diner pays in Razorpay's checkout.
  3. **Verification before any state change**: the API fetches the payment from Razorpay with the restaurant's token (and checks the signature where the confirmed scheme provides one). Only then is the order marked paid.
  4. In **one database transaction**: mark paid, issue the GST bill number (the existing atomic path), write the audit record, then emit the socket event.
  5. The Razorpay **webhook** is a second, independent route to the same idempotent transition (covers a diner who closes the tab after paying). A repeated delivery changes nothing.
- **Why the existing pilot work matters:** the atomic mark-paid, unique-bill index and server-side idempotency (migration 020) are exactly the guarantees online payment needs. Online payment must reuse `markPaid`, never write payment state by another path.
- **Refunds.** Manual refunds stay as they are (record, credit note, the owner returns money). Gateway refunds, when built, call Razorpay's refund API with the restaurant's token under the same `order_refunds` idempotency key, and the credit note is issued only after Razorpay accepts. **Not implemented; not designed further until question 6 is answered.**
- **Kill switches.** Per-outlet "online payments" setting (off by default) and the platform feature flag mechanism already used for KDS and inventory.

## 4. Proposed data model (not created)
| Entity | Purpose | Notes |
|---|---|---|
| `restaurant_payment_accounts` | one row per connected restaurant: Razorpay account id, mode (test/live), status (CONNECTED, REVOKED, ERROR), connected_at, encrypted access and refresh tokens, token expiry | Tokens encrypted with the platform settings key (AES-256-GCM, as the existing encrypted settings); never returned by any API; never logged (the log redaction already masks `token`, `access_token`, `refresh_token`) |
| `order_payments` | many attempts per order; amount in **integer paise**; provider order id and payment id (unique); status; `verified_at` set only after server-side verification | Unique constraints make a repeated webhook or verification harmless |
| `order_refunds.order_payment_id` | optional link for gateway refunds | The existing table already has a provider reference column |

## 5. Proposed endpoints (not implemented)
`GET/POST /payments/connect/*` (start and callback, owner only) · `POST /orders/:id/pay` (creates the Razorpay order; tracking token in the body, never the URL) · `POST /orders/:id/pay/verify` · `POST /payments/webhook/razorpay` (signature verified on the raw body, replay-safe) · `DELETE /payments/connect` (owner disconnects). Every endpoint: tenant-scoped, throttled, audited, credentials never in URLs or logs.

## 6. Security requirements
- Tokens encrypted at rest; decrypted only in the process that calls Razorpay; rotated per Razorpay's rules once known (Q1).
- Webhook secret and signature checked on the **raw** request body (the API already keeps `rawBody`); reject, record and alert on a bad signature (the existing platform webhook handling does this for Pangat's own account).
- The amount charged is always recomputed from the stored order; the client cannot choose it.
- No card or UPI credentials ever touch Pangat's servers (Razorpay's checkout handles them).
- A revoked or expired token puts the restaurant back to counter/UPI-manual payment with a clear message; it never blocks ordering.

## 7. Testing plan
1. Unit: signature check, amount recomputation, state machine (CREATED to PAID, FAILED, duplicate webhook).
2. Live, on a disposable database, against a **fake Razorpay server** that mimics only the behaviours Razorpay has **confirmed**: double webhook delivery = one bill; payment verified by fetch before marking paid; wrong amount refused; revoked token handled.
3. Test mode with the Partner Dashboard (needs access and answers to Q2, Q3, Q4) with a test restaurant, then a **₹1 live payment** by the founders on staging before any restaurant.
4. Concurrency: webhook and verify racing to mark the same order paid (must produce one bill).

## 8. Dependencies and gates (nothing starts until these exist)
Partner Dashboard access and Razorpay's answers to section 2 · a restaurant with an **active** Razorpay account (its own KYC) · CA and legal confirmation of obligations · a staging environment · founders' decision on whether online payment is part of the pilot at all (it should not be: the counter and owner-confirmed UPI paths work today).

## 9. What exists today that this builds on
Atomic mark-paid and refunds with database constraints; server-side idempotency with payload-conflict detection; owner-confirmed UPI destination with no fallback; encrypted platform settings; log redaction for tokens; the platform webhook handling pattern (signature, record, alert); audit logging; the feature-flag mechanism. **No collection is enabled.**

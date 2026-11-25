# Pangat — Phase 2 Revision Report (Revision 2)

> **Superseded in part (Revision 3).** The commercial structure described in this report (Starter/Growth/Group, ₹799/₹1,799/₹4,499, 60-day pilot) was a proposal and has been **replaced by the founders' approved Mini/Starter/Growth/Enterprise strategy**, now implemented. Read `PANGAT_COMMERCIAL_IMPLEMENTATION_REPORT.md` for the current commercial state. The technical findings and the P0/P1 engineering plan in this report still stand.

**Purpose:** summarise how the founder review was incorporated so the Phase 2 plan is one consistent document set.
**Restrictions observed:** read-only inspection; no application source modified; no migrations created; no database record or configuration changed; no hosting or deployment change; no feature implemented; **nothing committed, merged or deployed in this revision** (see §7 for the one earlier commit).

## 1. Documents

| Document | State |
|---|---|
| `PANGAT_PHASE2_PRODUCT_READINESS_AUDIT.md` | Revised (Razorpay facts, F-01/F-02 clarifications, new findings F-36…F-40) |
| `PANGAT_PHASE2_ROADMAP.md` | Rewritten (PR-0B, re-sequencing, interim mitigation, P0-10, claim endpoint, alert policy) |
| `PANGAT_PHASE2_TECHNICAL_DEPENDENCIES.md` | Rewritten (corrected dependency map, migrations 018–021, Razorpay confirmed/open) |
| `PANGAT_COMMERCIAL_PLAN_STRATEGY.md` | **New** |
| `PANGAT_PLAN_FEATURE_MATRIX.md` | **New** |
| `PANGAT_PRICING_AND_LIMITS.md` | **New** |
| `PANGAT_SUBSCRIPTION_LIFECYCLE_RULES.md` | **New** |
| `PANGAT_PHASE2_REVISION_REPORT.md` | This report |

## 2. Changes made (by instruction)
1. **PR-0B commercial workstream** added as a mandatory, gating workstream, with the four requested documents. It evaluates the existing Starter/Growth/Enterprise structure and does **not** assume it is correct. Verdict: entry price too high for the market and contradicts the landing page; Enterprise contains no feature Growth lacks; plan edits silently re-price all subscribers. Proposal: Starter ₹799 / Growth ₹1,799 / Group (≤ 3 outlets) ₹4,499 per month (+ GST), annual = 10× monthly, quarterly later; dedicated capped 14-day trial plan; Founding Partner terms; no add-ons or coupons at launch. Features are allocated only if they exist; unbuilt candidates are listed separately and not sold. Everything maps onto the existing entitlement keys, three limits and plan rows. **Approval is required before subscription billing is built or any final price is published.**
2. **Razorpay corrected.** The partner response is recorded as received, with the nine confirmed statements separated from the open technical questions; the regulatory caution is explicit; G8 now reads "response received; technical clarification and sandbox/Partner Dashboard access outstanding".
3. **Sequencing contradiction resolved:** P0-7a (minimum DB-backed CI + staging) is now first; no order/payment/schema change merges before it. An explicit interim mitigation (M1 operational, M2 a tiny web-only removal of the UPI buttons, only on founder decision) covers the UPI risk meanwhile.
4. **Refund idempotency made server-side and atomic** (new P0-10): row lock then re-read, idempotency as a database unique constraint with request-hash conflict detection, one bill per order, credit notes and bills inside the same transaction, and a mandatory concurrency test suite with mutation checks. The same defect class in `mark-paid` is covered.
5. **Manual UPI claim endpoint specified** (P0-8): tracking token in the body (not URL), throttled, idempotent, eligible orders only, never marks paid, issues no bill, emits only an update to the authorised staff room (kitchen redacted), no credentials in URLs or logs; wording states a claim is **not** proof of payment.
6. **UPI validation clarified** (P0-1): regex = shape only; owner confirmation (server-enforced), clear destination shown to diners, controlled ₹1 verification per outlet in UAT, and a defined **investigation of `pangat@icici`** without assuming ownership.
7. **Alert policy** (P0-5): events, recipients, de-duplication windows, reminders, burst digest, rate cap; every email attempt recorded; retries with back-off; failures visible in Super Admin with Retry; no-provider banner; in-app events always stored.
8. **Phase 1 architecture preserved:** no redesign of entitlements, Super Admin, tenancy or the subscription state machine. Optional small guards are listed (P1-15) and none is required.

## 3. Contradictions resolved
| Contradiction | Resolution |
|---|---|
| Dependency doc: P0-7 before order/payment/schema changes; roadmap scheduled P0-1/P0-2 first | P0-7a is first; M1/M2 handle the urgent UPI case |
| Audit said Razorpay response unavailable | Corrected; confirmed vs open separated |
| Landing ₹699 / 7-day trial vs seeded plans ₹1,499+ / 14-day | Resolved by PR-0B; interim copy states no price |
| "Keep 100%" vs Razorpay 2% + GST | Reworded; online payment is not a priced feature |
| Stable client keys offered as the refund fix | Server-side atomic idempotency (P0-10); client keys are defence in depth |
| Mitigation by switching UPI off in Settings | **Insufficient**: the hardcoded screen is reachable from three entry points that ignore that switch; mitigation redefined |
| Roadmap said VPA regex solves UPI correctness | Regex proves shape only; ownership needs confirmation + test payment |
| P0-8 draft put the token in a query string | Body only; log redaction as a prerequisite |
| Draft DDL gave `order_refunds` a mandatory gateway-payment link | Nullable link so manual and gateway refunds share one table |

## 4. New findings from this round (all by code reading; none reproduced)
F-36 refund and mark-paid are not atomic (duplicate credit notes/bills possible) · F-37 order tracking tokens are logged in URLs on server errors · F-38 alert email failures are silently discarded · F-39 plan model constraints (in-place plan edits, no price snapshot, no quarterly interval, trial defaults to Growth) · F-40 Pangat's own subscription invoices are non-sequential (~27 characters), always CGST+SGST, lack buyer state/GSTIN and PDF, and have no credit notes. Also corrected: the hardcoded VPA has been in the web code since commit `3f053bb` (2026-10-27).

## 5. New dependencies
Partner Dashboard access and Razorpay's technical answers · CA/legal confirmation (GST, SAC, invoices, refund policy, advertising claims, payment-related obligations) · a human with production database access for read-only checks, the duplicate-bill pre-check and the schema dump · founders' UPI/bank statements for the `pangat@icici` investigation · an email provider with failure visibility · migrations 018–021 (and later billing-profile/invoice-sequence changes) rehearsed on staging · log redaction before the claim endpoint · PR-0B approval before P0-6b and P1-2.

## 6. Decisions still required from founders
- **Interim:** M2 yes/no (any real-diner exposure possible?); results of the `pangat@icici` investigation.
- **G1–G10** (online payment at pilot, delivery, self-signup, hosting, kitchen release rule, menu entry, Razorpay follow-ups, production facts).
- **PR-0B C1–C15:** segments and positioning; structure (Starter/Growth/Group or the single-plan fallback); list prices and discount depth; pilot terms (60 days free, founding rate 30% off for 12 months); trial length and caps; price-change notice period; Group publicly or by quote; whether to publish prices during the pilot; CA decisions; downgrade with extra outlets; inventory deduction after downgrade; data retention after expiry; subscription refund policy; proration; quarterly at launch.
- Support WhatsApp number; alert recipient addresses and reminder expectations.

## 7. Risks that remain
- Prices are **not market-validated**; competitor figures are third-party listings. Validate with 8–10 prospects before freezing.
- Concurrency defects (F-36) are inferred from code and unproven until the P0-10 tests run against Postgres.
- Exposure from the hardcoded UPI ID is unknown until the investigation is done.
- Razorpay technical unknowns could change P1-1 scope; sandbox access is not yet in hand.
- Regulatory obligations are not settled by the merchant-of-record model; CA/legal input is outstanding.
- A single developer, single API process, unknown hosting tier: alert retries and sweeps stop if the API sleeps.
- Pangat cannot issue compliant paid invoices until F-40 is fixed (free pilots unaffected).
- Production data, plan rows and email configuration were not inspected.
- **Housekeeping:** the earlier revision of the three original documents was already committed and pushed to the development branch before this instruction (commit `b3d06a0`, docs only). This revision and the new documents are **uncommitted** in `pangat-api/docs/`, per your restriction.

## 8. Recommended implementation sequence (after approval)
PR-0 decisions and investigation → (parallel) **PR-0B** commercial approval → **M1/M2** interim mitigation → **PR-1** safety net MVP (CI with Postgres, staging) → **PR-2** atomic refund/mark-paid + concurrency tests → **PR-3** UPI payee fix + VPA confirmation + stable keys + interim copy → **PR-4** kitchen reliability → **PR-5** staff order entry → **PR-6** log redaction + payment-claim → **PR-7** onboarding completeness + alert policy → **PR-8** baseline schema/drift check + final copy (after PR-0B) → **PR-9** staging UAT on real devices incl. ₹1 UPI verification → **pilot go/no-go** → then CSV import, Razorpay for restaurants (1A–1E), subscription billing (after F-40 and PR-0B), reports, notifications and the rest. Details and gates: Roadmap §7.

I will not start implementation, commit or deploy until you approve.

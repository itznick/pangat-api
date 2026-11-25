# Pangat — Subscription Lifecycle Rules

**Status:** describes what the platform does **today** (verified by code and tests) and the rules for the approved plans. Items marked **[pending]** are not built and not enabled.
**Principle:** the Phase 1 subscription state machine, entitlement engine and Super Admin are unchanged. The only behavioural changes are the ones listed in §10, each justified by a demonstrated defect or by the approved plans.

## 1. States (unchanged, verified)

| Status | Meaning | Restaurant can… |
|---|---|---|
| `TRIAL` | Free period on the trial plan | Use everything the plan allows |
| `ACTIVE` | Paid (gateway) or granted (manual) period | Use everything |
| `PAST_DUE` / `GRACE_PERIOD` | Period ended or a payment failed, inside the grace window (default 7 days, setting `subscription.gracePeriodDays`) | **Everything, unchanged** |
| `EXPIRED` / `HALTED` | Grace over, or renewal turned off and the period ended | View data and finish orders already in flight; cannot create or change; guest ordering closes; new kitchen sessions refused |
| `CANCELLED` | Owner or founder cancelled | Works until the paid period runs out, no grace, then blocked |

Status is computed by one pure function used by request guards and the hourly sweep.

## 2. Trial
14 days, no card, dedicated non-public `PANGAT_TRIAL` plan: 1 outlet, 20 tables, 8 staff accounts, Growth-level supported features (reports, inventory), no multi-outlet. Created at sign-up or provisioning (and by `my-subscription` if somehow missing). One trial per organisation; a platform administrator can start or extend one with a mandatory reason (audited). Reminder 3 days before the end. Ends in the standard grace (7 days) then read-only; data is kept. Verified end to end: creation, 14-day length, capacity caps, grace, expiry, re-activation.
Operator note: provisioning a restaurant onto the trial plan applies the trial's 20-table cap to the initial floor; a larger floor needs the audited limit override (reason of at least 10 characters) or a plan assignment first.

## 3. Billing intervals
**Monthly and annual only.** Annual is exactly ten times monthly. **Quarterly billing is not offered and was not introduced.**

## 4. Becoming a paying customer — paid collection is OFF
| Path | State |
|---|---|
| Founder grants a plan for N months (pilot, offline) | Works, audited, **creates no invoice and is never counted as revenue** |
| Owner "Request this plan" | Records a request only; changes nothing; nobody is charged |
| Self-serve checkout / Razorpay subscription for Pangat's own account | **Not implemented and deliberately disabled.** Verified by test: no checkout endpoint exists, a plan request never changes the plan, no invoice is created |
| Webhook receiver for Pangat's own Razorpay account | Exists (signed, idempotent, ledgered) and now numbers invoices correctly; never exercised against Razorpay |
Restaurant food-order payments (the restaurant's own Razorpay account via OAuth) are a **separate integration** with separate credentials, webhooks and ledgers, and are not part of this work.

## 5. Upgrades and downgrades
| Event | Rule | Support |
|---|---|---|
| Upgrade | Effective immediately; entitlements change at once (sockets and console re-evaluate). Founders credit unused time by hand (no automated proration) | `change-plan` (audited) |
| Downgrade | At the end of the paid period, executed by a founder until automated **[pending]** | `change-plan` |
| Downgrade over limits | Nothing is deleted. The restaurant keeps its data but cannot add more until within limits; Super Admin sees it under "Close to or over their limits" | existing limit rules + new capacity view |
| **Feature lost (Inventory)** | Screens lock. **Stock deduction, order-edit adjustments and automatic sold-out marking stop immediately** (this was a defect: they continued). Stock is frozen; a deduction that already happened is still reversed if that order is cancelled; deduction resumes when the feature returns. Applies equally to expiry and to the platform kill switch and per-restaurant override | verified by test |
| Feature lost (Reports, Multi-outlet) | Screens/endpoints refuse; data kept | existing |
| Outlets above the new limit | Existing outlets keep working; no new outlet can be added. Recommended policy: ask the owner to close extras before downgrading. The engine has no "read-only outlet" state | **decision pending** |

## 6. Founding 10 offer (not automated)
Terms: first ten restaurants in Pune; 14-day trial; **20% off the first 12 paid months**; free assisted onboarding; free digital QR design; direct founder channel; priority consideration for feature requests; **written 12-month price-lock agreement**. Not a lifetime discount.

**Implementation (simplest safe form, no coupon engine, nothing automatic):** eight non-public plan rows `FOUNDING_{MINI,STARTER,GROWTH,ENTERPRISE}_{M,A}` priced at exactly 80% of list with the list plan's limits and features. A founder assigns one by hand (`assign`, with the agreement reference as the mandatory reason); the assignment is in the platform audit log; the Super Admin "Founding 10" panel lists who is on a founding row and how many of ten places are used (read-only). No code path assigns them.

| Question | Rule |
|---|---|
| When does the 12-month period start? | At the **first paid month**, not at assignment and not during the 14-day trial. Because paid collection is off, the founders record the first-paid date in the assignment reason / customer note |
| Monthly and annual? | Both: `FOUNDING_*_M` for monthly, `FOUNDING_*_A` for annual (the annual payment at 80% covers the first 12 months) |
| Customer changes plan during the 12 months? | Move to the Founding row of the new plan (still 80% of the new list price) for the remaining months. **Founder decision**: whether upgrades keep the discount |
| After 12 paid months? | The customer moves, by an audited plan change with notice, to the then-current list row. The discount does not continue |
| Recording and audit | Plan assignment and every change are in the audit log with the agreement reference; the panel shows current Founding customers |
| Gap | There is no automatic end date or reminder. Recommended (not built): a small grants table with start/end dates and a reminder job, once the founders approve the process |

## 7. Plan versioning and subscriber protection (implemented)
A subscription points at a plan row with no price snapshot, so editing a sold row re-prices its customers. Therefore:
1. The new catalogue was added as new rows; historical rows were not edited, only hidden (`is_public=false`), and stay active.
2. **API guard:** changing the price, billing interval or GST rate of a plan that any organisation is or has ever been on is refused with `409 PLAN_HAS_SUBSCRIBERS`, unless the administrator sends an explicit acknowledgement (recorded in the audit log). Names, descriptions, limits and features stay editable (limits/features behaviour is unchanged from Phase 1, with the over-limit report).
3. The Super Admin editor shows how many restaurants are on the plan, locks the commercial fields behind a typed acknowledgement and explains that new terms mean a new plan.
4. New terms = new row; the old row is retired from the public list; moving customers is an explicit audited `change-plan` with notice.
5. Migration 018 never updates an existing plan row's commercial fields, hides historical plans once (recording the previous visibility), and its down script restores it and removes only unsubscribed new rows. Verified by test, including re-running after an operator edit.

## 8. GST and subscription invoices — readiness

| Requirement | Status |
|---|---|
| Consecutive serial, unique per financial year, ≤ 16 characters | **Done.** `PGT/2627/000001`, a per-year counter incremented in the same transaction as the invoice insert (a failed insert burns no number); the old timestamp-random form (~27 characters) is gone. Failed payment attempts carry an `ATTEMPT-…` reference and take no serial. Prefix is operator-editable but capped at 4 characters. Existing invoices keep their numbers |
| Place of supply (CGST+SGST vs IGST) | **Done.** From the organisation's billing profile (state code), falling back to gateway notes; same state as the supplier (setting `billing.supplierStateCode`, default 27) is CGST+SGST, otherwise IGST. Verified by test |
| Customer billing details (name, address, state, GSTIN) | **Done.** Owner-editable card on the Subscription page; API validates GSTIN format and that its state matches; audited |
| SAC code and GST rate | **[pending CA]** The plan carries `sac_code` (empty) and 18% |
| PDF tax invoice | **[pending]** not built |
| Invoice for manual / offline payments | **[pending]** manual grants create no invoice |
| Credit notes for subscription refunds | **[pending]** not built |
| E-invoicing / registration status / invoice format | **[pending CA / founders]** |
**Paid collection stays disabled** until the pending rows are reviewed and approved by the founders and their CA.

## 9. Super Admin
Existing controls are unchanged (plans, change/extend/trial/assign/cancel/reactivate with mandatory reasons, limit override, feature override, audit). Added: plan families (monthly and annual together) in groups with Public/Hidden/Retired/Monthly/Annual labels, subscribers by status, "ever subscribed", over-limit count, the trial configuration, a "close to or over their limits" panel (≥ 80% or over; a single-outlet plan with its one outlet is not flagged), the Founding 10 panel, and the sold-plan guard. Permissions: all views need `subscriptions.view`; editing needs `plans.manage`.

## 10. Behaviour changes made (and why)
| Change | Reason |
|---|---|
| New plan rows; historical plans hidden | Approved four-plan strategy; protects existing subscribers |
| Default trial plan `PANGAT_TRIAL` (was `GROWTH`) | 14-day trial with 1 outlet / 20 tables / 8 staff, as approved. Existing trials unchanged; a stored operator setting overrides the default |
| Inventory deduction requires the entitlement | Demonstrated defect: stock moved for organisations without Inventory |
| Sold plans cannot be re-priced silently | Demonstrated risk: in-place edits changed every subscriber's terms |
| Sequential invoice numbers, billing profile, place of supply | Demonstrated non-compliance (Audit F-40) |
No change to states, grace, expiry, entitlements resolution, limit enforcement or the webhook ledger.

## 11. Verified scenarios (executed)
Trial creation, 14 days, capacity caps; grace keeps working; expiry makes the account read-only; re-activation restores it; each plan's limits and features enforced through the API; downgrade and upgrade including Inventory; kill switch and override; historical plan unchanged; sold-plan guard; Super Admin listing, capacity and Founding views; permissions; billing profile; CGST+SGST vs IGST; consecutive invoice numbers and no serial for a failed payment; duplicate webhook; no checkout endpoint; migration idempotency, operator edits preserved, exact down/up.
**Not verified (no environment):** production data, real Razorpay, real tablets, a deployed Render/Neon environment.

## 12. Open decisions
Whether upgrades keep the Founding discount; outlets above a downgraded limit; data retention after expiry; refund policy for subscription fees (with the CA); SAC code, PDF invoices and credit notes; whether to build the Founding grants table and reminder.

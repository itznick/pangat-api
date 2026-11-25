# Pangat — Pricing and Limits

**Status:** the approved numbers, implemented in code (`src/subscriptions/default-plans.ts`), migration 018 and the public site (`pangat-web/src/features/landing/plans.ts`). Tests in both repositories pin these numbers.
All prices are in INR and **exclude GST**. GST (18% configured on each plan; rate, SAC and registration to be confirmed by the CA) is added on top and shown on the invoice. The displayed price is therefore not the final amount payable.

## 1. Public plans

| Plan | Code (monthly / annual) | Monthly | + 18% GST | Annual | + 18% GST | Annual saving |
|---|---|---:|---:|---:|---:|---:|
| Pangat Mini | `PANGAT_MINI_M` / `PANGAT_MINI_A` | ₹699 | ₹824.82 | ₹6,990 | ₹8,248.20 | ₹1,398 |
| Pangat Starter | `PANGAT_STARTER_M` / `_A` | ₹1,299 | ₹1,532.82 | ₹12,990 | ₹15,328.20 | ₹2,598 |
| Pangat Growth | `PANGAT_GROWTH_M` / `_A` | ₹2,499 | ₹2,948.82 | ₹24,990 | ₹29,488.20 | ₹4,998 |
| Pangat Enterprise (from) | `PANGAT_ENTERPRISE_M` / `_A` | ₹4,999 | ₹5,898.82 | ₹49,990 | ₹58,988.20 | ₹9,998 |

Annual = exactly 10 × monthly (two months free; 16.67% below twelve monthly payments). No quarterly plans exist anywhere.

| Plan | Outlets | Tables / outlet | Staff accounts / outlet | Entitlements |
|---|---:|---:|---:|---|
| Mini | 1 | 10 | 3 | QR ordering, kitchen display |
| Starter | 1 | 25 | 8 | + Reports (`ANALYTICS`) |
| Growth | 3 | 60 | 20 | + Inventory, multi-outlet |
| Enterprise | 5 | 100 | 40 | Same entitlements as Growth |

No plan is unlimited (`-1` is not used). **KDS screens are not limited and no cap is advertised** (not enforceable; see Feature Matrix).
Display order in the API and Super Admin is by price, grouped by plan family, monthly before annual.

## 2. Trial (non-public plan `PANGAT_TRIAL`)
14 days; no card; 1 outlet; 20 tables; 8 staff accounts; Growth-level features that are supported (reports, inventory) but not multi-outlet (one outlet only). It is selected by the platform setting `subscription.defaultTrialPlanCode` (default now `PANGAT_TRIAL`), is never listed, cannot be requested, and existing trials are unchanged. After 14 days the existing lifecycle applies (7-day grace with full access, then read-only).

## 3. Founding 10 (non-public rows, never assigned automatically)
20% below list price for the first 12 paid months, under a written price-lock agreement.

| Row | Monthly | Annual |
|---|---:|---:|
| `FOUNDING_MINI_*` | ₹559.20 | ₹5,592 |
| `FOUNDING_STARTER_*` | ₹1,039.20 | ₹10,392 |
| `FOUNDING_GROWTH_*` | ₹1,999.20 | ₹19,992 |
| `FOUNDING_ENTERPRISE_*` | ₹3,999.20 | ₹39,992 |

Same limits and features as the corresponding list plan. Rules: Lifecycle §6.

## 4. Add-ons and extra usage
None built. Original ideas (QR stand ₹199–₹399, additional outlet ₹499–₹799/month, +10 staff ₹199/month, additional KDS screen ₹199/month, advanced analytics ₹299/month, WhatsApp notifications usage-based, custom domain ₹499/year, assisted menu onboarding ₹499–₹999) remain future roadmap items, except that a QR stand and assisted onboarding may be sold by hand with a manual invoice if fulfilment is possible. Enterprise outlets beyond five are negotiated manually (a dated non-public plan row or a documented limit override). Nothing raises a subscription charge silently.

## 5. GST presentation
- Every public price is shown as "₹X + GST" or with the note "All prices exclude GST. GST is charged additionally at the applicable rate and shown on your invoice, so the amount you pay is higher than the price displayed."
- Owner plan cards show base price and the GST-inclusive total.
- Invoice requirements and current readiness: Lifecycle §8.

## 6. Where each number lives (they must agree)
| Place | File |
|---|---|
| API catalogue (code) | `pangat-api/src/subscriptions/default-plans.ts` |
| Production rows | `pangat-api/src/migrations/018_commercial_plans.sql` (generated from the code; a test fails if they differ) |
| Public site | `pangat-web/src/features/landing/plans.ts` (a web test pins it to this table) |
| Super Admin / owner pages | read from the API; no prices in code |

Changing a price means a **new plan row** in the API and the same change on the site; never an edit of a sold row (the API now refuses without an explicit acknowledgement).

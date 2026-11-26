# Pangat — Commercial Plan Strategy (approved structure, implemented)

**Status:** the founders' approved four-plan strategy is implemented in the backend, Super Admin and public site. It replaces the earlier alternative structure (Starter/Growth/Group) that appeared in a previous draft of this document; that draft is withdrawn.
**Companions:** `PANGAT_PLAN_FEATURE_MATRIX.md` · `PANGAT_PRICING_AND_LIMITS.md` · `PANGAT_SUBSCRIPTION_LIFECYCLE_RULES.md` · `PANGAT_COMMERCIAL_IMPLEMENTATION_REPORT.md` (what was built and tested, rollout steps).
**Still gated (founder + CA approval):** paid subscription collection, final publication of the Founding 10 section, and any claim about service commitments. See §8.

---

## 1. The approved plans

Prices exclude GST. Annual price is exactly ten times monthly (two months free, 16.67% off twelve monthly payments). No quarterly billing.

| Plan | Monthly | Annual | Annual saving | Outlets | Tables / outlet | Staff / outlet | Target |
|---|---:|---:|---:|---:|---:|---:|---|
| **Pangat Mini** | ₹699 | ₹6,990 | ₹1,398 | 1 | 10 | 3 | Food stalls, small cafés, kiosks, takeaway counters |
| **Pangat Starter** | ₹1,299 | ₹12,990 | ₹2,598 | 1 | 25 | 8 | Cafés, bakeries, small restaurants, QSRs |
| **Pangat Growth** | ₹2,499 | ₹24,990 | ₹4,998 | 3 | 60 | 20 | Established restaurants, small groups |
| **Pangat Enterprise** | from ₹4,999 | ₹49,990 | ₹9,998 | 5 | 100 | 40 | Chains, franchises, larger operations |

Enterprise includes five outlets. Additional outlets are negotiated by hand; there is no automated per-outlet billing.

## 2. What actually differentiates the plans (verified in code)

The product enforces three numeric limits (outlets, tables per outlet, staff accounts per outlet) and five feature entitlements (`QR_ORDERING`, `KDS`, `ANALYTICS`, `INVENTORY`, `MULTI_OUTLET`). Everything else, including order management, table management and staff roles, is present on every plan. So, honestly:

| Step up | What genuinely changes |
|---|---|
| Mini → Starter | 10 → 25 tables, 3 → 8 staff accounts, and the **Reports page** (`ANALYTICS`). Mini still has the dashboard's "today" revenue, covers and prep-time figures |
| Starter → Growth | 25 → 60 tables, 8 → 20 staff, **Inventory** (ingredients, recipes, stock tracking, low-stock alerts, automatic sold-out) and **up to 3 outlets** (`MULTI_OUTLET`) |
| Growth → Enterprise | 3 → 5 outlets, 60 → 100 tables, 20 → 40 staff. **No additional software feature exists today**: the Enterprise software entitlements are identical to Growth's. The rest of the difference is service (arranged onboarding, a dedicated contact), which is a business commitment rather than software |

The brief listed "advanced order management", "table management", "order status tracking" and "staff roles and permissions" as Starter items. They exist on all plans and cannot be withheld from Mini without building a new entitlement; they are therefore described as part of every plan, and not sold as an upgrade. Likewise there is a single Reports feature, so "basic" versus "advanced" analytics is not presented as a distinction between Starter and Growth.

## 3. Commercial assessment (candid)

- **Price points.** Third-party listings place lightweight QR-ordering tools at roughly ₹400–₹1,500 a month and full POS suites far higher (listed estimates are vendor-adjacent and conflicting; confirm before relying on them). ₹699 and ₹1,299 sit inside the QR-tool band with more included (kitchen display, GST bills, staff roles); ₹2,499 and ₹4,999 sit below the POS band but above it in ambition: **Growth and Enterprise are only defensible while Pangat's inventory and multi-outlet value is real to the buyer**, and Enterprise today is capacity plus service, not new software. Treat Enterprise as "talk to us", which is how it is presented.
- **Revenue is SaaS only.** Pangat takes no commission. Restaurants pay Razorpay's own charges (quoted 2% plus GST) only if and when online payments are built.
- **Validate before scaling.** These are founder-chosen prices that have not been tested with customers. Use the Founding 10 conversations to learn what restaurants will pay.

## 4. Positioning (what the site now says)
Table ordering and kitchen display for Indian restaurants; QR-based digital menu; order management; kitchen display; staff and outlet management; inventory on Growth and above; reports on Starter and above. It does not claim to replace a POS, printer, payment gateway or delivery aggregator.

## 5. Founding 10 (original offer, restored)
First ten restaurants in Pune: 14-day free trial; 20% off the first 12 paid months; free assisted onboarding; free digital QR design; a direct founder feedback channel; priority consideration for feature requests; a written 12-month price-lock agreement. **Not a lifetime discount.** Mechanics, auditing and open points are in `PANGAT_SUBSCRIPTION_LIFECYCLE_RULES.md` §6. The public section is written and tested but **unpublished** (`FOUNDING_10_PUBLISHED = false`) until the founders confirm they can fulfil it.

## 6. Add-ons (intent only; nothing built)
Physical QR stand (₹199–₹399 one-time) and assisted menu onboarding (₹499–₹999 one-time) may be offered by hand if fulfilment is possible. Additional outlet (₹499–₹799/month), additional 10 staff (₹199/month), additional KDS screen (₹199/month), advanced analytics (₹299/month), WhatsApp notifications (usage-based) and custom domain (₹499/year plus domain cost) are **future roadmap items**: the platform has no add-on billing engine, no KDS device registration, no separate advanced-analytics entitlement and no WhatsApp channel. None is advertised and nothing silently raises a subscription charge.

## 7. Existing customers
Plan rows that have ever been subscribed are commercial records. The new catalogue was added as **new rows**; the historical rows (`STARTER`, `GROWTH`, `ENTERPRISE` and annual variants, at ₹1,499 / ₹2,999 / ₹5,999) were **not edited**, are only hidden from the public list, stay active, and nobody is moved automatically. The API now refuses to re-price a plan that anyone is or has been on, unless a platform administrator explicitly acknowledges the impact (audited). Details: Lifecycle §7.

## 8. Decisions and approvals still needed from the founders
1. **Service commitments.** "Priority support" (Growth, Enterprise), "dedicated Pangat contact" and "onboarding arranged with our team" (Enterprise) are shown on the site. Confirm you can deliver them, or ask for them to be removed.
2. **Founding 10 publication** and its fulfilment (assisted onboarding, QR design, the written agreement, how the 12-month period is tracked).
3. **Paid subscription collection** stays off until invoice numbering (done), customer billing details (done), place of supply (done), SAC/GST treatment, PDF invoices and credit notes are reviewed by the CA, and the Razorpay subscription integration is built and approved.
4. **Contact details on the site** (`hello@pangat.app`, the WhatsApp number, the domain) are unverified and pre-existing; confirm them.
5. **Production plan data** before rollout: run `docs/staging/commercial_plans_precheck.sql` and review (Implementation Report §9).

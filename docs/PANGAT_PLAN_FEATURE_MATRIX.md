# Pangat — Plan Feature Matrix

**Status:** implemented and tested (see `PANGAT_COMMERCIAL_IMPLEMENTATION_REPORT.md`). Companion to the Commercial Plan Strategy.
**Rule applied:** a feature is allocated or advertised only if the code enforces it or demonstrably provides it. Everything else is classified and listed under "not advertised".

## 1. What the entitlement engine can express (unchanged architecture)
- **Feature keys on a plan:** `QR_ORDERING`, `KDS`, `ANALYTICS`, `INVENTORY`, `MULTI_OUTLET`. (`ADVANCED_REPORTS` exists as a key but nothing is built behind it; it is on no plan and cannot be added.) Decisions come from one resolver (plan + platform kill switch + per-restaurant override).
- **Numeric limits:** outlets, tables per outlet, staff accounts per outlet (a seat is an active, real-person staff account; the owner and the shared kitchen-station login are free). Over-limit data is never deleted; the restaurant simply cannot add more.
- **Not expressible today:** a KDS screen/device cap, separate basic/advanced analytics, add-ons, discounts, quarterly intervals.

## 2. Classification of every item in the brief

| # | Item | Classification | Evidence / enforcement | Plans |
|---|---|---|---|---|
| 1 | QR menu and QR ordering | **1 Implemented and enforced** | `QR_ORDERING`: `POST /orders`, public menu | All |
| 2 | Kitchen Display System (access) | **1** | `KDS`: PIN sign-in, live feed, kitchen-role APIs | All |
| 3 | KDS **screen limits** (1/2/5) | **3 Requires implementation** and **4 not approved for launch as a claim** | No device registration or counting exists; any number of tablets can open the display | Not advertised |
| 4 | Order management, status tracking | **2 Implemented but not separately enforced** | Status, edit, cancel, mark paid, refund, bills: all plans | All |
| 5 | "Basic" vs "Advanced" order management | **4** | One implementation; no separate entitlement | Not distinguished |
| 6 | Table management | **2** | Tables, QR kit, status; capped by `max_tables_per_outlet` | All (cap differs) |
| 7 | Staff roles and permissions | **2** | Owner, manager, chef, steward, cashier; capped by `max_staff_per_outlet` | All (cap differs) |
| 8 | Restaurant-side order history | **2** | Orders list with filters and bills | All |
| 9 | Customer accounts / customer-owned order history | **4 Not approved** | No such feature | Not advertised |
| 10 | Basic sales summary | **2** | Dashboard "today": revenue, covers, prep time, active tickets (not gated) | All |
| 11 | Order and sales reports | **1** | `ANALYTICS` gates `/reports/*` (totals, GST, refunds, payment mix, order types, hourly, best-sellers, kitchen times) | Starter and above |
| 12 | "Advanced analytics" | **3 / 4** | There is one Reports feature. No separate entitlement. Smallest change if wanted later: a second key (e.g. `ANALYTICS_ADVANCED`) plus a defined report set | Not advertised |
| 13 | Inventory, recipes, stock tracking, low-stock alerts | **1** | `INVENTORY` on `/inventory/*`. **Defect fixed in this release:** automatic stock deduction, order-edit adjustment and automatic sold-out marking now stop when the entitlement is lost (downgrade, expiry, kill switch, override) and resume when it returns; a deduction that already happened is still reversed on cancel | Growth and above |
| 14 | Purchase orders / supplier management | **4** | Not built | Not advertised |
| 15 | Staff performance reports | **3 / 4** | Not built | Not advertised |
| 16 | Several outlets under one owner (create, switch, per-outlet roles and reports) | **1** | `MULTI_OUTLET` + `max_outlets` | Growth (3), Enterprise (5) |
| 17 | Outlet-wise reporting | **2** | Reports are per selected outlet | Growth and above (as "each outlet has its own reports") |
| 18 | Consolidated reporting, outlet comparison | **3 / 4** | No cross-outlet roll-up exists | Not advertised |
| 19 | Central menu management | **3 / 4** | Menus are per outlet | Not advertised |
| 20 | Advanced role management | **2** | Same roles on every plan | Not advertised as an upgrade |
| 21 | Standard support | Service | Support tickets in the product | Mini, Starter |
| 22 | Priority support, dedicated account contact, custom onboarding | **Service commitment**, not software | Cannot be enforced in code | Shown on Growth/Enterprise; **founder to confirm deliverability** |
| 23 | API integrations | **4** | None | Not advertised |
| 24 | Add-ons, extra usage charges | **3 / 4** | No add-on billing engine | Not advertised |
| 25 | Founding 10 discount | **3** (no automation) | Non-public plan rows assigned by hand, audited | Site section written, unpublished |
| 26 | Subscription checkout and automated billing | **3** | No Razorpay subscription creation exists; deliberately off | Not offered |

## 3. Plan matrix (what is enforced)

| | Mini | Starter | Growth | Enterprise | Trial (non-public) |
|---|:--:|:--:|:--:|:--:|:--:|
| Outlets | 1 | 1 | 3 | 5 | 1 |
| Tables per outlet | 10 | 25 | 60 | 100 | 20 |
| Staff accounts per outlet | 3 | 8 | 20 | 40 | 8 |
| `QR_ORDERING` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `KDS` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `ANALYTICS` (Reports page) | — | ✅ | ✅ | ✅ | ✅ |
| `INVENTORY` | — | — | ✅ | ✅ | ✅ |
| `MULTI_OUTLET` | — | — | ✅ | ✅ | — |
| Order/table management, staff roles, order history, dashboard summary, bills, feedback | ✅ | ✅ | ✅ | ✅ | ✅ |

The Founding 10 rows carry the same limits and features as the list plan they discount.

## 4. Smallest entitlement changes if the founders later want the brief's finer distinctions
These are **not** implemented and not needed to sell the approved plans honestly.
1. **Advanced analytics:** add a feature key and gate a defined set of extra reports (roll-up, cashier close-out, export) behind it. Requires building those reports first.
2. **KDS screen cap:** device registration with counting and revocation, plus a numeric limit column on plans. A new subsystem; do not advertise until built and tested.
3. **Advanced order management for Starter:** only meaningful if specific capabilities are moved behind a key; today there is nothing to move.

# Pangat — future reporting ideas (not built, not advertised)

**Status:** ideas for later, recorded so they are not lost. **Nothing here exists in the product and none of it may appear on the landing page, in pricing or in sales material until it is built and tested.** Today's reports are one outlet, one date range, with sales, GST, tax split, payment-method and order-type splits, top items and an hourly view (`GET /reports/summary`).

| Idea | Why an owner would want it | What it needs | Notes |
|---|---|---|---|
| End-of-day cash and UPI close-out | Reconcile the till and the UPI app at night | Payments already carry method and settle time; needs a per-cashier and per-shift grouping and a "counted cash" entry | Highest value for a pilot owner |
| CSV / spreadsheet export | The accountant wants the numbers | An export endpoint with the same tenant and role rules as the report; spreadsheet-injection-safe cells | Bills and credit notes with their numbers are the useful rows |
| GST summary for filing support | Monthly tax totals by rate, with CGST/SGST/IGST | Already stored per document; needs a monthly view and CA review of the layout | Do not call it a GST return |
| Multi-outlet roll-up | Owners with several branches | Organisation-level aggregation with per-outlet permissions | Plan-gated (Growth and above) |
| Food cost and wastage | Margin per dish | Inventory recipes and stock movements exist; needs cost reporting | Depends on owners keeping recipes current |
| Slow movers and menu engineering | Remove or reprice weak dishes | Order item history | Reads only existing data |
| Peak-hour staffing view | Roster against demand | Hourly orders exist | Simple chart |
| Refund and cancellation review | Spot misuse | Refunds and cancellations are already audited | Surfaces patterns by staff member |
| Guest feedback trends | Quality over time | Feedback already stored | Needs minimum counts to avoid noise |
| Scheduled email summary | Owners who do not open the app | An email provider with delivery tracking (the alert delivery log is the model) | **Not WhatsApp.** The earlier landing claim about a daily WhatsApp summary was removed because it does not exist |

Rules for any of these: tenant-scoped like every report, role-restricted (owner and manager), no personal data beyond what the report needs, and tested the way the existing reports are before anyone is told about them.

# Pangat — Staging deployment checklist (pilot release)

**Purpose:** put the pilot-readiness release on a *staging* environment and prove it there before any real restaurant uses it.
**Status of this document:** a checklist to be executed by a person with access. **Nothing in it has been executed.** No staging environment exists yet in this repository's history; creating one needs founder approval where it costs money (see §1).
**Hard rules:** never run anything here against production; never use the production database or its secrets in staging; no step below requires paid infrastructure unless §1 says so and the founders approved it.

Builds on `docs/staging/STAGING_CHECKLIST.md` (Phase 1: backup/restore, entitlement audit, migration 017 rehearsal). Do those first if they were never done; this file adds what the pilot release changed.

Legend: ☐ = to do · record result and date beside each line.

---
## 1. Decisions and access needed before starting (BLOCKED until provided)
| Need | Why | Who | Cost |
|---|---|---|---|
| A separate staging API service | Never test on production | Founders | Free tier is acceptable for a pilot rehearsal; a free tier that sleeps will **delay the first request and pause background jobs** (alert retries, subscription sweep). Note this limitation in the results. |
| A separate staging PostgreSQL | Realistic, disposable data | Founders | A free database/branch. **Not** the production database. |
| An email provider key for staging | Prove alert delivery for real | Founders | A free-tier provider is enough |
| A real phone with a UPI app and a bank account the founders control | The ₹1 UPI verification (§8) | Founders | ₹1 |
| A kitchen tablet or phone, and a second device as a guest | Real-device kitchen and diner checks | Founders | none |
| Read-only access to a production schema dump | Schema drift comparison (§3) | Whoever holds production access | none |

☐ Founders approved the staging environment in writing. ☐ Provider/hosting names recorded: ______

## 2. Release candidate
☐ API and web branch `claude/nifty-wright-ith4qq` at the commits under test: API `git rev-parse HEAD` = ______ ; web = ______ .
☐ CI is green on that commit: API `build-and-test` and `live-suites`; web `build-and-test` (and `browser-tests` if enabled).
☐ No secrets or `.env` files in the diff (`git diff <base>..HEAD --stat`, gitleaks job green).

## 3. Database
☐ **Backup first** of the staging database (`docs/staging/backup_restore_check.sh`). Keep the file and its sha256.
☐ **Schema drift check** (read-only). Dump production's *schema only* (a person with access runs `scripts/schema/dump-schema.sh`), then:
```bash
scripts/schema/compare-schema.sh <production_schema.sql> docs/schema/reference_schema_after_021.sql
```
Expected: differences are understood. Anything unexpected is reviewed *before* migrating. This is the evidence the baseline strategy (`docs/SCHEMA_BASELINE_STRATEGY.md`) is waiting for.
☐ **Rehearse migrations 018 to 021 on a copy** of staging data (apply twice; second run changes nothing):
- 018 commercial plans (run `docs/staging/commercial_plans_precheck.sql` first; it is read-only)
- 019 billing profile / invoice series
- 020 payment integrity: it adds a partial unique index on bills and a refund `CHECK`. The migration **skips the unique index if duplicate bills already exist** and the refund check is added `NOT VALID`. Run this read-only query and record the result; a non-empty result needs a human decision, not a forced migration:
```sql
SELECT order_id, count(*) FROM tax_documents WHERE kind = 'BILL' GROUP BY order_id HAVING count(*) > 1;
```
- 021 alert deliveries and go-live checklist storage
☐ Each migration's `.down.sql` was rehearsed on the copy and the application still booted before re-applying.

## 4. Configuration (staging API and web)
| Item | Required |
|---|---|
| `NODE_ENV` | `production` (schema sync off; numbered migrations apply at boot) |
| `DATABASE_URL` | the **staging** database; direct (non-pooled) endpoint for the first boot because migrations use an advisory lock |
| `JWT_SECRET` | random, 32+ characters, not the dev value |
| `FRONTEND_URL` | the exact staging web origin; no `*` |
| `THROTTLE_DISABLED`, `JOBS_DISABLED`, `SOCKET_REVALIDATE_MS` | **unset** |
| `PLATFORM_BOOTSTRAP_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | set (webhook answers 503 without it); staging values, not production's |
| Email | a provider key or SMTP set **in staging only**; recipients for alert emails set in Super Admin > Settings > Notifications |
| Self sign-up | **off** (the default). Confirm: `GET /api/v1/platform/config` shows `selfSignupEnabled: false` |
| Web build | `VITE_API_URL` and `VITE_WS_URL` point to the staging API |
☐ After boot the log shows migrations 018 to 021 applied once and no error. ☐ `GET /health` is OK.

## 5. Deploy order
1. Backup verified (§3). 2. Deploy **API**; check `/health` and the log. 3. Deploy **web**. 4. Run §6 to §10.

## 6. Provisioning and go-live (Super Admin, then owner)
☐ Provision a test restaurant from a lead (Super Admin > Leads). Expect: **no UPI ID is pre-filled**; trial plan "14-day" with 1 outlet / 20 tables / 8 staff.
☐ Owner signs in with the one-time password and sets a new one.
☐ Owner dashboard shows the **go-live checklist**. Expect honest state: menu/tables done, kitchen PIN **not** done, UPI "needs attention" if UPI is on.
☐ Owner sets the kitchen PIN under Settings > Kitchen (the PIN is shown nowhere afterwards). Checklist ticks it.
☐ Kitchen device signs in with the PIN and opens the display. Checklist ticks "kitchen display opened".

## 7. Money safety (use disposable test orders only)
☐ Place the same order twice quickly (double tap): **one** order, one ticket.
☐ Mark paid from two devices at once: **one** bill number.
☐ Cancel a paid order and refund twice with the same request: **one** credit note; a larger refund than the total is refused.
☐ A refund attempted with the same key but a different amount is refused (conflict).

## 8. UPI (the founders do this personally)
☐ With UPI on and the ID **unconfirmed**: the diner sees **no** UPI pay button, only counter payment.
☐ Owner confirms the UPI ID in Settings (after sending themselves ₹1). The diner now sees "You are paying <restaurant name>".
☐ Diner pays ₹1 from a real phone: the money reaches **the restaurant's** account (not any other). The order stays "pending" until the cashier marks it paid; the screen never claims it was paid automatically.
☐ Change the UPI ID: the confirmation clears and UPI disappears for diners until re-confirmed.

## 9. Kitchen reliability (real tablet)
☐ Display shows **Connected**. Turn the tablet's Wi-Fi off for a minute: it shows **Offline** and the warning banner. Place an order meanwhile from another device. Turn Wi-Fi on: the order **appears by itself**, once, and the badge returns to Connected.
☐ "Enable kitchen sound" banner appears after a reload; tapping the button plays a chime. A new order chimes.
☐ "Keep screen on" shows **Screen stays on** (or an honest message if the browser refuses). Leave it 10 minutes: the screen does not sleep.
☐ Sign the kitchen user out in another tab / let the session expire: the display signs out cleanly instead of showing stale tickets.

## 10. Operator alerts
☐ Super Admin > Monitoring > **Alert delivery**: health shows what is missing (recipients/provider) until configured.
☐ Submit a lead from the landing page: a bell event appears **and** an email arrives (alerts on). Request a plan change from an owner account: same.
☐ Break the provider key on purpose: the lead still saves, the delivery shows **Failed** with a reason; fix the key and press **Retry now**: it sends once.

## 11. Sign-off and rollback
☐ Results recorded; defects triaged (blocker / acceptable for pilot).
**Rollback:** redeploy the previous API and web builds; restore the §3 backup if a migration must be undone (`.down.sql` scripts exist for 018 to 021 and refuse to delete data that exists). Rollback does not need paid tooling.

## What this checklist cannot tell you
It proves the release behaves on staging. It does **not** prove production is configured the same way (production was never inspected), that the production database has no duplicate bills, or that the production hosting tier keeps background jobs running. Those remain open until a person with production access checks them.

# Pangat Phase 1 — Staging deployment checklist

Release under test: **API `9e45f25`** (approved) and **web `6457ec1`** (approved). The branch also carries test-only and documentation commits after them
(see the final approval report); none changes runtime code. Use disposable tenants only. **Never run any script in this folder against production.**
Every script refuses a target database whose name does not end in `_verify`, and refuses managed-database hosts unless `STAGING_ALLOW_REMOTE=yes`.

Legend: ☐ = to do · **Expected** = what a pass looks like · record the result and the date next to each line.

---
## 0. Preconditions
☐ A staging database that is a **copy** of production data (or realistic seed data) and a staging API/web environment. Neon: use a **branch** of the production database, not production itself.
☐ You can read the staging database with `psql` (needed by the verification scripts) and have `pg_dump`/`pg_restore` 16.
☐ Release candidate checked out: `git rev-parse HEAD` shows the approved commits (`git merge-base --is-ancestor 9e45f25 HEAD`; same for web `6457ec1`). The earlier API commit `7dda8b0` must never be deployed on its own (it contains the deadlock).

## 1. Backup and restore verification (before anything is deployed)
```bash
SOURCE_URL='postgres://…/staging_db'  TARGET_URL='postgres://…/pangat_restore_verify' \
  docs/staging/backup_restore_check.sh
```
**Expected:** every line PASS, final line `BACKUP/RESTORE VERIFIED`; row counts equal for organisations, restaurants, tables, staff, orders, subscriptions and the append-only audit/tax tables; `schema_migrations` restored.
☐ Keep the dump file; record its sha256. This is the rollback point (§12).
☐ Neon: also create a point-in-time **branch** now and note its name/time.

## 2. Existing-tenant entitlement audit — BEFORE deploy
```bash
psql "$STAGING_URL" -f docs/staging/entitlement_audit.sql   # read-only
```
**Expected before deploy:** (1) lists plans lacking `QR_ORDERING`/`KDS` that are in use — **each such plan will be repaired by migration 017**, but note them; (2) organisations with several outlets on plans without `MULTI_OUTLET` (017 adds the feature to plans with `max_outlets <> 1`); (3)/(4) outlets already above their table/seat limit (nothing is deleted, they just cannot add more); (5) organisations without a subscription (a trial is created on first use); (6) rows the sweep will move to grace/expired; (7) plans carrying `ADVANCED_REPORTS` (hidden, harmless); (8) must be empty.
☐ Save the output as `entitlements_before.txt`.

## 3. Migration 017 rehearsal on a disposable copy
```bash
COPY_URL='postgres://…/pangat_restore_verify'  docs/staging/migration_017_check.sh
```
(run it on the database restored in §1)
**Expected:** `up applied`, `second run changed nothing`, `up only appended features`, `down restores the pre-017 plan features exactly`, final `MIGRATION 017 REHEARSAL PASSED`, followed by the before→after plan diff. Review that diff: every changed plan only *gained* `QR_ORDERING`, `KDS` or `MULTI_OUTLET`.
Manual rollback rehearsal on the copy: `psql "$COPY_URL" -f src/migrations/017_plan_feature_enforcement.down.sql` → plans return to the pre-017 state, `plan_feature_backfills` is gone.

## 4. Configuration checks (staging API and web)
| Item | Required value / check |
|---|---|
| `NODE_ENV` | `production` (schema sync off; numbered SQL migrations apply on boot) |
| `DATABASE_URL` | the staging database; **non-pooled/direct endpoint for the first boot** (the migration runner uses a Postgres advisory lock, which a transaction-pooling endpoint does not honour); `DATABASE_CA`/SSL as before |
| `JWT_SECRET`, `ADMIN_JWT_EXPIRATION`, `JWT_EXPIRATION` | set, 32+ characters, not the dev value |
| `FRONTEND_URL` | exact staging web origin(s) (CORS); no `*` |
| `AUTO_MIGRATE` | unset or `true` for this release (017 applies at boot); `false` only if you apply SQL by hand |
| `THROTTLE_DISABLED` | **must be unset** (throttling is a security control) |
| `JOBS_DISABLED` | unset (the subscription sweep must run) |
| `SOCKET_REVALIDATE_MS` | **unset** (default 30 000 ms) — only set low in disposable test runs |
| `PLATFORM_BOOTSTRAP_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, e-mail provider keys | as in production; webhook secret present (webhook answers 503 without it) |
| Proxy trust count | matches the number of proxies in front of the API |
| Web build | `VITE_API_URL` / `VITE_WS_URL` point to the staging API; built from `6457ec1` |
| DB pool | API pool is 15 connections: confirm the database allows ≥ 15 per API instance |
☐ After boot, the API log shows `Applying migration 017_plan_feature_enforcement.sql` once (or nothing if already applied) and no migration error.

## 5. Deployment order
1. §1 backup verified. 2. Deploy **API** `9e45f25` (boots, applies 017). 3. Check `GET /health` and the log. 4. Deploy **web** `6457ec1`. 5. Run §6–§11.
Why this order: the new API is backward compatible with the old web (it already sends tokens on the staff listings; ignores new fields). The new web against the *old* API only degrades (no entitlements → no stock-alert polling, no lock icons), so API-first is always safe. Rollback is the reverse (§12).

## 6. Existing tenant entitlements — AFTER deploy
☐ `psql "$STAGING_URL" -f docs/staging/entitlement_audit.sql > entitlements_after.txt`; **query 1 must now be empty**; query 2 shows existing multi-outlet organisations unchanged.
☐ `SELECT code, max_outlets, features FROM subscription_plans ORDER BY code;` and `SELECT * FROM plan_feature_backfills;` match the §3 rehearsal.
☐ Restart the API once: the log must not re-apply or change plans.
☐ Sign in as 3 real staging owners (different plans): billing page shows their plan and usage; place a guest order, use the kitchen screen, open Reports/Inventory only where the plan has them.

## 7. Role journeys (one disposable tenant; create each person from Settings → Team)
| Role | Must work | Must be refused |
|---|---|---|
| **Owner** | sign in; billing/entitlements; add tables up to the limit; add staff up to the limit; add an outlet only with MULTI_OUTLET; settings; menu; reports/inventory per plan; switch between own outlets | the 5th table on a 4-table plan (clear message); outlet without MULTI_OUTLET (upgrade notice); override control (not shown; `limitOverrideReason` → 403) |
| **Store manager** | tables add/delete, menu, orders, settings (not UPI/GST/service charge), set kitchen PIN, list tables/menu of **their** outlet | create staff or outlets (403); another outlet's tables/menu (403) |
| **Kitchen (chef)** | PIN sign-in → KDS; live tickets; Start Prep → Mark Ready; sold-out switch; list menu items of own outlet | admin room, order rooms, reports, other outlets (403); everything on KDS-less plans |
| **Steward** | floor view, table status, edit/cancel orders; settle only if the outlet allows | settings, menu edit, staff, refunds |
| **Cashier** | table status, mark paid | cancel/edit orders, settings, menu |
For each role also confirm: `GET /tables?restaurantId=<other organisation's outlet>` → 403 and, for non-owners, `GET /tables?restaurantId=<sibling outlet of the same organisation>` → 403; anonymous → 401.

## 8. Diner QR ordering
☐ Open `/r/<slug>/t/<table>` on a phone (no sign-in): menu loads; add item; checkout; order placed (dine-in and takeaway); tracking page updates when the kitchen advances the order.
☐ Switch `QR_ORDERING` off for the tenant (Super Admin → restaurant → Feature access, or the plan): menu still opens, ordering shown as closed, direct `POST /orders` → 400. Switch back: ordering works.

## 9. Socket revocation and reconnection (real kitchen tablet)
1. Kitchen PIN sign-in on the tablet; place a guest order → ticket appears live. Keep the owner's Orders screen open on a laptop.
2. In Super Admin, do each of: change the plan to one without KDS; flip the global KDS switch; set a per-restaurant `FORCE_OFF`; cancel the subscription immediately. **Expected after each (≤ ~1 s, ≤ 30 s worst case):** the tablet replaces the board with "kitchen display is not included…" and stops receiving tickets; the owner's Orders screen keeps receiving orders; a fresh PIN sign-in is refused with a clear message.
3. Restore (plan/switch/override/extend). **Expected:** the tablet recovers on its own within ~30 s and receives new tickets live; PIN sign-in works again.
4. Safety net: change the plan **directly in the database** on the disposable tenant → the tablet is revoked within ~30 s.
5. Deactivate the kitchen user while connected → revoked within ~30 s.

## 10. Super Admin override and audit
☐ As platform OWNER/ADMIN open a restaurant console that is at its table limit, add a table → refusal with the limit message → "Exceed plan limit (audited exception)…" → reason < 10 characters keeps Apply disabled; ≥ 10 + acknowledgement → table created.
☐ Check **Audit log** (platform) and the restaurant's *Subscription → Billing events*: `PLAN_LIMIT_OVERRIDDEN` with actor, reason, limit, current, requested.
☐ Provision a restaurant above the trial plan's table limit: refused → exception flow → created; audit shows `limit 40, current 0, requested N` (or your trial plan's values).
☐ As a restaurant owner at the limit: no override control; API with `limitOverrideReason` → 403 `LIMIT_OVERRIDE_FORBIDDEN`. As a read-only analyst admin: cannot enter a restaurant console.

## 11. Subscription expiry/restoration and concurrency
☐ Disposable tenant: Super Admin → Cancel immediately → owner still signs in and sees billing; editing/adding is blocked with the subscription message; an in-flight order can still be settled; guests cannot order; the kitchen feed is cut. Extend → everything returns at once.
☐ Grace window: set `subscription.gracePeriodDays`; a period that ended recently keeps working until grace ends.
☐ Concurrency (disposable tenants; needs DB access to the staging database for test setup):
```bash
UAT_API=https://<staging-api>/api/v1 DATABASE_URL=<disposable staging db> npm run test:phase1_1   # deadlock hunt, settings race, platform permissions
UAT_API=… DATABASE_URL=… npm run test:phase1_final                                                # five roles' isolation, settings overwrite check
SOCKET_REVALIDATE_MS=<value the staging API runs with> UAT_API=… DATABASE_URL=… npm run test:phase1_2   # socket tests (periodic ones need the short interval; skip otherwise)
```
During the run: `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();` before and after must be equal. **Do not run these suites against a database holding real customer data** (they create and modify tenants and plans); use the copy.
☐ Manual: open Settings on two browsers; save different fields at the same time as adding tables; nothing is lost.

## 12. Rollback procedure
| Situation | Action |
|---|---|
| Web problem only | redeploy the previous web build (API is compatible) |
| API problem, no data concern | redeploy the previous API build. Migration 017 only *added* plan feature keys and a record table; the previous API ignores both, so **no database action is needed** |
| Plan features must return to the pre-release state | on staging first: `psql -f src/migrations/017_plan_feature_enforcement.down.sql` (removes exactly what 017 added; operator edits made afterwards are kept; safe if 017 is not applied) |
| Data damage | restore the §1 dump into a new database and repoint, or restore the Neon branch/PITR; verify with `backup_restore_check.sh` row counts |
After any rollback: restart, run §6 first lines, confirm guest ordering and the kitchen screen on a real tenant.

## 13. Go / no-go
Go only if: §1 and §3 scripts PASS; §6 query 1 empty; every §7–§11 line passes; no deadlock increase; no 5xx in the API log during the runs. Record who ran it and when. **Production deployment and merge still need explicit approval.**

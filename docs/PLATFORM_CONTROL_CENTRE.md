# Platform Control Centre (Super Admin)

Everything under `/api/v1/admin/**` is permission-checked on the server (`PlatformAdminGuard` + `@RequirePermission`).
A route without a declared permission is denied (covered by a test).

## Roles & permissions
`src/platform/permissions.ts` holds the catalogue. Roles: **OWNER** (everything), **ADMIN** (all but administrator management),
**FINANCE**, **SUPPORT**, **ANALYST** (read-only). A platform admin with no `platform_role` is treated as OWNER (legacy accounts).
Per-person overrides are stored in `staff.platform_permissions`. A role change applies on the next request (permissions are
re-read from the database on every call). A read-only platform role also cannot mutate data inside a restaurant console
(`merchant.operate`, enforced in `TenantGuard` / `RolesGuard`).

## Data model (migration `010_platform_control_centre.sql`, idempotent)
New tables are raw-SQL only (no TypeORM entities): `platform_audit_logs` (append-only via DB triggers), `organization_notes`,
`webhook_events`, `login_events`, `error_logs`, `job_runs`, `health_snapshots`, `platform_settings` (secrets AES-256-GCM),
`feature_flags`, `org_feature_overrides`, `announcements`, `notification_templates`, `platform_notifications`,
`notification_deliveries`, `platform_events`, `support_tickets`, `support_ticket_events`, `data_exports`.
Added columns: organization status/verification, staff platform role, plan trial days / visibility, subscription source,
invoice failure/refund detail.

## Payments
Invoices (and therefore revenue) are created **only** from Razorpay webhooks whose HMAC signature verifies
(`subscription.charged`, `payment.captured`, `payment.failed`, `refund.processed`). Every delivery - accepted or rejected -
is written to `webhook_events`. There is no endpoint to mark a payment paid. A manual plan grant creates no invoice and never
counts as revenue (source = `MANUAL`).

## Enforcement hooks
Suspended/deactivated restaurant: blocked at login, in `JwtStrategy` (live tokens), and for guest orders (`getOrgAccess`).
Maintenance mode: restaurant users blocked at login and in `JwtStrategy`. Feature switches: `FeatureGuard`, guest ordering
(`QR_ORDERING`) and extra outlets (`MULTI_OUTLET`). Plan limits (outlets / tables / staff) were already enforced and are unchanged.
Grace period and trial length come from platform settings / the plan.

## Operations
- Background jobs (`JOBS_DISABLED=true` to turn off): health sampling (5 min), subscription expiry sweep + trial reminders (hourly),
  log retention (daily). Each run is recorded in `job_runs`; a database claim prevents double runs across instances.
- `PLATFORM_SETTINGS_KEY` encrypts stored secrets (falls back to `JWT_SECRET`).
- Tests: `npm run test:platform` (needs a running API + Postgres, see the header of `test/platform-control.e2e.test.mjs`).

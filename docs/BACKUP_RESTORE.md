# Backup and restore

Pangat's data lives in a Neon PostgreSQL database. Pangat does **not** run its own backups: recovery relies on Neon's
point-in-time recovery (PITR) and branching. This page says exactly how to use them and how to prove they work.

## What the targets are

- **RPO** (how much data we can lose): as little as Neon's PITR window allows (minutes). Check your Neon plan: the free plan has a short
  history window (hours), paid plans keep days to weeks. **Choose a plan whose window covers how long it could take you to notice a mistake.**
- **RTO** (how long to be back): target 1 hour for a restore, rehearsed below.

## Before real customers: do these once

1. In the Neon console open **Project → Settings** and write down the plan's **restore window**: ______ .
2. Confirm the project is in a region you are comfortable with for personal data (Neon console → Region): ______ .
3. Run the **restore drill** below and write the date and how long it took here: ______ .

## Restore drill (never practise on production)

1. Neon console → **Branches** → *Create branch* from your main branch, choosing **a point in time** a few minutes ago.
   The branch is an independent copy; it costs nothing to try.
2. Copy that branch's connection string.
3. Start a throw-away API against it, locally or on a spare service:
   `DATABASE_URL=<branch string> JWT_SECRET=<any 32+ chars> NODE_ENV=production AUTO_MIGRATE=false node dist/main`
4. Sign in as an admin and check: restaurants, recent orders, the audit log, `schema_migrations` has every file (001 to the latest).
5. Run `npm run test:integration` against it only if it is a **throw-away branch** (the tests create data).
6. Delete the branch. Record the time taken.

## Real restore after a mistake or incident

1. **Stop writes**: turn on Maintenance mode (Super Admin → Settings → Operations) so nobody adds data while you recover.
2. Neon console → create a branch from the **last good point in time**. Do not overwrite main yet.
3. Check the branch as in the drill.
4. Choose one:
   - **Switch over**: in Render change `DATABASE_URL` to the branch's connection string and redeploy. (Fastest; the old main stays untouched for investigation.)
   - **Restore main to that time** using Neon's *Restore* on the branch (only when you are sure; this discards later data).
5. Re-run migrations is automatic on boot (`AUTO_MIGRATE=true`); check the API log says migrations are up to date.
6. Turn Maintenance mode off. Write what was lost (orders after the restore point) and tell the affected restaurants.

## Things the audit design relies on

- `audit_logs`, `platform_audit_logs` and `tax_documents` reject UPDATE/DELETE/TRUNCATE. A restore from backup is the **only** way their contents go back in time, so
  record every restore in your incident log.
- Bill and credit-note numbers are consecutive per outlet and financial year. After a restore that loses recent orders, numbers for those lost bills
  disappear from the register. Tell the restaurant's accountant which bill numbers were lost.

## Other things worth backing up

- Environment variables from Render (store them in a password manager, never in git).
- The Brevo sender/domain setup and the Razorpay webhook configuration (screenshots are enough).

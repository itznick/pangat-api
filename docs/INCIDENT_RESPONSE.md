# Incident response runbook

Use this when something may have gone wrong with security or personal data: a stolen password, unexpected access, data
exposed, the site defaced, ransomware, a leaked key, an employee misusing access. **When in doubt, treat it as an incident.**

Incident lead: **Nikhil Bhamare** (also the grievance officer). Back-up: name a second person here: ______________.

## The clocks (India)

| Clock | Rule | Who |
|---|---|---|
| **6 hours** | Report certain cyber incidents to **CERT-In** within 6 hours of noticing them or being told (CERT-In Directions, 28 April 2022). Covers things like data breach, data leak, unauthorised access to systems or data, attacks on servers/applications, identity theft/spoofing/phishing, malicious code. | Incident lead |
| **Without delay, then 72 hours** | Under the DPDP Rules 2025, tell each affected person without delay, and give the Data Protection Board a detailed report within 72 hours of becoming aware of a personal-data breach (obligation starts about May 2027; confirm the exact date and form with a lawyer). | Incident lead + grievance officer |
| **180 days** | Keep ICT system logs for a rolling 180 days (Pangat keeps sign-in history 365 days; the audit logs are never deleted). | Automatic |

CERT-In reporting channel at the time of writing: email `incident@cert-in.org.in`, helpline 1800-11-4949. **Check cert-in.org.in for the current form and contacts before relying on this.**

## First hour: contain

1. **Write down the time you noticed it** and who told you. Keep a running log (a shared doc). Do not delete anything.
2. **Stop the bleeding** (pick what applies):
   - Compromised staff account: Super Admin → Users → *Sign out everywhere* and *Deactivate*, then *Send reset link*.
   - Compromised platform admin: another Owner admin deactivates it (Users & access → Administrators). Rotate `PLATFORM_BOOTSTRAP_SECRET`.
   - Leaked secret/API key: rotate it at the provider (Brevo, Razorpay, Neon, Render), update the Render environment, redeploy. Rotating `JWT_SECRET` signs **everyone** out (this is the fastest way to kill every stolen session).
   - Attack in progress: Super Admin → Settings → Operations → **Maintenance mode** (restaurant users are blocked, admins are not), or turn off *Accept guest QR orders platform-wide*.
   - Suspected database exposure: in Neon, rotate the database password and restrict allowed IPs.
3. **Preserve evidence**: do not restart or wipe services you have not captured. Note the `X-Request-Id` values from affected requests (they appear in the audit log and error log).

## Investigate

All of this is already recorded, and is append-only:

- **Super Admin → Audit log**: every platform admin action, admin sign-ins/failures, **who opened which restaurant's data** (category *Privacy*).
- **Restaurant Settings → Activity** (owner): staff actions at an outlet; *Sign-in activity*; *Pangat staff access*.
- **Super Admin → Monitoring → Errors**: server errors with request ids (kept 90 days).
- `login_events` table: sign-in attempts with IP and device (365 days).
- Render logs and Neon query history for the time window.

Questions to answer and write down: What was accessed or changed? Whose data (which restaurants, how many people)? What kind of data (phone numbers, addresses, staff emails; we hold no card data)? How did it happen? Is it over?

## Decide who must be told

| If... | Then |
|---|---|
| A cyber incident of the kinds CERT-In lists happened | Report to CERT-In **within 6 hours** (even if details are incomplete; send more later) |
| Personal data was exposed, lost, altered or accessed without authority | Tell the affected restaurants first (they are the data fiduciary for diner data), then the affected people **without delay**, and the Data Protection Board when its process is in force |
| Money or bank details may be involved | Tell Razorpay and the restaurant's bank/UPI provider |
| A crime | Consider a police/cyber-cell complaint (1930 / cybercrime.gov.in) |

Message to affected people must say, in plain language: what happened, what data, what could follow from it, what we have done, what they should do, and who to contact (the grievance officer).

## Recover and learn

1. Restore service (see `BACKUP_RESTORE.md` if data was damaged).
2. Re-enable maintenance/ordering, force password resets where needed.
3. Within a week write a short **post-incident note**: timeline, cause, impact, what we changed. Keep it with the incident log.
4. Fix the root cause and add a test for it.

## Contact sheet (fill in and keep current)

| Role | Name | Phone | Email |
|---|---|---|---|
| Incident lead / grievance officer | Nikhil Bhamare | | |
| Back-up | | | |
| Hosting (Render) support | | | |
| Database (Neon) support | | | |
| Email (Brevo) support | | | |
| Lawyer | | | |

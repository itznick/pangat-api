# Compliance register (internal)

A living summary of what Pangat does about the law, so it can be shown to a lawyer, a CA or an auditor.
**This is engineering documentation, not legal advice.** Items marked **Confirm** need a lawyer or CA.

## Who is who

| Data | Fiduciary (decides why) | Pangat's role |
|---|---|---|
| Diner name, phone, address (orders) | The restaurant | Processor: processes on the restaurant's instructions (Terms of Service, "Your data") |
| Restaurant owner and staff details, sign-in history | Pangat | Fiduciary |
| Demo-request contact details | Pangat | Fiduciary |

Grievance officer (published on the Privacy Policy, set in Super Admin → Settings → Privacy & compliance): **Nikhil Bhamare**.
Set his email there before launch: until then the Privacy Policy only offers the request form.

## Personal data we hold, why, and how long

| Data | Where | Purpose | Kept |
|---|---|---|---|
| Diner name, phone, delivery address, delivery notes | `orders` | Prepare, deliver, bill the order | Removed automatically after 12 months for finished orders (setting). Bill amounts/items/tax stay. |
| Consent record (notice version + time) | `orders`, `leads` | Proof of consent | With the order / lead |
| Demo requests | `leads` | Contact the restaurant | Deleted after 18 months (setting) |
| Staff name, email, phone, role | `staff` | Run the service, security | While the account exists |
| Sign-in history (email, IP, device) | `login_events` | Security evidence | 365 days |
| Audit trail of actions | `audit_logs`, `platform_audit_logs` | Accountability, disputes | Not deleted (append-only) |
| Bills, credit notes | `tax_documents`, `orders` | Tax records (CGST Rules 46, 53) | Not deleted. **Confirm** the legal retention period (commonly 6 years) |
| Privacy requests | `privacy_requests` | Prove we answered | Not deleted |
| Error logs | `error_logs` | Troubleshooting | 90 days |

Not collected: card numbers (Razorpay and UPI handle payments), contacts, location.

## Sub-processors (listed in the Privacy Policy as categories; keep this list exact)

| Provider | For | Data seen | Region | DPA/terms checked |
|---|---|---|---|---|
| Neon | Database | everything above | **fill in** | |
| Render | API hosting | everything in transit/logs | **fill in** | |
| Netlify | Web hosting | none stored (static site) | n/a | |
| Brevo (or chosen email provider) | Transactional email | recipient email, message | **fill in** | |
| Razorpay | Restaurant subscription payments | payer details | India | |

## Rights and how they are handled

| Right (DPDP) | How | Where in the product |
|---|---|---|
| Know what is held | Privacy request, then officer "Look up" by phone | Privacy page; Super Admin → Privacy requests |
| Correct | Privacy request; restaurant or officer corrects | same |
| Erase | Privacy request, then officer "Erase" (orders anonymised, demo requests deleted, bills kept) | same; audit entry `PRIVACY_ERASURE_EXECUTED` |
| Withdraw consent | Privacy request | same |
| Grievance | Privacy request or the officer directly | same; due date = 30 days (setting) |
| Nominate | Privacy request | same |

Target answer time 30 days (the Rules allow up to 90 for grievances: **Confirm**). Overdue requests are highlighted.

## Security controls (what to show an auditor)

- Roles and least privilege: see "Role matrix" below; kitchen role receives no customer or money fields (API and live feed).
- Authentication: bcrypt (cost 12), lockout after 5 failures, tokens revoked instantly on password change or deactivation. Passwords: 10+ characters, no common/sequential/identity-based passwords. Temporary and owner-typed passwords must be replaced at first sign-in. Platform admin sessions last 8 hours.
- Two-factor: authenticator app (TOTP, RFC 6238) with single-use recovery codes, available to everyone, can be **required** for platform admins (Settings → Security → *Require an authenticator app for platform admins*). Optional email code as a fallback for admins without it.
- Kitchen accountability: each chef can have a personal PIN (unique per outlet) so actions are recorded under their name; the shared station PIN is still supported but records everything as "Kitchen Station".
- Abuse limits: per-IP throttles (real client IP via trust proxy), 5-guess lockouts for passwords/PINs/second factor, and burst limits on public ordering per outlet and per table.
- Audit: restaurant and platform audit logs are append-only in the database; each entry has actor, role, IP, device, request id; money and security changes are saved in the same transaction as their audit entry.
- Pangat staff opening a restaurant's data is logged and visible to that restaurant's owner.
- Transport: TLS; HSTS and security headers (see `netlify.toml` and API helmet).
- Secrets: encrypted at rest in settings (AES-256-GCM); environment variables for the rest.
- Backups and recovery: `BACKUP_RESTORE.md`. Incidents: `INCIDENT_RESPONSE.md`.
- Web app: Content-Security-Policy and security headers (`netlify.toml`). If `index.html`'s inline script ever changes, its hash in the policy must be recomputed (build the app, hash the `<script>` body with SHA-256, base64).
- CI on every pull request (`.github/workflows/ci.yml`): build, tests, dependency audit (fails on high/critical), secret scan. Dependabot opens update pull requests weekly.

## Role matrix

| Role | Can | Cannot |
|---|---|---|
| Super Owner | Everything for the brand, staff, billing, UPI/GST/FSSAI, settings | |
| Store Manager | Menu, prices, tables, refunds, stock, reports, kitchen PIN, outlet settings | UPI ID, GSTIN, FSSAI, tax rates, staff accounts, subscription |
| Chef / Kitchen station | See tickets, advance/regress status, mark dishes sold out, read stock | Customer phone/address, any money field, recipes, bills |
| Steward | Take and edit orders (before preparation), cancel (not after cooking starts), table status | Settle bills (unless the outlet allows), refunds, menu |
| Cashier | Settle bills, table status, orders list | Refunds, menu, settings |
| Platform Owner / Admin | All platform tools | (Owner only: manage administrators) |
| Platform Support | Tickets, user unlock/sign-out/reset link, open restaurant consoles (logged) | Billing changes, settings |
| Platform Finance | Subscriptions, payments, exports | Audit, settings, restaurant consoles |
| Platform Analyst | Dashboard, restaurants, subscriptions, payments (read) | Everything else |
| Platform Compliance | Privacy requests, audit log (read) | Billing, settings, accounts |

## Tax documents

- Bill number issued when a bill is paid: `{outlet code}/{FY}/{6 digits}`, consecutive per outlet per financial year (1 April to 31 March, IST), max 16 characters.
- Credit notes for refunds: own series `{code}/{FY}/C{5 digits}`.
- Bills show GSTIN, FSSAI licence number, HSN/SAC, CGST/SGST split.
- A paid and numbered bill cannot be edited.

## Not built yet (known gaps)

1. Extra roles recommended in the audit: Accountant/Auditor (read-only bills and reports), Storekeeper, Delivery partner, Area manager. Today an accountant must use an owner or manager login.
2. Tamper-evident audit (hash chain) and automatic "leakage" alerts to owners (many cancellations/refunds by one person, out-of-hours actions).
3. Session list ("my devices") and idle timeout for restaurant staff; tokens are still bearer tokens kept in the browser, so the CSP is the main defence against script injection.
4. SMS verification of diner phone numbers (needs DLT registration and a paid provider).
5. Service-charge GST treatment (see below) and bill-of-supply handling.

## Open items for a lawyer / CA (**Confirm**)

1. Final Privacy Policy and Terms text, the legal entity name and registered address, the jurisdiction city.
2. DPDP Rules timelines (breach reporting, consent notice content, children, any "significant fiduciary" status) and the exact commencement dates.
3. GST treatment of **service charge**: Pangat currently adds service charge on top of the food total and charges GST only on the food total. Service charge is generally part of the value of the supply and taxable at the same rate. This needs a CA's decision before real billing, because it changes the amounts on bills.
4. Whether restaurants below the GST threshold, or under the composition scheme, need a "bill of supply" instead of a "tax invoice" (the bill currently always says Tax Invoice; the outlet's GSTIN can be empty).
5. Retention period for bills and credit notes.
6. Whether e-invoicing or any other registration applies to your restaurants' turnover.
7. Data location: where Neon and Render store data, and the CERT-In log-storage position for your case.

# Phase 1.1 browser UAT (Playwright)

Reproducible browser journeys used for the Phase 1.1 verification. **Local/disposable environments only.**

Requirements: a throwaway PostgreSQL, the API running against it (`THROTTLE_DISABLED=true`, `NODE_ENV=development`), the web app served by Vite with
`VITE_API_URL=http://localhost:4000/api/v1`, and Playwright with Chromium. `seed.mjs` writes directly to the database named in it
(`postgres://postgres@localhost:5432/pangat`): change that only to another disposable database, never production.

Run in order: `journeyA` (owner), `journeyBC` then `journeyBCE` (kitchen + diner), `journeyE` (expired), `journeyD` (Super Admin), `journeyF` (inventory notices + override control), `journeyG` (provisioning override), `journeyH` (live KDS revocation).
`journeyA` writes `/tmp/uat_state.json`, which the later journeys read. Screenshots go to `/home/user/uat-screenshots` (see `ui.mjs`).
The import path of Playwright in `ui.mjs` and the repo paths in `seed.mjs` are specific to the verification sandbox; adjust them.

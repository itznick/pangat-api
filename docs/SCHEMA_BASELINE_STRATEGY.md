# Schema baseline strategy

## The problem
The application's core tables (organisations, restaurants, orders, staff, menu, tables, ...) are created by TypeORM `synchronize` in development and test. **No numbered migration creates them.** The numbered migrations (`src/migrations/009` onward) only add to that schema, are idempotent, and run at boot. So:
- a new database **cannot be rebuilt from the repository alone in production mode** (staging rebuild, disaster recovery, a new developer);
- an entity edit can silently change the development schema without any migration, so development and production can drift apart unnoticed.

## What we will NOT do
We will **not** generate one large `CREATE TABLE` migration and let the runner apply it. On a live database that would at best be a no-op and at worst conflict with differences nobody has compared. No baseline is ever placed in `src/migrations`, so the runner can never apply it.

## What exists now (all safe, none touches a live database)
| Piece | What it does |
|---|---|
| `docs/schema/reference_schema_after_021.sql` | The structure (no data) produced by the code at migration 021 on a fresh database. A *reference*, not something that runs. |
| `scripts/schema/dump-schema.sh` | Read-only `pg_dump --schema-only` of any database you can read (including production, by a person with access). Changes nothing. |
| `scripts/schema/compare-schema.sh a.sql b.sql` | Compares two schema dumps and prints structural differences (ignores ordering and noise). Exit 1 on any difference. |
| `scripts/schema/make-baseline.sh` and `apply-baseline.sh` | Build `docs/schema/baseline_000.sql` from a dump and apply it **only to an empty database**; `apply-baseline.sh` refuses if the application's tables already exist. |
| CI `live-suites` job | Every run starts from an empty Postgres, so the migration chain and the application are proven on a fresh database each time. It also compares the schema it built with the reference (informational for now). |
| CI `baseline-rebuild` job and `scripts/ci/check-baseline.sh` | Empty database, apply the baseline, boot the API in **production mode** (no schema sync), confirm `/health`; the migrations re-apply cleanly over it, and re-applying the baseline is refused. **Passed locally** (13 migrations applied on the baseline). |

## The plan, in order
1. **Compare production to the reference** (needs a person with read access to production; BLOCKED until then). Run `dump-schema.sh` on production and `compare-schema.sh` against the reference. Record every difference and decide for each: fix production by a reviewed additive migration, or correct the entity.
2. **Re-generate and freeze the baseline** once production and the reference agree (or the differences are accepted): update the reference, run `make-baseline.sh`, commit. A *candidate* `docs/schema/baseline_000.sql` (generated from the current reference) is already committed so the rebuild check can run; do not treat it as production's schema until step 1 is done.
3. **Prove rebuildability** on staging: create an empty database, `apply-baseline.sh`, boot the API with `NODE_ENV=production`, and confirm `/health` and the CI suites' smoke checks. (`scripts/ci/check-baseline.sh` automates this against a disposable database and already runs in CI.)
4. **Stop the drift**: any entity change must come with a numbered migration, and the reference is regenerated in the same pull request. CI already *reports* a difference between the freshly built schema and the reference; it becomes a blocking check after step 1.

## Honest status
- Step 1 is **not done** (needs production read access). Step 3's rebuild check is automated and passed on a disposable database. Step 4 is partly in place (informational CI comparison).
- The reference dump is generated from a development-mode (synchronised) database plus migrations 009 to 021. It is the repository's view of the schema, not production's.
- Until step 1 is done, do not claim that production matches the repository.

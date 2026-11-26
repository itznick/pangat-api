#!/usr/bin/env bash
# Apply the baseline to a NEW, EMPTY database (staging rebuild, disaster recovery, new developer). Refuses if the schema already exists,
# so it can never be run against a live database by mistake. After it, boot the API: migrations 009+ are idempotent and apply cleanly.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL (the NEW empty database) is required}"
f="$(dirname "$0")/../../docs/schema/baseline_000.sql"
present="$(psql "$DATABASE_URL" -Atc "SELECT (to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.restaurants') IS NOT NULL OR to_regclass('public.orders') IS NOT NULL)")"
if [ "$present" = "t" ]; then echo "Refusing: this database already has Pangat tables. The baseline is for empty databases only." >&2; exit 3; fi
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
echo "Baseline applied."

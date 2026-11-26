#!/usr/bin/env bash
# Turn a schema-only dump into docs/schema/baseline_000.sql. It lives outside src/migrations on purpose: the migration runner never applies it.
# It is applied only by scripts/schema/apply-baseline.sh, which refuses any database that already has the application's tables.
set -euo pipefail
src="${1:?usage: make-baseline.sh <schema-dump.sql>}"
out="docs/schema/baseline_000.sql"
{
  echo "-- Pangat baseline schema (structure only, no data). For a NEW, EMPTY database only; apply with scripts/schema/apply-baseline.sh."
  grep -vE '^(\\restrict|\\unrestrict)' "$src"
} > "$out"
echo "wrote $out"

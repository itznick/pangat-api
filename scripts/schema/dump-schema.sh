#!/usr/bin/env bash
# READ-ONLY schema capture (no data). Safe to point at any database you have read access to, including production, because it only
# issues pg_dump --schema-only. It writes one file and changes nothing in the database.
#   DATABASE_URL=... scripts/schema/dump-schema.sh out.sql
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
out="${1:?usage: dump-schema.sh <output.sql>}"
pg_dump --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions "$DATABASE_URL" | grep -vE '^\\(un)?restrict ' > "$out"  # \restrict lines carry a random token that changes every dump
echo "wrote $out ($(wc -l < "$out") lines, schema only)"

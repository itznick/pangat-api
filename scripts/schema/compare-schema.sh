#!/usr/bin/env bash
# Compare two schema-only dumps (e.g. production vs the repository's reference). Prints the differences; exits 1 if any.
# Normalises noise (SET lines, comments, blank lines, statement order) so only real structural drift shows.
set -euo pipefail
a="${1:?usage: compare-schema.sh <a.sql> <b.sql>}"; b="${2:?usage: compare-schema.sh <a.sql> <b.sql>}"
norm() {
  # one statement per line (statements end with ';'), drop SET/SELECT pg_catalog/comments, sort so ordering differences do not matter
  grep -vE '^(--|SET |SELECT pg_catalog|\\restrict|\\unrestrict)' "$1" | tr '\n' ' ' | sed -E 's/;[[:space:]]*/;\n/g' | sed -E 's/[[:space:]]+/ /g; s/^ //' | grep -v '^$' | sort
}
if diff <(norm "$a") <(norm "$b") > /tmp/schema-diff.$$; then
  echo "Schemas match."; rm -f /tmp/schema-diff.$$; exit 0
fi
echo "Schemas differ ('<' only in $a, '>' only in $b):"; cat /tmp/schema-diff.$$; rm -f /tmp/schema-diff.$$; exit 1

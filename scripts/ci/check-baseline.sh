#!/usr/bin/env bash
# Proves the repository can rebuild a database from nothing in PRODUCTION mode (no schema sync): empty DB -> baseline -> API boots,
# applies migrations, answers /health. Disposable databases only (same guard as run-live-suites.sh).
#   ADMIN_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres scripts/ci/check-baseline.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL (a local postgres admin connection to the 'postgres' database) is required}"
host="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#')"
case "$host" in localhost|127.0.0.1|postgres|::1) ;; *) echo "Refusing non-local database '$host'" >&2; exit 2 ;; esac
name="pangat_baseline_check_$$"
base="${ADMIN_DATABASE_URL%/*}"
psql "$ADMIN_DATABASE_URL" -qc "CREATE DATABASE $name"
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; psql "$ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS $name" || true; }
trap cleanup EXIT
export DATABASE_URL="$base/$name"
scripts/schema/apply-baseline.sh
# applying it a second time must be refused (never run against a live database)
if scripts/schema/apply-baseline.sh 2>/dev/null; then echo "FAIL: baseline re-applied onto an existing schema" >&2; exit 1; fi
[ -f dist/main.js ] || npm run build
# The disposable local database offers no TLS (a CI service container does not); production defaults to TLS and ignores this for hosted databases
DATABASE_SSL=false PORT="${PORT:-4100}" NODE_ENV=production JWT_SECRET="$(openssl rand -hex 32)" FRONTEND_URL="http://localhost:5173" \
  PLATFORM_BOOTSTRAP_SECRET="$(openssl rand -hex 16)" RAZORPAY_WEBHOOK_SECRET="whsec_$(openssl rand -hex 8)" \
  node dist/main > baseline-check.log 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT:-4100}/health" >/dev/null 2>&1 && ok=1 && break; sleep 1; done
if [ -z "${ok:-}" ]; then echo "FAIL: API did not boot on the baseline in production mode" >&2; tail -40 baseline-check.log >&2; exit 1; fi
echo "migrations applied on the baseline:"; grep -c "Applying migration" baseline-check.log || true
echo "BASELINE REBUILD VERIFIED"

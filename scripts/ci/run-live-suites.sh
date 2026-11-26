#!/usr/bin/env bash
# Boots the API on a THROWAWAY Postgres and runs every live suite, one at a time. Used by GitHub Actions and runnable locally:
#   DATABASE_URL=postgres://postgres:pg@localhost:5432/pangat_scratch scripts/ci/run-live-suites.sh [suite ...]
# Safety: refuses any database that is not local/disposable. It never touches production, staging or Neon.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${DATABASE_URL:?DATABASE_URL (a throwaway database) is required}"
host="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#')"
case "$host" in
  localhost|127.0.0.1|postgres|::1) ;;
  *) echo "Refusing to run live suites against '$host': only a local or service-container database is allowed." >&2; exit 2 ;;
esac
if printf '%s' "$DATABASE_URL" | grep -qiE 'neon\.tech|amazonaws|render\.com|supabase|railway|azure|googleapis'; then
  echo "Refusing: that looks like a hosted database." >&2; exit 2
fi

export NODE_ENV=development            # dev JWT fallback and schema sync: only ever on this disposable database
export THROTTLE_DISABLED=true
export PORT="${PORT:-4000}"
export PLATFORM_BOOTSTRAP_SECRET="${PLATFORM_BOOTSTRAP_SECRET:-$(openssl rand -hex 16)}"
export RAZORPAY_WEBHOOK_SECRET="${RAZORPAY_WEBHOOK_SECRET:-whsec_$(openssl rand -hex 8)}"
export UAT_API="${UAT_API:-http://localhost:$PORT/api/v1}"

SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(test test:integration test:phase1 test:phase1_1 test:phase1_2 test:phase1_final test:platform test:compliance test:commercial test:pilot-payments test:pilot-ops test:pilot-roles test:pilot-menu)
fi

[ -f dist/main.js ] || npm run build
LOG="${API_LOG:-api-ci.log}"
API_PID=""
stop_api() { [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null && wait "$API_PID" 2>/dev/null || true; API_PID=""; }
start_api() {
  node dist/main > "$LOG" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "API did not become healthy; log follows" >&2; tail -50 "$LOG" >&2; return 1
}
trap stop_api EXIT

start_api
node test/support/enable-signup.mjs   # sign-up is OFF by default; the suites onboard through the public route

failed=()
for s in "${SUITES[@]}"; do
  echo "::group::$s"
  if npm run -s "$s"; then echo "PASS $s"; else echo "FAIL $s"; failed+=("$s"); fi
  echo "::endgroup::"
done

# Migrations apply at boot under a lock and must be idempotent: restarting the API on the SAME database must be a clean no-op.
echo "::group::migrations are idempotent across a restart"
stop_api
if start_api && ! grep -q "ERROR" "$LOG"; then echo "PASS restart"; else echo "FAIL restart"; failed+=("restart-idempotency"); fi
echo "::endgroup::"

if [ ${#failed[@]} -gt 0 ]; then echo "FAILED: ${failed[*]}" >&2; exit 1; fi
echo "All live suites passed."

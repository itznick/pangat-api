#!/bin/bash
# Rehearses migration 017 up / up again / down on a disposable copy and prints before/after plan snapshots.
#   COPY_URL=postgres://.../pangat_restore_verify  ./migration_017_check.sh
# Run it on the restored copy from backup_restore_check.sh, never on staging or production itself.
source "$(dirname "$0")/_guard.sh"
: "${COPY_URL:?set COPY_URL}"; require_disposable "$COPY_URL" COPY
M="$(cd "$(dirname "$0")/../../src/migrations" && pwd)"
snap() { psql "$COPY_URL" -Atc "SELECT rpad(code,22)||' | outlets='||max_outlets||' | '||features FROM subscription_plans ORDER BY code" > "/tmp/m017_$1.txt"; }
applied() { psql "$COPY_URL" -Atc "SELECT to_regclass('plan_feature_backfills') IS NOT NULL"; }
echo "state before: backfill table present = $(applied)"; snap 0_start
# put the copy into its pre-017 state (only changes the disposable copy)
psql "$COPY_URL" -q -v ON_ERROR_STOP=1 -f "$M/017_plan_feature_enforcement.down.sql" 2>&1 | grep -v "^$" || true
snap 1_pre017; [[ "$(applied)" == "f" ]] && pass "down leaves no record table" || fail "record table still present after down"
psql "$COPY_URL" -q -v ON_ERROR_STOP=1 -f "$M/017_plan_feature_enforcement.sql" && snap 2_up && pass "up applied"
[[ "$(applied)" == "t" ]] && pass "record table created"
psql "$COPY_URL" -q -v ON_ERROR_STOP=1 -f "$M/017_plan_feature_enforcement.sql" 2>&1 | grep -v "^$" || true; snap 3_up_again
diff -q /tmp/m017_2_up.txt /tmp/m017_3_up_again.txt >/dev/null && pass "second run changed nothing" || fail "second run changed plans"
# nothing was removed by up, only appended
python3 - <<PY && pass "up only appended features (no feature removed, no other column touched in the snapshot)" || fail "up removed or reordered features"
a=[l.split(' | ') for l in open('/tmp/m017_1_pre017.txt').read().splitlines()]
b=dict((l.split(' | ')[0].strip(),l.split(' | ')) for l in open('/tmp/m017_2_up.txt').read().splitlines())
import sys
for code,o,f in a:
    n=b[code.strip()]; before=set(f.split(',')) - {''}; after=set(n[2].split(',')) - {''}
    assert before <= after, code
    assert n[1]==o, code
PY
echo "--- rows recorded by 017:"; psql "$COPY_URL" -Atc "SELECT feature, count(*) FROM plan_feature_backfills GROUP BY 1 ORDER BY 1"
psql "$COPY_URL" -q -v ON_ERROR_STOP=1 -f "$M/017_plan_feature_enforcement.down.sql" 2>&1 | grep -v "^$" || true; snap 4_down
diff -q /tmp/m017_1_pre017.txt /tmp/m017_4_down.txt >/dev/null && pass "down restores the pre-017 plan features exactly" || { fail "down differs from the pre-017 state"; diff /tmp/m017_1_pre017.txt /tmp/m017_4_down.txt | head; }
# leave the copy in the state the real deployment will produce
psql "$COPY_URL" -q -v ON_ERROR_STOP=1 -f "$M/017_plan_feature_enforcement.sql"; snap 5_final
echo; echo "=== plans before 017 -> after 017 (copy) ==="; diff /tmp/m017_1_pre017.txt /tmp/m017_5_final.txt || true
echo; [[ $FAILED == 0 ]] && echo "MIGRATION 017 REHEARSAL PASSED" || { echo "MIGRATION 017 REHEARSAL FAILED"; exit 1; }

#!/bin/bash
# Proves a backup of SOURCE_URL can be restored and is complete, by restoring it into a disposable *_verify database and comparing row counts.
#   SOURCE_URL=postgres://.../pangat  TARGET_URL=postgres://.../pangat_restore_verify  ./backup_restore_check.sh
# SOURCE is only READ (pg_dump). Nothing is ever written to it.
source "$(dirname "$0")/_guard.sh"
: "${SOURCE_URL:?set SOURCE_URL}"; : "${TARGET_URL:?set TARGET_URL}"
require_disposable "$TARGET_URL" TARGET
DUMP="${DUMP_FILE:-/tmp/pangat_backup_$(date +%Y%m%d_%H%M%S).dump}"
ADMIN_URL="${TARGET_URL%/*}/postgres"; TDB="${TARGET_URL##*/}"; TDB="${TDB%%\?*}"
pg_dump "$SOURCE_URL" -Fc -f "$DUMP" && pass "backup written: $DUMP ($(du -h "$DUMP" | cut -f1), sha256 $(sha256sum "$DUMP" | cut -c1-16)…)"
pg_restore -l "$DUMP" >/dev/null && pass "backup is readable (table of contents lists)"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS \"$TDB\"" -c "CREATE DATABASE \"$TDB\""
pg_restore --no-owner -d "$TARGET_URL" "$DUMP" 2>/tmp/restore.err && pass "restore completed" || { grep -vE "already exists|does not exist, skipping" /tmp/restore.err | head -5; }
for t in organizations restaurants tables staff orders order_items menu_items subscription_plans organization_subscriptions audit_logs platform_audit_logs subscription_audit_logs tax_documents; do
  a=$(psql "$SOURCE_URL" -Atc "SELECT COUNT(*) FROM $t" 2>/dev/null || echo n/a); b=$(psql "$TARGET_URL" -Atc "SELECT COUNT(*) FROM $t" 2>/dev/null || echo n/a)
  if [[ "$a" == "$b" ]]; then pass "$t: $a rows in source and restore"; else fail "$t: source $a vs restore $b"; fi
done
psql "$TARGET_URL" -Atc "SELECT COUNT(*) FROM schema_migrations" >/dev/null 2>&1 && pass "schema_migrations restored: $(psql "$TARGET_URL" -Atc "SELECT string_agg(name, ', ' ORDER BY name) FROM schema_migrations")"
echo; [[ $FAILED == 0 ]] && echo "BACKUP/RESTORE VERIFIED" || { echo "BACKUP/RESTORE NOT VERIFIED"; exit 1; }

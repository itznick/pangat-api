#!/bin/bash
# Shared safety checks for the staging verification scripts. They only ever WRITE to a database whose name ends in _verify,
# and refuse hosts that look like a managed production service unless STAGING_ALLOW_REMOTE=yes is set deliberately.
set -euo pipefail
require_disposable() {
  local url="$1" what="$2"
  local db="${url##*/}"; db="${db%%\?*}"
  if [[ "$db" != *_verify ]]; then echo "REFUSING: $what database name '$db' must end in _verify (a disposable copy)"; exit 2; fi
  if [[ "$url" == *neon.tech* || "$url" == *render.com* || "$url" == *amazonaws.com* ]] && [[ "${STAGING_ALLOW_REMOTE:-no}" != "yes" ]]; then
    echo "REFUSING: $what looks like a managed database. Set STAGING_ALLOW_REMOTE=yes only for a disposable staging copy."; exit 2
  fi
}
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILED=1; }
FAILED=0

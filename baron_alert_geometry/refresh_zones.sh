#!/bin/bash
#
# Refresh zone geometry only when the API says a shapefile version changed.
#
# Zone geometry is versioned and static, so a scheduled full fetch wastes ~217 MB
# for nothing. This checks versions first (one request) and refetches only the
# types whose version moved, then rebuilds and verifies the GeoPackage.
#
# Usage:
#   ./refresh_zones.sh [out_dir]
#
# Cron, daily at 04:15 local:
#   15 4 * * * cd /Users/sherman/tmp/1/2 && ./refresh_zones.sh >> refresh.log 2>&1
#
# Exit codes: 0 nothing to do or refresh succeeded, 1 refresh or verification failed.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

OUT_DIR="${1:-zones_out}"
STAMP() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "[$(STAMP)] checking zone shapefile versions in $OUT_DIR"

CHECK_OUTPUT=$(python3 baron_zones_fetch.py --out-dir "$OUT_DIR" --check-versions 2>&1)
CHECK_STATUS=$?
echo "$CHECK_OUTPUT"

if [ "$CHECK_STATUS" -eq 0 ]; then
    echo "[$(STAMP)] local copy is current, nothing to do"
    exit 0
fi

# --check-versions prints "refetch with: --types FIRE,FORECAST" when types are stale.
STALE=$(printf '%s\n' "$CHECK_OUTPUT" | sed -n 's/^refetch with: --types //p' | tail -1)

if [ -z "$STALE" ]; then
    echo "[$(STAMP)] version check failed but named no stale types; not refetching" >&2
    echo "[$(STAMP)] check credentials and connectivity, then rerun" >&2
    exit 1
fi

echo "[$(STAMP)] stale types: $STALE — refetching"

# No --resume: a version bump means the geometry itself changed, so the staged
# records for these types are obsolete and must be replaced rather than appended
# to. Types NOT listed here keep their staging files and are carried forward into
# the rebuilt GeoPackage.
if ! python3 baron_zones_fetch.py --out-dir "$OUT_DIR" --types "$STALE"; then
    echo "[$(STAMP)] refetch reported failures; GeoPackage may be incomplete" >&2
    echo "[$(STAMP)] retry the failed ids with: python3 baron_zones_fetch.py --out-dir $OUT_DIR --types $STALE --resume" >&2
    exit 1
fi

echo "[$(STAMP)] verifying"
if ! python3 verify_zones.py "$OUT_DIR"; then
    echo "[$(STAMP)] verification FAILED" >&2
    exit 1
fi

echo "[$(STAMP)] refresh complete and verified"
exit 0

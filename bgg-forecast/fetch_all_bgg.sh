#!/usr/bin/env bash
#
# Download every BGG global product listed in bgg-global-endpoints.md
# (latest run, Standard-Geodetic) plus each product's legend, via geotiff_fetch.py.
#
# Usage:
#   ./fetch_all_bgg.sh [--dir OUTDIR] [--timestamp TS] [--list]
#
#   --dir OUTDIR    where to write files (default: ./download)
#   --timestamp TS  run to fetch: "latest" (default) or an ISO time. To pin an
#                   exact init time use init+1s (e.g. 2026-07-22T12:00:01Z), since
#                   the API's metadata query is a strictly-exclusive "older_than".
#   --list          dry run: print the product codes that would be fetched, then exit.
#
# Requires BARON_ACCESS_KEY / BARON_ACCESS_KEY_SECRET in the environment (fetch only;
# legends are public). Product codes are read from bgg-global-endpoints.md next to
# this script. Output naming (…_Standard-Geodetic_latest.tif + _legend.json) is what
# geotiff_value_at.py / qa_bgg.py expect for legend auto-resolution.
#
# Notes: ~10 GB total, fetched sequentially (plain/hourly products are 252-band, up to
# ~380 MB). 10 of the 60 legends 404 at the CDN (mps winds, windvector, day/night wxcode,
# plain precip-probability) — expected; see BGG_QA_TEST_PLAN.md §0.1#4 for their decode.
# Exits 0 even if some fetches fail, printing a per-product FAILED line and a final count.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

OUTDIR="download"
TS="latest"
LIST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)       OUTDIR="$2"; shift 2;;
    --timestamp) TS="$2"; shift 2;;
    --list)      LIST=1; shift;;
    *) echo "unknown arg: $1"; exit 1;;
  esac
done

ENDPOINTS="bgg-global-endpoints.md"
if [[ ! -f "$ENDPOINTS" ]]; then
  echo "Error: $ENDPOINTS not found next to this script"; exit 1
fi

# Product codes = column 1 of the markdown table (bash 3.2-compatible array fill)
CODES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && CODES+=("$line")
done < <(grep -oE '^\| bgg-global-[a-z0-9-]+' "$ENDPOINTS" | sed 's/^| //' | sort -u)
N=${#CODES[@]}
if [[ $N -eq 0 ]]; then echo "Error: no product codes parsed from $ENDPOINTS"; exit 1; fi

if [[ $LIST -eq 1 ]]; then
  printf '%s\n' "${CODES[@]}"
  echo "($N products)"
  exit 0
fi

mkdir -p "$OUTDIR"
i=0; fail=0
for p in "${CODES[@]}"; do
  i=$((i+1))
  echo "[$i/$N] $p"
  python3 geotiff_fetch.py --product "$p" --projection Standard-Geodetic \
      --product-type forecast --timestamp "$TS" \
      --output "$OUTDIR/${p}_Standard-Geodetic_latest.tif" \
      --save-metadata "$OUTDIR/${p}_Standard-Geodetic_latest_meta.json" --quiet \
    || { echo "  FETCH FAILED: $p"; fail=$((fail+1)); }
  # legend is public; some products have none (expected) — don't count as failure
  python3 geotiff_fetch.py --product "$p" --projection Standard-Geodetic \
      --save-legend "$OUTDIR/${p}_Standard-Geodetic_legend.json" --quiet 2>/dev/null \
    || echo "  (no legend for $p)"
done

echo ""
echo "DONE: $N requested, $fail fetch failures. Output in $OUTDIR/"
du -sh "$OUTDIR" 2>/dev/null || true

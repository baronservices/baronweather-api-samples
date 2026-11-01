#!/usr/bin/env bash
# Renders every example job, one after another: examples/*.json, examples/map-only/*.json, then
# examples/regions/*.json (global to close-up views, each setting every job and style key), then
# examples/big/*.json (continents and regions in large type and thick lines, for low vision).
# The PNGs go into the output folder (default: the current directory), named after each job.
# A failed job is reported and the rest still run; the exit code is 1 if any failed.
# Ctrl-C stops the whole run.
#
# usage: scripts/render-examples.sh [output-folder]
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-.}
mkdir -p "$out" || exit 1
cd "$out" || exit 1

trap 'echo; echo "stopped"; exit 130' INT

ok=0
failed=()
for job in "$root"/examples/*.json "$root"/examples/map-only/*.json "$root"/examples/regions/*.json "$root"/examples/big/*.json; do
  name=${job#"$root"/examples/}
  echo "== $name"
  node "$root/cli/sigwx.js" render "$job"
  status=$?
  [ "$status" -eq 130 ] && { echo "stopped"; exit 130; }   # the CLI exits 130 on Ctrl-C
  if [ "$status" -eq 0 ]; then ok=$((ok + 1)); else failed+=("$name"); fi
  echo
done

echo "$ok rendered, ${#failed[@]} failed, in $(pwd)"
if [ ${#failed[@]} -gt 0 ]; then
  printf '  failed: %s\n' "${failed[@]}"
  exit 1
fi

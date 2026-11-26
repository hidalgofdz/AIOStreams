#!/usr/bin/env bash
# Later page after the 5-minute catalog cache has expired: first page cold, wait, then later pages.
# testbed/expiry.sh <server> <library> [wait-seconds]
here="$(cd "$(dirname "$0")" && pwd)"
node "$here/replay.mjs" --server "$1" --client infuse-direct --library "$2" --first-only --label expiry-first --out "$here/results/timing-expiry.jsonl" | sed -n 2,4p
sleep "${3:-320}"
for start in 50 200; do
  node "$here/replay.mjs" --server "$1" --client infuse-direct --library "$2" --start $start --label "expiry-later-$start" --out "$here/results/timing-expiry.jsonl" | sed -n 2,4p
done

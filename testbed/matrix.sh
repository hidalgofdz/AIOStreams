#!/usr/bin/env bash
# One matrix row: testbed/matrix.sh <label> <server> <replay args...>
# Runs cold with --exhaust, appends the full result to testbed/.state/matrix.jsonl
# and prints one summary line per library.
here="$(cd "$(dirname "$0")" && pwd)"
label="$1"; server="$2"; shift 2
node "$here/replay.mjs" --server "$server" --cold --exhaust --label "$label" --json "$@" 2>/dev/null \
  | tee -a >(jq -c . >> "$here/.state/matrix.jsonl") \
  | jq -r --arg label "$label" '.server as $s | .client as $c | .page as $p | .runs[] | .upstreamTotal as $u | .libraries[] |
    "\($label) | \($s) | \($c)/\($p) | first=\(.firstTotal) seen=\(.totalsSeen|tostring) fetched=\(.uniqueItems) dup=\(.duplicateItems) reachable=\(.reachableItems) | \(if .totalMatchesReachable and .shapeGotEverything then "PASS" else "FAIL" end) | firstMs=\(.firstMs) laterMax=\(.laterMsMax) up=\(.upstream.requests)/\($u) peak=\(.upstream.peakConcurrency) status=\(.statuses|tostring)"'

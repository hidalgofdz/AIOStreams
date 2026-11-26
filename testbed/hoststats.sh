#!/usr/bin/env bash
# Host-wide view of the most recent namespace on a mock: testbed/hoststats.sh [mock-url] [catalog-prefix]
mock="${1:-http://localhost:3999}"; prefix="${2:-}"
curl -s "$mock/__stats" | jq -r --arg p "$prefix" '
  (.log|last.ns) as $ns
  | [.log[]|select(.ns==$ns and (.catalog|startswith($p)))] | sort_by(.start) as $l
  | ($l|map(.start)) as $s | ($l|map(.end // .start)) as $e
  | ([range(0;$l|length)] | map(. as $i | [range(0;$l|length)] | map(select($s[.] <= $s[$i] and $e[.] > $s[$i])) | length) | max) as $peak
  | "ns=\($ns) requests=\($l|length) span=\((($e|max)-($s|min)))ms peakInFlight=\($peak) peakPerSecond=\([$s[]|./1000|floor]|group_by(.)|map(length)|max) 429s=\([$l[]|select(.status==429)]|length) 500s=\([$l[]|select(.status==500)]|length)"'

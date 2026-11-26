#!/usr/bin/env bash
# Library Mode, main against the PR, at one cap setting:
#   testbed/library-mode.sh <label> <cap-env-or-"default"> "<lib>,<lib>,..."
# Restarts both servers with the cap, replays the real Infuse Library Mode shape
# cold with --exhaust for each library, writes results/library-mode-<label>-{main,pr}.jsonl
# and diffs them.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-/Users/hidalgofdz/development/AIOStreams}"
label="$1"; cap="$2"; libs="$3"
extra=(); [[ "$cap" != default ]] && extra=("JELLYFIN_MAX_CATALOG_ITEMS=$cap")
"$here/server.sh" start main "$REPO/.claude/worktrees/testbed-main" 3101 "${extra[@]}"
"$here/server.sh" start pr "$REPO" 3102 "${extra[@]}"
rm -f "$here/results/library-mode-$label-main.jsonl" "$here/results/library-mode-$label-pr.jsonl"
IFS=',' read -ra L <<<"$libs"
for lib in "${L[@]}"; do
  for s in main pr; do
    node "$here/replay.mjs" --server "$s" --client infuse-library --library "$lib" --cold --exhaust \
      --label "cap-$label" --out "$here/results/library-mode-$label-$s.jsonl" | grep -v "^run \|^main \|^pr " | sed "s/^/[$s] /"
  done
done
node "$here/compare.mjs" "$here/results/library-mode-$label-main.jsonl" "$here/results/library-mode-$label-pr.jsonl" | tail -40

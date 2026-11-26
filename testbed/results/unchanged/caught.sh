#!/usr/bin/env bash
out="$1"
run() { local label="$1"; shift
  for s in main pr; do node testbed/replay.mjs --server $s --cold --exhaust --label "$label" --out "$out-$s.jsonl" "$@" >/dev/null 2>>"$out-err.log" || echo "FAILED $s $label"; done; }
KUA="Kodi/21.2 (X11; Linux x86_64) App_Bitness/64 Version/21.2-(21.2.0)-Git:20250115-nogitfound"
for lib in "Above Cap" "Slow Above Cap"; do
  run kodi-ua-only-web   --client web      --client-name "Kofin" --user-agent "$KUA" --library "$lib"
  run kodi-ua-only-once  --client infuse-direct --client-name "Kofin" --user-agent "$KUA" --library "$lib"
  run kodi-ua-findroid   --client findroid --client-name "SomeAddon" --user-agent "$KUA" --library "$lib"
  run kodi-name-kodi-ua  --client kodi --user-agent "$KUA" --library "$lib"
  run jellycon-kodi-ua   --client jellycon --user-agent "$KUA" --library "$lib"
  run infuse-in-name     --client web --client-name "Infuse" --user-agent "Mozilla/5.0" --library "$lib"
done
run kodi-ua-coll --client web --client-name "Kofin" --user-agent "$KUA" --child-of "Collections In Turn"

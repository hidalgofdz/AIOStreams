#!/usr/bin/env bash
# usage: unchanged.sh <outprefix> ; runs every row on main and pr
out="$1"
run() { # label, then replay args
  local label="$1"; shift
  for s in main pr; do
    node testbed/replay.mjs --server $s --cold --exhaust --label "$label" --out "$out-$s.jsonl" "$@" >/dev/null 2>>"$out-err.log" || echo "FAILED $s $label $*"
  done
}
LIBS=("Fifty" "Above Cap" "Thousand" "Mixed Types" "Variable Pages" "Duplicates" "No Skip" "Series" "Empty" "Flaky")
for lib in "${LIBS[@]}"; do
  for c in kodi jellycon web findroid; do run plain --client $c --library "$lib"; done
  run swiftfin --client web --client-name "Swiftfin iOS" --user-agent "Swiftfin/1.3 (iPhone; iOS 18.1)" --page 100 --library "$lib"
  run androidtv --client web --client-name "Android TV" --user-agent "Jellyfin Android TV/0.18.5 okhttp/4.12.0" --page 100 --library "$lib"
  run streamyfin --client web --client-name "Streamyfin" --user-agent "Streamyfin/0.28.0" --page 50 --library "$lib"
  run noua --client web --client-name "Unknown" --user-agent none --library "$lib"
done
# genre, search, collections, no-total
for c in kodi jellycon web findroid; do
  run genre --client $c --library "Genres" --param Genres=Action
  run search --client $c --library "Searchable" --param searchTerm=0001
  for coll in "Collections In Turn" "Collections Interleaved" "Collections Small" "Collections Big"; do
    run coll --client $c --child-of "$coll"
  done
  run nototal --client $c --library "Above Cap" --no-total
done

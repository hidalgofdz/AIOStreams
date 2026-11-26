# Infuse exact-total test bed

Throwaway tooling for [the map](https://github.com/hidalgofdz/AIOStreams/issues/5) on
[PR 4](https://github.com/hidalgofdz/AIOStreams/pull/4). It lives only on the branch
`testbed/infuse-exact-total` and is never merged. Plain Node, no dependencies.

| File | What it is |
| --- | --- |
| `mock-addon.mjs` | Mock Stremio addon. One catalog per entry of `scenarios.json`. Logs every upstream request. |
| `scenarios.json` | The catalogs: size, page size (fixed or variable), delay, duplicates, mixed types, genres, search, no skip, rate limit. |
| `server.sh` | Starts or stops one AIOStreams server from any checkout, with its own database. |
| `replay.mjs` | Sends client-shaped `/Items` requests and records totals, items, timing and upstream requests. |
| `compare.mjs` | Diffs two `replay.mjs --out` files (main against the PR). |

## Start

Three checkouts are involved. Paths are the ones on the owner's machine.

| Role | Path | Branch |
| --- | --- | --- |
| Test bed | `.claude/worktrees/testbed` | `testbed/infuse-exact-total` |
| Before | `.claude/worktrees/testbed-main` | `main` |
| After | the repository root | `fix/jellyfin-infuse-library-total` |

```bash
cd .claude/worktrees/testbed
REPO=/Users/hidalgofdz/development/AIOStreams

node testbed/mock-addon.mjs &                                         # port 3999
testbed/server.sh start main $REPO/.claude/worktrees/testbed-main 3101
testbed/server.sh start pr   $REPO                                3102

node testbed/replay.mjs --server main --client infuse-direct --library "Above Cap" --cold --exhaust
node testbed/replay.mjs --server pr   --client infuse-direct --library "Above Cap" --cold --exhaust
```

Expected: `main` answers a first total of 110 for a library that holds 250 reachable
items, the PR answers 250.

A checkout needs `pnpm install` and `pnpm -F crypto -F core build` before
`server.sh` can start it, and the build must be redone after a change to
`packages/core`. In a fresh worktree `pnpm install` fails on the `yencode`
native build; install with `--ignore-scripts` and copy
`node_modules/.pnpm/yencode@*/node_modules/yencode/build/Release/yencode.node`
from the repository root (already done for `testbed-main`).

`server.sh start` wipes that server's state, so it is always a fresh database.
Pass server settings as trailing `NAME=VALUE` pairs:

```bash
testbed/server.sh start pr $REPO 3102 JELLYFIN_MAX_CATALOG_ITEMS=0     # cap disabled
testbed/server.sh start pr $REPO 3102 JELLYFIN_MAX_CATALOG_ITEMS=1000
testbed/server.sh stop pr
testbed/server.sh log pr 80
```

Rate limiting is off (`DISABLE_RATE_LIMITS=true`). State, logs and pid files are in
`testbed/.state/<name>/` (git-ignored).

## Scenarios

Edit `scenarios.json`, restart the mock, and restart the servers (a start creates a
new configuration that reads the new manifest). Fields are documented at the top of
`mock-addon.mjs`. The library name in Jellyfin is the scenario's `name`.

The mock's first path segment is a namespace, so each server has its own request
log: `http://localhost:3999/__stats?ns=pr`. `replay.mjs` resets and reads it for you.

## Client shapes

From [How do Infuse and Kodi read the library total?](https://github.com/hidalgofdz/AIOStreams/issues/7).

| `--client` | Route and parameters | Page | How it pages |
| --- | --- | --- | --- |
| `infuse-direct` | `/Items`, camelCase, `Infuse-Direct/8.5.11` | 50 | reads the first total, then every window up to it, last one shortened |
| `infuse-direct-jump` | same | 50 | reads the first total, then only the last two windows |
| `infuse-library` | `/Users/{id}/Items`, PascalCase, `Infuse-Library/8.5.11` | 200 | in order up to the first total (reading it once is an assumption) |
| `kodi` | Jellyfin for Kodi: client `Kodi`, `Jellyfin-Kodi/1.0.6` | 50 | `Limit=1&EnableTotalRecordCount=true` probe, then pages three at a time with `EnableTotalRecordCount=false` |
| `jellycon` | client `Kodi JellyCon`, `python-requests` user agent | 50 | rereads the total on every page |
| `web` | client `Jellyfin Web`, browser user agent | 100 | rereads the total on every page |
| `findroid` | client `Findroid`, `okhttp` user agent | 100 | ignores totals, pages until an empty page |

Any shape can be bent: `--client-name`, `--user-agent` (`none` sends no explicit
one), `--page`, `--types`, `--param k=v` (repeatable, for example
`--param Genres=Action` or `--param searchTerm=00012`), `--no-total`,
`--first-only`, `--start <n>`, `--abort-after <ms>`, `--parent-id <id>` for
collections. `node testbed/replay.mjs --help` lists everything.

## What a run records

Per library: the first total, every distinct total seen, requests sent, items and
unique items returned, first-request and slowest later-request latency, HTTP
statuses, and from the mock the upstream request count, peak upstream concurrency,
429s, and the `skip` of every upstream request in arrival order. Each request row
has its own start, limit, status, returned count, total and latency.

- `--exhaust` then pages as the same client until an empty page and reports
  `reachable` (the ground truth), `totalMatches` (first total equals reachable) and
  `gotAll` (the shape fetched everything reachable).
- `--cold` uses a fresh configuration on a fresh mock namespace. Use it for every
  cold-cache number.
- `--repeat n` reruns the shape. With `--cold`, run 1 is cold and the rest are warm.
- `--library "A,B,C"` runs several libraries at once (a simulated sync).
- `--out file.jsonl` appends the full result; `--json` prints it.

```bash
# before and after, diffed
for c in web kodi jellycon findroid; do
  node testbed/replay.mjs --server main --client $c --library "Above Cap" --cold --out /tmp/main.jsonl
  node testbed/replay.mjs --server pr   --client $c --library "Above Cap" --cold --out /tmp/pr.jsonl
done
node testbed/compare.mjs /tmp/main.jsonl /tmp/pr.jsonl
```

`compare.mjs` matches results on client, client name, user agent, page, options,
label and library, compares every request's start, limit, status, returned count,
total and ordered item ids plus the upstream request count, never timing, and exits
1 on any difference. Item ids are the same on both servers.

## Things that will mislead you

- **The catalog cache cannot be turned off from the environment.**
  `CATALOG_CACHE_TTL=-1`, `0` and `*:-1` were all tried: a repeat request still made
  zero upstream requests. Without `--cold`, anything read in the last 5 minutes is
  warm. Restarting a server also clears it.
- **Signing in probes every library.** After sign-in the server reads the first page
  of every catalog in the background. Those requests show up in a run's
  `upstream requests` total, and the probed first page is then cached, so a cold walk
  of a 200-item library shows 10 upstream requests for that library where 11 are
  needed. The per-library `upstream=` number counts only that library's catalog.
- **`--abort-after`** waits 1.5 s after the disconnect before reading the mock, so the
  upstream count shows whether the walk stopped.
- `kodi` reports one item more than the library holds: the probe's single item is
  counted.
- Jellyfin clamps `Limit` between 100 and 500 depending on the cap (`browseLimit`).

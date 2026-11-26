#!/usr/bin/env bash
# Start or stop one AIOStreams server for the test bed.
#
#   testbed/server.sh start <name> <checkout-dir> <port> [ENV=VALUE ...]
#   testbed/server.sh stop  <name>
#   testbed/server.sh log   <name>
#
# <name> doubles as the mock addon namespace (see mock-addon.mjs), so keep it
# to "main" and "pr" unless you need more. Each server gets its own SQLite
# database, log and pid file under testbed/.state/<name>/, which is wiped on
# every start: a start is always a cold server with no configuration.
#
# Extra ENV=VALUE pairs are passed to the server, for example
#   JELLYFIN_MAX_CATALOG_ITEMS=0     disable the cap
#   CATALOG_CACHE_TTL=-1             no catalog cache: every request is cold
#   CATALOG_TIMEOUT=30000
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cmd="${1:?start|stop|log}"
name="${2:?server name}"
state="$here/.state/$name"

stop() {
  if [[ -f "$state/pid" ]]; then
    pid="$(cat "$state/pid")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$state/pid"
  fi
}

case "$cmd" in
  stop) stop ;;
  log) tail -n "${3:-40}" "$state/server.log" ;;
  start)
    dir="$(cd "${3:?checkout dir}" && pwd)"
    port="${4:?port}"
    shift 4
    stop
    rm -rf "$state"
    mkdir -p "$state"
    [[ -x "$dir/node_modules/.bin/tsx" ]] || {
      echo "no node_modules in $dir: run pnpm install and pnpm -F crypto -F core build there" >&2
      exit 1
    }
    (
      cd "$dir"
      env \
        NODE_ENV=development \
        PORT="$port" \
        BASE_URL="http://localhost:$port" \
        SECRET_KEY="abababababababababababababababababababababababababababababababab" \
        DATABASE_URI="sqlite://$state/db.sqlite" \
        DISABLE_RATE_LIMITS=true \
        LOG_LEVEL="${LOG_LEVEL:-info}" \
        "$@" \
        nohup node_modules/.bin/tsx packages/server/src/server.ts \
        >"$state/server.log" 2>&1 &
      echo $! >"$state/pid"
    )
    echo "$port" >"$state/port"
    git -C "$dir" rev-parse --abbrev-ref HEAD >"$state/branch"
    git -C "$dir" rev-parse --short HEAD >"$state/commit"
    for _ in $(seq 1 120); do
      if curl -sf "http://localhost:$port/jellyfin/System/Info/Public" >/dev/null; then
        echo "$name: $(cat "$state/branch")@$(cat "$state/commit") on http://localhost:$port"
        exit 0
      fi
      kill -0 "$(cat "$state/pid")" 2>/dev/null || { tail -20 "$state/server.log" >&2; exit 1; }
      sleep 0.5
    done
    echo "$name did not come up; see $state/server.log" >&2
    exit 1
    ;;
  *) echo "unknown command $cmd" >&2; exit 1 ;;
esac

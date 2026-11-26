#!/usr/bin/env bash
# Real-client run: one AIOStreams checkout on a copy of a real deployment's
# database, behind capture-proxy.mjs. Point Infuse at http://<lan-ip>:<proxy-port>.
#
#   testbed/real.sh start <checkout-dir> <deployment-dir> [ENV=VALUE ...]
#   testbed/real.sh stop
#   testbed/real.sh mark "<label>"      write a marker line into the capture log
#
# <deployment-dir> holds the deployment's `.env` (SECRET_KEY is read from it and
# never printed) and `data/db.sqlite`. The copy is taken with sqlite's online
# backup, so the deployment can stay up. Every start takes a fresh copy and a
# cold server; the capture log is kept and appended to.
#
# PROXY_PORT (3111) and SERVER_PORT (3112) can be set in the environment.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
state="$here/.state/real"
data="$here/.state/real-data"
log="$here/.state/real-capture.jsonl"
proxy_port="${PROXY_PORT:-3111}"
server_port="${SERVER_PORT:-3112}"

stop_proxy() {
  if [[ -f "$data/proxy.pid" ]]; then
    kill "$(cat "$data/proxy.pid")" 2>/dev/null || true
    rm -f "$data/proxy.pid"
  fi
}

case "${1:?start|stop|mark}" in
  mark)
    printf '{"t":"%s","mark":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "${2:?label}" >>"$log"
    ;;
  stop)
    "$here/server.sh" stop real
    stop_proxy
    ;;
  start)
    dir="${2:?checkout dir}"
    dep="$(cd "${3:?deployment dir}" && pwd)"
    shift 3
    "$here/server.sh" stop real
    stop_proxy
    rm -rf "$data"
    mkdir -p "$data"
    sqlite3 "$dep/data/db.sqlite" ".backup '$data/db.sqlite'"
    key="$(grep -E '^SECRET_KEY=' "$dep/.env" | head -1 | cut -d= -f2- | tr -d '"'"'")"
    ip="$(ipconfig getifaddr en0 2>/dev/null || echo localhost)"
    "$here/server.sh" start real "$dir" "$server_port" \
      NODE_ENV=production \
      SECRET_KEY="$key" \
      DATABASE_URI="sqlite://$data/db.sqlite" \
      BASE_URL="http://$ip:$proxy_port" \
      "$@"
    LISTEN="$proxy_port" UPSTREAM="$server_port" LOG="$log" \
      nohup node "$here/capture-proxy.mjs" >"$data/proxy.log" 2>&1 &
    echo $! >"$data/proxy.pid"
    "$0" mark "start $(cat "$state/branch")@$(cat "$state/commit") $*"
    echo "Infuse address: http://$ip:$proxy_port/jellyfin   capture: $log"
    ;;
esac

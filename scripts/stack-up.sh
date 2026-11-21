#!/usr/bin/env bash
#
# Bring up the storefront on the host.
#
#   just stack-up
#
# WHAT THIS BRINGS UP
#
# One thing: the storefront, on the host, so that `next dev` can hot-reload.
#
# The crawler is not here. It is a separate service, operated in the crawler
# repository (wb-parser-kotlin-new): it owns its image, its PostgreSQL and its
# schema, and this repository only reads its HTTP API. Nothing here starts,
# stops, migrates or configures it — the storefront is a client and only a
# client.
#
# THE CRAWLER HAS TO BE ALREADY THERE
#
# The address and the key come from the environment or from the `.env` file in
# the repository root — the same two values production uses. Before the site is
# started the catalog API is asked whether it is ready: a storefront that comes
# up against an unreachable catalog only serves error pages, and saying so
# before it starts is cheaper than finding it out in the browser.
#
# THE STOREFRONT RUNS ON THE HOST
#
# `npm run dev` gives hot reload, which a containerised `next dev` does not.
# It is started under `setsid`, because `npm run dev` spawns a `next-server`
# child that outlives its parent: killing the npm PID would leave the process
# that actually holds :3000 alive, and the next `stack-up` would fail on
# "address already in use". `stack-down.sh` signals the process group.
#
# Env overrides (all optional):
#   STACK_SITE_PORT       storefront port            (default 3000)
#   STACK_CATALOG_TIMEOUT seconds to wait for the API (default 60)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="$ROOT/.stack"
LOG_DIR="$STACK_DIR/logs"

SITE_PORT="${STACK_SITE_PORT:-3000}"
CATALOG_TIMEOUT="${STACK_CATALOG_TIMEOUT:-60}"

mkdir -p "$LOG_DIR"

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[0;32m  ✅ %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m  ⚠️  %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m  ❌ %s\033[0m\n' "$1" >&2; exit 1; }

# The catalog's address and key: the environment first, the `.env` file
# second. The file is where they live in production too — one place, two
# environments.
read_env() {
    local name="$1"
    local value="${!name:-}"
    if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
        value="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    fi
    # The deploy writes single-quoted values (compose reads those literally, so
    # a `$` in the key is not rewritten on the way in). The quotes are not part
    # of the value.
    case "$value" in
        \'*\') value="${value:1:${#value}-2}" ;;
    esac
    printf '%s' "$value"
}

# What identifies the storefront in /proc/<pid>/cmdline. `npm run dev` never
# says "next" — see stack-down.sh for what went wrong when it did.
SITE_MATCH="run dev"

# A recorded PID is only useful if something is still behind it. Reusing a stale
# PID would make `stack-down` kill an unrelated process, so the recorded command
# line is checked as well as the PID.
running_pid() {
    local pidfile="$1" expect="$2"
    [ -f "$pidfile" ] || return 1
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    [ -n "$pid" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$expect" || return 1
    echo "$pid"
}

# Launch a long-running service, fully detached, recording the PID that will
# actually be the service.
#
# `$!` is NOT that PID. `setsid` forks whenever it is already a process group
# leader, so `$!` names a wrapper that exits immediately — a pidfile full of
# corpses, and a `stack-down` that reports every service as already gone while
# the processes hold their ports.
#
# So the service records its own PID, after `setsid` has done whatever forking
# it does and immediately before `exec` replaces the shell — and `exec` keeps the
# PID, which makes the number it wrote the number stack-down will signal.
launch() {
    local pidfile="$1" logfile="$2"; shift 2
    rm -f "$pidfile"
    setsid bash -c 'printf "%s\n" "$$" > "$1"; shift; exec "$@"' _ "$pidfile" "$@" \
        </dev/null >>"$logfile" 2>&1 &
    disown 2>/dev/null || true
}

# ── preflight ───────────────────────────────────────────────────────────────

step "Preflight"

CRAWLER_API_URL="$(read_env CRAWLER_API_URL)"
CRAWLER_API_KEY="$(read_env CRAWLER_API_KEY)"

[ -n "$CRAWLER_API_URL" ] || die "CRAWLER_API_URL is not set.
       It is the crawler's base URL — the address of the API this storefront
       reads. Put it in .env (see .env.example) or in the environment."
[ -n "$CRAWLER_API_KEY" ] || die "CRAWLER_API_KEY is not set.
       It is the crawler's CATALOG_API_KEY, sent as X-Api-Key. Put it in .env
       (see .env.example) or in the environment."

export CRAWLER_API_URL CRAWLER_API_KEY

# Readiness is the crawler's own statement that the catalog can be served.
bash "$ROOT/scripts/wait-catalog-ready.sh" "$CATALOG_TIMEOUT" >/dev/null \
    || die "the catalog API at $CRAWLER_API_URL did not become ready.
       Is the crawler running, and is the address and the key the ones it
       expects?"
ok "catalog API ready at $CRAWLER_API_URL"

# ── storefront ───────────────────────────────────────────────────────────────

step "Storefront"
if running_pid "$STACK_DIR/site.pid" "$SITE_MATCH" >/dev/null; then
    ok "already running (pid $(cat "$STACK_DIR/site.pid"))"
else
    launch "$STACK_DIR/site.pid" "$LOG_DIR/site.log" \
        env \
        CRAWLER_API_URL="$CRAWLER_API_URL" \
        CRAWLER_API_KEY="$CRAWLER_API_KEY" \
        NEXT_PUBLIC_SITE_URL="http://localhost:$SITE_PORT" \
        NEXT_TELEMETRY_DISABLED=1 \
        PORT="$SITE_PORT" \
        npm run dev

    waited=0
    while [ "$waited" -lt 120 ]; do
        if curl -fsS -o /dev/null -m 3 "http://localhost:$SITE_PORT/" 2>/dev/null; then
            break
        fi
        sleep 2
        waited=$((waited + 2))
    done
    ok "storefront on http://localhost:$SITE_PORT (log: $LOG_DIR/site.log)"
fi

# ── report ───────────────────────────────────────────────────────────────────

step "Ready"
echo "  catalog     $CRAWLER_API_URL"
echo "  storefront  http://localhost:$SITE_PORT"
echo ""
echo "  the catalog API answers:"
echo "    curl -H \"X-Api-Key: \$CRAWLER_API_KEY\" $CRAWLER_API_URL/stats"
echo ""
echo "  Stop the storefront with: just stack-down"

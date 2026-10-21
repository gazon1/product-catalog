#!/usr/bin/env bash
#
# Bring up the whole local stack: the crawler's database, the crawler, and the
# storefront.
#
#   just stack-up
#
# WHAT THE STACK IS
#
# Three things, and only three:
#
#   * a PostgreSQL, with no published port — it is reachable from the compose
#     network and from nowhere else;
#   * the crawler, which creates the schema (its own Flyway migrations) and
#     fills it with synthetic data (its own demo seed);
#   * the storefront, which reads the catalog over HTTP.
#
# The storefront has no database credentials. It has a key and a URL. There is
# no copy of the schema in this repository, so there is nothing here that can
# drift from the schema the crawler actually has.
#
# THE CRAWLER IS A CONTAINER, NOT A JAR
#
# The crawler used to be started from a jar built by the checkout next door,
# which meant the stack needed a crawler checkout, a gradle build, and a
# half-minute of waiting before anything else could start. It is now the
# crawler's own image — the same artifact that is deployed — so the local stack
# runs the same bytes production runs.
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
#   STACK_PARSER_IMAGE    crawler image              (default wb-parser:local)
#   STACK_CRAWLER_API_KEY catalog key                (default local-dev-catalog-key)
#   STACK_ADMIN_API_KEY   admin API key              (default local-dev-admin-key)
#   STACK_SITE_PORT       storefront port            (default 3000)
#   STACK_PARSER_PORT     crawler port               (default 8080)
#   STACK_SKIP_SITE=1     bring up the database and crawler only
#   STACK_DEMO_SEED=0     start the crawler without the demo seed

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="$ROOT/.stack"
LOG_DIR="$STACK_DIR/logs"

# Every Docker call is bounded: a daemon that does not answer has to say so
# instead of hanging the script.
. "$ROOT/scripts/docker-timeout.sh"

SITE_PORT="${STACK_SITE_PORT:-3000}"
PARSER_PORT="${STACK_PARSER_PORT:-8080}"
CATALOG_API_KEY="${STACK_CRAWLER_API_KEY:-local-dev-catalog-key}"
ADMIN_API_KEY="${STACK_ADMIN_API_KEY:-local-dev-admin-key}"
PARSER_IMAGE="${STACK_PARSER_IMAGE:-wb-parser:local}"

export STACK_CATALOG_API_KEY="$CATALOG_API_KEY"
export STACK_ADMIN_API_KEY="$ADMIN_API_KEY"

DB_CONTAINER="product-catalog-dev-db"
PARSER_CONTAINER="product-catalog-dev-parser"

mkdir -p "$LOG_DIR"

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[0;32m  ✅ %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m  ⚠️  %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m  ❌ %s\033[0m\n' "$1" >&2; exit 1; }

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

# The daemon is asked first and separately: a machine whose daemon does not
# answer is a different problem from a machine that has no such image, and the
# two must not be reported with the same words.
docker_daemon_alive || die "the Docker daemon does not answer. Restart it: systemctl restart docker"

if ! run_bounded "$DOCKER_CALL_TIMEOUT" docker image inspect "$PARSER_IMAGE" >/dev/null 2>&1; then
    die "the crawler image '$PARSER_IMAGE' is not available locally.
       Build it in the crawler repository:  just app::docker-build
       Or point this stack at another one:  STACK_PARSER_IMAGE=<image> just stack-up"
fi
ok "crawler image $PARSER_IMAGE"

# ── database and crawler ─────────────────────────────────────────────────────

step "Database and crawler"

docker_bounded compose -f "$ROOT/docker-compose.dev.yml" up -d db wb-parser >/dev/null \
    || die "the database and the crawler did not start"
ok "starting $DB_CONTAINER and $PARSER_CONTAINER"

bash "$ROOT/scripts/wait-healthy.sh" "$DB_CONTAINER" 120 >/dev/null
ok "$DB_CONTAINER healthy"

# The crawler applies its migrations and seeds itself. Readiness says both
# happened — it is the crawler's own statement, not a guess.
export CRAWLER_API_URL="http://localhost:$PARSER_PORT"
export CRAWLER_API_KEY="$CATALOG_API_KEY"
bash "$ROOT/scripts/wait-catalog-ready.sh" 240 >/dev/null \
    || die "the crawler did not become ready — see: docker logs $PARSER_CONTAINER"
ok "crawler ready on $CRAWLER_API_URL"

# ── storefront ───────────────────────────────────────────────────────────────

if [ "${STACK_SKIP_SITE:-0}" = "1" ]; then
    warn "skipping the storefront (STACK_SKIP_SITE=1)"
else
    step "Storefront"
    if running_pid "$STACK_DIR/site.pid" "$SITE_MATCH" >/dev/null; then
        ok "already running (pid $(cat "$STACK_DIR/site.pid"))"
    else
        launch "$STACK_DIR/site.pid" "$LOG_DIR/site.log" \
            env \
            CRAWLER_API_URL="$CRAWLER_API_URL" \
            CRAWLER_API_KEY="$CATALOG_API_KEY" \
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
fi

# ── report ───────────────────────────────────────────────────────────────────

step "Ready"
echo "  database    docker container $DB_CONTAINER (no published port)"
echo "  crawler     $CRAWLER_API_URL"
[ "${STACK_SKIP_SITE:-0}" = "1" ] || echo "  storefront  http://localhost:$SITE_PORT"
echo ""
echo "  the catalog API answers:"
echo "    curl -H \"X-Api-Key: \$CRAWLER_API_KEY\" $CRAWLER_API_URL/stats"
echo ""
echo "  Stop everything with: just stack-down"

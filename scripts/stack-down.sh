#!/usr/bin/env bash
#
# Stop everything `just stack-up` started: crawler, storefront, dev database.
#
#   just stack-down
#   just stack-down --purge     # also drop the database volume (destructive)
#
# ORDER MATTERS
#
# Crawler, then storefront, then database. The crawler holds pooled JDBC
# connections to the dev database; killing the database out from under it leaves
# a process that logs connection errors for as long as it lives. The storefront
# opens a new connection per query through a pool, so it would merely fail its
# next render — but there is no reason to let either happen.
#
# PROCESS GROUPS, NOT PIDS
#
# `npm run dev` forks a `next-server` that outlives its parent, so signalling the
# recorded npm PID leaves the process holding :3000 alive and the next
# `stack-up` fails on "address already in use". Both services are started under
# `setsid` (see stack-up.sh), which gives each its own process group whose PGID
# equals the recorded PID — so the whole group can be signalled at once.
#
# A recorded PID is verified against /proc/<pid>/cmdline before it is signalled.
# PIDs get reused, and `kill` on a recycled PID belonging to something else is
# the kind of mistake that is only noticed much later.
#
# WITHOUT --purge
#
# The Postgres volume is left alone. It holds the synthetic seed and, after a
# real crawl, hundreds of scraped rows; a stack that forgets its own state
# between sessions is an annoyance, a stack that forgets its data is a lost
# afternoon. `--purge` is the explicit, separate ask.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="$ROOT/.stack"
LOG_DIR="$STACK_DIR/logs"

PURGE=0
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
    esac
done

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[0;32m  ✅ %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m  ⚠️  %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m  ❌ %s\033[0m\n' "$1" >&2; exit 1; }

# What identifies each service in /proc/<pid>/cmdline.
#
# The storefront is `npm run dev`, NOT `next` — npm is the process that gets the
# pidfile and its command line never contains the word "next". Matching on "next"
# made a healthy storefront look like a recycled PID, so the group kill was
# skipped and only the port-holder fallback stopped it. `next-server` is the
# child that actually binds :3000; clear_port deals with that one.
SITE_MATCH="run dev"
PARSER_MATCH="app.jar"

# Signal a process group, escalating to SIGKILL only if SIGTERM is ignored.
#
# `$1` = pidfile, `$2` = substring that must appear in the cmdline, `$3` = label.
stop_group() {
    local pidfile="$1" expect="$2" label="$3" pid waited

    [ -f "$pidfile" ] || { warn "$label not running (no pidfile)"; return 0; }

    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -z "$pid" ]; then
        warn "$label pidfile is empty"
        rm -f "$pidfile"
        return 0
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
        warn "$label already gone (stale pidfile)"
        rm -f "$pidfile"
        return 0
    fi

    if ! tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$expect"; then
        # The PID exists but it is not what we started. Refusing here is the
        # entire point of writing the check down.
        warn "$label pid $pid has been recycled — not killing it, removing the pidfile"
        rm -f "$pidfile"
        return 0
    fi

    # Negative PID = the whole process group.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 15 ]; do
        sleep 1
        waited=$((waited + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        warn "$label ignored SIGTERM — sending SIGKILL"
        kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi

    rm -f "$pidfile"
    ok "$label stopped (pid $pid)"
}

# ---- crawler ----------------------------------------------------------------

step "Crawler"
stop_group "$STACK_DIR/parser.pid" "$PARSER_MATCH" "crawler"

# ---- storefront -------------------------------------------------------------

step "Storefront"
stop_group "$STACK_DIR/site.pid" "$SITE_MATCH" "storefront"

# A `next dev` child can outlive the group leader that was recorded, and it is
# the process holding :3000. Leaving it behind means the next `stack-up` fails
# on "address already in use" — so the port is cleared, but only after checking
# that whoever holds it is this stack. Killing an arbitrary PID by port number is
# how you take down somebody's unrelated server.
clear_port() {
    local port="$1" expect="$2" label="$3" holder

    holder="$(ss -tlnp 2>/dev/null | grep -E ":$port[[:space:]]" \
        | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"

    [ -n "$holder" ] || return 0

    if ! tr '\0' ' ' < "/proc/$holder/cmdline" 2>/dev/null | grep -q -- "$expect"; then
        warn ":$port is held by pid $holder, which is not $label — leaving it alone"
        return 0
    fi

    warn ":$port still held by $label (pid $holder) — stopping it"
    kill -TERM "$holder" 2>/dev/null || true
    sleep 2
    kill -0 "$holder" 2>/dev/null && kill -KILL "$holder" 2>/dev/null || true
    ok "$label released :$port"
}

clear_port "${STACK_SITE_PORT:-3000}" "$SITE_MATCH\|next-server" "the storefront"
clear_port "${STACK_PARSER_PORT:-8090}" "$PARSER_MATCH" "the crawler"

# ---- database ---------------------------------------------------------------

step "Database"
if docker ps --format '{{.Names}}' | grep -qx "product-catalog-dev-db"; then
    if [ "$PURGE" = "1" ]; then
        (cd "$ROOT" && docker compose -f docker-compose.dev.yml down -v >/dev/null)
        ok "dev database and its volume removed (--purge)"
    else
        (cd "$ROOT" && docker compose -f docker-compose.dev.yml down >/dev/null)
        ok "dev database stopped (volume kept — use --purge to drop it)"
    fi
else
    warn "dev database not running"
fi

# ---- report -----------------------------------------------------------------

step "Done"
echo "  logs kept for inspection: $LOG_DIR"
echo ""
echo "  Bring it all back with: just stack-up"
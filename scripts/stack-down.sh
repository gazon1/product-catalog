#!/usr/bin/env bash
#
# Stop what `just stack-up` started: the storefront.
#
#   just stack-down
#
# WHAT IT STOPS
#
# The storefront, and nothing else. The crawler and its database are not ours:
# they are started, stopped and migrated in the crawler repository, and this
# script does not know their names.
#
# PROCESS GROUPS, NOT PIDS
#
# `npm run dev` forks a `next-server` that outlives its parent, so signalling
# the recorded npm PID leaves the process holding :3000 alive and the next
# `stack-up` fails on "address already in use". The storefront is started under
# `setsid` (see stack-up.sh), which gives it its own process group whose PGID
# equals the recorded PID — so the whole group can be signalled at once.
#
# A recorded PID is verified against /proc/<pid>/cmdline before it is signalled.
# PIDs get reused, and `kill` on a recycled PID belonging to something else is
# the kind of mistake that is only noticed much later.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="$ROOT/.stack"
LOG_DIR="$STACK_DIR/logs"

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[0;32m  ✅ %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m  ⚠️  %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m  ❌ %s\033[0m\n' "$1" >&2; exit 1; }

# What identifies the storefront in /proc/<pid>/cmdline.
#
# The storefront is `npm run dev`, NOT `next` — npm is the process that gets the
# pidfile and its command line never contains the word "next". Matching on
# "next" made a healthy storefront look like a recycled PID, so the group kill
# was skipped and only the port-holder fallback stopped it. `next-server` is the
# child that actually binds :3000; clear_port deals with that one.
SITE_MATCH="run dev"

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

# ---- report -----------------------------------------------------------------

step "Done"
echo "  logs kept for inspection: $LOG_DIR"
echo ""
echo "  Bring it back with: just stack-up"

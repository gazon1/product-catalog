#!/usr/bin/env bash
#
# Block until a container reports healthy, or fail loudly.
#
# Used by `just wait-healthy` and by the deploy workflow on the VPS, so the
# definition of "the deploy worked" lives in exactly one place.
#
# NOT `docker compose wait`: that blocks until containers STOP, which a
# long-running web server never does — it would burn the whole timeout on every
# deploy and then continue as if nothing were wrong.
#
# `docker ps --filter` is used instead of `docker inspect -f` on purpose: a Go
# template contains doubled braces, which `just` tries to interpolate before the
# recipe runs, and quoting does not help.
#
# Usage: wait-healthy.sh <container> [timeout-seconds]

set -euo pipefail

container="${1:-}"
timeout="${2:-300}"

if [ -z "$container" ]; then
    echo "usage: $(basename "$0") <container> [timeout-seconds]" >&2
    exit 1
fi

# Anchored, so `product-catalog` cannot be matched while waiting for `product-catalog-dev-db`.
name_filter="name=^/${container}$"

echo "→ Waiting for ${container} to become healthy (timeout ${timeout}s)..."

state=missing
deadline=$(( $(date +%s) + timeout ))

while [ "$(date +%s)" -lt "$deadline" ]; do
    # Order matters. health=none is checked BEFORE the plain "is it running"
    # test, otherwise a container without a healthcheck looks like a perfectly
    # normal starting one and we would sit here for the full timeout.
    if docker ps --filter "$name_filter" --filter "health=healthy" -q | grep -q .; then
        state=healthy
    elif docker ps --filter "$name_filter" --filter "health=unhealthy" -q | grep -q .; then
        state=unhealthy
    elif docker ps --filter "$name_filter" --filter "health=none" -q | grep -q .; then
        state=no-healthcheck
    elif docker ps --filter "$name_filter" -q | grep -q .; then
        state=starting
    elif docker ps -a --filter "$name_filter" -q | grep -q .; then
        state=exited
    else
        state=missing
    fi

    case "$state" in
        healthy)
            echo "✅ ${container} is healthy"
            exit 0
            ;;
        unhealthy)
            echo "❌ ${container} reported unhealthy" >&2
            docker logs --tail 50 "$container" >&2 || true
            exit 1
            ;;
        no-healthcheck)
            # Failing here rather than treating it as "still starting" is the
            # whole point: this container's healthcheck also probes the
            # database, so a missing check means a broken deployment, not a slow
            # one.
            echo "❌ ${container} is running but has no healthcheck — check docker-compose.yml" >&2
            exit 1
            ;;
    esac

    sleep 5
done

echo "❌ ${container} did not become healthy within ${timeout}s (last state: ${state})" >&2
docker compose ps >&2 2>/dev/null || true
docker logs --tail 50 "$container" >/dev/null 2>&1 || true
exit 1
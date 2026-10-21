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
# Every Docker call is bounded: a daemon that does not answer has to say so
# instead of hanging the wait until its own timeout.
#
# Usage: wait-healthy.sh <container> [timeout-seconds]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/docker-timeout.sh"

container="${1:-}"
timeout="${2:-300}"

if [ -z "$container" ]; then
    echo "usage: $(basename "$0") <container> [timeout-seconds]" >&2
    exit 1
fi

# The ids of the containers that match the filters.
#
# The answer lands in `ids`, and the status says whether the daemon answered
# at all: "the container is missing" and "we could not look" are different
# states, and only one of them is worth waiting for. The function does not
# exit on its own — it is called from this shell, not from a subshell, so the
# caller decides what a daemon that does not answer means.
ids_matching() {
    ids="$(docker_bounded ps "$@" -q)" || return 1
    return 0
}

# The daemon did not answer. There is nothing to wait for: the container may
# well be healthy, and this script cannot tell.
die() {
    echo "❌ $1" >&2
    echo "   Restart the Docker daemon: systemctl restart docker" >&2
    exit 1
}

# Anchored, so `product-catalog` cannot be matched while waiting for `product-catalog-dev-db`.
name_filter="name=^/${container}$"

echo "→ Waiting for ${container} to become healthy (timeout ${timeout}s)..."

state=missing
deadline=$(( $(date +%s) + timeout ))

while [ "$(date +%s)" -lt "$deadline" ]; do
    # Order matters. health=none is checked BEFORE the plain "is it running"
    # test, otherwise a container without a healthcheck looks like a perfectly
    # normal starting one and we would sit here for the full timeout.
    ids_matching --filter "$name_filter" --filter "health=healthy" \
        || die "the Docker daemon does not answer"
    healthy="$ids"

    ids_matching --filter "$name_filter" --filter "health=unhealthy" \
        || die "the Docker daemon does not answer"
    unhealthy="$ids"

    ids_matching --filter "$name_filter" --filter "health=none" \
        || die "the Docker daemon does not answer"
    without_healthcheck="$ids"

    ids_matching --filter "$name_filter" \
        || die "the Docker daemon does not answer"
    running="$ids"

    ids_matching --all --filter "$name_filter" \
        || die "the Docker daemon does not answer"
    known="$ids"

    if [ -n "$healthy" ]; then
        state=healthy
    elif [ -n "$unhealthy" ]; then
        state=unhealthy
    elif [ -n "$without_healthcheck" ]; then
        state=no-healthcheck
    elif [ -n "$running" ]; then
        state=starting
    elif [ -n "$known" ]; then
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
            docker_bounded logs --tail 50 "$container" >&2 || true
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
docker_bounded compose ps >/dev/null 2>&1 || true
docker_bounded logs --tail 50 "$container" >/dev/null 2>&1 || true
exit 1
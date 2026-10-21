#!/usr/bin/env bash
#
# docker-timeout.sh — the ceiling on every Docker call, and what to say when
# the ceiling is reached.
#
# WHY A CEILING
#
# A Docker daemon that does not answer does not answer quickly: the client
# waits on the socket, the socket waits on the daemon, and nothing ever comes
# back. A stand script that calls it without a limit hangs forever — and a
# hanging script is worse than a failing one: it holds the terminal, it holds
# the CI job, and it says nothing at all about what went wrong.
#
# So every Docker call in this repository goes through `docker_bounded`, which
# puts a ceiling on the wait and turns the ceiling into an error with a text:
# what did not answer, and what to do about it.
#
# THE CEILING
#
# Thirty seconds is generous for the calls that do real work — a compose up
# pulls images — and short enough to be a message rather than a wait. A slower
# machine can raise it with DOCKER_CALL_TIMEOUT.
#
# USAGE
#
#   . "$(dirname "$0")/docker-timeout.sh"
#   docker_bounded ps --format '{{.Names}}'

# The ceiling, in seconds.
DOCKER_CALL_TIMEOUT="${DOCKER_CALL_TIMEOUT:-30}"

# Run a command with a ceiling on its runtime.
#
# `timeout` does it wherever coreutils is installed; the watchdog below is the
# same thing for the machines that do not have it. The status 124 is the
# convention for "the ceiling was reached", and it is what the caller checks.
run_bounded() {
    local limit="$1"
    shift

    if command -v timeout >/dev/null 2>&1; then
        timeout "$limit" "$@"
        return $?
    fi

    "$@" &
    local pid=$!
    ( sleep "$limit"; kill -TERM "$pid" 2>/dev/null || true ) &
    local watchdog=$!
    wait "$pid"
    local status=$?
    kill "$watchdog" 2>/dev/null || true

    # A command the watchdog had to kill reports the signal, not the ceiling.
    if [ "$status" -ge 128 ]; then
        return 124
    fi
    return "$status"
}

# Run docker with the ceiling, and say what happened when it fails.
#
# `$@` is the docker command and its arguments. The status is docker's own, or
# 124 when the ceiling was reached. The output of a successful call is passed
# through, so the caller can pipe it.
docker_bounded() {
    local status=0
    local output

    output="$(run_bounded "$DOCKER_CALL_TIMEOUT" docker "$@" 2>&1)" || status=$?

    if [ "$status" -eq 0 ]; then
        if [ -n "$output" ]; then
            printf '%s\n' "$output"
        fi
        return 0
    fi

    if [ "$status" -eq 124 ]; then
        echo "❌ the Docker daemon does not answer: 'docker $*' did not return in ${DOCKER_CALL_TIMEOUT}s." >&2
        echo "   If the daemon is stuck, restart it: systemctl restart docker" >&2
        return 124
    fi

    echo "❌ 'docker $*' failed (exit ${status})." >&2
    if [ -n "$output" ]; then
        printf '%s\n' "$output" | sed 's/^/   /' >&2
    fi
    # The daemon's own words are the surest sign that it is the daemon and not
    # the command that is at fault.
    if printf '%s' "$output" | grep -qi 'daemon'; then
        echo "   The Docker daemon does not answer. Restart it: systemctl restart docker" >&2
    fi
    return "$status"
}

# Whether the Docker daemon answers at all.
#
# The answer is what tells a hung daemon from a service that is merely slow:
# the first is a problem with the machine, the second is a problem with the
# service, and they need different words.
docker_daemon_alive() {
    docker_bounded version --format '{{.Server.Version}}' >/dev/null
}

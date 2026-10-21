#!/usr/bin/env bash
#
# pull-crawler-image.sh — pull the crawler's image from the registry, and say
# what is wrong when it cannot be pulled.
#
# WHY ONE SCRIPT
#
# The pull happens in two places — the CI job and the test suite — and the two
# have to fail the same way. A path that hangs on a rate limit in one place
# and explains it in the other is a path somebody debugs twice.
#
# THE RATE LIMIT
#
# GHCR serves anonymous clients at most 100 pulls per hour per address. The
# repository has no GHCR_READ_TOKEN secret, so the pull is anonymous — and the
# addresses of the runners are shared, so the limit is reached by other
# people's runs. The fix is a read-only token in the secret GHCR_READ_TOKEN;
# until there is one, this script says exactly that, instead of leaving the
# reader with the registry's "toomanyrequests" and no idea what it means.
#
# Usage: pull-crawler-image.sh <image-reference>

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/docker-timeout.sh"

image="${1:-}"
if [ -z "$image" ]; then
    echo "usage: $(basename "$0") <image-reference>" >&2
    exit 1
fi

REGISTRY="ghcr.io"
TOKEN="${GHCR_READ_TOKEN:-}"

if [ -n "$TOKEN" ]; then
    # A token that cannot log in is worse than no token at all: the pull would
    # then be anonymous and rate-limited, and the reason would be hidden behind
    # a login error.
    if ! echo "$TOKEN" | docker login "$REGISTRY" \
        --username "${GHCR_READ_USERNAME:-${GITHUB_ACTOR:-ci}}" --password-stdin; then
        echo "❌ the GHCR_READ_TOKEN was rejected by $REGISTRY." >&2
        echo "   The pull stays anonymous, and anonymous pulls are limited to 100 per hour per address." >&2
        exit 1
    fi
else
    echo "⚠️  no GHCR_READ_TOKEN: the pull of $image is anonymous." >&2
    echo "   $REGISTRY serves anonymous clients at most 100 pulls per hour per address, and the" >&2
    echo "   addresses of the runners are shared — so this pull can be refused by other people's runs." >&2
    echo "   A read-only token in the repository secret GHCR_READ_TOKEN ends the counting." >&2
fi

status=0
output="$(run_bounded "$DOCKER_CALL_TIMEOUT" docker pull "$image" 2>&1)" || status=$?

if [ "$status" -eq 0 ]; then
    printf '%s\n' "$output"
    exit 0
fi

echo "❌ the crawler image $image could not be pulled." >&2
if [ -n "$output" ]; then
    printf '%s\n' "$output" | sed 's/^/   /' >&2
fi

if [ "$status" -eq 124 ]; then
    echo "   The pull did not return in ${DOCKER_CALL_TIMEOUT}s." >&2
fi

if printf '%s' "$output" | grep -qiE 'toomanyrequests|rate limit|too many requests|429'; then
    echo "   That is $REGISTRY's pull limit: an anonymous client gets at most 100 pulls per hour per address." >&2
    if [ -z "$TOKEN" ]; then
        echo "   This pull was anonymous, because the repository has no GHCR_READ_TOKEN secret." >&2
        echo "   Add a read-only token as the secret GHCR_READ_TOKEN and run it again." >&2
    fi
fi

exit "$status"

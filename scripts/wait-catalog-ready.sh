#!/usr/bin/env bash
#
# Wait until the crawler's catalog API says it is ready.
#
#   bash scripts/wait-catalog-ready.sh [timeout-seconds]
#
# The probe is the crawler's own readiness endpoint, and it is asked with the key the
# storefront uses. Readiness is not "the process is up": it says the catalog's pool can
# run a statement and that the columns the catalog reads are there. A crawler that is
# up but has not migrated yet answers 503, and the storefront would render an error
# page for every request.
#
# The key is read from the environment, because the crawler and the storefront are
# configured with the same secret and the two configurations are not one file.
#
# The Docker daemon is asked about, with a ceiling on the wait, whenever the
# crawler does not answer and the crawler is local: a daemon that does not
# answer is a different problem from a crawler that is not ready yet, and the
# two need different words. Without the check, a hung daemon looks like a slow
# crawler and the wait burns its whole budget before saying anything.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/docker-timeout.sh"

TIMEOUT="${1:-180}"
API_URL="${CRAWLER_API_URL:-http://localhost:8080}"
API_KEY="${CRAWLER_API_KEY:-local-dev-catalog-key}"
READY_URL="$API_URL/api/catalog/v1/ready"

# Whether the crawler is expected to run on this machine.
#
# A remote crawler has nothing to do with the local Docker daemon, so the
# daemon is only asked about when the crawler is local — and a local crawler
# runs in a container, which means a daemon that does not answer is the reason
# the crawler is silent.
crawler_is_local() {
    case "$API_URL" in
        http://localhost:*|http://127.0.0.1:*) return 0 ;;
        *) return 1 ;;
    esac
}

waited=0
last_problem="the crawler did not answer"

while [ "$waited" -lt "$TIMEOUT" ]; do
    # `|| true`, not `|| echo 000`: curl already prints 000 for a connection it
    # could not make, and the two together made the message say "000000".
    status="$(curl -s -o /dev/null -w '%{http_code}' -m 3 \
        -H "X-Api-Key: $API_KEY" "$READY_URL" 2>/dev/null || true)"

    if [ "$status" = "200" ]; then
        exit 0
    fi

    if [ "$status" = "401" ]; then
        echo "the crawler rejected the catalog key (401)." >&2
        echo "The crawler and the storefront must be configured with the same key:" >&2
        echo "  crawler:    CATALOG_API_KEY" >&2
        echo "  storefront: CRAWLER_API_KEY" >&2
        exit 1
    fi

    if [ "$status" = "404" ]; then
        echo "the crawler does not serve $READY_URL — the image predates the catalog API." >&2
        exit 1
    fi

    if crawler_is_local; then
        if ! docker_daemon_alive; then
            echo "the Docker daemon does not answer, so the crawler at $API_URL cannot become ready." >&2
            echo "Restart it: systemctl restart docker" >&2
            exit 1
        fi
    fi

    last_problem="the readiness probe answered $status"
    sleep 2
    waited=$((waited + 2))
done

echo "the catalog API did not become ready within ${TIMEOUT}s: $last_problem" >&2
exit 1

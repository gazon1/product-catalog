#!/usr/bin/env bash
#
# How far behind the crawler's main the pinned image is.
#
#   scripts/pin-lag.sh [--repo gazon1/wb-parser-kotlin-new] [--ref main]
#
# WHY
#
# The pin names an image by digest: the image that was checked is the image
# that gets deployed. But a digest says nothing about *when* that image was
# built. A storefront can be pinned to an image that is three crawler's
# releases old, and nothing in the pin says so — the pin is a decision, and a
# decision that has quietly gone stale looks exactly like a decision that is
# still good.
#
# The image carries the commit it was built from in its labels
# (`org.opencontainers.image.revision`), and the crawler's repository says how
# far `main` has moved since that commit. The difference is the lag.
#
# WHAT IT IS NOT
#
# It is a report, not a gate. The storefront adapts to the crawler *after* the
# crawler moves (§7.3 of the plan), so a lag is the normal state of the two
# repositories between a crawler's release and the storefront's next one. A
# gate here would fail the storefront for the crawler's work — the wrong
# direction, and a red that nobody can act on.
#
# IT NEEDS DOCKER AND NETWORK
#
# The commit comes from the image's own labels, so the image has to be present
# locally (`docker pull` it first). The distance comes from the GitHub API.
# When either is unavailable, the script says so and says nothing else: a
# report that cannot be produced is not a failure, it is a missing report.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="gazon1/wb-parser-kotlin-new"
REF="main"

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) REPO="$2"; shift 2 ;;
        --ref)  REF="$2"; shift 2 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

step() { printf '\033[1;34m▸ %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m  ⚠️  %s\033[0m\n' "$1"; }
ok()   { printf '\033[0;32m  ✅ %s\033[0m\n' "$1"; }

PIN_FILE="$ROOT/contract/crawler-image.txt"

# The pin file is a comment block with one reference in it.
# `|| true` is not optional: grep answers 1 when it finds nothing, and under
# `set -e` that would end the script before it says anything.
image="$(grep -vE '^\s*(#|$)' "$PIN_FILE" | head -1 || true)"

if [ -z "$image" ]; then
    warn "the pin file names no image"
    exit 0
fi

if [[ "$image" != *@sha256:* ]]; then
    warn "the pin names a local tag ($image) — the lag is not defined for a tag"
    exit 0
fi

step "The commit the pinned image was built from"
# The pin records it: the crawler sends the commit with the publication, and
# the pin keeps it next to the digest. That is the primary source — it needs
# neither Docker nor the image.
#
# The label on the image is the fallback: an image built by a repository that
# stamps `org.opencontainers.image.revision` says the same thing on its own.
revision="$(grep -E '^#[[:space:]]*crawler-commit:' "$PIN_FILE" | head -1 | sed -E 's/^#[[:space:]]*crawler-commit:[[:space:]]*//' || true)"

if [ -z "$revision" ]; then
    # The timeout is not decoration: a Docker daemon that does not answer would
    # otherwise hang the report that was supposed to say the daemon is unwell.
    revision="$(timeout 30 docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)"
    if [ -z "$revision" ] || [ "$revision" = "<no value>" ]; then
        warn "the pin does not record the commit its image was built from, and the image carries no revision label — the lag is unknown"
        exit 0
    fi
fi
ok "$revision"

step "How far the crawler's $REF has moved"
response="$(timeout 30 curl -fsS -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/compare/${revision}...${REF}" 2>/dev/null || true)"

if [ -z "$response" ]; then
    warn "the GitHub API did not answer — the lag is unknown"
    exit 0
fi

read -r ahead status files <<<"$(printf '%s' "$response" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("unknown unknown 0")
    raise SystemExit(0)
print(data.get("ahead_by", "unknown"), data.get("status", "unknown"),
      len(data.get("files", []) or []))
')"

case "$status" in
    ahead|identical|diverged)
        case "$ahead" in
            ''|*[!0-9]*) warn "the distance is unknown" ;;
            0) ok "the pin is current: the crawler's $REF has not moved since this commit" ;;
            *) ok "the pin is $ahead commit(s) behind the crawler's $REF ($files file(s) changed)" ;;
        esac
        ;;
    *)
        warn "the comparison says '$status' — the pin's commit is not on the crawler's $REF"
        ;;
esac

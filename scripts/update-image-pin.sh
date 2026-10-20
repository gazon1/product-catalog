#!/usr/bin/env bash
# ==============================================================================
# update-image-pin.sh — move the storefront's image pin to a digest, in a PR.
#
# ## What it does
#
# It writes the crawler's image reference into `contract/crawler-image.txt` and
# opens a pull request with the change. It never pushes to the branch the
# storefront is deployed from: the pin is a decision, and a decision is reviewed.
#
# ## Why the pin is a digest and not a tag
#
# A tag can be moved. `latest` is moved every time the crawler is released, and
# a pin that names a tag says "whatever that tag points at when it is pulled".
# A digest names one image: `sha256:…` is the identity of the exact bytes, and
# the image that was checked is the image that gets deployed.
#
# ## Why the pin only moves for a release build
#
# The plan says the pin names the digest of a *merged* commit's build. The image
# of a pull request and the image of the merge that follows it are two different
# images with two different digests — the merge rebuilds, and the rebuild is not
# bit-for-bit the same bytes. Pinning the pull request's digest would pin an
# image that is never deployed.
#
# So the tag of the build is checked, and a `pr-<n>` image is refused.
#
# ## Why the pin moves only after a green check
#
# The pin is the storefront's statement about which crawler it understands. It
# is updated from a run that proved exactly that — the compatibility run whose
# conclusion is `success`, against the same digest, with the site's own commit
# in it.
#
# Without that condition the pin would move on every crawler release, and the
# storefront would start depending on a crawler image nobody checked against
# it. That is how a "green" storefront deploys against a crawler that answers a
# different shape.
#
# ## Usage
#
#   scripts/update-image-pin.sh --digest sha256:… [--tag TAG] [--run-id N]
#                               [--verify-run] [--dry-run]
#
# `--verify-run` asks the script to read the run's conclusion from the GitHub
# API and refuse to move the pin unless it is `success`. The workflow that calls
# this script does not pass it: that workflow's pin job *depends on* the
# compatibility job, so its own green is the proof — and the run's conclusion is
# not `success` yet while the run is still going. The flag is for the manual
# invocation, where the run has finished.
# ==============================================================================

set -euo pipefail

# The root is where the repository is. `PIN_ROOT` overrides it, and the
# override exists because the script rewrites a tracked file: a test that runs
# it against the real checkout would leave the tree dirty, and a copy of the
# repository is the only safe place to run it in.
ROOT="${PIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

PIN_FILE="contract/crawler-image.txt"
BRANCH="${PIN_BRANCH:-chore/pin-crawler-image}"
BASE="${PIN_BASE:-main}"
IMAGE_NAME="${CRAWLER_IMAGE_NAME:-ghcr.io/gazon1/wb-parser}"

DIGEST=""
TAG=""
RUN_ID=""
VERIFY_RUN=false
DRY_RUN=false

usage() {
    sed -n '3,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --digest) DIGEST="$2"; shift 2 ;;
        --tag) TAG="$2"; shift 2 ;;
        --run-id) RUN_ID="$2"; shift 2 ;;
        --verify-run) VERIFY_RUN=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

# The reference may arrive as a whole image reference — the dispatch payload
# carries one — and the digest is the part that names the image.
if [[ "$DIGEST" == *@sha256:* ]]; then
    DIGEST="${DIGEST##*@}"
fi

if [[ -z "$DIGEST" ]]; then
    echo "error: --digest is required" >&2
    exit 2
fi

# The digest is the identity of the image. A tag is not, and a pin that names
# a tag says "whatever it points at when it is pulled" — which is exactly the
# promise the pin must not make.
if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "error: '$DIGEST' is not a digest — the pin names one image, and only a digest does that" >&2
    exit 2
fi

# A pull request's image is never the deployed one: the merge rebuilds it.
if [[ "$TAG" == pr-* ]]; then
    echo "error: '$TAG' is a pull request image — the pin names the digest of a merged" >&2
    echo "       commit's build, and the merge of that pull request is a different image." >&2
    exit 1
fi

IMAGE="${IMAGE_NAME}@${DIGEST}"

# --- the current pin ---------------------------------------------------------

current_pin() {
    grep -vE '^\s*(#|$)' "$PIN_FILE" | head -1
}

CURRENT="$(current_pin)"

if [[ "$CURRENT" == "$IMAGE" ]]; then
    echo "the pin already names this image — nothing to do"
    echo "pin: $CURRENT"
    exit 0
fi

# --- the run that proved it --------------------------------------------------

# The pin moves on the strength of a green compatibility run for *this* digest.
# The run is read from the GitHub API rather than taken on trust, because a
# workflow that reports "success" because it was skipped is exactly the failure
# mode this repository refuses.
if [[ "$VERIFY_RUN" == "true" ]]; then
    if [[ -z "$RUN_ID" ]]; then
        echo "error: --verify-run needs --run-id" >&2
        exit 2
    fi
    if ! command -v gh >/dev/null 2>&1; then
        echo "error: --verify-run needs the GitHub CLI" >&2
        exit 2
    fi
    repo="${SITE_REPO:-gazon1/product-catalog}"
    conclusion="$(gh api "repos/${repo}/actions/runs/${RUN_ID}" --jq '.conclusion' 2>/dev/null || echo "unknown")"
    if [[ "$conclusion" != "success" ]]; then
        echo "error: the compatibility run ${RUN_ID} concluded '${conclusion}', not 'success'." >&2
        echo "       The pin moves only on a run that proved the storefront understands this image." >&2
        exit 1
    fi
    echo "the compatibility run ${RUN_ID} concluded 'success'"
fi

# --- the change ---------------------------------------------------------------

# The file keeps its explanation and changes only the reference: the comments
# say why the pin is what it is, and a rewrite that dropped them would leave
# the next reader without the reason.
BODY="$(cat <<EOF
The crawler's image pin, moved to the digest whose compatibility run is green.

- Image: \`${IMAGE}\`
- Compatibility run: ${RUN_ID:-the run that called this script}

The pin names a digest rather than a tag because a tag can be moved and a
digest cannot: the image that was checked is the image that gets deployed.

The pin moves only after the compatibility run for this exact digest concluded
\`success\`. A pin that moved on every crawler release would have the storefront
depending on a crawler image nobody checked it against.

This change is reviewed like any other: the pin is a decision.
EOF
)"

# The branch is cut from the base *before* the file is written. A checkout
# refuses to move when a tracked file it would overwrite has local changes —
# and writing the pin first is exactly that. The order is the whole trick.
#
# The pin's own branch is fetched too, when it exists. The push below is
# `--force-with-lease`, and a lease is a promise about the branch's current
# state: it is kept against the remote-tracking ref, and a ref that was never
# fetched is not a promise the push can keep — the push would be refused with
# "stale info" on every run after the first. Fetching first makes the lease
# mean what it says: "replace the branch, but only if it is still the branch I
# looked at".
if [[ "$DRY_RUN" != "true" ]]; then
    git fetch origin "$BASE" --quiet
    if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
        git fetch origin "$BRANCH" --quiet
    fi
    git checkout -B "$BRANCH" "origin/$BASE"
fi

# The reference line is the first non-comment line; the comments above it are
# kept.
{
    awk '/^\s*#/ || /^\s*$/ { print; next } { exit }' "$PIN_FILE"
    echo "$IMAGE"
    echo
    echo "# Updated by scripts/update-image-pin.sh — the digest of the image whose"
    echo "# compatibility run concluded 'success'. The pull request links to that run."
} >"$PIN_FILE.new"

mv "$PIN_FILE.new" "$PIN_FILE"

echo "pin moved:"
echo "  from: ${CURRENT:-<none>}"
echo "  to:   ${IMAGE}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo
    echo "dry run — the change is in the working tree:"
    git --no-pager diff -- "$PIN_FILE"
    exit 0
fi

# --- the pull request --------------------------------------------------------

if git diff --quiet -- "$PIN_FILE"; then
    echo "no change to the pin file"
    exit 0
fi

git add "$PIN_FILE"
git commit -m "chore: pin the crawler image to ${DIGEST:0:19}…" -m "$BODY"
git push --force-with-lease origin "$BRANCH"

# The pull request is opened through the REST endpoint rather than through
# the GraphQL mutation that `gh pr create` uses. The mutation refuses the
# token of a workflow unless the repository has allowed Actions to create
# pull requests, and it refuses it with a message about *approving* pull
# requests — which is not what this script does, and which leaves the reader
# guessing. The REST endpoint asks the one question that matters here: may
# this token open a pull request in this repository?
REPO="${SITE_REPO:-gazon1/product-catalog}"
OWNER="${REPO%%/*}"
TITLE="chore: pin the crawler image to ${DIGEST:0:19}…"

if ! command -v gh >/dev/null 2>&1; then
    echo "error: the GitHub CLI is needed to open the pull request" >&2
    exit 1
fi

existing="$(gh api "repos/${REPO}/pulls?state=open&head=${OWNER}:${BRANCH}" --jq '.[0].number' 2>/dev/null || true)"
if [[ -n "$existing" && "$existing" != "null" ]]; then
    gh api --method PATCH "repos/${REPO}/pulls/${existing}" \
        -f title="$TITLE" -f body="$BODY" >/dev/null
    echo "pull request #${existing} updated"
else
    url="$(gh api --method POST "repos/${REPO}/pulls" \
        -f title="$TITLE" -f head="$BRANCH" -f base="$BASE" -f body="$BODY" \
        --jq '.html_url')"
    echo "pull request opened: ${url}"
fi

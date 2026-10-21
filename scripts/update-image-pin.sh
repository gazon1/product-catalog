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
# ## Why the types travel with the pin
#
# The storefront's types describe the contract of the image it talks to, and the
# pin is that image. So the pull request that moves the pin carries the types
# regenerated from the contract of the commit it pins — the pin and the types
# arrive together, in one pull request.
#
# Without them the storefront would be left compiling against a contract the
# pinned image no longer speaks: the pin says "this crawler", and the types
# have to say the same thing. A change of the crawler's contract that needs
# more than regenerated types shows up as a red `typecheck` in that very pull
# request — which is where it belongs.
#
# ## Usage
#
#   scripts/update-image-pin.sh --digest sha256:… [--tag TAG] [--run-id N]
#                                 [--crawler-commit SHA]
#                                 [--contract-document PATH]
#                               [--verify-run] [--dry-run]
#
# `--contract-document` names the crawler's contract document of the commit
# being pinned. With it, the types are regenerated from that document before
# the pin is written, and both land in the same commit.
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
# The commit the image was built from. The pin names the image; the commit
# says *when* it was built, and that is what makes the pin's staleness
# visible (scripts/pin-lag.sh).
CRAWLER_COMMIT=""
# The contract document of the commit being pinned. With it, the types are
# regenerated before the pin is written — the pin and the types travel in the
# same commit, because the storefront compiles against both.
CONTRACT_DOCUMENT=""
RUN_ID=""
VERIFY_RUN=false
DRY_RUN=false

usage() {
    sed -n '3,75p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --digest) DIGEST="$2"; shift 2 ;;
        --crawler-commit) CRAWLER_COMMIT="$2"; shift 2 ;;
        --contract-document) CONTRACT_DOCUMENT="$2"; shift 2 ;;
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

# The lines the pull request's description gets from the run: the commit the
# image was built from, and the fact that the types travel with the pin. They
# are built here rather than inside the description, so that a missing value is
# an empty line and not a failed command in the middle of the text.
BODY_COMMIT_LINE=""
if [[ -n "$CRAWLER_COMMIT" ]]; then
    BODY_COMMIT_LINE="- Crawler commit: ${CRAWLER_COMMIT}"
fi

BODY_TYPES_LINE=""
if [[ -n "$CONTRACT_DOCUMENT" ]]; then
    BODY_TYPES_LINE="The storefront's types are regenerated from the contract of that commit and travel with the pin: the types are what the storefront compiles against, and they have to describe the contract of the image the pin names."
fi

# The file keeps its explanation and changes only the reference: the comments
# say why the pin is what it is, and a rewrite that dropped them would leave
# the next reader without the reason.
BODY="$(cat <<EOF
The crawler's image pin, moved to the digest whose compatibility run is green.

- Image: \`${IMAGE}\`
- Compatibility run: ${RUN_ID:-the run that called this script}
${BODY_COMMIT_LINE}

The pin names a digest rather than a tag because a tag can be moved and a
digest cannot: the image that was checked is the image that gets deployed.

The pin moves only after the compatibility run for this exact digest concluded
\`success\`. A pin that moved on every crawler release would have the storefront
depending on a crawler image nobody checked it against.

${BODY_TYPES_LINE}

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

# --- the types ----------------------------------------------------------------
#
# The types are regenerated *before* the pin is written, and they are what the
# storefront compiles against: the pin says which crawler the storefront talks
# to, and the types say what that crawler speaks. Writing the pin first and the
# types afterwards would still land them in one commit — but the order is what
# makes the failure legible: a contract that the storefront's code cannot
# follow stops the run here, with the generator's own complaint on screen,
# rather than after the pin has already been moved.
#
# The document is the one of the commit being pinned — the same commit the
# compatibility job checked the image against. A document of another commit
# would describe another contract, and the types would be right about the
# wrong crawler.
TYPES_FILE="src/lib/api/types.generated.ts"

if [[ -n "$CONTRACT_DOCUMENT" ]]; then
    if [[ ! -f "$CONTRACT_DOCUMENT" ]]; then
        echo "error: the contract document '$CONTRACT_DOCUMENT' does not exist" >&2
        echo "       the types cannot be generated from a document that is not there" >&2
        exit 2
    fi
    if [[ -z "$CRAWLER_COMMIT" ]]; then
        echo "error: --contract-document needs --crawler-commit" >&2
        echo "       the pin names the image and the commit it was built from, and" >&2
        echo "       the types describe the contract of that commit" >&2
        exit 2
    fi

    mkdir -p "$(dirname "$TYPES_FILE")"
    echo "regenerating the types from ${CONTRACT_DOCUMENT}"
    # The document is named explicitly, and not found by the generator's own
    # resolution: the generator's candidates are the crawler's checkouts, and
    # this run has already said which one it means.
    CONTRACT_OPENAPI_PATH="$CONTRACT_DOCUMENT" node scripts/generate-contract-types.mjs
fi

# The reference line is the first non-comment line; the comments above it are
# kept.
{
    awk '/^\s*#/ || /^\s*$/ { print; next } { exit }' "$PIN_FILE"
    echo "$IMAGE"
    echo
    echo "# Updated by scripts/update-image-pin.sh — the digest of the image whose"
    echo "# compatibility run concluded 'success'. The pull request links to that run."
    if [ -n "$CRAWLER_COMMIT" ]; then
        echo "#"
        echo "# crawler-commit: ${CRAWLER_COMMIT}"
        echo "# The commit the pinned image was built from. A digest says which image"
        echo "# is pinned; this says how far the crawler's main has moved since it."
    fi
} >"$PIN_FILE.new"

mv "$PIN_FILE.new" "$PIN_FILE"

echo "pin moved:"
echo "  from: ${CURRENT:-<none>}"
echo "  to:   ${IMAGE}"

if [[ "$DRY_RUN" == "true" ]]; then
    echo
    echo "dry run — the change is in the working tree:"
    git --no-pager diff -- "$PIN_FILE" "$TYPES_FILE"
    exit 0
fi

# --- the pull request --------------------------------------------------------

if git diff --quiet -- "$PIN_FILE"; then
    echo "no change to the pin file"
    exit 0
fi

# The pin and the types are one decision, and they land in one commit: the
# storefront's types describe the contract of the image the pin names, and a
# pull request that carries one without the other is a pull request that leaves
# the storefront half-adapted.
git add "$PIN_FILE"
if [[ -n "$CONTRACT_DOCUMENT" ]]; then
    git add "$TYPES_FILE"
fi
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

# =============================================================================
# product-catalog — build recipes
# Run `just --list` for all available commands.
# Run `just check` before every commit.
# =============================================================================

set shell := ["bash", "-uc"]
set unstable

# ==============================================================================
# DEFAULT
# ==============================================================================
[doc('Show available commands')]
default:
    @just --list --list-heading $'📦 Available Commands:\n' --list-prefix '  • '

# ==============================================================================
# Local development
# ==============================================================================
# The storefront on the host, in dev mode, against a crawler that somebody else
# runs. The crawler and its database are not ours: they live in the crawler
# repository and are started from there.
#
# The address and the key come from the environment or from `.env` — the same
# two values production uses. A key that contains a `$` is written in single
# quotes, and the quotes are not part of the value: the same reader that
# `stack-up` uses reads them here, so both recipes talk to the catalog with
# the same key.
[doc('Run next dev on :3000 against a crawler that is already running')]
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    source scripts/read-env.sh
    api_url="$(read_env CRAWLER_API_URL)"
    api_key="$(read_env CRAWLER_API_KEY)"
    [ -n "$api_url" ] || { echo "error: CRAWLER_API_URL is not set. Put it in .env (see .env.example)." >&2; exit 1; }
    [ -n "$api_key" ] || { echo "error: CRAWLER_API_KEY is not set. Put it in .env (see .env.example)." >&2; exit 1; }
    export CRAWLER_API_URL="$api_url" CRAWLER_API_KEY="$api_key"
    npm run dev

# The storefront, on the host, against a crawler that somebody else runs. The
# crawler and its database are not ours: they live in the crawler repository and
# are started from there. `just stack-down` stops the storefront.
[doc('Bring up the storefront (the crawler runs somewhere else)')]
stack-up:
    bash scripts/stack-up.sh

[doc('Stop the storefront')]
stack-down:
    bash scripts/stack-down.sh

[doc('Remove the local stack, the build output and the test artefacts')]
clean *args:
    bash scripts/clean.sh {{args}}

# ==============================================================================
# Verification
# ==============================================================================
[doc('Typecheck')]
typecheck:
    npx tsc --noEmit

[doc('Run the unit, architecture and contract tests (requires a working Docker daemon)')]
test:
    npx vitest run

[doc('Run only the contract test: the crawler this storefront talks to, against the contract')]
contract-check:
    npm run contract-check

[doc('Regenerate the site’s types from the crawler’s contract document')]
contract-types:
    npm run contract-types

[doc('Fail when the committed types no longer describe the crawler’s contract document')]
contract-types-check:
    npm run contract-types:check

[doc('Fail when a test file did not execute (reads the JUnit XML npm test wrote)')]
test-runs:
    python3 scripts/check-test-runs.py

[doc('Production build')]
build:
    npm run build

# Runs the gates that CI runs, so a green local run means a green pipeline.
#
# The gates are written down once — in config/gates.yaml — and both sides run
# them from there through the same script. A gate that is written down twice
# is a gate that gets updated in one of the two places, and the one nobody
# reads is the one that rots.
#
# The order, and why it is that order, is in the list itself.
#
# `just check` needs a working Docker daemon and the crawler's image: the
# contract gates talk to the crawler.
[doc('Everything CI runs: the gates of config/gates.yaml (needs Docker and the crawler image)')]
check:
    node scripts/run-gates.mjs

# ==============================================================================
# Deployment
# ==============================================================================
[doc('Build the production image locally')]
docker-build *args:
    docker build -t product-catalog:local {{args}} .

[doc('Build and push to GHCR (requires gh auth)')]
release:
    git push origin main
    @echo "CI will build and push the image; deploy it from the Deploy workflow."

[doc('Block until a container reports healthy')]
wait-healthy container='product-catalog':
    bash scripts/wait-healthy.sh {{container}} 300

# ==============================================================================
# Caddy route
# ==============================================================================
# The shared reverse proxy is NOT this project's business. It is provisioned by
# the Caddy-vps Ansible repository (gazon1/Caddy-vps), which backs the snippet
# up, validates the result and rolls back on failure. Nothing here touches
# caddy_global.
#
# CADDY_VPS_DIR points at a Caddy-vps checkout and defaults to a sibling directory,
# which is where it sits on a developer machine. The deploy workflow's route
# drift check compares deploy/caddy.conf.caddy against
# /opt/caddy/conf.d/product-catalog.caddy, so the snippet has to be applied from
# this recipe before a deploy — a forgotten `just route` fails the deploy
# instead of shipping a 502.
# Caddy-vps defaults to ~/Caddy-vps on this machine; override with CADDY_VPS_DIR env var
CADDY_VPS_DIR := env('CADDY_VPS_DIR', home_directory() / 'Caddy-vps')
ROUTE_NAME := 'product-catalog'

[doc('Apply deploy/caddy.conf.caddy to the shared proxy (needs a Caddy-vps checkout)')]
route *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f "{{ CADDY_VPS_DIR }}/site.yml" ]; then
      echo "error: no Caddy-vps checkout at {{ CADDY_VPS_DIR }}" >&2
      echo "       git clone git@github.com:gazon1/Caddy-vps.git, or set" >&2
      echo "       CADDY_VPS_DIR=/path/to/Caddy-vps and re-run." >&2
      exit 1
    fi
    just --justfile "{{ CADDY_VPS_DIR }}/justfile" route "{{ ROUTE_NAME }}" \
      "{{ justfile_directory() }}/deploy/caddy.conf.caddy" {{ args }}

[doc('Compare the local route snippet against the one installed on a host')]
route-drift host="" user="":
    #!/usr/bin/env bash
    set -euo pipefail
    local_file="{{ justfile_directory() }}/deploy/caddy.conf.caddy"
    if [ -z "{{ host }}" ]; then
      echo "usage: just route-drift <host> [user]"
      echo "  compares $local_file against /opt/caddy/conf.d/{{ ROUTE_NAME }}.caddy"
      exit 0
    fi
    target="{{ user }}"
    [ -n "$target" ] || target="root"
    local_sum=$(sha256sum "$local_file" | cut -d' ' -f1)
    remote_sum=$(ssh "$target@{{ host }}" \
      "sha256sum /opt/caddy/conf.d/{{ ROUTE_NAME }}.caddy 2>/dev/null | cut -d' ' -f1" \
      || echo "<unreadable>")
    echo "repo      $local_sum"
    echo "installed $remote_sum"
    if [ "$local_sum" = "$remote_sum" ]; then
      echo "in sync"
    else
      echo "OUT OF SYNC — apply it with: just route"
      exit 1
    fi

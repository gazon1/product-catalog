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
[doc('Start the crawler and its database (the crawler creates the schema and seeds it)')]
db-up:
    docker compose -f docker-compose.dev.yml up -d db wb-parser
    @# Reuses the same definition of "healthy" as the deploy workflow, rather
    @# than a second inline check that could drift from it.
    @bash scripts/wait-healthy.sh product-catalog-dev-db 120
    @# Readiness is the crawler's own statement that the catalog can be served:
    @# its pool runs a statement and the columns it reads are there.
    @bash scripts/wait-catalog-ready.sh 240

[doc('Drop and recreate the dev database and the crawler from scratch')]
db-reset:
    # The crawler's migrations and its seed are applied by the crawler itself, on
    # every start. Only the volume has to go for a clean database.
    docker compose -f docker-compose.dev.yml down -v
    docker compose -f docker-compose.dev.yml up -d db wb-parser
    @bash scripts/wait-healthy.sh product-catalog-dev-db 120
    @bash scripts/wait-catalog-ready.sh 240

[doc('Stop the dev database and the crawler')]
db-down:
    docker compose -f docker-compose.dev.yml down

[doc('Run next dev on :3000 against the running crawler')]
dev:
    CRAWLER_API_URL=$(grep -E '^CRAWLER_API_URL=' .env 2>/dev/null | cut -d= -f2- || echo http://localhost:8080) \
    CRAWLER_API_KEY=$(grep -E '^CRAWLER_API_KEY=' .env 2>/dev/null | cut -d= -f2- || echo local-dev-catalog-key) \
        npm run dev

# The whole stack, the way production runs it: one database, the crawler that
# owns it, and this storefront that reads it over HTTP. Two databases would test
# a topology nobody deploys. `just stack-down` stops all of it.
[doc('Bring up the crawler + its database + the storefront')]
stack-up:
    bash scripts/stack-up.sh

[doc('Stop the whole stack (add --purge to also drop the database volume)')]
stack-down *args:
    bash scripts/stack-down.sh {{args}}

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

# ==============================================================================
# Ansible deploy (parser + migrations + wbshop)
# ==============================================================================
# Full stack deploy: parser → Flyway migrations → wbshop.
# Use this when you need to update the parser or run migrations.
#
# For wbshop-only updates (no parser, no migrations), use the GitHub Actions
# "Deploy to VPS" workflow instead — it's simpler and faster.
#
# Delegates to ~/Caddy-vps/just wbshop-deploy.
#
# Required env vars:
#   CADDY_VPS_DIR  - path to Caddy-vps checkout (default: ~/Caddy-vps)
#   PARSER_REPO    - path to wb-parser-kotlin-new/sailfish checkout
#   WBPARSER_DB_PASSWORD, WBPARSER_ADMIN_PASSWORD, WBPARSER_ADMIN_API_KEY
#
# Usage:
#   just ansible-deploy              # deploy current HEAD
#   just ansible-deploy <tag>        # deploy a specific tag
#   just ansible-deploy -- --check   # dry-run
# ==============================================================================

PARSER_REPO := env('PARSER_REPO', justfile_directory() / '..' / 'wb-parser-kotlin-new' / 'sailfish')
PARSER_COMPOSE_SRC := PARSER_REPO / "deploy" / "docker-compose.vps.yml"

[doc('Deploy full stack via Ansible: parser → migrations → wbshop')]
ansible-deploy tag *args:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{ justfile_directory() }}"

    WBSHOP_TAG="{{ tag }}"
    if [[ -z "$WBSHOP_TAG" ]]; then
      WBSHOP_TAG="$(git rev-parse --short HEAD)"
    fi

    if [[ ! -f "{{ CADDY_VPS_DIR }}/justfile" ]]; then
      echo "❌ Caddy-vps not found at {{ CADDY_VPS_DIR }}" >&2
      echo "   Set CADDY_VPS_DIR or clone: git clone git@github.com:gazon1/Caddy-vps.git {{ CADDY_VPS_DIR }}" >&2
      exit 1
    fi

    if [[ ! -f "{{ PARSER_COMPOSE_SRC }}" ]]; then
      echo "❌ Parser compose not found: {{ PARSER_COMPOSE_SRC }}" >&2
      echo "   Set PARSER_REPO to the wb-parser-kotlin-new/sailfish checkout." >&2
      exit 1
    fi

    if [[ -n "$(git status --porcelain)" ]]; then
      echo "⚠️  Working tree is dirty:"
      git status --short
      echo ""
    fi

    echo "🚀 Deploying wbshop stack..."
    echo "   tag:     $WBSHOP_TAG"
    echo "   parser:  {{ PARSER_COMPOSE_SRC }}"
    echo ""

    just --justfile "{{ CADDY_VPS_DIR }}/justfile" wbshop-deploy \
        -e "wbparser_tag=$WBSHOP_TAG" \
        -e "wbshop_tag=$WBSHOP_TAG" \
        -e "wbparser_compose_src={{ PARSER_COMPOSE_SRC }}" \
        -e "wbshop_compose_src={{ justfile_directory() }}/docker-compose.yml" \
        {{ args }}

[doc('Dry-run Ansible deploy')]
ansible-dry-run tag="":
    just {{ justfile_directory() }}/justfile ansible-deploy "{{ tag }}" -- --check
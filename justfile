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
[doc('Start the dev database (migrations + synthetic seed)')]
db-up:
    docker compose -f docker-compose.dev.yml up -d db
    @# Reuses the same definition of "healthy" as the deploy workflow, rather
    @# than a second inline check that could drift from it.
    @bash scripts/wait-healthy.sh product-catalog-dev-db 120

[doc('Drop and recreate the dev database from scratch')]
db-reset:
    # The postgres entrypoint runs /docker-entrypoint-initdb.d exactly once, when
    # the data directory is first created. Changing a migration or the seed does
    # nothing to an existing volume — this is the only way to re-apply them.
    docker compose -f docker-compose.dev.yml down -v
    docker compose -f docker-compose.dev.yml up -d db
    @# Reuses the same definition of "healthy" as the deploy workflow, rather
    @# than a second inline check that could drift from it.
    @bash scripts/wait-healthy.sh product-catalog-dev-db 120

[doc('Stop the dev database')]
db-down:
    docker compose -f docker-compose.dev.yml down

[doc('Run next dev on :3000 against the dev database')]
dev:
    DATABASE_URL=$(grep -E '^DATABASE_URL=' .env 2>/dev/null | cut -d= -f2- || echo postgresql://catalog:catalog@127.0.0.1:5433/product_catalog) \
        npm run dev

# ==============================================================================
# Database maintenance
# ==============================================================================
[doc('Copy the crawler migrations into dev/db/ and regenerate the seed')]
schema-sync *args:
    bash scripts/sync-dev-schema.sh {{args}}

[doc('Fail if dev/db/ no longer matches the crawler migrations (optional path to the crawler repo)')]
schema-check *args:
    bash scripts/check-dev-schema-sync.sh {{args}}

# ==============================================================================
# Verification
# ==============================================================================
[doc('Typecheck')]
typecheck:
    npx tsc --noEmit

[doc('Run the unit, architecture and database tests (requires a working Docker daemon)')]
test:
    npx vitest run

[doc('Fail when a test file did not execute (reads the JUnit XML npm test wrote)')]
test-runs:
    python3 scripts/check-test-runs.py

[doc('Production build')]
build:
    npm run build

# Runs the gates that CI runs, so a green local run means a green pipeline.
# Ordered as CI orders them, not merely by cost: `schema-check` must precede
# `test`, because the tests apply dev/db/ as their schema and a run against a
# stale copy proves nothing. `test-runs` must follow `test`, because it reads
# the XML that run wrote. `build` stays last — it is the expensive one.
[doc('Everything CI runs: typecheck, schema sync, tests, test-runs, build (needs Docker)')]
check: typecheck schema-check test test-runs build
    @echo ""
    @echo "✅ all checks passed"

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
# Full deploy via Ansible: runs the parser first, then migrations, then wbshop.
# This is the preferred deploy method when you need the full stack.
#
# The playbook lives in the Caddy-vps repository and orchestrates:
#   1. Deploy/updated wb-parser container
#   2. Wait for parser to be healthy
#   3. Run Flyway migrations on the shared DB (if needed)
#   4. Deploy/updated product-catalog (wbshop) container
#
# Required env vars / Ansible vars:
#   CADDY_VPS_DIR  - path to Caddy-vps checkout (default: ../Caddy-vps)
#   WB_PARSER_DIR  - path to wb-parser-kotlin-new/sailfish checkout
#
# Usage:
#   just ansible-deploy              # deploy current HEAD
#   just ansible-deploy <tag>        # deploy a specific tag
#   just ansible-deploy --check      # dry-run with --check --diff
# ==============================================================================

WBSHOP_PLAYBOOK := CADDY_VPS_DIR / "playbooks" / "wbshop.yml"
WBSHOP_COMPOSE_SRC := justfile_directory() / "docker-compose.yml"
# Default to sibling directory for parser; can be overridden
PARSER_REPO := env('PARSER_REPO', justfile_directory() / '..' / 'wb-parser-kotlin-new' / 'sailfish')
PARSER_COMPOSE_SRC := PARSER_REPO / "deploy" / "docker-compose.vps.yml"

[doc('Deploy full stack via Ansible: parser → migrations → wbshop')]
ansible-deploy tag="":
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{ justfile_directory() }}"

    WBSHOP_TAG="{{ tag }}"
    if [[ -z "$WBSHOP_TAG" ]]; then
      WBSHOP_TAG="$(git rev-parse --short HEAD)"
    fi

    if [[ ! -f "{{ WBSHOP_PLAYBOOK }}" ]]; then
      echo "❌ Playbook not found: {{ WBSHOP_PLAYBOOK }}"
      echo "   Set CADDY_VPS_DIR to the Caddy-vps checkout."
      echo "   Or clone: git clone git@github.com:gazon1/Caddy-vps.git"
      exit 1
    fi

    if [[ ! -f "{{ PARSER_COMPOSE_SRC }}" ]]; then
      echo "❌ Parser compose not found: {{ PARSER_COMPOSE_SRC }}"
      echo "   Set PARSER_REPO to the wb-parser-kotlin-new/sailfish checkout."
      exit 1
    fi

    # A dirty working tree is OK for deployment (you might have local config),
    # but warn about it.
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "⚠️  Working tree is dirty:"
      git status --short
      echo ""
    fi

    echo "🚀 Deploying wbshop stack via Ansible..."
    echo "   wbshop tag: $WBSHOP_TAG"
    echo "   playbook:   {{ WBSHOP_PLAYBOOK }}"
    echo "   wbshop:     {{ WBSHOP_COMPOSE_SRC }}"
    echo "   parser:     {{ PARSER_COMPOSE_SRC }}"
    echo ""

    ansible-playbook "{{ WBSHOP_PLAYBOOK }}" \
        -e "wbshop_tag=$WBSHOP_TAG" \
        -e "wbparser_tag=$WBSHOP_TAG" \
        -e "wbshop_compose_src={{ WBSHOP_COMPOSE_SRC }}" \
        -e "wbparser_compose_src={{ PARSER_COMPOSE_SRC }}"

    echo ""
    echo "✅ Deploy complete: wbshop=$WBSHOP_TAG"

[doc('Dry-run Ansible deploy with --check --diff')]
ansible-dry-run tag="":
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{ justfile_directory() }}"

    WBSHOP_TAG="{{ tag }}"
    if [[ -z "$WBSHOP_TAG" ]]; then
      WBSHOP_TAG="$(git rev-parse --short HEAD)"
    fi

    if [[ ! -f "{{ WBSHOP_PLAYBOOK }}" ]]; then
      echo "❌ Playbook not found: {{ WBSHOP_PLAYBOOK }}"
      exit 1
    fi

    ansible-playbook "{{ WBSHOP_PLAYBOOK }}" \
        --check --diff \
        -e "wbshop_tag=$WBSHOP_TAG" \
        -e "wbparser_tag=$WBSHOP_TAG" \
        -e "wbshop_compose_src={{ WBSHOP_COMPOSE_SRC }}" \
        -e "wbparser_compose_src={{ PARSER_COMPOSE_SRC }}"
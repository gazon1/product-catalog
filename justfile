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

[doc('Fail if dev/db/ no longer matches the crawler migrations')]
schema-check:
    bash scripts/check-dev-schema-sync.sh

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
# CADDY_REPO points at a Caddy-vps checkout and defaults to a sibling directory,
# which is where it sits on a developer machine. The deploy workflow's route
# drift check compares deploy/caddy.conf.caddy against
# /opt/caddy/conf.d/product-catalog.caddy, so the snippet has to be applied from
# this recipe before a deploy — a forgotten `just route` fails the deploy
# instead of shipping a 502.
CADDY_REPO := env('CADDY_REPO', justfile_directory() / '..' / 'Caddy-vps')
ROUTE_NAME := 'product-catalog'

[doc('Apply deploy/caddy.conf.caddy to the shared proxy (needs a Caddy-vps checkout)')]
route *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f "{{ CADDY_REPO }}/site.yml" ]; then
      echo "error: no Caddy-vps checkout at {{ CADDY_REPO }}" >&2
      echo "       git clone git@github.com:gazon1/Caddy-vps.git, or set" >&2
      echo "       CADDY_REPO=/path/to/Caddy-vps and re-run." >&2
      exit 1
    fi
    just --justfile "{{ CADDY_REPO }}/justfile" route "{{ ROUTE_NAME }}" \
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
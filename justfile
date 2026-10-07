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

[doc('Production build')]
build:
    npm run build

# Runs the gates that CI runs, so a green local run means a green pipeline.
# Ordered as CI orders them, not merely by cost: `schema-check` must precede
# `test`, because the tests apply dev/db/ as their schema and a run against a
# stale copy proves nothing. `build` stays last — it is the expensive one.
[doc('Everything CI runs: typecheck, schema sync, tests, build (needs Docker)')]
check: typecheck schema-check test build
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
#!/usr/bin/env bash
#
# sync-dev-schema.sh — copy the crawler's Flyway migrations into dev/db/.
#
# WHY THIS EXISTS
#
# The storefront owns no schema. But it still needs one locally, and a hand-kept
# copy drifts: someone adds a column to the crawler, the dev database keeps the
# old shape, and every query that touches the new column fails in dev while
 # working in production — the worst possible place to find out.
#
# So the copy is never edited by hand. It is copied, and CI re-runs this script
# and fails when the result differs from what is committed (see
# scripts/check-dev-schema-sync.sh). That turns "the dev schema is stale" from a
# mystery into a build failure.
#
# USAGE
#   bash scripts/sync-dev-schema.sh [path-to-crawler-repo]
#
# Defaults to ../wb-parser-kotlin-new. The script prints what it did and exits
# non-zero if the source is missing — it does not silently leave a stale copy
# behind, because a stale copy is the entire problem this script exists to fix.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$ROOT/../wb-parser-kotlin-new}"
MIGRATIONS="$SOURCE/app/src/main/resources/db/migration"
DEST="$ROOT/dev/db"

if [[ ! -d "$MIGRATIONS" ]]; then
    echo "error: migrations not found at $MIGRATIONS" >&2
    echo "       pass the crawler repo path as the first argument." >&2
    exit 1
fi

mkdir -p "$DEST"

# Postgres' docker-entrypoint runs everything in /docker-entrypoint-initdb.d in
# *alphabetical* order, so a file called `seed.sql` loads before `V1__init.sql`
# and fails on a table that does not exist yet. Migrations are therefore copied
# with a zero-padded ordinal prefix, and the seed is `99-seed.sql` so it always
# sorts last. A crawler reaching 99 migrations is not a scenario worth handling.
index=0
count=0
for sql in "$MIGRATIONS"/V*.sql; do
    [[ -e "$sql" ]] || continue
    index=$((index + 1))
    name="$(basename "$sql")"
    target="$DEST/$(printf '%02d-%s' "$index" "$name")"
    if [[ -f "$target" ]] && cmp -s "$sql" "$target"; then
        echo "  = $(basename "$target") (unchanged)"
    else
        cp "$sql" "$target"
        echo "  + $(basename "$target") (copied)"
    fi
    count=$((count + 1))
done

if [[ $count -eq 0 ]]; then
    echo "error: no V*.sql migrations found in $MIGRATIONS" >&2
    exit 1
fi

# The seed is applied after the migrations and is regenerated from the schema
# shape, so a stale seed is just as wrong as a stale schema copy.
echo "seed: regenerating dev/db/99-seed.sql"
node "$ROOT/scripts/generate-seed.mjs" --out "$DEST/99-seed.sql"

echo "done: $count migration(s) in sync with $SOURCE"
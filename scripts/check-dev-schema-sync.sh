#!/usr/bin/env bash
#
# check-dev-schema-sync.sh — fail when dev/db/ no longer matches the crawler.
#
# ## The defect this catches
#
# dev/db/ holds a copy of the crawler's Flyway migrations. A hand-maintained copy
# drifts the moment a column is added upstream, and the drift is invisible until
# a query touches the new column — at which point it fails in development and
# works in production, or worse, works in development against stale data.
#
# The check regenerates into a temporary directory and compares. It never edits
# the working tree: a gate that silently "fixes" the problem it is meant to
# report is a gate nobody has to look at.
#
# ## When the crawler repo is missing
#
# The check fails loudly rather than skipping. A gate that passes when it cannot
# run is exactly the failure mode this file exists to prevent — a check that
# reports "all clear" having verified nothing is worse than no check at all.
#
# Usage: check-dev-schema-sync.sh [path-to-crawler-repo]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$ROOT/../wb-parser-kotlin-new}"
MIGRATIONS="$SOURCE/app/src/main/resources/db/migration"

if [[ ! -d "$MIGRATIONS" ]]; then
    echo "❌ crawler migrations not found at $MIGRATIONS" >&2
    echo "   pass the crawler repo path as the first argument." >&2
    echo "   This check cannot verify anything without the source, so it fails." >&2
    exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The generator writes to --out, so the whole regeneration goes to the temp dir
# and only the result is compared.
node "$ROOT/scripts/generate-seed.mjs" --out "$TMP/99-seed.sql" >/dev/null

status=0

index=0
for sql in "$MIGRATIONS"/V*.sql; do
    [[ -e "$sql" ]] || continue
    index=$((index + 1))
    name="$(basename "$sql")"
    expected="$TMP/$(printf '%02d-%s' "$index" "$name")"
    cp "$sql" "$expected"

    actual="$ROOT/dev/db/$(printf '%02d-%s' "$index" "$name")"
    if [[ ! -f "$actual" ]]; then
        echo "❌ missing: dev/db/$(basename "$actual") — run 'just schema-sync'" >&2
        status=1
    elif ! cmp -s "$expected" "$actual"; then
        echo "❌ out of sync: dev/db/$(basename "$actual") differs from the crawler" >&2
        echo "   the crawler added or changed a migration. Run 'just schema-sync' and commit the result." >&2
        status=1
    fi
done

# A migration that was removed upstream leaves an orphan behind; postgres would
# apply it and the dev database would no longer match production.
for actual in "$ROOT"/dev/db/[0-9][0-9]-V*.sql; do
    [[ -e "$actual" ]] || continue
    base="$(basename "$actual" | sed -E 's/^[0-9]{2}-//')"
    if [[ ! -f "$MIGRATIONS/$base" ]]; then
        echo "❌ orphan: dev/db/$(basename "$actual") has no counterpart in the crawler" >&2
        status=1
    fi
done

if ! cmp -s "$TMP/99-seed.sql" "$ROOT/dev/db/99-seed.sql"; then
    echo "❌ dev/db/99-seed.sql is stale — run 'just schema-sync'" >&2
    status=1
fi

if [[ $status -eq 0 ]]; then
    echo "✅ dev/db is in sync with the crawler ($index migration(s))"
fi
exit $status
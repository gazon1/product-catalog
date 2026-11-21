#!/usr/bin/env bash
#
# Leave nothing behind: the local stack, the build output, the test artefacts.
#
#   just clean
#   just clean --modules   # also remove node_modules (a full reinstall follows)
#
# WHY ONE COMMAND
#
# The storefront, the build output and the test artefacts are three different
# kinds of leftovers, and each of them is easy to forget: a `next dev` left
# running holds :3000, `.next` holds a build of code that no longer exists, and
# `build/test-results` holds the report of a run that happened yesterday. A
# command that removes all three is worth more than three commands that each
# have to be remembered.
#
# WHAT IT DOES NOT TOUCH
#
# The crawler and its database are not ours: they run in the crawler
# repository, and this script does not know their names.
#
# node_modules is kept by default: reinstalling it takes minutes and changes
# nothing about the state of the code. `--modules` is the explicit ask.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODULES=0
for arg in "$@"; do
    case "$arg" in
        --modules) MODULES=1 ;;
        *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
    esac
done

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[0;32m  ✅ %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m  ⚠️  %s\033[0m\n' "$1"; }

cd "$ROOT"

# ---- the stack --------------------------------------------------------------

step "The local stack"
# The stack is stopped first, and a failure here does not stop the rest of the
# cleaning: the build output and the test artefacts are on this machine
# whatever the Docker daemon is doing. The failure is reported and remembered,
# and the script ends with a non-zero status — a clean that could not clean
# everything must not say it did.
stack_failed=0
bash scripts/stack-down.sh || stack_failed=1
if [ "$stack_failed" -ne 0 ]; then
    warn "the local stack was not stopped (see above)"
fi

# ---- what the build leaves --------------------------------------------------

step "The build output"
for path in .next build coverage; do
    if [ -e "$path" ]; then
        rm -rf "$path"
        ok "$path removed"
    else
        warn "$path was not there"
    fi
done

# The test artefacts are a report of a run that happened; a report of a run
# that happened is still a report of a run that happened, but it is a stale one.
if [ -d "build/test-results" ]; then
    ok "the test report was removed with build/"
fi

# ---- dependencies -----------------------------------------------------------

if [ "$MODULES" = "1" ]; then
    step "The dependencies"
    if [ -d "node_modules" ]; then
        rm -rf node_modules
        ok "node_modules removed — 'npm ci' before the next run"
    else
        warn "node_modules was not there"
    fi
else
    step "The dependencies"
    warn "node_modules kept (--modules removes it)"
fi

# ---- report -----------------------------------------------------------------

step "Done"
echo "  the tree is clean; 'npm ci' and 'just stack-up' bring it back"

if [ "$stack_failed" -ne 0 ]; then
    echo ""
    echo "  ⚠️  the local stack was not stopped — the tree is clean, the containers are not"
    exit 1
fi

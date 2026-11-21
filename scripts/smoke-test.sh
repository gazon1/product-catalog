#!/usr/bin/env bash
#
# The public smoke test, as a script rather than a block inside the workflow.
#
#   SMOKE_URL=https://example.test bash scripts/smoke-test.sh
#
# Why a script: the deploy workflow's smoke test decides whether a rollout
# succeeded, and logic embedded in YAML can only be checked with a regex against
# its own text — a check that stays green when the branch that exits 1 changes.
# As a script it is executed by `tests/smoke-test.test.ts` against a stub server,
# so the policy below is proven, not asserted.
#
# The policy is the issue #146 split:
#
#   - `/api/health` is liveness. It must answer 200, or the deployment did not
#     produce a live site, and the step fails.
#   - `/api/ready` is the parser dependency. Its failure is a warning: the
#     storefront is deployed and running, and a parser/NetBird outage must not
#     read as a storefront process failure.
#
# Env overrides (the defaults are what the deploy uses):
#   SMOKE_ATTEMPTS  liveness attempts            (default 10)
#   SMOKE_DELAY     seconds between attempts     (default 15)
#   SMOKE_URL       the site's public address    (required)

set -euo pipefail

: "${SMOKE_URL:?SMOKE_URL must be set to the public address of the site}"
attempts="${SMOKE_ATTEMPTS:-10}"
delay="${SMOKE_DELAY:-15}"

alive=no
for i in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 15 "$SMOKE_URL/api/health" | grep -q '"ok":true'; then
        echo "✅ Storefront process alive after ${i} attempt(s)"
        alive=yes
        break
    fi
    echo "Attempt $i: not alive yet, retrying in ${delay}s"
    sleep "$delay"
done

if [ "$alive" != yes ]; then
    echo "::error::Storefront process did not become alive after ${attempts} attempts"
    echo "Rollback: cd \$APP_DIR && export TAG=<prev-sha> && docker compose up -d"
    exit 1
fi

# A ready catalog is not what liveness promised. When it is not ready, say so as
# a dependency outage — the image is deployed and running.
if status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$SMOKE_URL/api/ready")" \
   && [ "$status" = "200" ]; then
    echo "✅ Catalog dependency ready"
else
    echo "::warning::The storefront is alive but the catalog dependency is not ready (/api/ready answered ${status:-no answer})."
    echo "::warning::This is a parser/NetBird problem, not a storefront process failure; the deployed image stays running."
fi

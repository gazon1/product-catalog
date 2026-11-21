#!/usr/bin/env bash
#
# Can the storefront's container reach the catalog API, and does the API accept
# what this deployment gave it?
#
#   bash scripts/probe-catalog-from-container.sh [container]
#
# Why the probe runs inside the container: the container's route to the crawler
# over NetBird is not the host's route. A check from the host proves nothing.
#
# Why this is a script and not a block in the workflow: it decides whether a
# deployment fails, and logic in YAML can only be checked by matching its own
# text. `tests/deploy-probe.test.ts` executes this file against a stub server.
#
# TWO FAILURES, TWO OUTCOMES (issue #146)
#
#   refused  — the catalog answered 401/403/404. The address or the key this
#              deploy wrote cannot work. That fails the deploy.
#   silent   — the catalog did not answer, or answered 5xx. A parser/NetBird
#              outage. The storefront is deployed and alive (`/api/health`
#              proves it), so this only warns: a deploy that reddens on somebody
#              else's downtime is a deploy people re-run until it is green.
#
# The key is never passed on a command line and never printed: it is read from
# the container's own environment and sent as a header.

set -euo pipefail

container="${1:-product-catalog}"

# A network that drops packets — a route that disappeared, a firewall that
# swallowed the request — never refuses and never answers. The probe has to be
# bounded, or the deploy step hangs until the job's own timeout: a blackholed
# route would read as a hung deployment, not as the outage it is.
probe_timeout_ms="${CRAWLER_PROBE_TIMEOUT_MS:-5000}"
case "$probe_timeout_ms" in
    '' | *[!0-9]*)
        echo "CRAWLER_PROBE_TIMEOUT_MS must be a number of milliseconds, got '$probe_timeout_ms'" >&2
        exit 1
        ;;
esac
# Zero aborts every request immediately, and Node clamps anything above the
# signed 32-bit timer maximum (2147483647) to a 1 ms timeout with only a warning
# — both are this deploy's misconfiguration, and both would otherwise be
# reported as an outage of somebody else's service.
#
# `10#` makes bash read the value as decimal: a leading zero would otherwise be
# octal to bash. The value travels to node through the environment and is read
# with Number() there — interpolating the string into the script would make
# `0008` a syntax error and `010` the octal 8.
if [ "$((10#$probe_timeout_ms))" -lt 1 ] || [ "$((10#$probe_timeout_ms))" -gt 2147483647 ]; then
    echo "CRAWLER_PROBE_TIMEOUT_MS must be between 1 and 2147483647 ms, got '$probe_timeout_ms'" >&2
    exit 1
fi

set +e
docker exec -e CRAWLER_PROBE_TIMEOUT_MS="$probe_timeout_ms" "$container" node -e "
  const raw = process.env.CRAWLER_API_URL || '';
  const base = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const url = base.endsWith('/api/catalog/v1') ? base : base + '/api/catalog/v1';
  fetch(url + '/ready', {
    headers: { 'X-Api-Key': process.env.CRAWLER_API_KEY || '' },
    signal: AbortSignal.timeout(Number(process.env.CRAWLER_PROBE_TIMEOUT_MS)),
  })
    .then((r) => {
      console.log('the catalog API answered', r.status);
      if (r.ok) process.exit(0);
      process.exit([401, 403, 404].includes(r.status) ? 2 : 1);
    })
    .catch((e) => { console.error('the catalog API is unreachable from the container:', e.message); process.exit(1); });
"
probe=$?
set -e

if [ "$probe" = 2 ]; then
    echo "::error::The storefront container reached the catalog API and it refused the request (401/403/404)."
    echo "::error::That is a misconfiguration this deploy wrote, not an outage: check that CRAWLER_API_URL is the crawler's address in the NetBird network and that CRAWLER_API_KEY is the crawler's CATALOG_API_KEY."
    exit 1
fi

if [ "$probe" != 0 ]; then
    echo "::warning::The storefront container cannot reach the catalog API right now — parser/NetBird dependency unavailable."
    echo "::warning::The storefront process is deployed and alive; /api/ready reports this separately. The deploy is not re-run on somebody else's downtime."
fi

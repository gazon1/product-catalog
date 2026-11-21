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
#   refused  — the catalog answered 4xx or redirected (3xx). The address, the
#              key or the path this deploy wrote cannot work. Fails the deploy.
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
#
# The deadline is a constant, not a setting: the deploy needs one number, and a
# knob nobody asked for is a knob that needs its own validation.
set +e
docker exec "$container" node -e "
  const raw = process.env.CRAWLER_API_URL || '';
  const base = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const url = base.endsWith('/api/catalog/v1') ? base : base + '/api/catalog/v1';
  fetch(url + '/ready', {
    headers: { 'X-Api-Key': process.env.CRAWLER_API_KEY || '' },
    signal: AbortSignal.timeout(5000),
    // A redirect means the address is not the API: fetch would follow it to
    // whatever answers 200 there, and a wrong CRAWLER_API_URL would pass.
    redirect: 'manual',
  })
    .then((r) => {
      console.log('the catalog API answered', r.status);
      if (r.ok) process.exit(0);
      // 3 = the deploy wrote a key or an address that cannot work. 4 = the
      // catalog is there and is asking us to come back later (408, 429) — that
      // is not something this deploy can fix, so it is an outage.
      if ([408, 429].includes(r.status)) process.exit(4);
      process.exit(r.status >= 300 && r.status < 500 ? 3 : 4);
    })
    .catch((e) => { console.error('the catalog API is unreachable from the container:', e.message); process.exit(4); });
"
probe=$?
set -e

# The node code above exits 0 (answered), 3 (refused) or 4 (outage). Any other
# status — 1, 125, 126, 127 — is docker itself failing: no such container, no
# daemon, no node in the image. The probe did not run, so it proves nothing.
if [ "$probe" != 0 ] && [ "$probe" != 3 ] && [ "$probe" != 4 ]; then
    echo "::error::The container-side probe could not run at all (docker exec exited $probe)."
    echo "::error::That is a broken deployment, not a crawler outage: check that the container '$container' exists and that its image has node."
    exit 1
fi

if [ "$probe" = 3 ]; then
    echo "::error::The storefront container reached the catalog API and it refused the request (4xx/3xx)."
    echo "::error::That is a misconfiguration this deploy wrote, not an outage: check that CRAWLER_API_URL is the crawler's address in the NetBird network and that CRAWLER_API_KEY is the crawler's CATALOG_API_KEY."
    exit 1
fi

if [ "$probe" = 4 ]; then
    echo "::warning::The storefront container cannot reach the catalog API right now — parser/NetBird dependency unavailable."
    echo "::warning::The storefront process is deployed and alive; /api/ready reports this separately. The deploy is not re-run on somebody else's downtime."
fi

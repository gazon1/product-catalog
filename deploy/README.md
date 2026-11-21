# Deploy

This directory contains configuration for deploying the storefront.

## What is deployed here

The storefront and nothing else. The crawler and its database are operated in
the crawler repository (`gazon1/wb-parser-kotlin-new`): the storefront is a
client of the crawler's HTTP API and reaches it over the private NetBird
network, so it neither starts the crawler nor manages its database.

The storefront is deployed by the **Deploy to VPS** workflow
(`.github/workflows/deploy.yml`). It publishes the image, writes the catalog's
address and key into `.env` on the server, recreates the container and checks
that the container can reach the catalog API — from inside the container, which
is the only place where the route to the crawler is the one that matters.

Required repository secrets: `VPS_HOST`, `VPS_USER`, `VPS_PORT`,
`VPS_APP_DIR`, `VPS_SSH_KEY`, `CRAWLER_API_KEY`.
Required repository variables: `CRAWLER_API_URL` (the crawler's address in the
NetBird network), `PUBLIC_URL`.

## Caddy Route Configuration

`caddy.conf.caddy` — the Caddy route snippet for this site. Apply with:

```bash
just route
```

See the main [Caddy-vps README](../../Caddy-vps/README.md) for details.

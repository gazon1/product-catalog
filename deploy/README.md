# Deploy

This directory contains configuration for deploying the wbshop stack.

## Ansible Deploy (Full Stack)

The full-stack Ansible playbook lives in the **Caddy-vps** repository:

```
~/Caddy-vps/playbooks/wbshop.yml
```

This playbook deploys in order:
1. **adsbrowser** — headless browser (needed by the parser for AdsPower automation)
2. **wb-parser** — parser container
3. **Flyway migrations** — runs on shared DB after parser is healthy
4. **product-catalog (wbshop)** — the storefront
5. **Caddy route** — publishes `wb-parser.maxdrobin.ru` via the shared reverse proxy

### Usage via just

```bash
# Deploy current HEAD
just ansible-deploy

# Deploy a specific tag
just ansible-deploy abc1234

# Dry run
just ansible-dry-run
```

### Requirements

1. **Caddy-vps** at `~/Caddy-vps` (or set `CADDY_VPS_DIR` env var)
2. **wb-parser** at `../wb-parser-kotlin-new/sailfish` (or set `PARSER_REPO` env var)
3. Env vars: `WBPARSER_DB_PASSWORD`, `WBPARSER_ADMIN_PASSWORD`, `WBPARSER_ADMIN_API_KEY`

### Direct ansible-playbook

```bash
cd ~/Caddy-vps
ansible-playbook playbooks/wbshop.yml \
  -e "wbshop_tag=<git-sha>" \
  -e "wbparser_tag=<git-sha>"
```

## Caddy Route Configuration

`caddy.conf.caddy` — the Caddy route snippet for this site. Apply with:

```bash
just route
```

See the main [Caddy-vps README](../../Caddy-vps/README.md) for details.

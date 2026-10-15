# Deploy

This directory contains configuration for deploying the wbshop stack.

## Ansible Deploy (Full Stack)

The full-stack Ansible playbook lives in the **Caddy-vps** repository:

```
~/Caddy-vps/playbooks/wbshop.yml
```

This playbook deploys in order:
1. **wb-parser** — parser container
2. **Flyway migrations** — runs on shared DB after parser is healthy
3. **product-catalog (wbshop)** — the storefront

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

1. **Caddy-vps** at `~/Caddy-vps` (or set `CADDY_REPO` env var)
2. **wb-parser** at `../wb-parser-kotlin-new/sailfish` (or set `PARSER_REPO` env var)

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

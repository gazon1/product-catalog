# syntax=docker/dockerfile:1
#
# Next.js standalone build. Multi-stage: deps → builder → runner.
#
# `output: 'standalone'` in next.config.mts means the runner only copies a
# self-contained server plus the traced subset of node_modules it actually needs
# (`pg` and its protocol helpers) — which is why the crawler repository is not
# needed at runtime, and why this image can be deployed with no code checkout
# besides this repository.

ARG NODE_VERSION=22-bookworm-slim

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` refuses to run when package.json and the lockfile disagree, which is
# exactly the failure wanted: a build must never silently resolve new versions.
RUN npm ci --no-audit --no-fund

# ── builder ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# DATABASE_URL is *not* baked in and must not be: the image is built in CI, where
# no production credential exists, and the value differs per environment. It is
# read at runtime from the container environment (see docker-compose.yml), which
# is why nothing here needs a build arg for it.
RUN npm run build

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1

# Non-root, fixed uid — a restart must not have to agree with the previous
# container's ownership, and a root container serving a public site is a
# blast radius that has to be justified rather than assumed.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home /app --shell /usr/sbin/nologin nextjs

# The standalone bundle already contains a minimal node_modules and server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Hits /api/health, which returns 503 when the database is unreachable — so a
# container with no working DATABASE_URL never reports healthy, and the deploy
# workflow's wait-healthy step fails instead of green-lighting a dead site.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
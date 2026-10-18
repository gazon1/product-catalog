#!/usr/bin/env bash
#
# Bring up the whole local stack against ONE database: dev Postgres, the
# storefront, and the crawler.
#
#   just stack-up
#
# WHY ONE DATABASE
#
# Production has a single PostgreSQL that both processes read and write: the
# crawler inserts into `scraped_items`, the storefront reads the same table. Two
# databases here would test a topology nobody runs, and would hide exactly the
# class of bug this is for — a column the crawler writes and the storefront does
# not read, or vice versa.
#
# FLYWAY IS DELIBERATELY OFF FOR THE CRAWLER
#
# The dev database's schema is created by the postgres entrypoint running
# dev/db/*.sql — there is no `flyway_schema_history` table in it. Starting the
# crawler with Flyway enabled makes it apply V1__init.sql against tables that
# already exist, and it dies on startup. This is the same reason
# roles/wbparser/defaults/main.yml sets `wbparser_flyway_enabled: "false"` on
# the VPS. `just schema-check` is what keeps the two copies honest; this script
# does not migrate anything.
#
# PROCESS GROUPS
#
# `npm run dev` spawns a `next-server` child, so killing the npm PID orphans the
# process that actually holds :3000. Both services are therefore started under
# `setsid`, which puts each in its own process group, and `stack-down.sh` signals
# the group. That is why the PIDs recorded here are worth writing down at all.
#
# Env overrides (all optional):
#   STACK_CRAWLER_DIR    crawler checkout      (default ../wb-parser-kotlin-new)
#   STACK_SITE_PORT      storefront port       (default 3000)
#   STACK_PARSER_PORT    crawler port          (default 8090; 8080 is often taken)
#   STACK_CRON           crawler schedule      (default "0 0 */4 * * *" = every 4h)
#   STACK_ADMIN_PASSWORD admin password        (default local-dev-admin)
#   STACK_ADMIN_API_KEY  admin API key         (default local-dev-key)
#   STACK_BROWSER_PROFILES  space-separated AdsPower profile IDs. Leave unset to
#                        use the crawler repo's own application.yml list. Set it
#                        to the profiles currently OPEN in AdsPower — the browser
#                        pool attaches over CDP and a closed profile is not a
#                        browser.
#   STACK_SKIP_SITE=1    bring up the database and crawler only
#   STACK_SKIP_PARSER=1  bring up the database and storefront only
#
# A note on timing: the crawler skips any target it scraped within the last 4
# hours (`Freshness.defaultFreshnessMinutes = 240`), so a second `stack-up`
# against the same database reports "0 pages, 0 items" and that is correct
# behaviour, not a broken crawl. Use `just db-reset` for a clean run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="$ROOT/.stack"
LOG_DIR="$STACK_DIR/logs"

CRAWLER="${STACK_CRAWLER_DIR:-$ROOT/../wb-parser-kotlin-new}"

DB_CONTAINER="product-catalog-dev-db"
DB_PORT=5433
DB_NAME="product_catalog"
DB_USER="catalog"
DB_PASSWORD="catalog"

SITE_PORT="${STACK_SITE_PORT:-3000}"
PARSER_PORT="${STACK_PARSER_PORT:-8090}"
CRAWLER_CRON="${STACK_CRON:-0 0 */4 * * *}"
ADMIN_PASSWORD="${STACK_ADMIN_PASSWORD:-local-dev-admin}"
ADMIN_API_KEY="${STACK_ADMIN_API_KEY:-local-dev-key}"

mkdir -p "$LOG_DIR"

# ---- output -----------------------------------------------------------------

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[0;32m  ✅ %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m  ⚠️  %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m  ❌ %s\033[0m\n' "$1" >&2; exit 1; }

# ---- helpers ----------------------------------------------------------------

# Block until an HTTP endpoint answers 2xx/3xx. `curl -fsS` treats 404 as failure,
# which is what we want: the server is up before the route is, and a route that
# 404s is a different problem than a server that never started.
wait_http() {
    local url="$1" name="$2" timeout="${3:-120}" waited=0
    while [ "$waited" -lt "$timeout" ]; do
        if curl -fsS -o /dev/null -m 3 "$url" 2>/dev/null; then
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done
    die "$name did not answer $url within ${timeout}s — see $LOG_DIR"
}

# Must match what stack-down.sh uses to identify the same service — a storefront
# that stack-up thinks is running but stack-down cannot identify is a service
# nothing can stop. The storefront is `npm run dev`; its cmdline never says
# "next". See the matching constants in stack-down.sh.
SITE_MATCH="run dev"
PARSER_MATCH="app.jar"

# A recorded PID is only useful if something is still behind it. Reusing a stale
# PID would make `stack-down` kill an unrelated process, so the recorded command
# line is checked as well as the PID.
running_pid() {
    local pidfile="$1" expect="$2"
    [ -f "$pidfile" ] || return 1
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    [ -n "$pid" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$expect" || return 1
    echo "$pid"
}

# Launch a long-running service, fully detached, recording the PID that will
# actually be the service.
#
# `$!` is NOT that PID. `setsid` forks whenever it is already a process group
# leader, so `$!` names a wrapper that exits immediately — a pidfile full of
# corpses, and a `stack-down` that reports every service as already gone while
# the processes hold their ports. Measured: the recorded 2054421 died within
# seconds while the real java kept :8090.
#
# So the service records its own PID, after `setsid` has done whatever forking
# it does and immediately before `exec` replaces the shell — and `exec` keeps the
# PID, which makes the number it wrote the number stack-down will signal.
launch() {
    local pidfile="$1" logfile="$2"; shift 2
    rm -f "$pidfile"
    setsid bash -c 'printf "%s\n" "$$" > "$1"; shift; exec "$@"' _ "$pidfile" "$@" \
        </dev/null >>"$logfile" 2>&1 &
    disown 2>/dev/null || true
}

# ---- preflight --------------------------------------------------------------

step "Preflight"

[ -d "$CRAWLER" ] || die "crawler checkout not found at $CRAWLER
       set STACK_CRAWLER_DIR to point at the wb-parser-kotlin checkout."

JAR="$CRAWLER/app/build/libs/app.jar"
if [ "${STACK_SKIP_PARSER:-0}" != "1" ] && [ ! -f "$JAR" ]; then
    warn "jar missing, building it (this takes a minute)"
    (cd "$CRAWLER" && ./gradlew --quiet :app:bootJar)
    [ -f "$JAR" ] || die "gradle finished but $JAR does not exist"
fi
ok "crawler checkout at $CRAWLER"

# The schema drift gate is cheap and this stack exists to be trustworthy, so it
# runs before anything is started rather than after a confusing query failure.
if [ -x "$ROOT/scripts/check-dev-schema-sync.sh" ]; then
    bash "$ROOT/scripts/check-dev-schema-sync.sh" >/dev/null \
        || die "dev/db is out of sync with the crawler migrations — run 'just schema-sync'"
    ok "dev/db matches the crawler migrations"
fi

# ---- database ---------------------------------------------------------------

step "Database"

if docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
    ok "$DB_CONTAINER already running"
else
    (cd "$ROOT" && docker compose -f docker-compose.dev.yml up -d db >/dev/null)
    ok "$DB_CONTAINER starting"
fi
bash "$ROOT/scripts/wait-healthy.sh" "$DB_CONTAINER" 120 >/dev/null
ok "$DB_CONTAINER healthy on 127.0.0.1:$DB_PORT"

# ---- storefront -------------------------------------------------------------

if [ "${STACK_SKIP_SITE:-0}" = "1" ]; then
    warn "skipping the storefront (STACK_SKIP_SITE=1)"
else
    step "Storefront"
    if running_pid "$STACK_DIR/site.pid" "$SITE_MATCH" >/dev/null; then
        ok "already running (pid $(cat "$STACK_DIR/site.pid"))"
    else
        launch "$STACK_DIR/site.pid" "$LOG_DIR/site.log" \
            env \
            DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$DB_PORT/$DB_NAME" \
            NEXT_PUBLIC_SITE_URL="http://localhost:$SITE_PORT" \
            NEXT_TELEMETRY_DISABLED=1 \
            PORT="$SITE_PORT" \
            npm run dev
        wait_http "http://localhost:$SITE_PORT/" "storefront" 120
        ok "storefront on http://localhost:$SITE_PORT (log: $LOG_DIR/site.log)"
    fi
fi

# ---- crawler ----------------------------------------------------------------

if [ "${STACK_SKIP_PARSER:-0}" = "1" ]; then
    warn "skipping the crawler (STACK_SKIP_PARSER=1)"
else
    step "Crawler"
    if running_pid "$STACK_DIR/parser.pid" "$PARSER_MATCH" >/dev/null; then
        ok "already running (pid $(cat "$STACK_DIR/parser.pid"))"
    else
        # SPRING_FLYWAY_ENABLED=false — see the header. The dev database was
        # created by the postgres entrypoint, not by Flyway.
        env_args=(
            SERVER_PORT="$PARSER_PORT"
            DB_HOST=127.0.0.1
            DB_PORT="$DB_PORT"
            DB_NAME="$DB_NAME"
            DB_USER="$DB_USER"
            DB_PASSWORD="$DB_PASSWORD"
            SPRING_FLYWAY_ENABLED=false
            SPRING_PROFILES_ACTIVE=worker
            CRAWLER_SCHEDULE_CRON="$CRAWLER_CRON"
            ADMIN_PASSWORD="$ADMIN_PASSWORD"
            ADMIN_API_KEY="$ADMIN_API_KEY"
            OTEL_SDK_DISABLED=true
        )

        # Override the profile list only when asked. application.yml ships four
        # profile IDs, of which only the ones open in AdsPower can be attached to.
        if [ -n "${STACK_BROWSER_PROFILES:-}" ]; then
            i=0
            for profile in $STACK_BROWSER_PROFILES; do
                env_args+=("CRAWLER_SPIDER_BROWSER_PROFILES_$i=$profile")
                i=$((i + 1))
            done
            env_args+=("CRAWLER_SPIDER_TARGET_CONCURRENCY=$i")
        fi

        # No subshell and no `cd`: `$JAR` is absolute, and wrapping the launch in
        # `( … )` makes bash wait on the very job it just backgrounded — the
        # symptom being a stack-up that brings everything up correctly and then
        # hangs forever instead of returning.
        launch "$STACK_DIR/parser.pid" "$LOG_DIR/parser.log" \
            env "${env_args[@]}" java -jar "$JAR"

        # /live, not /ready: readiness also pings the database, and a slow dev
        # database should not be reported as a crawler that failed to start.
        wait_http "http://localhost:$PARSER_PORT/api/health/live" "crawler" 180
        ok "crawler on http://localhost:$PARSER_PORT (log: $LOG_DIR/parser.log)"
    fi
fi

# ---- report -----------------------------------------------------------------

step "Ready"
echo "  database    postgresql://$DB_USER@127.0.0.1:$DB_PORT/$DB_NAME"
[ "${STACK_SKIP_SITE:-0}" = "1" ]   || echo "  storefront  http://localhost:$SITE_PORT"
[ "${STACK_SKIP_PARSER:-0}" = "1" ] || echo "  crawler     http://localhost:$PARSER_PORT/api/health/live"
echo ""
echo "  item count:"
# `head -1` because `psql -t` emits a trailing blank line, which would otherwise
# be sed'd into a second, empty "scraped_items:" line.
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t \
    -c 'SELECT count(*) FROM scraped_items;' 2>/dev/null | head -1 \
    | sed 's/^ *//;s/^/  scraped_items: /' || true
echo ""
echo "  Stop everything with: just stack-down"
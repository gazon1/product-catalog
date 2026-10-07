/**
 * Vitest global setup — one PostgreSQL container for the whole suite.
 *
 * ## Why a container at all
 *
 * Every other test in this repository is pure: money arithmetic, slug
 * transliteration, query-string parsing. None of them opens a socket. That is
 * the gap this file closes.
 *
 * The storefront's entire contract with the crawler is the shape of
 * `scraped_items` and `crawl_targets`. `scripts/check-dev-schema-sync.sh`
 * compares the crawler's migration *files* against our copies — which catches
 * drift in the files and says nothing about whether the storefront's queries
 * still fit the resulting schema. A crawler migration that adds a NOT NULL
 * column, drops a column a SELECT names, or changes a type leaves both
 * repositories green and produces an empty storefront in production.
 *
 * Only running the real queries against the real schema catches that.
 *
 * ## What is applied, and why it is the crawler's and not ours
 *
 * `dev/db/01-V1__init.sql` and `dev/db/02-V2__catalog_columns.sql` are byte
 * copies of the crawler's Flyway migrations, kept in sync by
 * `scripts/sync-dev-schema.sh` and policed by `scripts/check-dev-schema-sync.sh`.
 * A copy is used rather than a hand-written fixture because a fixture would
 * drift silently and then agree with nothing.
 *
 * `99-seed.sql` is applied too — the same deterministic synthetic data the dev
 * database uses. 2 900 observations is a scale no hand-written fixture reaches,
 * and pagination, sorting and `DISTINCT ON` all behave differently at that size.
 *
 * ## Docker missing is a failure, not a skip
 *
 * If the container cannot start, this throws. A suite that reports success
 * without executing is worse than no suite: it is a green build that verified
 * nothing, which is the exact defect the rest of this repository works against.
 *
 * ## Known cosmetic warning
 *
 * Every run ends with `close timed out after 10000ms … something prevents Vite
 * server from exiting`. The exit code is 0 and every test has already run and
 * reported. The open handle belongs to testcontainers' container-log stream; it
 * is not the database connection, which `database.test.ts` closes explicitly.
 *
 * Raising `teardownTimeout` was tried and made it worse — a 60s close per run
 * instead of a 10s one, with the handle still open. Recorded here rather than
 * left to be rediscovered, and flagged as noise to revisit only if this
 * repository ever gates on vitest's exit *timing*, which nothing does today.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const ROOT = resolve(import.meta.dirname, '..');

export const SEED = 'dev/db/99-seed.sql';

/**
 * Migrations are discovered from `dev/db/`, never listed here.
 *
 * A hardcoded array was the first version of this file and it was wrong in a way
 * nothing caught: when the crawler ships a V3 and `just schema-sync` copies it to
 * `dev/db/03-V3__*.sql`, the sync gate turns green (the copy matches), the dev
 * database applies it (docker-entrypoint runs every file in `dev/db/`), and this
 * list still names two files. The suite would then assert against a schema
 * production will never have — the same silent drift it was written to detect,
 * reintroduced through the test harness itself.
 *
 * The pattern and the numeric sort mirror `scripts/sync-dev-schema.sh`, which is
 * what names the files: `%02d-<basename>`. Ordering by the parsed prefix rather
 * than by string keeps it correct past 99 migrations, which the sync script's
 * comment calls unlikely but costs nothing to handle.
 *
 * `99-seed.sql` is excluded because it does not match `-V` — and it must run
 * after the migrations, so it is applied separately.
 */
export function discoverMigrations(dir = resolve(ROOT, 'dev/db')): string[] {
  return readdirSync(dir)
    .filter((name) => /^\d+-V.*\.sql$/.test(name))
    .map((name) => ({
      name,
      ordinal: Number.parseInt(name, 10),
    }))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((entry) => `dev/db/${entry.name}`);
}

/**
 * The connection string is handed to workers through a file rather than an
 * environment variable: vitest's `globalSetup` runs in the main process while
 * tests run in worker processes, and an env var set in the former is not
 * guaranteed to reach the latter. A file both can read.
 */
/**
 * Written outside the repository.
 *
 * The obvious place — `node_modules/.vitest-db-connection` — puts a file that
 * changes on every run inside a tree vitest watches, which is a reliable way to
 * end up with open file handles at exit. The temp directory is not watched, and
 * it is removed in teardown either way.
 */
const CONNECTION_DIR = mkdtempSync(join(tmpdir(), 'product-catalog-testdb-'));
const CONNECTION_FILE = join(CONNECTION_DIR, 'connection.json');

declare global {
  // eslint-disable-next-line no-var
  var __catalogTestDbStarted: StartedPostgreSqlContainer | undefined;
}

export default async function setup(): Promise<void> {
  const migrations = discoverMigrations();
  if (migrations.length === 0) {
    throw new Error(
      `no crawler migrations found in ${resolve(ROOT, 'dev/db')} — ` +
        'run `just schema-sync` against the crawler repository'
    );
  }

  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('product_catalog_test')
    .withUsername('catalog')
    .withPassword('catalog')
    .start();

  globalThis.__catalogTestDbStarted = container;

  // `StartedPostgreSqlContainer` exposes a connection URI, not a driver client,
  // so the migrations are applied through `pg` — the same driver the storefront
  // itself uses. Applying them over a second driver would test a different
  // stack than production uses.
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();

  // Applied in order, and each step is verified before the next: a migration that
  // silently did nothing would leave a suite that passes against the wrong schema.
  for (const relative of [...migrations, SEED]) {
    const sql = readFileSync(resolve(ROOT, relative), 'utf8');
    await client.query(sql);
  }

  const { rows } = await client.query<{ targets: string; items: string }>(
    `SELECT (SELECT COUNT(*) FROM crawl_targets) AS targets,
            (SELECT COUNT(*) FROM scraped_items)  AS items`
  );
  const summary = rows[0];
  if (!summary || Number(summary.items) === 0) {
    await client.end();
    await container.stop();
    throw new Error(
      'the schema and seed did not produce rows — the suite would assert against an empty database'
    );
  }

  writeFileSync(
    CONNECTION_FILE,
    JSON.stringify({ url: container.getConnectionUri() }),
    'utf8'
  );

  console.log(
    `\n  test database: ${summary.targets} targets, ${summary.items} observations (${migrations.length} crawler migration(s) + seed)\n`
  );
}

export async function teardown(): Promise<void> {
  const container = globalThis.__catalogTestDbStarted;
  globalThis.__catalogTestDbStarted = undefined;

  if (container) {
    await container.stop();
  }

  rmSync(CONNECTION_DIR, { recursive: true, force: true });
}

export { CONNECTION_FILE };
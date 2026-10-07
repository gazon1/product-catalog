/**
 * Postgres access.
 *
 * ## This site owns nothing
 *
 * It does not migrate, does not create indexes, and does not write. The crawler's
 * Flyway migrations are the only thing allowed to change the schema, which is why
 * there is no ORM, no migration runner and no `CREATE` anywhere in this repository.
 *
 * ## The read-only guard is server-side, not a convention
 *
 * `default_transaction_read_only=on` is passed to the backend as a connection
 * option, so it applies to *every* session this pool opens regardless of what the
 * SQL text says. A bug in a query string can produce a wrong result; it cannot
 * produce a write. That is the difference between a rule and a comment, and this
 * database is owned by another repository that has no way to enforce its own side.
 *
 * The role this site connects as is additionally `SELECT`-only in Postgres. The
 * two guards are deliberately redundant: the role is the contract, the connection
 * option is what makes a stolen connection string useless on its own.
 */

import { Pool, type QueryResultRow } from 'pg';

/** Statements longer than this are a mistake, not a slow page. */
const STATEMENT_TIMEOUT_MS = 8_000;

declare global {
  // Next.js dev reloads modules on every edit; without this each reload would
  // leak a pool and eventually exhaust Postgres' connection slots.
  // eslint-disable-next-line no-var
  var __catalogPool: Pool | undefined;
}

class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      'DATABASE_URL is not set. The storefront reads the crawler database directly — ' +
        'set DATABASE_URL to a SELECT-only connection string (see .env.example).'
    );
    this.name = 'MissingDatabaseUrlError';
  }
}

export function getPool(): Pool {
  if (globalThis.__catalogPool) return globalThis.__catalogPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new MissingDatabaseUrlError();

  const pool = new Pool({
    connectionString,
    // Small on purpose: this is a read-only server-rendered site. A pool larger
    // than the database's own idea of reasonable concurrency turns a traffic
    // spike into connection refusals for the crawler, which shares the server.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // `timezone=UTC` because the crawler writes TIMESTAMPTZ: without it the
    // rendered timestamps follow the container's TZ, which changes between a
    // local run and a deploy and makes the same row render differently.
    options:
      `-c default_transaction_read_only=on` +
      ` -c statement_timeout=${STATEMENT_TIMEOUT_MS}` +
      ' -c timezone=UTC',
  });

  // A pool-level error listener is required: an idle client that fails (server
  // restart, network blip) emits 'error', and with no listener Node turns that
  // into an unhandled exception that takes the process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error', err);
  });

  globalThis.__catalogPool = pool;
  return pool;
}

/**
 * Run one parameterised query.
 *
 * Every value reaching Postgres goes through `$n`. The one thing that cannot be
 * parameterised here — the sort ORDER BY clause — is whitelisted in `queries.ts`
 * before it reaches this function. There is no code path that interpolates a
 * caller-supplied string into SQL text.
 *
 * `T extends QueryResultRow` mirrors `pg`'s own constraint: a "row" has to be
 * something an object can hold, which is what stops a caller from asking for a
 * `number[]` and having Postgres hand back one destructured value.
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
/**
 * Per-worker setup — point the storefront's own pool at the test container.
 *
 * This runs in the vitest worker, before any test file is imported, which is
 * what lets the tests call the *production* query functions rather than
 * re-implementing their SQL. Re-implementing the SQL is the mistake this suite
 * exists to avoid: the previous solution's tests did that, so they validated a
 * copy of the query rather than the query.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Find the connection file written by the global setup.
 *
 * By modification time, not by name: a run that was interrupted leaves its
 * directory behind, and sorting names alphabetically picked a stale directory
 * whose container had already been stopped — so the worker connected to a dead
 * port and the suite failed with ECONNREFUSED against a container that was
 * running perfectly well a moment earlier.
 */
function findConnectionFile(): string | null {
  const dirs = readdirSync(tmpdir()).filter((n) => n.startsWith('product-catalog-testdb-'));
  const withFiles = dirs
    .map((dir) => join(tmpdir(), dir, 'connection.json'))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return withFiles[0] ?? null;
}

const CONNECTION_FILE = findConnectionFile();

if (CONNECTION_FILE === null) {
  throw new Error(
    'no test database connection file. The global setup either did not run or failed to start ' +
      'its container — failing here rather than letting the suite run without a database.'
  );
}

const connection: { url?: unknown } = JSON.parse(readFileSync(CONNECTION_FILE, 'utf8'));

if (typeof connection.url !== 'string') {
  throw new Error(
    `the connection file at ${CONNECTION_FILE} carries no usable url — ` +
      'the global setup wrote something this worker cannot connect with.'
  );
}

process.env.DATABASE_URL = connection.url;
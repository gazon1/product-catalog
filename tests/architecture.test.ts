import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSortOrder, SORT_ORDERS } from '@/lib/types';
import { ORDER_BY_FRAGMENTS } from '@/lib/queries';

/**
 * Architectural gate: this repository must contain no writes.
 *
 * The storefront reads a database owned by another repository. That boundary is
 * enforced in three places, and this file checks the two that a code review can
 * miss:
 *
 *   1. the Postgres role is SELECT-only        (operational — checked on deploy)
 *   2. the session sets default_transaction_read_only  (this file)
 *   3. no statement in this repo writes        (this file)
 *
 * A static check is not a substitute for 1 and 2, and they are not a substitute
 * for this: the guard flags say "this must never happen", the code says "it does
 * not happen here". Removing any one of the three leaves two.
 */
const SRC = resolve(__dirname, '..', 'src');

function read(relative: string): string {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

describe('the storefront never writes', () => {
  const FORBIDDEN = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|INDEX|SCHEMA)|ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|UNIQUE|SCHEMA)|TRUNCATE|GRANT|REVOKE|COPY\s)\b/i;

  const files = ['lib/queries.ts', 'lib/db.ts', 'lib/types.ts', 'lib/money.ts'];

  it.each(files)('%s contains no write statement', (file) => {
    const source = read(file);
    const match = source.match(FORBIDDEN);
    expect(
      match,
      `${file} contains a write statement ("${match?.[0]}"). ` +
        'This site reads the crawler database as SELECT-only; a write here is a ' +
        'crossing of the repository boundary.'
    ).toBeNull();
  });
});

describe('the read-only guard is configured, not assumed', () => {
  it('sets default_transaction_read_only on every pooled connection', () => {
    // This is the server-side guard. Without it the SELECT-only role is the only
    // thing standing between a typo and a modified catalog.
    expect(read('lib/db.ts')).toContain('default_transaction_read_only=on');
  });

  it('bounds statement execution time', () => {
    // An unbounded query against the crawler's live table blocks a connection the
    // crawler also needs; the timeout turns that into a fast 503 instead.
    expect(read('lib/db.ts')).toContain('statement_timeout');
  });

  it('pins the session timezone', () => {
    // The crawler writes TIMESTAMPTZ. Without a fixed TZ the same row renders in
    // different time between a local run and a deploy.
    expect(read('lib/db.ts')).toContain('timezone=UTC');
  });
});

describe('every ORDER BY is total and inert', () => {
  it.each(Object.entries(ORDER_BY_FRAGMENTS))(
    '%s contains no statement separator and no comment marker',
    (_sort, fragment) => {
      // `;` would terminate the statement and start a second one; `--` starts a
      // comment that swallows the rest of the query. Neither can appear in a
      // fragment that is concatenated into SQL without parameterisation.
      expect(fragment).not.toContain(';');
      expect(fragment).not.toContain('--');
      expect(fragment).not.toContain('/*');
    }
  );

  it.each(Object.entries(ORDER_BY_FRAGMENTS))('%s ends with a tiebreaker', (_sort, fragment) => {
    // Without a total order PostgreSQL may return equal rows in a different
    // order per page, and a paginated list that repeats and drops items is
    // indistinguishable from a bug in the filter.
    const items = fragment.split(',').map((s) => s.trim());
    expect(items[items.length - 1]).toBe('i.id');
  });

  it('covers every declared sort order', () => {
    // A `Record<SortOrder, string>` makes a missing entry a compile error, so
    // this catches the runtime-only failure mode: an extra member added to the
    // array without a fragment, which TypeScript would also reject but a
    // regenerated declaration would not.
    expect(Object.keys(ORDER_BY_FRAGMENTS).sort()).toEqual([...SORT_ORDERS].sort());
  });
});

describe('sort order is a closed set', () => {
  it('accepts only declared values', () => {
    for (const order of SORT_ORDERS) {
      expect(isSortOrder(order)).toBe(true);
    }
  });

  it('rejects anything else from a URL', () => {
    // This is what stops `?sort=` from reaching ORDER BY. The union type stops it
    // in the compiler; this stops it at runtime, where the value actually
    // originates.
    expect(isSortOrder('PriceDesc; DROP TABLE scraped_items')).toBe(false);
    expect(isSortOrder('scraped_at DESC')).toBe(false);
    expect(isSortOrder('')).toBe(false);
    expect(isSortOrder(null)).toBe(false);
    expect(isSortOrder(undefined)).toBe(false);
  });
});
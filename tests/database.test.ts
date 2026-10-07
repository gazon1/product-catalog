/**
 * Integration suite: the storefront's real queries against the crawler's real schema.
 *
 * ## The gap this closes
 *
 * The other 101 tests are pure — money arithmetic, slug transliteration,
 * query-string parsing, static architecture assertions. Not one of them opens a
 * socket. So nothing here had ever executed a single line of the SQL in
 * `src/lib/queries.ts` against a PostgreSQL that had the crawler's columns.
 *
 * That is not a theoretical gap. A placeholder collision put `LIMIT $2` on the
 * same index as the `target_id` filter, so every category page failed with
 * `42804 datatype mismatch` while the home page — which passes no target id —
 * kept working. Unit tests on a pure query *builder* caught the collision after
 * the fact; they did not prevent the first deployment, because the first
 * failure was only visible against a real database.
 *
 * ## What is under test
 *
 * The production functions themselves — `listItems`, `getProduct`,
 * `listTopDeals`, `listTargets`, `getSiteStats` — imported from `@/lib/queries`.
 * Not a copy of their SQL. A test that re-implements the query validates the
 * re-implementation, and the previous solution's tests did exactly that: they
 * re-wrote the INSERT against a SQLite schema without foreign keys, so they
 * could not have caught a PostgreSQL typing error.
 *
 * The schema is the crawler's own migrations, copied byte-for-byte into
 * `dev/db/` by `scripts/sync-dev-schema.sh` and policed by
 * `scripts/check-dev-schema-sync.sh`. When the crawler adds a migration, that
 * gate fails the storefront's build before this suite ever runs — which is the
 * point: the failure should arrive as a red build, not as an empty page in
 * production.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getPool } from '@/lib/db';
import {
  getProduct,
  getSiteStats,
  listItems,
  listTargets,
  listTopDeals,
  normalizePaging,
} from '@/lib/queries';
import { MAX_PAGE_SIZE } from '@/lib/types';
import { kopecksToRubles, discountPercent } from '@/lib/money';

/** A separate connection for assertions written as SQL. */
let raw: Pool;

beforeAll(async () => {
  raw = new Pool({ connectionString: process.env.DATABASE_URL });
  await raw.query('SELECT 1');
});

afterAll(async () => {
  // Without this the worker holds an open socket and vitest cannot exit — the run
  // ends with "close timed out", which reads like a flaky test rather than the
  // resource leak it is.
  await raw.end();
});

describe('the schema is the crawler’s, not ours', () => {
  it('has the columns the storefront projects', async () => {
    // If this fails, the dev schema copy is stale — the same drift the sync gate
    // reports, asserted here as a fact about the database actually being used.
    const { rows } = await raw.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'scraped_items'`
    );
    const columns = new Set(rows.map((r) => r.column_name));

    for (const required of [
      'id', 'target_id', 'title', 'price_kopecks', 'sale_price_kopecks',
      'cashback', 'cashback_percent', 'image_url', 'in_stock', 'brand', 'seller',
      'product_id', 'match_id', 'product_url', 'content_hash', 'scraped_at',
    ]) {
      expect(columns.has(required), `scraped_items.${required} is missing`).toBe(true);
    }
  });

  it('is populated from the seed, so nothing here asserts against an empty table', async () => {
    const stats = await getSiteStats();
    expect(stats.totalTargets).toBeGreaterThan(1);
    expect(stats.totalItems).toBeGreaterThan(1000);
    expect(stats.newestScrapedAt).not.toBeNull();
  });

  it('the storefront\u2019s own pool is read-only, so a broken query cannot modify the crawler database', async () => {
    // Asserted through `getPool()` — the pool the application actually uses —
    // rather than through the test\u2019s own connection, which configures nothing
    // and would pass this assertion even if the guard were deleted from db.ts.
    // `SHOW` names the column after the setting, not `read_only`.
    const { rows } = await getPool().query<{ default_transaction_read_only: string }>(
      'SHOW default_transaction_read_only'
    );
    expect(rows[0]!.default_transaction_read_only).toBe('on');

    await expect(getPool().query('CREATE TABLE catalog_should_not_exist (id int)')).rejects.toThrow();
  });
});

describe('listItems — unscoped', () => {
  it('returns cards with money mapped from kopecks', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 5 } });

    expect(page.items).toHaveLength(5);
    expect(page.totalCount).toBeGreaterThan(1000);

    for (const item of page.items) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.productUrl).toMatch(/^https?:\/\//);
      expect(item.targetName.length).toBeGreaterThan(0);
      expect(item.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Money arrives as a string from Postgres and must be a number here.
      if (item.priceKopecks !== null) {
        expect(Number.isInteger(item.priceKopecks)).toBe(true);
      }
    }
  });

  it('paginates without repeating or dropping an item', async () => {
    // The failure this catches is subtle: a stable ORDER BY without a tiebreaker
    // lets PostgreSQL return equal rows in a different order per page, and a
    // paginated list that quietly repeats and omits rows looks like a filter bug.
    const first = await listItems({ paging: { page: 0, pageSize: 20 } });
    const second = await listItems({ paging: { page: 1, pageSize: 20 } });

    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items).toHaveLength(20);
    for (const item of second.items) {
      expect(firstIds.has(item.id), `page 2 repeated ${item.id}`).toBe(false);
    }
  });

  it('reports page metadata consistent with the total', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 24 } });
    expect(page.pageSize).toBe(24);
    expect(page.totalPages).toBe(Math.ceil(page.totalCount / 24));
    expect(page.hasNextPage).toBe(true);
    expect(page.hasPrevPage).toBe(false);

    const last = await listItems({ paging: { page: page.totalPages - 1, pageSize: 24 } });
    expect(last.hasNextPage).toBe(false);
    expect(last.hasPrevPage).toBe(true);
  });

  it('clamps hostile paging instead of failing', async () => {
    const page = await listItems({ paging: { page: -5, pageSize: 10_000 } });
    expect(page.page).toBe(0);
    expect(page.pageSize).toBe(MAX_PAGE_SIZE);
    expect(page.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it('sorts by cashback descending when asked', async () => {
    const page = await listItems({ sort: 'CashbackPercentDesc', paging: { page: 0, pageSize: 30 } });
    const percents = page.items
      .map((i) => i.cashbackPercent)
      .filter((v): v is number => v !== null);
    expect(percents.length).toBeGreaterThan(0);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeLessThanOrEqual(percents[i - 1]!);
    }
  });
});

describe('listItems — scoped to a target', () => {
  // This is the path that was broken. A target id binds `$1` and the filter must
  // not collide with the LIMIT/OFFSET indices; when it did, PostgreSQL rejected
  // the UUID where it expected an integer and every category page rendered an
  // error state — while the unscoped home page kept working throughout.

  it('returns only the requested target’s items', async () => {
    const targets = await listTargets();
    const target = targets.find((t) => t.itemCount > 0)!;
    expect(target).toBeDefined();

    const page = await listItems({ targetId: target.id, paging: { page: 0, pageSize: 10 } });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.totalCount).toBe(target.itemCount);

    for (const item of page.items) {
      expect(item.targetId).toBe(target.id);
      expect(item.targetName).toBe(target.name);
    }
  });

  it('returns nothing for an empty target instead of falling back to all items', async () => {
    const targets = await listTargets();
    const empty = targets.find((t) => t.itemCount === 0)!;
    expect(empty, 'the seed should contain one configured-but-empty target').toBeDefined();

    const page = await listItems({ targetId: empty.id, paging: { page: 0, pageSize: 24 } });
    expect(page.totalCount).toBe(0);
    expect(page.items).toEqual([]);
  });

  it('returns nothing for an unknown target id', async () => {
    const page = await listItems({
      targetId: '00000000-0000-4000-a000-000000000000',
      paging: { page: 0, pageSize: 24 },
    });
    expect(page.totalCount).toBe(0);
    expect(page.items).toEqual([]);
  });

  it('survives a target id combined with every filter', async () => {
    // Scoped + 5 filters = 6 bound parameters before LIMIT. This is where an
    // off-by-one in the placeholder numbering becomes a runtime error.
    const targets = await listTargets();
    const target = targets.find((t) => t.itemCount > 100)!;

    const page = await listItems({
      targetId: target.id,
      sort: 'PriceAsc',
      filter: {
        search: 'а',
        minPriceRubles: 1,
        maxPriceRubles: 1_000_000,
        minCashbackPercent: 0,
        inStockOnly: true,
      },
      paging: { page: 0, pageSize: 20 },
    });

    for (const item of page.items) {
      expect(item.targetId).toBe(target.id);
      if (item.inStock !== null) expect(item.inStock).toBe(true);
    }
    // Whether anything matches is data-dependent; that the query *ran* is not.
    expect(page.totalCount).toBeGreaterThanOrEqual(0);
  });

  it('agrees with SQL written by hand for the same filter', async () => {
    const targets = await listTargets();
    const target = targets.find((t) => t.itemCount > 0)!;
    const min = 500;

    const page = await listItems({
      targetId: target.id,
      filter: { minCashbackPercent: min },
      sort: 'CashbackPercentDesc',
      paging: { page: 0, pageSize: 15 },
    });

    const { rows } = await raw.query<{ count: string }>(
      `SELECT COUNT(*) FROM scraped_items
        WHERE target_id = $1 AND cashback_percent >= $2`,
      [target.id, min]
    );

    expect(page.totalCount).toBe(Number(rows[0]!.count));
  });
});

describe('listItems — filters', () => {
  it('searches title, brand and seller', async () => {
    const { rows } = await raw.query<{ brand: string }>(
      `SELECT brand FROM scraped_items WHERE brand IS NOT NULL GROUP BY brand ORDER BY COUNT(*) DESC LIMIT 1`
    );
    const brand = rows[0]!.brand;

    const page = await listItems({ filter: { search: brand }, paging: { page: 0, pageSize: 30 } });
    expect(page.totalCount).toBeGreaterThan(0);
    for (const item of page.items) {
      const haystack = `${item.title} ${item.brand ?? ''} ${item.seller ?? ''}`.toLowerCase();
      expect(haystack).toContain(brand.toLowerCase());
    }
  });

  it('treats LIKE wildcards in a search as literal', async () => {
    // `100%` must not match every row. Unescaped, `_` is a single-character
    // wildcard and `%` matches anything, so the search silently degenerates.
    const literal = await listItems({ filter: { search: '100%' }, paging: { page: 0, pageSize: 10 } });
    const wildcard = await listItems({ filter: { search: '%%%%%' }, paging: { page: 0, pageSize: 10 } });

    expect(literal.totalCount).toBe(0);
    expect(wildcard.totalCount).toBe(0);
  });

  it('applies the price bounds in rubles against the effective price', async () => {
    const { rows } = await raw.query<{ price: number }>(
      `SELECT COALESCE(sale_price_kopecks, price_kopecks) / 100.0 AS price
         FROM scraped_items
        WHERE COALESCE(sale_price_kopecks, price_kopecks) IS NOT NULL
        ORDER BY random() LIMIT 40`
    );

    const floor = Math.ceil(rows[0]!.price);
    const page = await listItems({
      filter: { minPriceRubles: floor },
      paging: { page: 0, pageSize: 40 },
    });

    for (const item of page.items) {
      const effective =
        item.salePriceKopecks !== null && item.salePriceKopecks > 0
          ? item.salePriceKopecks
          : item.priceKopecks;
      if (effective !== null) {
        expect(effective / 100).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it('never returns a discount badge for a price that did not fall', async () => {
    const page = await listItems({ sort: 'PriceDesc', paging: { page: 0, pageSize: 60 } });
    for (const item of page.items) {
      const discount = discountPercent(item.priceKopecks, item.salePriceKopecks);
      if (discount !== null) {
        expect(discount).toBeGreaterThan(0);
      }
    }
  });

  it('maps cashback percent and rubles independently', async () => {
    // The crawler stores them as two columns in two units. Reading them into one
    // variable is the mistake the crawler's ADR had to undo.
    const page = await listItems({
      filter: { minCashbackPercent: 1 },
      sort: 'CashbackPercentDesc',
      paging: { page: 0, pageSize: 25 },
    });

    for (const item of page.items) {
      expect(item.cashbackPercent).not.toBeNull();
      expect(item.cashbackPercent!).toBeGreaterThanOrEqual(1);
      if (item.cashbackRubles !== null) {
        // A cashback larger than the product is the unit bug, visible as a
        // seven-figure amount on a 40 000 ₽ kettle.
        expect(item.cashbackRubles).toBeLessThanOrEqual(
          kopecksToRubles(item.salePriceKopecks ?? item.priceKopecks) ?? Infinity
        );
      }
    }
  });
});

describe('getProduct', () => {
  it('returns a product with its price history, newest first', async () => {
    const { rows } = await raw.query<{ id: string; target_id: string; product_id: string }>(
      `SELECT s.id, s.target_id, s.product_id
         FROM scraped_items s
         JOIN (SELECT target_id, product_id
                 FROM scraped_items
                WHERE product_id IS NOT NULL
                GROUP BY target_id, product_id
               HAVING COUNT(*) > 1) many
           ON many.target_id = s.target_id AND many.product_id = s.product_id
        ORDER BY s.scraped_at DESC
        LIMIT 1`
    );
    const row = rows[0];
    expect(row, 'the seed should contain a product with several observations').toBeDefined();

    const product = await getProduct(row!.id);
    expect(product).not.toBeNull();
    expect(product!.history.length).toBeGreaterThan(1);

    for (let i = 1; i < product!.history.length; i += 1) {
      expect(product!.history[i]!.scrapedAt <= product!.history[i - 1]!.scrapedAt).toBe(true);
    }
  });

  it('does not mix a product’s history across targets', async () => {
    // Some products appear in several catalogs. History is keyed on
    // (target_id, product_id), so a price observed elsewhere must not leak in.
    const { rows } = await raw.query<{ id: string; target_id: string }>(
      `SELECT id, target_id FROM scraped_items
        WHERE product_id = (SELECT product_id FROM scraped_items GROUP BY product_id HAVING COUNT(DISTINCT target_id) > 1 LIMIT 1)
        ORDER BY scraped_at DESC LIMIT 1`
    );
    if (rows.length === 0) return; // no cross-target product in the seed

    const product = await getProduct(rows[0]!.id);
    expect(product!.targetId).toBe(rows[0]!.target_id);

    // The product really does appear in other targets — otherwise this test has
    // nothing to prove and the guard would be satisfied by a tautology.
    const { rows: cross } = await raw.query<{ count: string }>(
      `SELECT COUNT(*) FROM scraped_items
        WHERE product_id = (SELECT product_id FROM scraped_items WHERE id = $1)
          AND target_id <> $2`,
      [rows[0]!.id, rows[0]!.target_id]
    );
    expect(Number(cross[0]!.count)).toBeGreaterThan(0);

    // And the history the storefront returned contains none of those rows:
    // every point must have been recorded inside this target.
    const { rows: leaked } = await raw.query<{ count: string }>(
      `SELECT COUNT(*) FROM scraped_items
        WHERE product_id = (SELECT product_id FROM scraped_items WHERE id = $1)
          AND target_id <> $2
          AND scraped_at = ANY($3::timestamptz[])`,
      [rows[0]!.id, rows[0]!.target_id, product!.history.map((p) => p.scrapedAt)]
    );
    expect(Number(leaked[0]!.count)).toBe(0);
  });

  it('returns an empty history rather than guessing for a product with one observation', async () => {
    const { rows } = await raw.query<{ id: string }>(
      `SELECT s.id
         FROM scraped_items s
         JOIN (SELECT target_id, product_id
                 FROM scraped_items
                WHERE product_id IS NOT NULL
                GROUP BY target_id, product_id
               HAVING COUNT(*) = 1) single
           ON single.target_id = s.target_id AND single.product_id = s.product_id
        LIMIT 1`
    );
    if (rows.length === 0) return;

    const product = await getProduct(rows[0]!.id);
    expect(product!.history).toEqual([]);
  });

  it('returns null for an unknown id', async () => {
    expect(await getProduct('00000000-0000-4000-a000-000000000000')).toBeNull();
  });

  it('returns null for a malformed id instead of throwing', async () => {
    // The id comes straight from the URL.
    await expect(getProduct('not-a-uuid')).resolves.toBeNull();
  });
});

describe('listTopDeals', () => {
  it('returns one row per match_id, ordered by cashback', async () => {
    const page = await listTopDeals({ paging: { page: 0, pageSize: 30 } });
    expect(page.items.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const item of page.items) {
      expect(seen.has(item.id), `duplicate product ${item.id}`).toBe(false);
      seen.add(item.id);
    }

    const percents = page.items.map((i) => i.cashbackPercent);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeLessThanOrEqual(percents[i - 1]!);
    }
  });

  it('honours the minimum cashback filter', async () => {
    const page = await listTopDeals({ minCashbackPercent: 15, paging: { page: 0, pageSize: 20 } });
    for (const item of page.items) {
      expect(item.cashbackPercent!).toBeGreaterThanOrEqual(15);
    }
  });

  it('excludes items without a match_id rather than deduplicating them arbitrarily', async () => {
    const { rows } = await raw.query<{ count: string }>(
      'SELECT COUNT(*) FROM scraped_items WHERE match_id IS NULL'
    );
    if (Number(rows[0]!.count) === 0) return;

    const page = await listTopDeals({ paging: { page: 0, pageSize: 60 } });
    const { rows: ids } = await raw.query<{ id: string }>(
      'SELECT id FROM scraped_items WHERE match_id IS NULL LIMIT 1'
    );
    expect(page.items.some((i) => i.id === ids[0]!.id)).toBe(false);
  });
});

describe('listTargets and getSiteStats', () => {
  it('counts every item and never exceeds the table', async () => {
    const targets = await listTargets();
    const stats = await getSiteStats();

    expect(targets).toHaveLength(stats.totalTargets);
    for (const target of targets) {
      expect(target.itemCount).toBeGreaterThanOrEqual(0);
    }
    expect(targets.reduce((sum, t) => sum + t.itemCount, 0)).toBe(stats.totalItems);
  });

  it('counts only rows with cashback in the cashback figure', async () => {
    const stats = await getSiteStats();
    const { rows } = await raw.query<{ count: string }>(
      'SELECT COUNT(*) FROM scraped_items WHERE cashback_percent IS NOT NULL'
    );
    expect(stats.withCashback).toBe(Number(rows[0]!.count));
  });

  it('reports a null newest timestamp rather than the epoch for an empty database', async () => {
    const stats = await getSiteStats();
    // A seeded database has one, so this asserts the *mapping*: a Date that was
    // never formatted must not become 1970-01-01 on the page.
    if (stats.newestScrapedAt !== null) {
      expect(stats.newestScrapedAt.startsWith('19')).toBe(false);
    }
  });
});

describe('normalizePaging is the same function the queries use', () => {
  it('clamps identically', () => {
    expect(normalizePaging(-1, 0)).toEqual({ page: 0, pageSize: 1 });
    expect(normalizePaging(1e9, 1e9)).toEqual({ page: 1e9, pageSize: MAX_PAGE_SIZE });
  });
});
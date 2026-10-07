/**
 * Every SQL statement this site runs.
 *
 * ## Rules this file exists to keep
 *
 * 1. **No writes, no DDL.** Not one statement here mutates anything. The crawler's
 *    Flyway migrations are the only writer of this schema.
 * 2. **Every caller-supplied value is a bind parameter.** There is no `${}` in any
 *    string that reaches `query()` except the sort clause, and that one is chosen
 *    from a frozen union by `orderByFor()` below — never passed through from a URL.
 * 3. **Columns are named explicitly.** `SELECT *` would couple this site to column
 *    order and would silently keep working after a migration renames a column,
 *    which is exactly when you want it to fail.
 */

import { query, queryOne } from './db';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  type Paged,
  type PricePoint,
  type ProductCard,
  type ProductDetail,
  type SortOrder,
  type TargetSummary,
} from './types';
import { toNumber } from './money';

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

/**
 * The card projection. `scraped_at` comes back as a Date (timestamptz) and is
 * normalised to ISO-8601 in `mapCard` so nothing downstream has to guess whether
 * it got a string, a Date or a local-time rendering.
 */
const CARD_COLUMNS = `
  i.id::text                AS id,
  i.target_id::text         AS target_id,
  t.name                    AS target_name,
  i.title,
  i.price_kopecks,
  i.sale_price_kopecks,
  i.brand,
  i.seller,
  i.cashback_percent,
  i.cashback,
  i.in_stock,
  i.image_url,
  i.product_url,
  i.scraped_at
`;

interface CardRow {
  id: string;
  target_id: string;
  target_name: string;
  title: string | null;
  price_kopecks: string | number | null;
  sale_price_kopecks: string | number | null;
  brand: string | null;
  seller: string | null;
  cashback_percent: string | number | null;
  cashback: string | number | null;
  in_stock: boolean | null;
  image_url: string | null;
  product_url: string;
  scraped_at: Date | string;
}

function mapCard(row: CardRow): ProductCard {
  return {
    id: row.id,
    targetId: row.target_id,
    targetName: row.target_name,
    // A row with no title still has to render as a link, and an empty anchor is
    // invisible. The product id is the least-bad fallback and is always present.
    title: row.title?.trim() || `Товар ${row.id.slice(0, 8)}`,
    priceKopecks: toNumber(row.price_kopecks),
    salePriceKopecks: toNumber(row.sale_price_kopecks),
    brand: row.brand,
    seller: row.seller,
    cashbackPercent: toNumber(row.cashback_percent),
    cashbackRubles: toNumber(row.cashback),
    inStock: row.in_stock,
    imageUrl: row.image_url,
    productUrl: row.product_url,
    scrapedAt: iso(row.scraped_at),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * ORDER BY fragments, keyed by the `SortOrder` union.
 *
 * The object is `Record<SortOrder, string>` rather than a Map so that adding a
 * member to the union without adding a fragment here is a **compile error**
 * instead of a runtime fallback. Every fragment ends with `i.id` — without a
 * tiebreaker, PostgreSQL may return equal rows in a different order per page,
 * and a paginated list that repeats and drops items is indistinguishable from a
 * bug in the filter.
 */
const ORDER_BY: Record<SortOrder, string> = {
  DateDesc: 'i.scraped_at DESC NULLS LAST, i.id',
  DateAsc: 'i.scraped_at ASC NULLS LAST, i.id',
  PriceAsc: 'COALESCE(i.sale_price_kopecks, i.price_kopecks) ASC NULLS LAST, i.id',
  PriceDesc: 'COALESCE(i.sale_price_kopecks, i.price_kopecks) DESC NULLS LAST, i.id',
  CashbackPercentDesc: 'i.cashback_percent DESC NULLS LAST, i.scraped_at DESC, i.id',
  CashbackPercentAsc: 'i.cashback_percent ASC NULLS LAST, i.scraped_at DESC, i.id',
  TitleAsc: 'i.title ASC NULLS LAST, i.id',
  TitleDesc: 'i.title DESC NULLS LAST, i.id',
};

/**
 * Exported for the architectural test in tests/architecture.test.ts.
 *
 * The property that matters is not "the strings look safe" but "every fragment
 * is a fixed, closed list of ORDER BY items". The union type above makes that
 * exhaustive at compile time; exporting the map lets a test assert the runtime
 * properties the compiler cannot see — no statement separator, and a total
 * ordering (every fragment ends with a tiebreaker).
 */
export function orderByFor(sort: SortOrder): string {
  return ORDER_BY[sort];
}

/** The full fragment table, for tests that assert properties over every entry. */
export const ORDER_BY_FRAGMENTS: Readonly<Record<SortOrder, string>> = ORDER_BY;

// ---------------------------------------------------------------------------
// Filtering + paging
// ---------------------------------------------------------------------------

export interface ItemFilter {
  search?: string | undefined;
  minPriceRubles?: number | undefined;
  maxPriceRubles?: number | undefined;
  minCashbackPercent?: number | undefined;
  inStockOnly?: boolean | undefined;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

/**
 * Build the shared WHERE fragment and its bind parameters.
 *
 * Parameters are numbered from 1 with no gaps. An earlier version started the
 * filter at `$2` when a target id was present, on the assumption that something
 * else held `$1` — nothing did, so the query skipped a parameter. It worked,
 * but it made every placeholder number in the file conditional on a flag, and
 * the LIMIT/OFFSET numbering then had to depend on it too, which is precisely
 * how a filter placeholder and a LIMIT placeholder ended up sharing an index and
 * every category page failed with 42804.
 */
function buildWhere(filter: ItemFilter, targetId?: string): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

  // Resolves the index of the parameter that is *about to be* pushed. Calling
  // it after the push yields params.length + 1 and shifts every subsequent
  // placeholder by one — which is how a filter clause ended up on `$2` while
  // LIMIT was also `$2`, and every search page failed with a datatype mismatch.
  const next = () => `$${params.length + 1}`;

  if (targetId !== undefined) {
    const idx = next();
    params.push(targetId);
    clauses.push(`i.target_id = ${idx}`);
  }

  if (filter.search) {
    const idx = next();
    params.push(`%${escapeLike(filter.search)}%`);
    // Title first, then brand/seller: a match in the title is what the user meant,
    // and OR-ing without parentheses would let the brand clause escape the filter.
    // The same `$n` is reused three times, which PostgreSQL allows and which is
    // why it counts as one bound value.
    clauses.push(`(i.title ILIKE ${idx} OR i.brand ILIKE ${idx} OR i.seller ILIKE ${idx})`);
  }

  if (filter.minPriceRubles !== undefined && Number.isFinite(filter.minPriceRubles)) {
    const idx = next();
    params.push(Math.round(filter.minPriceRubles * 100));
    clauses.push(`COALESCE(i.sale_price_kopecks, i.price_kopecks) >= ${idx}`);
  }

  if (filter.maxPriceRubles !== undefined && Number.isFinite(filter.maxPriceRubles)) {
    const idx = next();
    params.push(Math.round(filter.maxPriceRubles * 100));
    clauses.push(`COALESCE(i.sale_price_kopecks, i.price_kopecks) <= ${idx}`);
  }

  if (filter.minCashbackPercent !== undefined && Number.isFinite(filter.minCashbackPercent)) {
    const idx = next();
    params.push(filter.minCashbackPercent);
    clauses.push(`i.cashback_percent >= ${idx}`);
  }

  if (filter.inStockOnly) {
    clauses.push('i.in_stock = true');
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/**
 * `ILIKE` treats `%` and `_` in the user's text as wildcards, so searching for
 * "100%" returns every row. Escaping them makes the search literal, which is what
 * someone typing a product name into a search box expects.
 *
 * The backslash escape is Postgres' default for `LIKE`, and `standard_conforming_strings`
 * is on, so `'\'` is a single backslash in the SQL literal.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface Paging {
  page: number;
  pageSize: number;
}

/** Clamp user-supplied paging so `?page=-1` and `?pageSize=100000` are not a 500. */
export function normalizePaging(page: number, pageSize: number): Paging {
  return {
    page: Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0,
    pageSize: Number.isFinite(pageSize)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)))
      : DEFAULT_PAGE_SIZE,
  };
}

function paged<T>(items: T[], totalCount: number, paging: Paging): Paged<T> {
  const totalPages = Math.ceil(totalCount / paging.pageSize);
  return {
    items,
    totalCount,
    page: paging.page,
    pageSize: paging.pageSize,
    totalPages,
    hasNextPage: paging.page + 1 < totalPages,
    hasPrevPage: paging.page > 0 && totalCount > 0,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface BuiltQuery {
  text: string;
  values: unknown[];
}

/**
 * Build the paginated item query.
 *
 * Exported so it can be tested without a database — which is the only reason the
 * placeholder numbering below is checkable at all. A collision between a filter
 * placeholder and LIMIT/OFFSET produces `datatype mismatch` from PostgreSQL, not
 * a syntax error, and only on the code paths that bind a target id.
 */
export function buildItemListSql(options: {
  targetId?: string | undefined;
  filter?: ItemFilter | undefined;
  sort?: SortOrder | undefined;
  paging?: Paging | undefined;
}): BuiltQuery {
  const sort = options.sort ?? DEFAULT_SORT;
  const paging = normalizePaging(options.paging?.page ?? 0, options.paging?.pageSize ?? DEFAULT_PAGE_SIZE);
  const filter = options.filter ?? {};

  // The first bind parameter belongs to the filter, and LIMIT/OFFSET have to be
  // numbered from *after* it.
  //
  // Getting this wrong is a placeholder collision rather than a syntax error:
  // with only a target id the filter binds `$1` and LIMIT was also written as
  // `$1`, so Postgres received the target's UUID where it expected an integer
  // and every category page failed with 42804 (datatype mismatch) — while the
  // home page, which passes no target id, kept working.
  const where = buildWhere(filter, options.targetId);
  const limitIndex = where.params.length + 1;
  const offsetIndex = limitIndex + 1;

  const text = `SELECT ${CARD_COLUMNS}
       FROM scraped_items i
       JOIN crawl_targets t ON t.id = i.target_id
       ${where.sql}
      ORDER BY ${orderByFor(sort)}
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}`;

  return {
    text,
    values: [...where.params, paging.pageSize, paging.page * paging.pageSize],
  };
}

export async function listItems(options: {
  targetId?: string | undefined;
  filter?: ItemFilter | undefined;
  sort?: SortOrder | undefined;
  paging?: Paging | undefined;
}): Promise<Paged<ProductCard>> {
  const sort = options.sort ?? DEFAULT_SORT;
  const paging = normalizePaging(options.paging?.page ?? 0, options.paging?.pageSize ?? DEFAULT_PAGE_SIZE);
  const filter = options.filter ?? {};
  const where = buildWhere(filter, options.targetId);

  const built = buildItemListSql(options);
  const rows = await query<CardRow>(built.text, built.values);

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM scraped_items i
       JOIN crawl_targets t ON t.id = i.target_id
       ${where.sql}`,
    where.params
  );

  return paged(rows.map(mapCard), toNumber(countRow?.count) ?? 0, paging);
}

/**
 * Every crawl target with its item count.
 *
 * The `LEFT JOIN` + `GROUP BY` is a full pass over `scraped_items` — with the
 * `idx_scraped_items_target_id` index it is an index-only scan per target, which
 * is why this is cached for 10 minutes rather than per request. It is the one
 * query here that does not scale for free, and the honest fix (a maintained
 * counter) would mean writing to this database, which this site does not do.
 */
export async function listTargets(): Promise<TargetSummary[]> {
  const rows = await query<{
    id: string;
    name: string;
    root_category_name: string | null;
    is_active: boolean;
    item_count: string;
    newest_scraped_at: Date | string | null;
  }>(
    `SELECT t.id::text AS id,
            t.name,
            t.root_category_name,
            t.is_active,
            COUNT(i.id) AS item_count,
            MAX(i.scraped_at) AS newest_scraped_at
       FROM crawl_targets t
       LEFT JOIN scraped_items i ON i.target_id = t.id
      GROUP BY t.id, t.name, t.root_category_name, t.is_active
      ORDER BY t.name ASC`
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rootCategoryName: r.root_category_name,
    isActive: r.is_active,
    itemCount: toNumber(r.item_count) ?? 0,
    newestScrapedAt: r.newest_scraped_at ? iso(r.newest_scraped_at) : null,
  }));
}

/**
 * One product plus its price history.
 *
 * History is keyed on `(target_id, product_id)`, not on the row id: the writer's
 * upsert keeps one row per (target, product, price), so a row id identifies a
 * single price observation and the history of a product is the set of its rows.
 * Rows whose `product_id` is null cannot be grouped this way and get no history
 * — the product page renders the price it has rather than pretending to a series.
 */
export async function getProduct(id: string): Promise<ProductDetail | null> {
  const card = await queryOne<CardRow>(
    `SELECT ${CARD_COLUMNS}
       FROM scraped_items i
       JOIN crawl_targets t ON t.id = i.target_id
      WHERE i.id = $1`,
    [id]
  );
  if (!card) return null;

  const mapped = mapCard(card);

  const productIdRow = await queryOne<{ product_id: string | null }>(
    'SELECT product_id::text AS product_id FROM scraped_items WHERE id = $1',
    [id]
  );
  const productId = productIdRow?.product_id ?? null;

  if (productId === null) return { ...mapped, history: [] };

  const historyRows = await query<{
    scraped_at: Date | string;
    price_kopecks: string | number | null;
    cashback_percent: string | number | null;
    cashback: string | number | null;
  }>(
    `SELECT scraped_at, price_kopecks, cashback_percent, cashback
       FROM scraped_items
      WHERE target_id = $1 AND product_id = $2
      ORDER BY scraped_at DESC
      LIMIT 120`,
    [mapped.targetId, productId]
  );

  const history: PricePoint[] = historyRows.map((r) => ({
    scrapedAt: iso(r.scraped_at),
    priceKopecks: toNumber(r.price_kopecks),
    cashbackPercent: toNumber(r.cashback_percent),
    cashbackRubles: toNumber(r.cashback),
  }));

  return { ...mapped, history };
}

/**
 * Highest cashback across all targets, one row per `match_id`.
 *
 * `DISTINCT ON` collapses the same upstream product appearing in several targets. Rows
 * with a null `match_id` are excluded: without a stable grouping key the
 * "best deal" list would deduplicate arbitrarily and show the same product twice,
 * which is worse than showing it once per target.
 */
export async function listTopDeals(options: {
  minCashbackPercent?: number | undefined;
  paging?: Paging | undefined;
}): Promise<Paged<ProductCard>> {
  const paging = normalizePaging(options.paging?.page ?? 0, options.paging?.pageSize ?? DEFAULT_PAGE_SIZE);
  const params: unknown[] = [];
  let filterSql = '';
  if (options.minCashbackPercent !== undefined && Number.isFinite(options.minCashbackPercent)) {
    params.push(options.minCashbackPercent);
    filterSql = `AND s.cashback_percent >= $${params.length}`;
  }

  const rows = await query<CardRow & { match_id: string }>(
    `SELECT DISTINCT ON (i.match_id)
            ${CARD_COLUMNS},
            i.match_id::text AS match_id
       FROM scraped_items i
       JOIN crawl_targets t ON t.id = i.target_id
      WHERE i.match_id IS NOT NULL
        ${filterSql}
      ORDER BY i.match_id, i.cashback_percent DESC NULLS LAST, i.scraped_at DESC`,
    params
  );

  // DISTINCT ON cannot be paginated in SQL without wrapping it in a subquery and
  // re-sorting, and the dataset is the deduplicated set of all crawled products.
  // The slice happens here; at the crawler's scale this stays in memory.
  const all = rows.map(mapCard);
  const totalCount = all.length;
  const start = paging.page * paging.pageSize;
  const items = all.slice(start, start + paging.pageSize);

  return paged(items, totalCount, paging);
}

export interface SiteStats {
  totalItems: number;
  totalTargets: number;
  newestScrapedAt: string | null;
  withCashback: number;
}

export async function getSiteStats(): Promise<SiteStats> {
  const row = await queryOne<{
    total_items: string;
    total_targets: string;
    newest_scraped_at: Date | string | null;
    with_cashback: string;
  }>(
    `SELECT (SELECT COUNT(*) FROM scraped_items)                       AS total_items,
            (SELECT COUNT(*) FROM crawl_targets)                      AS total_targets,
            (SELECT MAX(scraped_at) FROM scraped_items)                AS newest_scraped_at,
            (SELECT COUNT(*) FROM scraped_items WHERE cashback_percent IS NOT NULL) AS with_cashback`
  );

  return {
    totalItems: toNumber(row?.total_items) ?? 0,
    totalTargets: toNumber(row?.total_targets) ?? 0,
    newestScrapedAt: row?.newest_scraped_at ? iso(row.newest_scraped_at) : null,
    withCashback: toNumber(row?.with_cashback) ?? 0,
  };
}

/** Cheap liveness probe: proves the connection works and the tables are visible. */
export async function ping(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch (err) {
    console.error('[db] ping failed', err);
    return false;
  }
}
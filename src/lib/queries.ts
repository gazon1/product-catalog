/**
 * Everything the site reads from the catalog.
 *
 * ## The boundary
 *
 * The crawler owns the database and the only way into it is its read-only HTTP
 * API. This file is the storefront's side of that boundary: it turns the
 * site's own vocabulary (a filter, a sort, a page) into a request, and turns
 * the answer back into the shapes the pages render.
 *
 * There is no SQL here any more, and there is no connection string, and there
 * is no driver. That is the whole point of the change: a storefront that
 * cannot open a database connection cannot break the crawler's schema, cannot
 * accidentally write to it, and cannot keep working when the crawler's
 * migrations rename a column.
 *
 * ## What the site still owns
 *
 * Two things, and they are the two that the API cannot decide for us:
 *
 *   - the **sort vocabulary** — the names in `?sort=` are the site's own URLs,
 *     so the site checks them before they travel (`src/lib/api/sort.ts`);
 *   - the **title fallback** — the contract promises a non-empty title, but a
 *     card without a title cannot be rendered as a link, and an empty anchor is
 *     invisible, so the site keeps its own placeholder.
 *
 * Everything else — the schema, the units inside the database, the SQL, the
 * escaping of a search term — belongs to the crawler.
 *
 * ## The units
 *
 * `priceKopecks` and `salePriceKopecks` are kopecks, because that is what the
 * crawler stores. `cashbackRubles` is rubles, because the crawler's writer
 * already converts kopecks to rubles before storing them: the value passes
 * through unchanged, and dividing it by 100 here would turn a 500 ₽ cashback
 * into 5 ₽. The price *filters* the site sends are rubles too, and the
 * conversion to kopecks happens exactly once — inside the API.
 */

import { ApiError, apiGet, CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './api/client';
import {
  buildItemsQuery,
  buildTopDealsQuery,
  normalizePaging,
  type ItemFilter,
  type Paging,
} from './api/params';
import { DEFAULT_PAGE_SIZE, DEFAULT_SORT, type SortOrder } from './api/sort';
import type {
  Paged,
  PricePoint,
  ProductCard,
  ProductDetail,
  SiteStats,
  TargetSummary,
} from './api/types';

export { normalizePaging } from './api/params';
export type { ItemFilter, Paging } from './api/params';
export type { SiteStats } from './api/types';

/**
 * The connect budget for a catalog read.
 *
 * The default of three seconds is a *connect* budget: the time to reach the
 * crawler and start an answer. For a query the answer time is the query time —
 * the response headers arrive when the SQL finishes — and the crawler is
 * allowed eight seconds of SQL before its own statement timeout fires. A
 * three-second budget here would abort work the crawler is allowed to finish,
 * so a catalog read gets the overall budget instead. The crawler's own
 * statement timeout stays the real budget; this one only makes sure a request
 * cannot hang forever.
 */
const CATALOG_CONNECT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

/**
 * Apply the site's own fallback for a title the API could not provide.
 *
 * The contract promises a non-empty title, so this never fires against a
 * correct API. It stays because a card without a title cannot be rendered as a
 * link: an empty anchor is invisible, and a page of invisible links is a
 * broken page. The two layers agree on the placeholder, so the fallback is a
 * second line of defence rather than a second source of truth.
 */
function mapCard(card: ProductCard): ProductCard {
  return {
    id: card.id,
    targetId: card.targetId,
    targetName: card.targetName,
    title: card.title?.trim() || `Товар ${String(card.id ?? '').slice(0, 8)}`,
    priceKopecks: card.priceKopecks ?? null,
    salePriceKopecks: card.salePriceKopecks ?? null,
    brand: card.brand ?? null,
    seller: card.seller ?? null,
    cashbackPercent: card.cashbackPercent ?? null,
    cashbackRubles: card.cashbackRubles ?? null,
    inStock: card.inStock ?? null,
    imageUrl: card.imageUrl ?? null,
    productUrl: card.productUrl,
    scrapedAt: card.scrapedAt,
  };
}

/** One price observation, as the pages read it. */
function mapPricePoint(point: PricePoint): PricePoint {
  return {
    scrapedAt: point.scrapedAt,
    priceKopecks: point.priceKopecks ?? null,
    cashbackPercent: point.cashbackPercent ?? null,
    cashbackRubles: point.cashbackRubles ?? null,
  };
}

/**
 * The paged envelope, defensively.
 *
 * The counters are the crawler's, not ours: the crawler knows how many rows
 * matched before paging, and a second count here would be a second query and a
 * second chance to disagree with the first.
 */
function mapPage<T>(page: Paged<T>): Paged<T> {
  return {
    items: page.items ?? [],
    totalCount: page.totalCount ?? 0,
    page: page.page ?? 0,
    pageSize: page.pageSize ?? 0,
    totalPages: page.totalPages ?? 0,
    hasNextPage: page.hasNextPage ?? false,
    hasPrevPage: page.hasPrevPage ?? false,
  };
}

/**
 * A filtered, sorted, paginated page of product cards.
 *
 * The filter keeps the site's own names; the query string keeps the API's.
 * The translation happens once, in `src/lib/api/params.ts`.
 */
export async function listItems(options: {
  targetId?: string | undefined;
  filter?: ItemFilter | undefined;
  sort?: SortOrder | undefined;
  paging?: Paging | undefined;
}): Promise<Paged<ProductCard>> {
  const paging = normalizePaging(
    options.paging?.page ?? 0,
    options.paging?.pageSize ?? DEFAULT_PAGE_SIZE,
  );

  const query = buildItemsQuery({
    targetId: options.targetId,
    filter: options.filter,
    sort: options.sort ?? DEFAULT_SORT,
    paging,
  });

  const page = await apiGet<Paged<ProductCard>>('/items', {
    query,
    connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
  });

  return { ...mapPage(page), items: (page.items ?? []).map(mapCard) };
}

/**
 * Every crawl target with its item count.
 *
 * The API answers with `{ items: [...] }` — the same envelope shape as the
 * paged lists, without the paging — and the count of a target is the
 * crawler's aggregate, cached on its side. The site used to compute it with a
 * `LEFT JOIN` over the whole scraped table, which was the one query here that
 * did not scale for free.
 */
export async function listTargets(): Promise<TargetSummary[]> {
  const body = await apiGet<{ items: TargetSummary[] }>('/targets', {
    connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
  });
  return body.items ?? [];
}

/**
 * One product plus its price history.
 *
 * ## Why a malformed id is a `null` and not an error
 *
 * The id comes straight from `/product/[id]`. The contract says it is a UUID
 * and that anything else is a `400`; the crawler used to answer `22P02` from
 * PostgreSQL, which was a database error page for what is really a typo in a
 * URL. Both the `400` and the `404` are therefore mapped to `null` here, so a
 * mistyped id renders the "not found" page instead of an error page.
 *
 * The id is *not* checked locally any more. The crawler owns the shape of its
 * own identifiers, and a second parser on this side would be a second place to
 * disagree with it about what a valid id is.
 */
export async function getProduct(id: string): Promise<ProductDetail | null> {
  try {
    const product = await apiGet<ProductDetail>(`/items/${encodeURIComponent(id)}`, {
      connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
    });
    return {
      ...mapCard(product),
      history: (product.history ?? []).map(mapPricePoint),
    };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 404)) return null;
    throw err;
  }
}

/**
 * The highest cashback across all targets, one row per matched product.
 *
 * The deduplication is the crawler's business: it knows which rows describe
 * the same product, and it collapses them to their best observation. The site
 * used to do it with `DISTINCT ON (match_id)`, wrapped in a subquery because
 * `DISTINCT ON` orders by the grouping key and a "top by cashback" list that
 * comes back in `match_id` order is not a top list.
 */
export async function listTopDeals(options: {
  minCashbackPercent?: number | undefined;
  paging?: Paging | undefined;
}): Promise<Paged<ProductCard>> {
  const paging = normalizePaging(
    options.paging?.page ?? 0,
    options.paging?.pageSize ?? DEFAULT_PAGE_SIZE,
  );

  const query = buildTopDealsQuery({
    minCashbackPercent: options.minCashbackPercent,
    paging,
  });

  const page = await apiGet<Paged<ProductCard>>('/top-deals', {
    query,
    connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
  });

  return { ...mapPage(page), items: (page.items ?? []).map(mapCard) };
}

/** Aggregate counters for the whole catalog. */
export async function getSiteStats(): Promise<SiteStats> {
  const stats = await apiGet<SiteStats>('/stats', {
    connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
  });

  return {
    totalItems: stats.totalItems ?? 0,
    totalProducts: stats.totalProducts ?? 0,
    totalTargets: stats.totalTargets ?? 0,
    newestScrapedAt: stats.newestScrapedAt ?? null,
    withCashback: stats.withCashback ?? 0,
    productsWithCashback: stats.productsWithCashback ?? 0,
    // The moment the counters were computed. The contract makes it required, and
    // it is — but the storefront may briefly talk to a crawler that is older
    // than the contract, and an empty string is what the page renders as "—".
    asOf: stats.asOf ?? '',
  };
}

/**
 * Is the catalog ready to be served?
 *
 * The answer comes from the crawler's own readiness probe, which checks that
 * its pool can execute a statement *and* that the columns the catalog reads
 * are present. The site used to answer this question with `SELECT 1 FROM
 * scraped_items LIMIT 1`, which is a weaker question: it says the table is
 * there, not that the columns the queries name are.
 *
 * A readiness probe that takes longer than the connect budget is a failed
 * readiness probe, not a slow one: the crawler documents the check as cheap on
 * purpose, because the deploy gate, the container health check and the
 * storefront all call it.
 *
 * This never throws. A health check that throws is a health check that takes
 * the process down with it.
 */
export async function ping(): Promise<boolean> {
  try {
    // A 2xx answer is the only way out of `apiGet`, so reaching the `return`
    // means the readiness probe answered 200.
    await apiGet<{ status: string }>('/ready', {
      timeoutMs: CONNECT_TIMEOUT_MS,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    // The message is already redacted by the client; the whole error object is
    // not logged, because a `cause` is not ours to vouch for.
    const detail = err instanceof Error ? err.message : 'unknown error';
    console.error('[api] the catalog is not ready:', detail);
    return false;
  }
}

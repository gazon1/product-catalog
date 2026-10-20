/**
 * The query strings the storefront sends to the catalog API.
 *
 * ## Why the two vocabularies do not match, and why that is fine
 *
 * The site's own filter shape (`ItemFilter`) speaks in the names the pages use:
 * `search`, `minPriceRubles`, `maxPriceRubles`, `minCashbackPercent`,
 * `inStockOnly`. The API speaks in the names its contract documents: `q`,
 * `minPrice`, `maxPrice`, `minCashback`, `inStock`, `sort`, `page`, `pageSize`.
 *
 * The translation happens here, once, and nowhere else. When it happened in the
 * pages, every page would have had to know the API's spelling, and a rename on
 * the API side would have become a rename on the site side.
 *
 * ## The units
 *
 * `minPrice` and `maxPrice` are **rubles**, and they are sent as rubles. The
 * conversion to kopecks happens exactly once, inside the API, when it builds its
 * query. Multiplying by 100 here would be the second conversion, and the
 * difference between a hundred and a ten-thousandfold price filter is exactly
 * the kind of bug that shows up as "the filter does nothing".
 */

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  isSortOrder,
  type SortOrder,
} from './sort';

/**
 * The site's filter shape.
 *
 * The names are the site's own and are not the API's; see the note above.
 */
export interface ItemFilter {
  search?: string | undefined;
  /** Rubles. */
  minPriceRubles?: number | undefined;
  /** Rubles. */
  maxPriceRubles?: number | undefined;
  /** Percent. */
  minCashbackPercent?: number | undefined;
  inStockOnly?: boolean | undefined;
}

/** The site's paging shape: a zero-based page and a page size. */
export interface Paging {
  page: number;
  pageSize: number;
}

/**
 * Clamp user-supplied paging so `?page=-1` and `?pageSize=100000` are not a 500.
 *
 * The clamps are the API's own limits (`page` is zero-based, `pageSize` is 1..60),
 * applied here so that an ordinary site URL can never become a request for a page
 * that does not exist. The API clamps such a request itself — the contract says so,
 * and `400` is reserved for a parameter it cannot interpret at all — but the site
 * clamps as well, because the two answers have to be the same one.
 */
export function normalizePaging(page: number, pageSize: number): Paging {
  return {
    page: Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0,
    pageSize: Number.isFinite(pageSize)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)))
      : DEFAULT_PAGE_SIZE,
  };
}

/** A finite number, or nothing. `NaN` and `Infinity` are not filters. */
function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The query string for `GET /items`.
 *
 * The parameter order is fixed. A query string is not a set, and a test that
 * asserts on one has to be able to predict it; a builder that appended
 * parameters in the order a caller happened to set them would make that test
 * flaky for no benefit.
 *
 * Only parameters that carry meaning are sent. An absent filter is not the
 * same as a filter of zero — `minPrice=0` asks the API for free products, which
 * is a different question from "no minimum" — so a missing value is left out
 * entirely rather than sent as an empty or zero value.
 */
export function buildItemsQuery(options: {
  targetId?: string | undefined;
  filter?: ItemFilter | undefined;
  sort?: SortOrder | undefined;
  paging?: Paging | undefined;
}): URLSearchParams {
  const params = new URLSearchParams();
  const filter = options.filter ?? {};

  // The sort is checked here, not at the edge of the page. A name the API does
  // not know is a `400` there, so the site never sends one: an unknown name
  // falls back to the default order, which is what the page would have shown
  // anyway.
  const sort = isSortOrder(options.sort) ? options.sort : DEFAULT_SORT;

  const paging = normalizePaging(options.paging?.page ?? 0, options.paging?.pageSize ?? DEFAULT_PAGE_SIZE);

  if (options.targetId) params.set('targetId', options.targetId);

  if (filter.search && filter.search.trim().length > 0) {
    // Sent verbatim. The API owns the escaping: `%` and `_` are literal
    // characters there, and escaping them here would mean the site's SQL
    // dialect leaking into a query string.
    params.set('q', filter.search);
  }

  // Rubles, unchanged. The API converts to kopecks exactly once.
  if (finite(filter.minPriceRubles)) params.set('minPrice', String(filter.minPriceRubles));
  if (finite(filter.maxPriceRubles)) params.set('maxPrice', String(filter.maxPriceRubles));

  if (finite(filter.minCashbackPercent)) params.set('minCashback', String(filter.minCashbackPercent));

  // Only sent when it is on: `inStock=false` would be a filter for the
  // out-of-stock rows, which is not what "in stock only" means.
  if (filter.inStockOnly) params.set('inStock', 'true');

  params.set('sort', sort);
  params.set('page', String(paging.page));
  params.set('pageSize', String(paging.pageSize));

  return params;
}

/**
 * The query string for `GET /top-deals`.
 *
 * There is no `sort` parameter: the contract does not define one, because the
 * order of a "best cashback" list is not a choice — it is the definition of the
 * list.
 */
export function buildTopDealsQuery(options: {
  minCashbackPercent?: number | undefined;
  paging?: Paging | undefined;
}): URLSearchParams {
  const params = new URLSearchParams();
  const paging = normalizePaging(options.paging?.page ?? 0, options.paging?.pageSize ?? DEFAULT_PAGE_SIZE);

  if (finite(options.minCashbackPercent)) {
    params.set('minCashback', String(options.minCashbackPercent));
  }

  params.set('page', String(paging.page));
  params.set('pageSize', String(paging.pageSize));

  return params;
}

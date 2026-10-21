/**
 * The sort vocabulary — the storefront's own.
 *
 * ## Why the site owns this and not the API
 *
 * The names are part of the site's URLs (`?sort=PriceAsc`) and of its own
 * components (`SortSelect`), so the site is the only place that can decide what
 * they mean. The API owns the SQL that implements them; the site owns the
 * closed set of names that are allowed to travel.
 *
 * The set is closed *here* on purpose: an ordinary site URL can never turn into
 * an API `400` because the value was checked against this list before it left
 * the process. A name that the API does not know is a `400` there, and a `400`
 * on a page a visitor opened is a broken page.
 *
 * The contract's `sort` enum and this list are compared against each other by
 * `tests/architecture/sort-vocabulary.test.ts` and `tests/api-contract.test.ts`,
 * so the two cannot drift apart silently.
 */

/** Every sort order the site may send, in the order the UI lists them. */
export const SORT_ORDERS = [
  'DateDesc',
  'DateAsc',
  'PriceAsc',
  'PriceDesc',
  'CashbackPercentDesc',
  'CashbackPercentAsc',
  'TitleAsc',
  'TitleDesc',
] as const;

/** The sort order used when the caller does not name one. */
export type SortOrder = (typeof SORT_ORDERS)[number];

/** The default order: newest observations first, which is what a catalogue wants. */
export const DEFAULT_SORT: SortOrder = 'DateDesc';

/** Upper bound on page size — an unbounded page is a cheap way to OOM a box. */
export const MAX_PAGE_SIZE = 60;

/** How many rows a page holds when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 24;

/**
 * The largest offset the API will serve, in rows.
 *
 * ## Why the offset and not the page index
 *
 * The database pays for the rows *before* the page: it walks them one by one. The
 * crawler's own measurement says what that costs — at two hundred thousand
 * observations a page a hundred thousand rows deep takes about a hundred
 * milliseconds, and the cost grows with the offset rather than with the page.
 *
 * So the bound belongs on the offset. A page index on its own says nothing about
 * the work: with a page size of sixty, a million pages means sixty million rows to
 * walk, which the crawler's eight-second statement timeout would cut off — and a
 * request the database gives up on is a `500`, not an answer.
 *
 * ## Where the number comes from
 *
 * The contract document, under `x-catalog-paging.maxOffset`. It is mirrored
 * here by hand, the way the shapes and the sort names are, and
 * `tests/architecture/paging-bound.test.ts` compares the two — so a bound that
 * drifts in one place cannot drift silently in the other.
 *
 * The storefront clamps to it as well as the API clamping to it. A storefront
 * that clamped to a different page than the API serves would show a page the API
 * never sent.
 */
export const MAX_OFFSET = 1_000_000;

/**
 * The largest page index whose offset stays within `maxOffset` rows.
 *
 * The bound depends on the page size, because the offset is what the work is
 * measured in: a page of sixty rows and a page of one row cannot be bounded by
 * the same index.
 *
 * @param pageSize - How many rows the page holds.
 * @returns The largest page index that fits.
 */
export function maxPageFor(pageSize: number): number {
  const size = Math.max(1, Math.floor(pageSize));
  return Math.max(1, Math.floor(MAX_OFFSET / size));
}


/**
 * Whether a value is one of the declared sort orders.
 *
 * The union type stops an unknown name at compile time; this stops it at
 * runtime, where the value actually originates — a query string.
 */
export function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}

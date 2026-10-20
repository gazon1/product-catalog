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
 * `tests/architecture.test.ts` and `tests/api-contract.test.ts`, so the two
 * cannot drift apart silently.
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
 * Whether a value is one of the declared sort orders.
 *
 * The union type stops an unknown name at compile time; this stops it at
 * runtime, where the value actually originates — a query string.
 */
export function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}

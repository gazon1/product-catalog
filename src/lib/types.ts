/**
 * The site's own vocabulary, and nothing else.
 *
 * ## What lives here now
 *
 * The sort orders, the paging limits and the type re-exports. The shapes the
 * catalog API answers with live in `src/lib/api/types.ts`, next to the client
 * that fetches them; the query strings that carry the site's filters into that
 * API live in `src/lib/api/params.ts`.
 *
 * This file re-exports both, because the components and the pages import from
 * `@/lib/types` and there is no reason to make every one of them learn the
 * internal layout of the API layer. A re-export is a promise about a location,
 * not a copy of a shape: there is exactly one definition of `ProductCard` and
 * exactly one definition of the sort orders, and this file is a signpost to
 * them.
 *
 * ## Why the sort orders are the site's and not the API's
 *
 * The names are in the site's URLs (`?sort=PriceAsc`) and in the site's own
 * components, so the site is the only place that can decide what they mean.
 * The API owns the SQL that implements them; the site owns the closed set of
 * names that are allowed to travel, and checks a name against that set before
 * it leaves the process — so an ordinary site URL can never become an API
 * `400`.
 */

export {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  SORT_ORDERS,
  isSortOrder,
  type SortOrder,
} from './api/sort';

export type {
  ErrorResponse,
  Paged,
  PricePoint,
  ProductCard,
  ProductDetail,
  SiteStats,
  TargetSummary,
} from './api/types';

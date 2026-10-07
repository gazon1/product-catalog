/**
 * Read-only data contract.
 *
 * These shapes are the boundary between the crawler's database and this site.
 * Nothing here is derived from a backend DTO — the previous solution had an
 * ASP.NET layer that translated DB rows into JSON, and every field had two
 * names (`price_kopecks` → `priceRubles`). Dropping that layer means one
 * vocabulary, but it also means the SQL is the only place where the crawler's
 * column names are allowed to appear.
 */

export interface ProductCard {
  id: string;
  targetId: string;
  targetName: string;
  title: string;
  /** null when the crawler recorded a price it could not parse. */
  priceKopecks: number | null;
  salePriceKopecks: number | null;
  brand: string | null;
  seller: string | null;
  /** Percent, from `cashback_percent`. */
  cashbackPercent: number | null;
  /** Rubles, from `cashback`. The crawler's writer already converts kopecks→rubles. */
  cashbackRubles: number | null;
  inStock: boolean | null;
  imageUrl: string | null;
  productUrl: string;
  scrapedAt: string;
}

export interface TargetSummary {
  id: string;
  name: string;
  rootCategoryName: string | null;
  isActive: boolean;
  itemCount: number;
  newestScrapedAt: string | null;
}

export interface Paged<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PricePoint {
  scrapedAt: string;
  priceKopecks: number | null;
  cashbackPercent: number | null;
  cashbackRubles: number | null;
}

export interface ProductDetail extends ProductCard {
  history: PricePoint[];
}

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

export type SortOrder = (typeof SORT_ORDERS)[number];

export const DEFAULT_SORT: SortOrder = 'DateDesc';

/** Upper bound on page size — an unbounded `LIMIT` is a cheap way to OOM a box. */
export const MAX_PAGE_SIZE = 60;

export const DEFAULT_PAGE_SIZE = 24;

export function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}
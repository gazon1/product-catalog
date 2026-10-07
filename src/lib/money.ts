/**
 * Money handling.
 *
 * The crawler stores money as `BIGINT` kopecks (`price_kopecks`) and as
 * `DECIMAL(10,2)` rubles (`cashback`). Both arrive from `pg` as **strings** —
 * node-postgres never guesses a JS number for int8 or numeric, because silently
 * losing precision on a money column is not a rounding error anyone would notice
 * in review. Every helper here therefore accepts `string | number | null`.
 *
 * Precision note: kopecks are converted with `Number()`. That is exact for any
 * value below 2^53 kopecks (~90 trillion rubles), which is nine orders of
 * magnitude above any real price. Anything larger is not a price.
 */

export type Numeric = string | number | null | undefined;

export function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // `Number('')` is 0 and `Number('  ')` is 0 as well. Postgres never returns an
  // empty string for a numeric column, but a value that reached here as one
  // would render as "0 ₽" — a price, which is a claim the data does not make.
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function kopecksToRubles(kopecks: Numeric): number | null {
  const n = toNumber(kopecks);
  return n === null ? null : n / 100;
}

export function rublesToKopecks(rubles: Numeric): number | null {
  const n = toNumber(rubles);
  return n === null ? null : Math.round(n * 100);
}

const RUB_FORMAT = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});

const RUB_FORMAT_PRECISE = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatRubles(amount: number | null, opts: { precise?: boolean } = {}): string {
  if (amount === null) return '—';
  if (opts.precise) return RUB_FORMAT_PRECISE.format(amount);
  return RUB_FORMAT.format(Math.round(amount));
}

/**
 * Discount off the list price, as a percentage.
 *
 * Returns null rather than 0 when there is nothing to compare — a card that
 * shows "0%" for a product whose sale price the crawler never recorded is
 * claiming a fact, and "—" is the honest rendering.
 */
export function discountPercent(priceKopecks: number | null, salePriceKopecks: number | null): number | null {
  if (priceKopecks === null || salePriceKopecks === null) return null;
  if (priceKopecks <= 0 || salePriceKopecks <= 0) return null;
  if (salePriceKopecks >= priceKopecks) return null;
  return Math.round(((priceKopecks - salePriceKopecks) / priceKopecks) * 100);
}

/** The price to display: the sale price when there is one, otherwise the base price. */
export function effectivePriceKopecks(priceKopecks: number | null, salePriceKopecks: number | null): number | null {
  if (salePriceKopecks !== null && salePriceKopecks > 0) return salePriceKopecks;
  return priceKopecks;
}